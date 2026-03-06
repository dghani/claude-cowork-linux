"use strict";

/**
 * CoworkSDKBridge
 *
 * Self-contained bridge between ipc-handler-setup.js and Claude Code CLI.
 * Spawns `claude --print "msg" --output-format stream-json` per message,
 * uses `--resume <conversation_id>` for multi-turn continuity.
 *
 * No dependency on HostCoworkVMManager — uses child_process.spawn directly.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const LOG = "[sdk-bridge]";

// ---------------------------------------------------------------------------
//  OAUTH COMPLIANCE: Environment variable allowlist
//
//  Only these variables are forwarded to Claude Code subprocesses.
//  This prevents inadvertent leakage of OAuth tokens, session cookies,
//  or other credentials that may exist in the Electron main process env.
//  Authentication is handled independently by Claude Code CLI itself.
// ---------------------------------------------------------------------------

const SDK_ENV_ALLOWLIST = [
  // System essentials
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  // XDG directories
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  // Display (needed for any GUI interactions)
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  // Node/Electron
  'NODE_ENV', 'ELECTRON_RUN_AS_NODE',
  // Claude-specific (user-configured, not OAuth)
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_PATH',
  // Debug
  'CLAUDE_COWORK_DEBUG', 'CLAUDE_COWORK_TRACE_IO',
];

// extra is an internal-only object built by this module (never from external
// input), so it is merged without additional filtering. Call sites must not
// pass user-supplied or renderer-supplied data via extra.
function filterEnvForSubprocess(baseEnv, extra) {
  const filtered = {};
  for (const key of SDK_ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) {
      filtered[key] = baseEnv[key];
    }
  }
  if (extra) {
    Object.assign(filtered, extra);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
//  Resolve claude binary
// ---------------------------------------------------------------------------

function resolveClaudeCodeCommand() {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;
  const home = process.env.HOME || os.homedir();
  const candidates = [
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    // Linuxbrew
    "/home/linuxbrew/.linuxbrew/bin/claude",
    path.join(home, ".linuxbrew/bin/claude"),
    // Version managers (mise, asdf)
    path.join(home, ".local/share/mise/shims/claude"),
    path.join(home, ".asdf/shims/claude"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* skip */ }
  }
  return "claude"; // PATH fallback
}

// ---------------------------------------------------------------------------
//  NDJSON stdout parser → Fle-shaped events
// ---------------------------------------------------------------------------

function parseStdoutLine(line, sessionId) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    return trimmed.length > 0 ? { type: "data", sessionId, data: trimmed } : null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const type = parsed.type || "data";

  switch (type) {
    case "init":
    case "system":
      return {
        type: "system", sessionId,
        data: JSON.stringify(parsed),
        ...(parsed.subtype === "init" ? { initializationStatus: "ready" } : {}),
      };

    case "assistant": {
      const message = parsed.message || {
        role: "assistant",
        content: parsed.content || [{ type: "text", text: parsed.text || "" }],
      };
      return { type: "message", sessionId, message };
    }

    case "tool_use":
      return {
        type: "message", sessionId,
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: parsed.id || crypto.randomUUID(),
            name: parsed.name || parsed.tool_name || "unknown",
            input: parsed.input || {},
          }],
        },
      };

    case "tool_result":
      return {
        type: "message", sessionId,
        message: {
          role: "tool",
          content: parsed.content || [{ type: "text", text: parsed.output || parsed.text || "" }],
          tool_use_id: parsed.tool_use_id || parsed.id,
        },
      };

    case "result":
      return { type: "result", sessionId, data: JSON.stringify(parsed) };

    case "error":
      return {
        type: "error", sessionId,
        error: parsed.error || parsed.message || "Unknown error",
        code: parsed.code || undefined,
      };

    default:
      return { type: parsed.type || "data", sessionId, data: JSON.stringify(parsed) };
  }
}

function extractConversationId(raw) {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch (_) { return null; }
  }
  return parsed?.session_id || parsed?.conversation_id || parsed?.conversationId || null;
}

// ---------------------------------------------------------------------------
//  Bridge class
// ---------------------------------------------------------------------------

class CoworkSDKBridge {
  constructor() {
    /** @type {Map<string, SessionState>} */
    this._sessions = new Map();
    this._claudeCmd = resolveClaudeCodeCommand();
    console.log(`${LOG} initialized, claude=${this._claudeCmd}`);
  }

  // ---- Public API (called from ipc-handler-setup.js) ----

  /**
   * Initialize a session. Dispatches system init event via emitFn.
   * If session.info?.message exists, sends the initial message immediately.
   *
   * @param {string} sessionId
   * @param {object} session - Session info (cwd, model, systemPrompt, etc.)
   * @param {function} emitFn - Event dispatcher
   * @param {object} [opts] - Options
   * @param {function} [opts.onConversationId] - Called when CLI conversation ID is captured
   */
  async startSession(sessionId, session, emitFn, opts = {}) {
    console.log(`${LOG} startSession ${sessionId}`);
    const state = {
      transcript: [],
      ccConversationId: session.ccConversationId || null,
      cwd: session.cwd || session.workingDirectory || process.cwd(),
      model: session.model || null,
      systemPrompt: session.systemPrompt || null,
      claudeConfigDir: session.claudeConfigDir || null,
      messageQueue: [],
      isProcessing: false,
      activeProcess: null,
      emitFn,
      onConversationId: opts.onConversationId || null,
    };
    this._sessions.set(sessionId, state);
    if (state.ccConversationId) {
      console.log(`${LOG} restored ccConversationId for ${sessionId}: ${state.ccConversationId}`);
    }

    // Dispatch init events
    emitFn({ type: "system", sessionId, initializationStatus: "initializing" });
    emitFn({ type: "system", sessionId, initializationStatus: "ready" });

    // If there was an initial message in the session start info, send it
    const initialMsg = session.initialMessage || session.info?.message;
    if (initialMsg) {
      await this.sendMessage(sessionId, initialMsg);
    }
  }

  /**
   * Send a message to the session's Claude Code subprocess.
   * Serializes messages (one at a time) via queue.
   * @param {string} sessionId
   * @param {string} message - User's text message
   * @param {Array} [images] - Image attachments from the UI
   * @param {Array} [files] - File attachments from the UI
   */
  async sendMessage(sessionId, message, images, files) {
    const state = this._sessions.get(sessionId);
    if (!state) {
      console.error(`${LOG} sendMessage: no session ${sessionId}`);
      return;
    }

    // Build enriched message that includes file/image context
    const enriched = this._buildEnrichedMessage(message, images, files);
    console.log(`${LOG} sendMessage ${sessionId}: ${enriched.slice(0, 80)}...`);

    // Record user message in transcript
    const userEvent = {
      type: "message", sessionId,
      message: { role: "user", content: [{ type: "text", text: enriched }] },
    };
    state.transcript.push(userEvent);

    // Queue if already processing
    if (state.isProcessing) {
      return new Promise((resolve, reject) => {
        state.messageQueue.push({ message: enriched, resolve, reject });
      });
    }

    state.isProcessing = true;
    try {
      await this._execMessage(sessionId, state, enriched);
    } catch (err) {
      console.error(`${LOG} execMessage error:`, err.message);
      state.emitFn({ type: "error", sessionId, error: err.message });
    } finally {
      // Process next queued message before setting isProcessing = false
      // This prevents concurrent execution of messages for the same session
      if (state.messageQueue.length > 0) {
        const next = state.messageQueue.shift();
        this.sendMessage(sessionId, next.message)
          .then(next.resolve)
          .catch(next.reject);
      } else {
        state.isProcessing = false;
      }
    }
  }

  /**
   * Merge file/image attachments into the message text so Claude Code
   * CLI has full context about what the user sent.
   */
  _buildEnrichedMessage(message, images, files) {
    const parts = [];

    // Attach file references — provide paths so Claude can read them
    if (files && files.length > 0) {
      const fileRefs = files.map((f) => {
        const filePath = f.path || f.filePath || f.name || "(unknown)";
        // Validate file existence (informational only, don't block)
        if (filePath !== "(unknown)" && !fs.existsSync(filePath)) {
          console.warn(`${LOG} Attached file does not exist: ${filePath}`);
        }
        return `  - ${filePath}`;
      });
      parts.push(`[Attached files]\n${fileRefs.join("\n")}`);
    }

    // Attach image references
    if (images && images.length > 0) {
      const imgRefs = images.map((img) => {
        const imgPath = img.path || img.filePath || img.name || "(image)";
        // Validate image existence (informational only, don't block)
        if (imgPath !== "(image)" && !fs.existsSync(imgPath)) {
          console.warn(`${LOG} Attached image does not exist: ${imgPath}`);
        }
        return `  - ${imgPath}`;
      });
      parts.push(`[Attached images]\n${imgRefs.join("\n")}`);
    }

    // User's actual message text
    if (message && message.trim()) {
      parts.push(message);
    }

    // If nothing at all, provide a fallback so the CLI doesn't get empty input
    if (parts.length === 0) {
      return "The user sent an attachment but no message text was captured. Please acknowledge and ask them to describe what they need.";
    }

    return parts.join("\n\n");
  }

  async stopSession(sessionId) {
    const state = this._sessions.get(sessionId);
    if (!state) return;
    console.log(`${LOG} stopSession ${sessionId}`);
    if (state.activeProcess) {
      try { state.activeProcess.kill("SIGTERM"); } catch (_) { /* already dead */ }
      state.activeProcess = null;
    }
  }

  /** Check if the bridge has an active session state for this ID. */
  hasSession(sessionId) {
    return this._sessions.has(sessionId);
  }

  getTranscript(sessionId) {
    const state = this._sessions.get(sessionId);
    if (!state) return [];
    return state.transcript.filter(e => e.type === "message");
  }

  // ---- Per-message execution ----

  _execMessage(sessionId, state, message) {
    return new Promise((resolve, reject) => {
      const args = [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
      ];
      if (state.model) args.push("--model", state.model);
      if (state.systemPrompt) args.push("--system-prompt", state.systemPrompt);
      if (state.ccConversationId) args.push("--resume", state.ccConversationId);

      // OAUTH COMPLIANCE: Only pass allowlisted env vars to subprocess.
      // This prevents OAuth tokens or session credentials in the Electron
      // process env from leaking to Claude Code. Claude Code authenticates
      // independently via its own `claude login` flow.
      const extra = { CLAUDE_CODE_SESSION_ID: sessionId };
      // Point the CLI at the session-specific .claude directory so transcripts
      // (and other per-project data) are written where the asar expects them.
      if (state.claudeConfigDir) {
        extra.CLAUDE_CONFIG_DIR = state.claudeConfigDir;
      }
      const env = filterEnvForSubprocess(process.env, extra);

      console.log(`${LOG} spawn: ${this._claudeCmd} --print - --output-format stream-json${state.ccConversationId ? " --resume " + state.ccConversationId : ""} (${message.length} chars via stdin)`);

      const child = spawn(this._claudeCmd, args, {
        cwd: state.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      state.activeProcess = child;

      // Pipe message via stdin to avoid CLI argument size limits
      child.stdin.write(message);
      child.stdin.end();

      let stdoutBuf = "";
      let resolved = false;

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() || "";

        for (const line of lines) {
          this._processLine(line, sessionId, state);
        }
      });

      child.stderr.on("data", (chunk) => {
        // Log stderr but don't dispatch as error — Claude Code writes progress/debug to stderr
        const text = chunk.toString().trim();
        if (text) console.log(`${LOG} stderr[${sessionId.slice(0, 8)}]: ${text.slice(0, 200)}`);
      });

      child.on("error", (err) => {
        console.error(`${LOG} spawn error:`, err.message);
        state.activeProcess = null;
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      child.on("close", (code, signal) => {
        // Flush remaining buffer
        if (stdoutBuf.trim()) {
          this._processLine(stdoutBuf, sessionId, state);
          stdoutBuf = "";
        }
        state.activeProcess = null;

        console.log(`${LOG} process exited: code=${code} signal=${signal}`);
        state.emitFn({ type: "sessionsUpdated", sessionId });

        if (!resolved) {
          resolved = true;
          if (code !== 0 && code !== null) {
            reject(new Error(`Claude Code exited with code ${code}`));
          } else {
            resolve();
          }
        }
      });
    });
  }

  _processLine(line, sessionId, state) {
    const event = parseStdoutLine(line, sessionId);
    if (!event) return;

    // Capture conversation ID for --resume
    if (!state.ccConversationId && event.data) {
      const ccId = extractConversationId(event.data);
      if (ccId) {
        state.ccConversationId = ccId;
        console.log(`${LOG} captured conversationId: ${ccId}`);
        // Notify caller so it can persist the ID for session resume
        if (typeof state.onConversationId === "function") {
          try { state.onConversationId(sessionId, ccId); } catch (_) { /* non-critical */ }
        }
      }
    }

    // Accumulate structured messages in transcript
    if (event.type === "message") {
      state.transcript.push(event);
    }

    // Dispatch to frontend — renderer recognizes: system, data, result, error, sessionsUpdated
    // Convert "message" to "data" so the frontend doesn't drop it
    if (event.type === "message") {
      state.emitFn({ type: "data", sessionId, data: JSON.stringify(event.message) });
    } else {
      state.emitFn(event);
    }
  }
}

module.exports = { CoworkSDKBridge };

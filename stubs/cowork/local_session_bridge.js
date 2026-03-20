const fs = require('fs');
const path = require('path');

// @session-refactor:NORM-007 DEFINITION — metadata message types to extract and accumulate (not forward as regular messages)
const HANDLED_LIVE_METADATA_MESSAGE_TYPES = new Set([
  'queue-operation',
  'progress',
  'last-prompt',
]);

// @session-refactor:NORM-002 DEFINITION — message types to drop from live events (local_session_bridge.js)
// NOTE: This set differs from NORM-001 (frame-fix-wrapper.js) — this only has rate_limit_event
const IGNORED_LIVE_MESSAGE_TYPES = new Set([
  'rate_limit_event',
]);

const SYNTHETIC_LOCAL_AGENT_MODE_EVENT_CHANNEL = '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_onEvent';

function defaultCloneSerializable(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function createLocalSessionBridge(options) {
  const {
    appSupportRoot,
    claudeLocalAgentConfigRoot,
    xdgDataHome,
    logger = console,
    cloneSerializable = defaultCloneSerializable,
  } = options || {};

  if (typeof claudeLocalAgentConfigRoot !== 'string' || claudeLocalAgentConfigRoot.length === 0) {
    throw new Error('claudeLocalAgentConfigRoot is required');
  }

  const liveAssistantMessageCache = new Map();
  const liveAssistantStreamState = new Map();
  const liveSessionCompatibilityState = new Map();

  function logInfo(...args) {
    if (logger && typeof logger.log === 'function') {
      logger.log(...args);
    }
  }

  function logWarn(...args) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(...args);
    }
  }

  function isLocalSessionMetadataFilePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return false;
    }

    const normalizedPath = path.resolve(filePath);
    if (!normalizedPath.startsWith(claudeLocalAgentConfigRoot + path.sep)) {
      return false;
    }

    return /^local_[^/\\]+\.json$/i.test(path.basename(normalizedPath));
  }

  function listLocalSessionMetadataFiles(rootPath) {
    const pendingPaths = [rootPath];
    const metadataFiles = [];

    while (pendingPaths.length > 0) {
      const currentPath = pendingPaths.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          pendingPaths.push(entryPath);
          continue;
        }
        if (entry.isFile() && isLocalSessionMetadataFilePath(entryPath)) {
          metadataFiles.push(entryPath);
        }
      }
    }

    return metadataFiles;
  }

  function detectJsonIndentation(sourceText) {
    if (typeof sourceText !== 'string') {
      return '  ';
    }
    const indentationMatch = sourceText.match(/^[ \t]+(?=")/m);
    return indentationMatch ? indentationMatch[0] : '  ';
  }

  function sanitizeTranscriptProjectKey(inputPath) {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      return null;
    }
    return inputPath.replace(/[^A-Za-z0-9]/g, '-');
  }

  function getPreferredLocalSessionRoot(sessionData) {
    if (!sessionData || typeof sessionData !== 'object' || !Array.isArray(sessionData.userSelectedFolders)) {
      return null;
    }

    for (const folderPath of sessionData.userSelectedFolders) {
      if (typeof folderPath === 'string' && path.isAbsolute(folderPath)) {
        return path.resolve(folderPath);
      }
    }

    return null;
  }

  function isDesktopRuntimePath(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return false;
    }
    if (typeof xdgDataHome !== 'string' || xdgDataHome.length === 0) {
      return false;
    }
    const normalizedPath = path.resolve(targetPath);
    const desktopRoot = path.join(xdgDataHome, 'claude-desktop');
    return normalizedPath === desktopRoot || normalizedPath.startsWith(desktopRoot + path.sep);
  }

  function isSyntheticSessionCwd(targetPath, sessionData) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return false;
    }

    if (targetPath.startsWith('/sessions/')) {
      return true;
    }

    const processNames = [
      sessionData && typeof sessionData.processName === 'string' ? sessionData.processName : null,
      sessionData && typeof sessionData.vmProcessName === 'string' ? sessionData.vmProcessName : null,
    ].filter(Boolean);

    return processNames.some((processName) => targetPath === path.join('/home', processName));
  }

  function listTranscriptCandidatesForSession(sessionMetadataPath) {
    const sessionDirectory = sessionMetadataPath.replace(/\.json$/i, '');
    const projectsRoot = path.join(sessionDirectory, '.claude', 'projects');
    let projectEntries = [];

    try {
      projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
    } catch (_) {
      return [];
    }

    const candidates = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }

      const projectDirectory = path.join(projectsRoot, projectEntry.name);
      let transcriptEntries = [];
      try {
        transcriptEntries = fs.readdirSync(projectDirectory, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      for (const transcriptEntry of transcriptEntries) {
        if (!transcriptEntry.isFile() || !transcriptEntry.name.endsWith('.jsonl')) {
          continue;
        }

        const transcriptPath = path.join(projectDirectory, transcriptEntry.name);
        let lineCount = 0;
        let stats = null;
        try {
          const transcriptText = fs.readFileSync(transcriptPath, 'utf8');
          const trimmedText = transcriptText.trim();
          lineCount = trimmedText ? trimmedText.split('\n').length : 0;
          stats = fs.statSync(transcriptPath);
        } catch (_) {
          continue;
        }

        candidates.push({
          cliSessionId: path.basename(transcriptEntry.name, '.jsonl'),
          transcriptPath,
          projectKey: projectEntry.name,
          lineCount,
          mtimeMs: stats ? stats.mtimeMs : 0,
        });
      }
    }

    return candidates;
  }

  function chooseBestTranscriptCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    return [...candidates].sort((leftCandidate, rightCandidate) => {
      if (rightCandidate.lineCount !== leftCandidate.lineCount) {
        return rightCandidate.lineCount - leftCandidate.lineCount;
      }
      return rightCandidate.mtimeMs - leftCandidate.mtimeMs;
    })[0] || null;
  }

  function chooseCanonicalTranscriptCandidate(sessionData, sessionMetadataPath) {
    const transcriptCandidates = listTranscriptCandidatesForSession(sessionMetadataPath);
    if (transcriptCandidates.length === 0) {
      return null;
    }

    const preferredRoot = getPreferredLocalSessionRoot(sessionData);
    const preferredProjectKey = preferredRoot ? sanitizeTranscriptProjectKey(preferredRoot) : null;
    const currentCandidate = typeof sessionData.cliSessionId === 'string'
      ? transcriptCandidates.find((candidate) => candidate.cliSessionId === sessionData.cliSessionId) || null
      : null;
    const preferredCandidates = preferredProjectKey
      ? transcriptCandidates.filter((candidate) => candidate.projectKey === preferredProjectKey)
      : [];
    const preferredCandidate = chooseBestTranscriptCandidate(preferredCandidates);

    if (!preferredCandidate) {
      return currentCandidate;
    }
    if (!currentCandidate) {
      return preferredCandidate;
    }
    if (currentCandidate.projectKey === preferredCandidate.projectKey) {
      return currentCandidate.lineCount >= preferredCandidate.lineCount ? currentCandidate : preferredCandidate;
    }

    const currentCwdIsSuspicious = isSyntheticSessionCwd(sessionData.cwd, sessionData)
      || isDesktopRuntimePath(sessionData.cwd);
    const currentProjectIsForeign = currentCandidate.projectKey !== preferredProjectKey;
    if (currentProjectIsForeign && (currentCwdIsSuspicious || preferredCandidate.lineCount >= currentCandidate.lineCount)) {
      return preferredCandidate;
    }

    return currentCandidate;
  }

  // @session-refactor:NORM-025 DEFINITION — repair session metadata (DUPLICATE of NORM-021 but with different return signature)
  // NOTE: This is logically identical to session_store.js normalizeSessionRecordForMetadataPath (NORM-021)
  // but returns {changed, value, reason} instead of just the value
  function repairLocalSessionMetadataData(sessionData, sessionMetadataPath) {
    if (!sessionData || typeof sessionData !== 'object' || Array.isArray(sessionData)) {
      return { changed: false, value: sessionData, reason: null };
    }

    const repairedSessionData = { ...sessionData };
    let changed = false;
    const changeReasons = [];

    const preferredRoot = getPreferredLocalSessionRoot(repairedSessionData);
    if (preferredRoot && typeof repairedSessionData.cwd === 'string') {
      const normalizedCwd = path.resolve(repairedSessionData.cwd);
      if (normalizedCwd !== preferredRoot && (isSyntheticSessionCwd(repairedSessionData.cwd, repairedSessionData) || isDesktopRuntimePath(repairedSessionData.cwd))) {
        repairedSessionData.cwd = preferredRoot;
        changed = true;
        changeReasons.push(`cwd -> ${preferredRoot}`);
      }
    }

    const canonicalCandidate = chooseCanonicalTranscriptCandidate(repairedSessionData, sessionMetadataPath);
    if (canonicalCandidate && canonicalCandidate.cliSessionId !== repairedSessionData.cliSessionId) {
      repairedSessionData.cliSessionId = canonicalCandidate.cliSessionId;
      changed = true;
      changeReasons.push(`cliSessionId -> ${canonicalCandidate.cliSessionId}`);
    }

    return {
      changed,
      value: repairedSessionData,
      reason: changeReasons.length > 0 ? changeReasons.join(', ') : null,
    };
  }

  // @session-refactor:NORM-084 DEFINITION — normalize serialized metadata (DUPLICATE of NORM-080 with logging)
  function normalizeLocalSessionMetadataSerialized(filePath, serializedValue) {
    if (!isLocalSessionMetadataFilePath(filePath) || typeof serializedValue !== 'string' || !serializedValue.trim()) {
      return serializedValue;
    }

    try {
      const parsedValue = JSON.parse(serializedValue);
      // @session-refactor:NORM-025 CALLER — repair session metadata
      const repaired = repairLocalSessionMetadataData(parsedValue, path.resolve(filePath));
      if (!repaired.changed) {
        return serializedValue;
      }

      const indent = detectJsonIndentation(serializedValue);
      const hasTrailingNewline = serializedValue.endsWith('\n');
      const normalizedSerializedValue = JSON.stringify(repaired.value, null, indent) + (hasTrailingNewline ? '\n' : '');
      logInfo('[Cowork] Repaired local session metadata during write:', path.resolve(filePath), repaired.reason);
      return normalizedSerializedValue;
    } catch (_) {
      return serializedValue;
    }
  }

  // @session-refactor:NORM-085 DEFINITION — normalize write value (DUPLICATE of NORM-081)
  function normalizeLocalSessionMetadataWriteValue(filePath, value) {
    if (typeof value === 'string') {
      // @session-refactor:NORM-084 CALLER — normalize JSON string
      return normalizeLocalSessionMetadataSerialized(filePath, value);
    }

    if (Buffer.isBuffer(value)) {
      // @session-refactor:NORM-084 CALLER — normalize JSON string from buffer
      const normalizedString = normalizeLocalSessionMetadataSerialized(filePath, value.toString('utf8'));
      return normalizedString === value.toString('utf8')
        ? value
        : Buffer.from(normalizedString, 'utf8');
    }

    return value;
  }

  // @session-refactor:NORM-086 DEFINITION — install fs.writeFile* patches (DUPLICATE of NORM-082 with extra reentrancy guard)
  function installMetadataPersistenceGuard() {
    if (global.__coworkLocalSessionMetadataPersistenceGuardInstalled) {
      return;
    }
    global.__coworkLocalSessionMetadataPersistenceGuardInstalled = true;

    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalWriteFile = fs.writeFile.bind(fs);
    const originalPromisesWriteFile = fs.promises && typeof fs.promises.writeFile === 'function'
      ? fs.promises.writeFile.bind(fs.promises)
      : null;

    const writeRepairedSessionMetadata = (filePath, normalizedValue) => {
      if (global.__coworkLocalSessionMetadataRepairWriteActive) {
        return;
      }
      global.__coworkLocalSessionMetadataRepairWriteActive = true;
      try {
        originalWriteFileSync(filePath, normalizedValue, 'utf8');
      } catch (error) {
        logWarn('[Cowork] Failed to persist repaired local session metadata:', filePath, error && error.message ? error.message : error);
      } finally {
        global.__coworkLocalSessionMetadataRepairWriteActive = false;
      }
    };

    fs.writeFileSync = function(filePath, value, ...rest) {
      // @session-refactor:NORM-085 CALLER — normalize value before writing
      const normalizedValue = normalizeLocalSessionMetadataWriteValue(filePath, value);
      return originalWriteFileSync(filePath, normalizedValue, ...rest);
    };

    fs.writeFile = function(filePath, value, options, callback) {
      // @session-refactor:NORM-085 CALLER — normalize value before writing
      const normalizedValue = normalizeLocalSessionMetadataWriteValue(filePath, value);
      return originalWriteFile(filePath, normalizedValue, options, callback);
    };

    if (originalPromisesWriteFile) {
      fs.promises.writeFile = function(filePath, value, options) {
        // @session-refactor:NORM-085 CALLER — normalize value before writing
        const normalizedValue = normalizeLocalSessionMetadataWriteValue(filePath, value);
        return originalPromisesWriteFile(filePath, normalizedValue, options);
      };
    }

    // @session-refactor:NORM-087 — repair all existing session metadata files on startup
    for (const metadataPath of listLocalSessionMetadataFiles(claudeLocalAgentConfigRoot)) {
      let serializedValue;
      try {
        serializedValue = fs.readFileSync(metadataPath, 'utf8');
      } catch (_) {
        continue;
      }

      // @session-refactor:NORM-084 CALLER — normalize existing metadata
      const normalizedValue = normalizeLocalSessionMetadataSerialized(metadataPath, serializedValue);
      if (normalizedValue !== serializedValue) {
        writeRepairedSessionMetadata(metadataPath, normalizedValue);
      }
    }

    logInfo('[Cowork] Local session metadata persistence guard installed');
  }

  function isLocalSessionEventChannel(channel) {
    return typeof channel === 'string' && (
      channel.includes('LocalAgentModeSessions_$_onEvent') ||
      channel.includes('LocalSessions_$_onEvent')
    );
  }

  function getLocalSessionEventSessionId(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (typeof payload.sessionId === 'string') {
      return payload.sessionId;
    }
    if (typeof payload.session_id === 'string') {
      return payload.session_id;
    }

    if (payload.message && typeof payload.message === 'object') {
      if (typeof payload.message.sessionId === 'string') {
        return payload.message.sessionId;
      }
      if (typeof payload.message.session_id === 'string') {
        return payload.message.session_id;
      }
    }

    return null;
  }

  function shouldNormalizeEventEmitterPayload(eventName, payload) {
    if (eventName !== 'event' || !payload || typeof payload !== 'object') {
      return false;
    }

    const sessionId = getLocalSessionEventSessionId(payload);
    if (typeof sessionId !== 'string' || !sessionId.startsWith('local_')) {
      return false;
    }

    if (payload.type === 'message' && payload.message && typeof payload.message === 'object') {
      return true;
    }

    if (payload.type === 'transcript_loaded' && Array.isArray(payload.messages)) {
      return true;
    }

    return typeof payload.type === 'string';
  }

  function isAssistantSdkMessage(message) {
    return !!(
      message &&
      typeof message === 'object' &&
      message.type === 'assistant' &&
      message.message &&
      typeof message.message === 'object' &&
      message.message.type === 'message' &&
      message.message.role === 'assistant' &&
      Array.isArray(message.message.content)
    );
  }

  function cloneMessageContent(content) {
    if (!Array.isArray(content)) {
      return [];
    }
    return content.map((block) => {
      if (!block || typeof block !== 'object') {
        return block;
      }
      const clonedBlock = { ...block };
      delete clonedBlock.__coworkPartialJson;
      return clonedBlock;
    });
  }

  function cloneAssistantSdkMessage(message) {
    if (!isAssistantSdkMessage(message)) {
      return null;
    }

    return {
      ...message,
      message: {
        ...message.message,
        content: cloneMessageContent(message.message.content),
      },
    };
  }

  function mergeStreamingText(previousValue, nextValue) {
    if (typeof previousValue !== 'string' || !previousValue) {
      return typeof nextValue === 'string' ? nextValue : previousValue;
    }
    if (typeof nextValue !== 'string' || !nextValue) {
      return previousValue;
    }
    if (nextValue.startsWith(previousValue)) {
      return nextValue;
    }
    if (previousValue.startsWith(nextValue) || previousValue.endsWith(nextValue)) {
      return previousValue;
    }
    return previousValue + nextValue;
  }

  function findMergeableAssistantBlockIndex(previousBlocks, nextBlock, fallbackIndex) {
    if (!Array.isArray(previousBlocks) || !nextBlock || typeof nextBlock !== 'object') {
      return -1;
    }

    if (nextBlock.id) {
      const byIdIndex = previousBlocks.findIndex((block) => block && typeof block === 'object' && block.id === nextBlock.id);
      if (byIdIndex !== -1) {
        return byIdIndex;
      }
    }

    const fallbackBlock = previousBlocks[fallbackIndex];
    if (fallbackBlock && typeof fallbackBlock === 'object' && fallbackBlock.type === nextBlock.type) {
      return fallbackIndex;
    }

    return -1;
  }

  // @session-refactor:NORM-044 DEFINITION — merge individual content blocks (text, thinking, tool_use, tool_result)
  function mergeAssistantContentBlock(previousBlock, nextBlock) {
    if (!previousBlock || typeof previousBlock !== 'object') {
      return nextBlock && typeof nextBlock === 'object' ? { ...nextBlock } : nextBlock;
    }
    if (!nextBlock || typeof nextBlock !== 'object') {
      return { ...previousBlock };
    }
    if (previousBlock.type !== nextBlock.type) {
      return { ...nextBlock };
    }

    const mergedBlock = {
      ...previousBlock,
      ...nextBlock,
    };

    if (mergedBlock.type === 'text') {
      mergedBlock.text = mergeStreamingText(previousBlock.text, nextBlock.text);
      if (Array.isArray(previousBlock.citations) || Array.isArray(nextBlock.citations)) {
        mergedBlock.citations = [
          ...(Array.isArray(previousBlock.citations) ? previousBlock.citations : []),
          ...(Array.isArray(nextBlock.citations) ? nextBlock.citations : []),
        ];
      }
    } else if (mergedBlock.type === 'thinking') {
      mergedBlock.thinking = mergeStreamingText(previousBlock.thinking, nextBlock.thinking);
      mergedBlock.signature = nextBlock.signature || previousBlock.signature || '';
    } else if (mergedBlock.type === 'tool_use') {
      if (previousBlock.input && nextBlock.input && typeof previousBlock.input === 'object' && typeof nextBlock.input === 'object') {
        mergedBlock.input = {
          ...previousBlock.input,
          ...nextBlock.input,
        };
      } else if (nextBlock.input === undefined) {
        mergedBlock.input = previousBlock.input;
      }
    } else if (mergedBlock.type === 'tool_result') {
      if (Array.isArray(previousBlock.content) || Array.isArray(nextBlock.content)) {
        mergedBlock.content = [
          ...(Array.isArray(previousBlock.content) ? previousBlock.content : []),
          ...(Array.isArray(nextBlock.content) ? nextBlock.content : []),
        ];
      }
    }

    if ('__coworkPartialJson' in previousBlock || '__coworkPartialJson' in nextBlock) {
      mergedBlock.__coworkPartialJson = mergeStreamingText(previousBlock.__coworkPartialJson, nextBlock.__coworkPartialJson);
    }

    return mergedBlock;
  }

  // @session-refactor:NORM-043 DEFINITION — merge assistant content blocks by ID or fallback index
  function mergeAssistantContent(previousContent, nextContent) {
    const mergedContent = cloneMessageContent(previousContent);
    const normalizedNextContent = cloneMessageContent(nextContent);

    for (let index = 0; index < normalizedNextContent.length; index += 1) {
      const nextBlock = normalizedNextContent[index];
      if (!nextBlock || typeof nextBlock !== 'object') {
        mergedContent.push(nextBlock);
        continue;
      }

      const targetIndex = findMergeableAssistantBlockIndex(mergedContent, nextBlock, index);
      if (targetIndex === -1) {
        mergedContent.push({ ...nextBlock });
        continue;
      }

      // @session-refactor:NORM-044 CALLER — merge individual content blocks
      mergedContent[targetIndex] = mergeAssistantContentBlock(mergedContent[targetIndex], nextBlock);
    }

    return mergedContent;
  }

  // @session-refactor:NORM-042 DEFINITION — merge two assistant messages if they have the same ID
  function mergeAssistantSdkMessages(previousMessage, nextMessage) {
    if (!isAssistantSdkMessage(previousMessage) || !isAssistantSdkMessage(nextMessage)) {
      return null;
    }

    const previousId = previousMessage.message && previousMessage.message.id;
    const nextId = nextMessage.message && nextMessage.message.id;
    if (!previousId || !nextId || previousId !== nextId) {
      return null;
    }

    return {
      ...previousMessage,
      ...nextMessage,
      uuid: previousMessage.uuid || nextMessage.uuid,
      session_id: previousMessage.session_id || nextMessage.session_id,
      parent_tool_use_id: previousMessage.parent_tool_use_id ?? nextMessage.parent_tool_use_id ?? null,
      message: {
        ...previousMessage.message,
        ...nextMessage.message,
        // @session-refactor:NORM-043 CALLER — merge content blocks
        content: mergeAssistantContent(previousMessage.message.content, nextMessage.message.content),
      },
    };
  }

  // @session-refactor:NORM-061 DEFINITION — get or create coworkCompatibilityState for session
  function getOrCreateLiveSessionCompatibilityState(sessionId) {
    if (!liveSessionCompatibilityState.has(sessionId)) {
      liveSessionCompatibilityState.set(sessionId, {
        queueOperations: [],
        queueSize: null,
        progress: null,
        lastPrompt: null,
        updatedAt: 0,
      });
    }
    return liveSessionCompatibilityState.get(sessionId);
  }

  function cloneLiveSessionCompatibilityState(sessionId) {
    const state = liveSessionCompatibilityState.get(sessionId);
    if (!state) {
      return null;
    }

    return {
      queueOperations: cloneSerializable(state.queueOperations),
      queueSize: state.queueSize,
      progress: cloneSerializable(state.progress),
      lastPrompt: cloneSerializable(state.lastPrompt),
      updatedAt: state.updatedAt,
    };
  }

  function extractQueueOperationIdentity(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const candidate = value.id ?? value.operation_id ?? value.request_id ?? value.uuid ?? value.name ?? null;
    return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : null;
  }

  function mergeQueueOperationState(state, queuePayload) {
    if (!state || !queuePayload || typeof queuePayload !== 'object') {
      return false;
    }

    const rawPayload = cloneSerializable(queuePayload);
    if (Array.isArray(rawPayload.operations)) {
      state.queueOperations = rawPayload.operations.map((entry) => cloneSerializable(entry));
      state.queueSize = state.queueOperations.length;
      return true;
    }

    const operation = rawPayload.operation && typeof rawPayload.operation === 'object'
      ? cloneSerializable(rawPayload.operation)
      : rawPayload;
    const operationId = extractQueueOperationIdentity(operation);
    const action = String(operation.action ?? operation.subtype ?? operation.operation ?? '').toLowerCase();
    if (action.includes('remove') || action.includes('dequeue') || action.includes('complete') || action.includes('finish')) {
      if (operationId) {
        state.queueOperations = state.queueOperations.filter((entry) => extractQueueOperationIdentity(entry) !== operationId);
      } else if (state.queueOperations.length > 0) {
        state.queueOperations = state.queueOperations.slice(1);
      }
    } else if (operationId) {
      const existingIndex = state.queueOperations.findIndex((entry) => extractQueueOperationIdentity(entry) === operationId);
      if (existingIndex >= 0) {
        state.queueOperations[existingIndex] = operation;
      } else {
        state.queueOperations.push(operation);
      }
    } else {
      state.queueOperations.push(operation);
    }

    const queueSize = rawPayload.queue_size ?? rawPayload.size ?? rawPayload.pending ?? null;
    state.queueSize = typeof queueSize === 'number' ? queueSize : state.queueOperations.length;
    return true;
  }

  // @session-refactor:NORM-060 DEFINITION — accumulate metadata messages into coworkCompatibilityState
  function applyLiveSessionMetadataMessage(sessionId, sdkMessage) {
    if (typeof sessionId !== 'string' || !sdkMessage || typeof sdkMessage !== 'object') {
      return false;
    }

    const messageType = sdkMessage.type;
    // @session-refactor:NORM-007 CALLER — check if message type is handled metadata
    if (!HANDLED_LIVE_METADATA_MESSAGE_TYPES.has(messageType)) {
      return false;
    }

    // @session-refactor:NORM-061 CALLER — get or create compatibility state
    const state = getOrCreateLiveSessionCompatibilityState(sessionId);
    let updated = false;

    if (messageType === 'queue-operation') {
      updated = mergeQueueOperationState(state, sdkMessage);
    } else if (messageType === 'progress') {
      state.progress = {
        current: typeof sdkMessage.current === 'number' ? sdkMessage.current : (typeof sdkMessage.completed === 'number' ? sdkMessage.completed : null),
        total: typeof sdkMessage.total === 'number' ? sdkMessage.total : (typeof sdkMessage.max === 'number' ? sdkMessage.max : null),
        phase: typeof sdkMessage.phase === 'string' ? sdkMessage.phase : (typeof sdkMessage.status === 'string' ? sdkMessage.status : null),
        raw: cloneSerializable(sdkMessage),
      };
      updated = true;
    } else if (messageType === 'last-prompt') {
      const promptValue = sdkMessage.prompt ?? sdkMessage.last_prompt ?? sdkMessage.text ?? sdkMessage.value ?? sdkMessage.message ?? null;
      state.lastPrompt = {
        text: typeof promptValue === 'string' ? promptValue : null,
        raw: cloneSerializable(sdkMessage),
      };
      updated = true;
    }

    if (updated) {
      state.updatedAt = Date.now();
    }
    return updated;
  }

  function finalizeLiveSessionCompatibilityState(sessionId) {
    const state = liveSessionCompatibilityState.get(sessionId);
    if (!state) {
      return;
    }
    if (state.progress && typeof state.progress === 'object' && !state.progress.phase) {
      state.progress = {
        ...state.progress,
        phase: 'completed',
      };
    }
    state.queueOperations = [];
    state.queueSize = 0;
    state.updatedAt = Date.now();
  }

  // @session-refactor:NORM-064 DEFINITION — attach accumulated metadata state to payload
  function attachLiveSessionCompatibilityState(sessionId, payload) {
    const compatibilityState = cloneLiveSessionCompatibilityState(sessionId);
    if (!compatibilityState || !payload || typeof payload !== 'object') {
      return payload;
    }
    return {
      ...payload,
      coworkCompatibilityState: compatibilityState,
    };
  }

  function clearLiveAssistantSessionState(sessionId) {
    liveAssistantMessageCache.delete(sessionId);
    liveAssistantStreamState.delete(sessionId);
    liveSessionCompatibilityState.delete(sessionId);
  }

  function tryParsePartialJson(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return undefined;
    }
    try {
      return JSON.parse(value);
    } catch (_) {
      return undefined;
    }
  }

  // @session-refactor:NORM-045 DEFINITION — build synthetic assistant message from stream_event
  function buildSyntheticAssistantPayloadFromStreamEvent(sessionId, streamMessage) {
    if (!streamMessage || typeof streamMessage !== 'object' || streamMessage.type !== 'stream_event') {
      return null;
    }

    const streamEvent = streamMessage.event;
    if (!streamEvent || typeof streamEvent !== 'object') {
      return null;
    }

    let currentAssistantMessage = liveAssistantStreamState.get(sessionId) || null;

    if (streamEvent.type === 'message_start') {
      const startingMessage = streamEvent.message;
      if (!startingMessage || startingMessage.role !== 'assistant') {
        return null;
      }

      currentAssistantMessage = {
        type: 'assistant',
        uuid: streamMessage.uuid || null,
        session_id: streamMessage.session_id || null,
        parent_tool_use_id: streamMessage.parent_tool_use_id ?? null,
        message: {
          ...startingMessage,
          content: cloneMessageContent(startingMessage.content),
        },
      };
      liveAssistantStreamState.set(sessionId, currentAssistantMessage);
      return cloneAssistantSdkMessage(currentAssistantMessage);
    }

    if (!isAssistantSdkMessage(currentAssistantMessage)) {
      return null;
    }

    currentAssistantMessage = {
      ...currentAssistantMessage,
      uuid: currentAssistantMessage.uuid || streamMessage.uuid || null,
      session_id: currentAssistantMessage.session_id || streamMessage.session_id || null,
      parent_tool_use_id: currentAssistantMessage.parent_tool_use_id ?? streamMessage.parent_tool_use_id ?? null,
      message: {
        ...currentAssistantMessage.message,
        content: cloneMessageContent(currentAssistantMessage.message.content),
      },
    };

    const currentContent = currentAssistantMessage.message.content;

    if (streamEvent.type === 'content_block_start') {
      currentContent[streamEvent.index] = streamEvent.content_block && typeof streamEvent.content_block === 'object'
        ? { ...streamEvent.content_block }
        : streamEvent.content_block;
    } else if (streamEvent.type === 'content_block_delta') {
      const currentBlock = currentContent[streamEvent.index];
      if (!currentBlock || typeof currentBlock !== 'object') {
        return null;
      }

      if (streamEvent.delta && streamEvent.delta.type === 'text_delta' && currentBlock.type === 'text') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          text: mergeStreamingText(currentBlock.text, streamEvent.delta.text),
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'thinking_delta' && currentBlock.type === 'thinking') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          thinking: mergeStreamingText(currentBlock.thinking, streamEvent.delta.thinking),
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'signature_delta' && currentBlock.type === 'thinking') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          signature: streamEvent.delta.signature || currentBlock.signature || '',
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
        const partialJson = mergeStreamingText(currentBlock.__coworkPartialJson, streamEvent.delta.partial_json);
        const parsedInput = tryParsePartialJson(partialJson);
        currentContent[streamEvent.index] = {
          ...currentBlock,
          __coworkPartialJson: partialJson,
          ...(parsedInput !== undefined ? { input: parsedInput } : {}),
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'citations_delta' && currentBlock.type === 'text') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          citations: [
            ...(Array.isArray(currentBlock.citations) ? currentBlock.citations : []),
            streamEvent.delta.citation,
          ],
        };
      }
    } else if (streamEvent.type === 'message_delta') {
      currentAssistantMessage.message = {
        ...currentAssistantMessage.message,
        stop_reason: streamEvent.delta ? streamEvent.delta.stop_reason : currentAssistantMessage.message.stop_reason,
        stop_sequence: streamEvent.delta ? streamEvent.delta.stop_sequence : currentAssistantMessage.message.stop_sequence,
        context_management: streamEvent.context_management ?? currentAssistantMessage.message.context_management,
        usage: {
          ...(currentAssistantMessage.message.usage || {}),
          ...(streamEvent.usage || {}),
        },
      };
    } else if (streamEvent.type !== 'content_block_stop' && streamEvent.type !== 'message_stop') {
      return null;
    }

    liveAssistantStreamState.set(sessionId, currentAssistantMessage);
    return cloneAssistantSdkMessage(currentAssistantMessage);
  }

  // @session-refactor:NORM-041 DEFINITION — merge consecutive assistant messages by message ID
  function mergeConsecutiveAssistantMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages;
    }

    const mergedMessages = [];
    for (const message of messages) {
      const previousMessage = mergedMessages[mergedMessages.length - 1];
      // @session-refactor:NORM-042 CALLER — merge two assistant messages if same ID
      const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, message);
      if (mergedAssistantMessage) {
        mergedMessages[mergedMessages.length - 1] = mergedAssistantMessage;
        continue;
      }
      mergedMessages.push(message);
    }
    return mergedMessages;
  }

  function getSdkMessageSessionId(message) {
    if (!message || typeof message !== 'object') {
      return null;
    }

    if (typeof message.sessionId === 'string') {
      return message.sessionId;
    }
    if (typeof message.session_id === 'string') {
      return message.session_id;
    }

    if (message.message && typeof message.message === 'object') {
      if (typeof message.message.sessionId === 'string') {
        return message.message.sessionId;
      }
      if (typeof message.message.session_id === 'string') {
        return message.message.session_id;
      }
    }

    return null;
  }

  function inferLocalSessionIdFromMessages(messages) {
    if (!Array.isArray(messages)) {
      return null;
    }

    for (const message of messages) {
      const sessionId = getSdkMessageSessionId(message);
      if (typeof sessionId === 'string' && sessionId.startsWith('local_')) {
        return sessionId;
      }
    }

    return null;
  }

  // @session-refactor:NORM-040 DEFINITION — normalize SDK message list (filter, extract metadata, merge assistant messages)
  function normalizeSdkMessageList(messages, sessionIdOverride) {
    if (!Array.isArray(messages)) {
      return messages;
    }

    const sessionId = typeof sessionIdOverride === 'string' && sessionIdOverride.startsWith('local_')
      ? sessionIdOverride
      : inferLocalSessionIdFromMessages(messages);
    const normalizedMessages = [];

    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }

      // @session-refactor:NORM-007 CALLER — check if message is handled metadata type
      if (HANDLED_LIVE_METADATA_MESSAGE_TYPES.has(message.type)) {
        if (sessionId) {
          // @session-refactor:NORM-060 CALLER — accumulate metadata into coworkCompatibilityState
          applyLiveSessionMetadataMessage(sessionId, message);
        }
        continue;
      }
      // @session-refactor:NORM-002 CALLER — check if message should be dropped
      if (IGNORED_LIVE_MESSAGE_TYPES.has(message.type)) {
        continue;
      }

      if (message.type === 'message' && message.message && typeof message.message === 'object') {
        // @session-refactor:NORM-007 CALLER — check if nested message is handled metadata type
        if (HANDLED_LIVE_METADATA_MESSAGE_TYPES.has(message.message.type)) {
          if (sessionId) {
            // @session-refactor:NORM-060 CALLER — accumulate metadata into coworkCompatibilityState
            applyLiveSessionMetadataMessage(sessionId, message.message);
          }
          continue;
        }
        // @session-refactor:NORM-002 CALLER — check if nested message should be dropped
        if (IGNORED_LIVE_MESSAGE_TYPES.has(message.message.type)) {
          continue;
        }
      }

      normalizedMessages.push(message);
    }

    // @session-refactor:NORM-041 CALLER — merge consecutive assistant messages
    return mergeConsecutiveAssistantMessages(normalizedMessages);
  }

  // @session-refactor:NORM-046 DEFINITION — normalize IPC session record (attach metadata, normalize messages)
  function normalizeIpcSessionRecord(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return result;
    }

    const sessionId = (
      typeof result.sessionId === 'string' ? result.sessionId
      : (typeof result.session_id === 'string' ? result.session_id : null)
    );
    if (typeof sessionId !== 'string' || !sessionId.startsWith('local_')) {
      return result;
    }

    const normalizedResult = { ...result };

    if (Array.isArray(result.bufferedMessages)) {
      // @session-refactor:NORM-040 CALLER — normalize bufferedMessages
      normalizedResult.bufferedMessages = normalizeSdkMessageList(result.bufferedMessages, sessionId);
    }

    if (Array.isArray(result.messages)) {
      // @session-refactor:NORM-040 CALLER — normalize messages
      normalizedResult.messages = normalizeSdkMessageList(result.messages, sessionId);
    }

    const compatibilityState = cloneLiveSessionCompatibilityState(sessionId);
    if (compatibilityState) {
      // @session-refactor:NORM-062 — attach accumulated metadata state
      normalizedResult.coworkCompatibilityState = compatibilityState;
    }

    return normalizedResult;
  }

  // @session-refactor:NORM-047 DEFINITION — normalize IPC result by channel (getTranscript, getSession, getAll)
  function normalizeLocalSessionIpcResult(channel, result) {
    if (typeof channel !== 'string') {
      return result;
    }
    if (!channel.includes('LocalAgentModeSessions_$_') && !channel.includes('LocalSessions_$_')) {
      return result;
    }

    if (channel.includes('getTranscript')) {
      if (Array.isArray(result)) {
        // @session-refactor:NORM-040 CALLER — normalize transcript message array
        return normalizeSdkMessageList(result, null);
      }
      if (result && typeof result === 'object' && Array.isArray(result.messages)) {
        // @session-refactor:NORM-046 CALLER — normalize transcript session record
        return normalizeIpcSessionRecord(result);
      }
      return result;
    }

    if (channel.includes('getSession')) {
      // @session-refactor:NORM-046 CALLER — normalize single session record
      return normalizeIpcSessionRecord(result);
    }

    if (channel.includes('getAll') && Array.isArray(result)) {
      // @session-refactor:NORM-046 CALLER — normalize array of session records
      return result.map((entry) => normalizeIpcSessionRecord(entry));
    }

    return result;
  }

  // @session-refactor:NORM-063 DEFINITION — normalize live session event payloads (dispatch, metadata extraction, message merging)
  function normalizeLiveSessionPayloads(channel, payload) {
    if (!isLocalSessionEventChannel(channel) || !payload || typeof payload !== 'object') {
      return [payload];
    }

    const sessionId = getLocalSessionEventSessionId(payload);
    if (!sessionId) {
      return [payload];
    }

    if (payload.type === 'start' || payload.type === 'close' || payload.type === 'stopped' || payload.type === 'deleted') {
      clearLiveAssistantSessionState(sessionId);
      return [payload];
    }

    // @session-refactor:NORM-007 CALLER — check if payload is handled metadata type
    if (HANDLED_LIVE_METADATA_MESSAGE_TYPES.has(payload.type)) {
      // @session-refactor:NORM-060 CALLER — accumulate metadata, don't dispatch
      applyLiveSessionMetadataMessage(sessionId, payload);
      return [];
    }

    if (payload.type === 'transcript_loaded' && Array.isArray(payload.messages)) {
      const normalizedMessages = [];
      for (const message of payload.messages) {
        // @session-refactor:NORM-007 CALLER — check if message is handled metadata type
        if (message && typeof message === 'object' && HANDLED_LIVE_METADATA_MESSAGE_TYPES.has(message.type)) {
          // @session-refactor:NORM-060 CALLER — accumulate metadata
          applyLiveSessionMetadataMessage(sessionId, message);
          continue;
        }
        // @session-refactor:NORM-002 CALLER — check if message should be dropped
        if (message && typeof message === 'object' && IGNORED_LIVE_MESSAGE_TYPES.has(message.type)) {
          continue;
        }
        normalizedMessages.push(message);
      }
      // @session-refactor:NORM-064 CALLER — attach metadata state to payload
      return [attachLiveSessionCompatibilityState(sessionId, {
        ...payload,
        // @session-refactor:NORM-041 CALLER — merge consecutive assistant messages
        messages: mergeConsecutiveAssistantMessages(normalizedMessages),
      })];
    }

    if (payload.type !== 'message' || !payload.message || typeof payload.message !== 'object') {
      // @session-refactor:NORM-064 CALLER — attach metadata state to payload
      return [attachLiveSessionCompatibilityState(sessionId, payload)];
    }

    // @session-refactor:NORM-007 CALLER — check if nested message is handled metadata type
    if (HANDLED_LIVE_METADATA_MESSAGE_TYPES.has(payload.message.type)) {
      // @session-refactor:NORM-060 CALLER — accumulate metadata, don't dispatch
      applyLiveSessionMetadataMessage(sessionId, payload.message);
      return [];
    }

    if (payload.message.type === 'result') {
      liveAssistantStreamState.delete(sessionId);
      finalizeLiveSessionCompatibilityState(sessionId);
      // @session-refactor:NORM-064 CALLER — attach metadata state to payload
      return [attachLiveSessionCompatibilityState(sessionId, payload)];
    }

    if (payload.message.type === 'stream_event') {
      // @session-refactor:NORM-045 CALLER — build synthetic assistant message
      const syntheticAssistantMessage = buildSyntheticAssistantPayloadFromStreamEvent(sessionId, payload.message);
      if (!syntheticAssistantMessage) {
        // @session-refactor:NORM-064 CALLER — attach metadata state to payload
        return [attachLiveSessionCompatibilityState(sessionId, payload)];
      }

      const previousMessage = liveAssistantMessageCache.get(sessionId);
      // @session-refactor:NORM-042 CALLER — merge with cached assistant message
      const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, syntheticAssistantMessage) || syntheticAssistantMessage;
      liveAssistantMessageCache.set(sessionId, mergedAssistantMessage);

      // @session-refactor:NORM-064 CALLER — attach metadata state to both payloads
      return [
        attachLiveSessionCompatibilityState(sessionId, payload),
        attachLiveSessionCompatibilityState(sessionId, {
          ...payload,
          message: mergedAssistantMessage,
        }),
      ];
    }

    if (!isAssistantSdkMessage(payload.message)) {
      // @session-refactor:NORM-064 CALLER — attach metadata state to payload
      return [attachLiveSessionCompatibilityState(sessionId, payload)];
    }

    const previousMessage = liveAssistantMessageCache.get(sessionId);
    if (previousMessage) {
      // @session-refactor:NORM-042 CALLER — merge with cached assistant message
      const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, payload.message);
      if (mergedAssistantMessage) {
        liveAssistantMessageCache.set(sessionId, mergedAssistantMessage);
        // @session-refactor:NORM-064 CALLER — attach metadata state to payload
        return [attachLiveSessionCompatibilityState(sessionId, {
          ...payload,
          message: mergedAssistantMessage,
        })];
      }
    }

    liveAssistantMessageCache.set(sessionId, payload.message);
    // @session-refactor:NORM-064 CALLER — attach metadata state to payload
    return [attachLiveSessionCompatibilityState(sessionId, payload)];
  }

  // @session-refactor:NORM-008 DEFINITION — check if live event should be dropped (DUPLICATE of NORM-003)
  // NOTE: Same logic as frame-fix-wrapper.js getIgnoredLiveMessageType (NORM-003) but uses NORM-002 set
  function getIgnoredLiveMessageType(channel, payload) {
    if (!isLocalSessionEventChannel(channel)) {
      return null;
    }
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (payload.type === 'message' && payload.message && typeof payload.message === 'object') {
      const messageType = payload.message.type;
      // @session-refactor:NORM-002 CALLER — uses IGNORED_LIVE_MESSAGE_TYPES from local_session_bridge.js
      return IGNORED_LIVE_MESSAGE_TYPES.has(messageType) ? messageType : null;
    }

    // @session-refactor:NORM-002 CALLER — uses IGNORED_LIVE_MESSAGE_TYPES from local_session_bridge.js
    return IGNORED_LIVE_MESSAGE_TYPES.has(payload.type) ? payload.type : null;
  }

  // @session-refactor:NORM-007 DEFINITION — export surface for HANDLED_LIVE_METADATA_MESSAGE_TYPES
  // @session-refactor:NORM-002 DEFINITION — export surface for IGNORED_LIVE_MESSAGE_TYPES
  // @session-refactor:NORM-025 DEFINITION — export surface for repairLocalSessionMetadataData
  // @session-refactor:NORM-084 DEFINITION — export surface for normalizeLocalSessionMetadataSerialized
  // @session-refactor:NORM-086 DEFINITION — export surface for installMetadataPersistenceGuard
  // @session-refactor:NORM-063 DEFINITION — export surface for normalizeLiveSessionPayloads
  // @session-refactor:NORM-047 DEFINITION — export surface for normalizeLocalSessionIpcResult
  // @session-refactor:NORM-008 DEFINITION — export surface for getIgnoredLiveMessageType
  // @session-refactor:NORM-041 DEFINITION — export surface for mergeConsecutiveAssistantMessages
  return {
    appSupportRoot,
    claudeLocalAgentConfigRoot,
    SYNTHETIC_LOCAL_AGENT_MODE_EVENT_CHANNEL,
    HANDLED_LIVE_METADATA_MESSAGE_TYPES,
    IGNORED_LIVE_MESSAGE_TYPES,
    installMetadataPersistenceGuard,
    isLocalSessionMetadataFilePath,
    normalizeLocalSessionMetadataSerialized,
    repairLocalSessionMetadataData,
    isLocalSessionEventChannel,
    shouldNormalizeEventEmitterPayload,
    normalizeLiveSessionPayloads,
    normalizeLocalSessionIpcResult,
    getIgnoredLiveMessageType,
    mergeConsecutiveAssistantMessages,
  };
}

module.exports = {
  createLocalSessionBridge,
};

// Voice Input Client for Linux — Local Vosk STT via WebSocket
//
// Connects to a local Vosk server (ws://127.0.0.1:2700) for low-latency
// speech-to-text without network round-trips. Falls back to Anthropic's
// cloud STT if the local server isn't running.
//
// Trigger: floating mic button (bottom-right) or Ctrl+Alt+V
(function() {
  'use strict';
  if (window.__voiceTriggerInjected) return;
  window.__voiceTriggerInjected = true;

  // ── State ──────────────────────────────────────────────────────────
  var ws = null;
  var audioCtx = null;
  var mediaStream = null;
  var scriptProcessor = null;
  var sourceNode = null;
  var keepAliveTimer = null;
  var active = false;
  var currentTranscript = '';
  var finalTranscript = '';
  var autoSendTimer = null;
  // Silence duration (ms) before auto-sending. Configurable via right-click
  // on the mic button or window.__voiceMode.setDelay(ms).
  var AUTO_SEND_DELAY_MS = 8000;

  // ── WebSocket ──────────────────────────────────────────────────────

  var VOSK_LOCAL_URL = 'ws://127.0.0.1:2700';
  var usingLocal = false;

  function connectWS() {
    return new Promise(function(resolve, reject) {
      // Try local Vosk server first, fall back to cloud
      tryConnect(VOSK_LOCAL_URL, true).then(resolve).catch(function() {
        console.log('[Voice Input] Local Vosk unavailable, falling back to cloud STT');
        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var host = window.location.host;
        var params = new URLSearchParams({
          encoding: 'linear16', sample_rate: '16000', channels: '1',
          endpointing_ms: '300', utterance_end_ms: '1000', language: 'en'
        });
        var cloudUrl = protocol + '//' + host + '/api/ws/speech_to_text/voice_stream?' + params.toString();
        tryConnect(cloudUrl, false).then(resolve).catch(reject);
      });
    });
  }

  function tryConnect(url, isLocal) {
    return new Promise(function(resolve, reject) {
      console.log('[Voice Input] Connecting to:', url);
      var socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';

      // Quick timeout for local connection attempt (don't wait long)
      var connectTimeout = isLocal ? setTimeout(function() {
        socket.close();
        reject(new Error('Local server timeout'));
      }, 500) : null;

      socket.onopen = function() {
        if (connectTimeout) clearTimeout(connectTimeout);
        ws = socket;
        usingLocal = isLocal;
        console.log('[Voice Input] Connected (' + (isLocal ? 'local Vosk' : 'cloud') + ')');
        startKeepAlive();
        resolve();
      };

      socket.onmessage = function(e) {
        if (typeof e.data === 'string') {
          try {
            var msg = JSON.parse(e.data);
            handleMessage(msg);
          } catch (err) {
            console.warn('[Voice Input] Parse error:', err);
          }
        }
      };

      socket.onerror = function(e) {
        if (connectTimeout) clearTimeout(connectTimeout);
        reject(new Error('WebSocket error'));
      };

      socket.onclose = function() {
        if (connectTimeout) clearTimeout(connectTimeout);
        console.log('[Voice Input] WebSocket closed');
        stopKeepAlive();
        ws = null;
        if (active) {
          console.log('[Voice Input] Reconnecting in 1s...');
          setTimeout(function() {
            if (!active) return;
            connectWS().then(function() {
              console.log('[Voice Input] Reconnected');
            }).catch(function(err) {
              console.error('[Voice Input] Reconnect failed:', err);
              stop();
            });
          }, 1000);
        }
      };
    });
  }

  function handleMessage(msg) {
    var type = msg.type;
    var data = msg.data;

    if (type === 'TranscriptInterim' && typeof data === 'string') {
      currentTranscript = data;
      updateInputField(finalTranscript + data);
      // Still speaking — cancel any pending auto-send
      clearAutoSend();
    } else if (type === 'TranscriptText' && typeof data === 'string') {
      finalTranscript += data + ' ';
      currentTranscript = '';
      updateInputField(finalTranscript);
      // Finalized text received — start silence countdown
      scheduleAutoSend();
    } else if (type === 'TranscriptEndpoint') {
      // Server detected end of utterance — send sooner if auto-send is on
      if (finalTranscript.trim() && AUTO_SEND_DELAY_MS > 0) {
        scheduleAutoSend(Math.min(AUTO_SEND_DELAY_MS, 3000));
      }
    }
  }

  function scheduleAutoSend(delayOverride) {
    clearAutoSend();
    var delay = delayOverride != null ? delayOverride : AUTO_SEND_DELAY_MS;
    if (delay <= 0) return; // auto-send disabled
    autoSendTimer = setTimeout(function() {
      autoSendTimer = null;
      if (!active || !finalTranscript.trim()) return;
      console.log('[Voice Input] Auto-sending after silence');
      submitInput();
    }, delay);
  }

  function clearAutoSend() {
    if (autoSendTimer) {
      clearTimeout(autoSendTimer);
      autoSendTimer = null;
    }
  }

  function submitInput() {
    // Try clicking the send button
    var sendBtn = document.querySelector('button[aria-label="Send message"]')
      || document.querySelector('button[aria-label*="Send"]');
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      console.log('[Voice Input] Message sent via button click');
    } else {
      // Fallback: simulate Enter keypress on the input field
      var field = findInputField();
      if (field) {
        var enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        });
        field.element.dispatchEvent(enterEvent);
        console.log('[Voice Input] Message sent via Enter key');
      }
    }
    // Reset transcript for next utterance
    finalTranscript = '';
    currentTranscript = '';
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 4000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function closeWS() {
    stopKeepAlive();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch (_) {}
      ws.close();
    }
    ws = null;
  }

  // ── Audio recording ────────────────────────────────────────────────

  function startRecording() {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      mediaStream = stream;
      // Use 16kHz sample rate for direct PCM capture
      audioCtx = new AudioContext({ sampleRate: 16000 });
      sourceNode = audioCtx.createMediaStreamSource(stream);
      // Buffer size 2048 = 128ms chunks at 16kHz
      scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);

      sourceNode.connect(scriptProcessor);
      // Must connect to destination for onaudioprocess to fire
      scriptProcessor.connect(audioCtx.destination);

      scriptProcessor.onaudioprocess = function(e) {
        if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
        var float32 = e.inputBuffer.getChannelData(0);
        var int16 = new Int16Array(float32.length);
        for (var i = 0; i < float32.length; i++) {
          var s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        ws.send(int16.buffer);
      };

      console.log('[Voice Input] Recording started (16kHz PCM)');
    });
  }

  function stopRecording() {
    if (scriptProcessor) {
      scriptProcessor.disconnect();
      scriptProcessor = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(function() {});
      audioCtx = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function(t) { t.stop(); });
      mediaStream = null;
    }
  }

  // ── Input field integration ────────────────────────────────────────

  function findInputField() {
    // ProseMirror editor (used by Claude webapp)
    var pm = document.querySelector('.ProseMirror[contenteditable="true"]');
    if (pm) return { element: pm, type: 'prosemirror' };
    // Standard textarea
    var ta = document.querySelector('textarea[placeholder]');
    if (ta) return { element: ta, type: 'textarea' };
    // Any contenteditable
    var ce = document.querySelector('[contenteditable="true"]');
    if (ce) return { element: ce, type: 'contenteditable' };
    return null;
  }

  function updateInputField(text) {
    var field = findInputField();
    if (!field) return;

    if (field.type === 'prosemirror') {
      // ProseMirror: set innerHTML and dispatch input event
      field.element.innerHTML = '<p>' + escapeHtml(text) + '</p>';
      field.element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (field.type === 'textarea') {
      // Textarea: use native setter to trigger React's onChange
      var nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(field.element, text);
      field.element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      field.element.textContent = text;
      field.element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Start / Stop ───────────────────────────────────────────────────

  function start() {
    if (active) return;
    active = true;
    finalTranscript = '';
    currentTranscript = '';
    updateButtonState();

    connectWS().then(function() {
      return startRecording();
    }).then(function() {
      console.log('[Voice Input] Active — speak now');
    }).catch(function(err) {
      console.error('[Voice Input] Failed to start:', err);
      stop();
    });
  }

  function stop() {
    active = false;        // must be first — prevents onclose from reconnecting
    clearAutoSend();
    stopRecording();
    closeWS();
    // Wipe all transcript state
    finalTranscript = '';
    currentTranscript = '';
    cachedField = null;
    usingLocal = false;
    updateButtonState();
    console.log('[Voice Input] Stopped — all state reset');
  }

  function toggle() {
    if (active) {
      stop();
    } else {
      start();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  window.__voiceMode = {
    start: start,
    stop: stop,
    toggle: toggle,
    isActive: function() { return active; },
    setDelay: function(ms) {
      AUTO_SEND_DELAY_MS = Math.max(1000, Number(ms) || 8000);
      console.log('[Voice Input] Auto-send delay set to ' + AUTO_SEND_DELAY_MS + 'ms');
    },
    getDelay: function() { return AUTO_SEND_DELAY_MS; }
  };

  // ── Keyboard shortcut: Ctrl+Alt+V ──────────────────────────────────

  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.altKey && e.code === 'KeyV') {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  }, true);

  // ── Delay picker menu (right-click mic button) ────────────────────

  function showDelayMenu(anchorEl) {
    var existing = document.getElementById('__voice-delay-menu');
    if (existing) { existing.remove(); return; }

    var options = [
      { label: '5 seconds', value: 5000 },
      { label: '8 seconds', value: 8000 },
      { label: '12 seconds', value: 12000 },
      { label: '20 seconds', value: 20000 },
      { label: '30 seconds', value: 30000 },
      { label: 'Off (manual send)', value: 0 }
    ];

    var menu = document.createElement('div');
    menu.id = '__voice-delay-menu';
    var ms = menu.style;
    ms.position = 'fixed';
    ms.bottom = '130px';
    ms.right = '24px';
    ms.background = '#1e1e2e';
    ms.border = '1px solid #444';
    ms.borderRadius = '8px';
    ms.padding = '6px 0';
    ms.zIndex = '100000';
    ms.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
    ms.fontFamily = 'system-ui, sans-serif';
    ms.fontSize = '13px';
    ms.minWidth = '170px';

    var title = document.createElement('div');
    title.textContent = 'Auto-send delay';
    title.style.cssText = 'padding:6px 14px 4px;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;';
    menu.appendChild(title);

    options.forEach(function(opt) {
      var item = document.createElement('div');
      var isCurrent = (opt.value === AUTO_SEND_DELAY_MS) || (opt.value === 0 && AUTO_SEND_DELAY_MS === 0);
      item.textContent = (isCurrent ? '\u2713 ' : '   ') + opt.label;
      item.style.cssText = 'padding:6px 14px;color:#e0e0e0;cursor:pointer;';
      item.addEventListener('mouseenter', function() { item.style.background = '#333'; });
      item.addEventListener('mouseleave', function() { item.style.background = 'none'; });
      item.addEventListener('click', function() {
        AUTO_SEND_DELAY_MS = opt.value;
        if (opt.value === 0) {
          clearAutoSend();
          console.log('[Voice Input] Auto-send disabled');
        } else {
          console.log('[Voice Input] Auto-send delay set to ' + opt.value + 'ms');
        }
        menu.remove();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Close on click outside
    function closeMenu(e) {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', closeMenu, true);
      }
    }
    setTimeout(function() { document.addEventListener('click', closeMenu, true); }, 0);
  }

  // ── Floating microphone button ─────────────────────────────────────

  function createVoiceButton() {
    if (document.getElementById('__voice-trigger-btn')) return;

    var btn = document.createElement('button');
    btn.id = '__voice-trigger-btn';
    btn.title = 'Voice Input (Ctrl+Alt+V)';
    btn.innerHTML = [
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">',
      '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 ',
      '1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-',
      '4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 ',
      '5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.',
      '39-1.14-1-1.14z"/>',
      '</svg>'
    ].join('');

    var s = btn.style;
    s.position = 'fixed';
    s.bottom = '80px';
    s.right = '24px';
    s.width = '44px';
    s.height = '44px';
    s.borderRadius = '50%';
    s.border = '2px solid transparent';
    s.background = 'rgba(99, 102, 241, 0.85)';
    s.color = 'white';
    s.cursor = 'pointer';
    s.zIndex = '99999';
    s.boxShadow = '0 2px 8px rgba(0,0,0,0.25)';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.transition = 'transform 0.15s ease, background 0.15s ease';
    s.padding = '0';
    s.outline = 'none';

    btn.addEventListener('mouseenter', function() { btn.style.transform = 'scale(1.1)'; });
    btn.addEventListener('mouseleave', function() { btn.style.transform = 'scale(1)'; });
    btn.addEventListener('click', function(e) { e.preventDefault(); toggle(); });
    btn.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      showDelayMenu(btn);
    });

    document.body.appendChild(btn);

    // Pulse animation CSS
    var styleEl = document.createElement('style');
    styleEl.textContent = '@keyframes voice-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}';
    document.head.appendChild(styleEl);
  }

  function updateButtonState() {
    var el = document.getElementById('__voice-trigger-btn');
    if (!el) return;
    if (active) {
      el.style.background = 'rgba(239, 68, 68, 0.9)';
      el.style.borderColor = 'rgba(239, 68, 68, 1)';
      el.style.animation = 'voice-pulse 1.5s ease-in-out infinite';
    } else {
      el.style.background = 'rgba(99, 102, 241, 0.85)';
      el.style.borderColor = 'transparent';
      el.style.animation = 'none';
    }
  }

  // ── Init ───────────────────────────────────────────────────────────
  // Create the button immediately — no React fiber traversal needed
  if (document.body) {
    createVoiceButton();
  } else {
    document.addEventListener('DOMContentLoaded', createVoiceButton);
  }

  console.log('[Voice Input] Ready — Ctrl+Alt+V or click the mic button');
})();

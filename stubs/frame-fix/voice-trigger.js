// Voice Input Client for Linux — Standalone dictation via WebSocket
//
// Connects to /api/ws/speech_to_text/voice_stream to transcribe speech
// and injects text into the active input field. Works on ALL pages
// (chat, cowork/task, settings) without needing VoiceModeProvider.
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

  // ── WebSocket ──────────────────────────────────────────────────────

  function connectWS() {
    return new Promise(function(resolve, reject) {
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var host = window.location.host;
      var params = new URLSearchParams({
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        endpointing_ms: '300',
        utterance_end_ms: '1000',
        language: 'en'
      });
      var url = protocol + '//' + host + '/api/ws/speech_to_text/voice_stream?' + params.toString();

      console.log('[Voice Input] Connecting to:', url);
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function() {
        console.log('[Voice Input] WebSocket connected');
        startKeepAlive();
        resolve();
      };

      ws.onmessage = function(e) {
        if (typeof e.data === 'string') {
          try {
            var msg = JSON.parse(e.data);
            handleMessage(msg);
          } catch (err) {
            console.warn('[Voice Input] Parse error:', err);
          }
        }
      };

      ws.onerror = function(e) {
        console.error('[Voice Input] WebSocket error');
        reject(new Error('WebSocket error'));
      };

      ws.onclose = function() {
        console.log('[Voice Input] WebSocket closed');
        stopKeepAlive();
        if (active) stop();
      };
    });
  }

  function handleMessage(msg) {
    var type = msg.type;
    var data = msg.data;

    if (type === 'TranscriptInterim' && typeof data === 'string') {
      currentTranscript = data;
      updateInputField(finalTranscript + data);
    } else if (type === 'TranscriptText' && typeof data === 'string') {
      finalTranscript += data + ' ';
      currentTranscript = '';
      updateInputField(finalTranscript);
    } else if (type === 'TranscriptEndpoint') {
      // End of utterance — could auto-submit here if desired
    }
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
    active = false;
    stopRecording();
    closeWS();
    currentTranscript = '';
    updateButtonState();
    console.log('[Voice Input] Stopped');
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
    isActive: function() { return active; }
  };

  // ── Keyboard shortcut: Ctrl+Alt+V ──────────────────────────────────

  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.altKey && e.code === 'KeyV') {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  }, true);

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

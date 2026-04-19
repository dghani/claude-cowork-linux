// Voice Mode Trigger for Linux
// Injected into the claude.ai webapp to enable voice conversation mode.
//
// The webapp's VoiceModeProvider IS mounted for desktop and the voice engine
// IS initialized, but the UI button is hidden because qTt() returns false
// for desktop clients (hardcoded !ZI() check). This script finds the Zustand
// voice store through React fiber traversal and provides an alternative
// trigger: a floating microphone button + Ctrl+Shift+V keyboard shortcut.
(function() {
  'use strict';

  // Avoid double-injection on page reload
  if (window.__voiceTriggerInjected) return;
  window.__voiceTriggerInjected = true;

  var SEARCH_INTERVAL = 2000;
  var MAX_SEARCH_TIME = 120000;
  var searchStartTime = Date.now();

  // ── GrowthBook feature flag overrides ──────────────────────────────
  // These enable the server-side feature flags that gate voice mode.
  // DJB2 hashes of feature names used as keys in gb_local_overrides.
  // Safe to set: does NOT affect UA/isDesktop detection (which broke before).
  try {
    var overrides = JSON.parse(localStorage.getItem('gb_local_overrides') || '{}');
    overrides['2152485414'] = true;   // claude_ai_voice_mode
    overrides['3298592719'] = true;   // desktop_dictation_voice
    localStorage.setItem('gb_local_overrides', JSON.stringify(overrides));
  } catch (_) {}

  // ── Zustand store detection ────────────────────────────────────────

  function isVoiceActions(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return (
      typeof obj.start === 'function' &&
      typeof obj.stop === 'function' &&
      (typeof obj.openOverlay === 'function' || typeof obj.interrupt === 'function')
    );
  }

  function isZustandStore(obj) {
    return (
      obj && typeof obj === 'object' &&
      typeof obj.getState === 'function' &&
      typeof obj.setState === 'function' &&
      typeof obj.subscribe === 'function'
    );
  }

  function checkCandidate(val) {
    if (!val) return null;
    // Direct voice actions object (from useSyncExternalStore snapshot)
    if (isVoiceActions(val)) return val;
    // Zustand store reference (from useRef)
    if (isZustandStore(val)) {
      var state = val.getState();
      if (isVoiceActions(state)) return state;
    }
    // useRef wrapper
    if (val.current) {
      if (isVoiceActions(val.current)) return val.current;
      if (isZustandStore(val.current)) {
        var s = val.current.getState();
        if (isVoiceActions(s)) return s;
      }
    }
    return null;
  }

  function findVoiceActions() {
    var rootEl = document.getElementById('root');
    if (!rootEl) return null;

    var fiberKey = Object.keys(rootEl).find(function(k) {
      return k.startsWith('__reactFiber');
    });
    if (!fiberKey) return null;

    var rootFiber = rootEl[fiberKey];

    // BFS through the fiber tree with depth limit
    var queue = [rootFiber];
    var visited = new WeakSet();
    var nodesSearched = 0;

    while (queue.length > 0 && nodesSearched < 15000) {
      var fiber = queue.shift();
      if (!fiber || visited.has(fiber)) continue;
      visited.add(fiber);
      nodesSearched++;

      // Walk the hook linked list on this fiber
      var hook = fiber.memoizedState;
      var hookCount = 0;
      while (hook && hookCount < 50) {
        hookCount++;
        var result = checkCandidate(hook.memoizedState);
        if (result) return result;
        if (hook.queue) {
          result = checkCandidate(hook.queue.lastRenderedState);
          if (result) return result;
        }
        hook = hook.next;
      }

      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }

    return null;
  }

  // ── Store search + activation ──────────────────────────────────────

  var cachedActions = null;
  // Also try to cache the Zustand store itself for live state reads
  var cachedStore = null;

  function findAndCacheStore() {
    var rootEl = document.getElementById('root');
    if (!rootEl) return null;
    var fiberKey = Object.keys(rootEl).find(function(k) {
      return k.startsWith('__reactFiber');
    });
    if (!fiberKey) return null;
    var rootFiber = rootEl[fiberKey];
    var queue = [rootFiber];
    var visited = new WeakSet();
    var nodesSearched = 0;

    while (queue.length > 0 && nodesSearched < 15000) {
      var fiber = queue.shift();
      if (!fiber || visited.has(fiber)) continue;
      visited.add(fiber);
      nodesSearched++;

      var hook = fiber.memoizedState;
      var hookCount = 0;
      while (hook && hookCount < 50) {
        hookCount++;
        var ms = hook.memoizedState;
        // Check useRef wrapper for Zustand store
        if (ms && ms.current && isZustandStore(ms.current)) {
          var state = ms.current.getState();
          if (isVoiceActions(state)) {
            cachedStore = ms.current;
            return state;
          }
        }
        // Check direct state
        if (isVoiceActions(ms)) return ms;
        if (hook.queue && isVoiceActions(hook.queue.lastRenderedState)) {
          return hook.queue.lastRenderedState;
        }
        hook = hook.next;
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  }

  function getActions() {
    // If we have a cached Zustand store, always read fresh state
    if (cachedStore) {
      try {
        var state = cachedStore.getState();
        if (isVoiceActions(state)) return state;
      } catch (_) {}
    }
    // Fall back to fiber traversal
    var fresh = findVoiceActions();
    if (fresh) cachedActions = fresh;
    return fresh || cachedActions;
  }

  function isActive() {
    if (cachedStore) {
      try { return !!cachedStore.getState().isActive; } catch (_) {}
    }
    var a = getActions();
    return a ? !!a.isActive : false;
  }

  function startSearch() {
    var actions = findAndCacheStore();
    if (!actions) actions = findVoiceActions();
    if (actions) {
      cachedActions = actions;
      onFound();
      return;
    }
    if (Date.now() - searchStartTime < MAX_SEARCH_TIME) {
      setTimeout(startSearch, SEARCH_INTERVAL);
    } else {
      console.warn('[Voice Trigger] Voice store not found after ' + (MAX_SEARCH_TIME / 1000) + 's');
    }
  }

  function onFound() {
    console.log('[Voice Trigger] Voice store found!');

    window.__voiceMode = {
      start: function() {
        var a = getActions();
        if (!a) { console.warn('[Voice Trigger] No voice actions available'); return; }
        a.start();
        if (typeof a.openOverlay === 'function') a.openOverlay();
      },
      stop: function() {
        var a = getActions();
        if (!a) return;
        a.stop();
      },
      toggle: function() {
        if (isActive()) {
          window.__voiceMode.stop();
        } else {
          window.__voiceMode.start();
        }
      },
      isActive: isActive,
      getState: function() {
        if (cachedStore) return cachedStore.getState();
        return getActions();
      },
    };

    // ── Keyboard shortcut: Ctrl+Shift+V ────────────────────────────
    document.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault();
        e.stopPropagation();
        window.__voiceMode.toggle();
      }
    }, true);

    console.log('[Voice Trigger] Ready! Press Ctrl+Shift+V or click the mic button');
    createVoiceButton();
  }

  // ── Floating microphone button ─────────────────────────────────────

  function createVoiceButton() {
    if (document.getElementById('__voice-trigger-btn')) return;

    var btn = document.createElement('button');
    btn.id = '__voice-trigger-btn';
    btn.title = 'Voice Mode (Ctrl+Shift+V)';
    btn.innerHTML = [
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">',
      '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 ',
      '1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-',
      '4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 ',
      '5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.',
      '39-1.14-1-1.14z"/>',
      '</svg>',
    ].join('');

    var style = btn.style;
    style.position = 'fixed';
    style.bottom = '80px';
    style.right = '24px';
    style.width = '44px';
    style.height = '44px';
    style.borderRadius = '50%';
    style.border = '2px solid transparent';
    style.background = 'rgba(99, 102, 241, 0.85)';
    style.color = 'white';
    style.cursor = 'pointer';
    style.zIndex = '99999';
    style.boxShadow = '0 2px 8px rgba(0,0,0,0.25)';
    style.display = 'flex';
    style.alignItems = 'center';
    style.justifyContent = 'center';
    style.transition = 'transform 0.15s ease, background 0.15s ease, border-color 0.15s ease';
    style.padding = '0';
    style.outline = 'none';

    btn.addEventListener('mouseenter', function() {
      btn.style.transform = 'scale(1.1)';
    });
    btn.addEventListener('mouseleave', function() {
      btn.style.transform = 'scale(1)';
    });
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      window.__voiceMode.toggle();
    });

    document.body.appendChild(btn);

    // Update button appearance based on voice active state
    setInterval(function() {
      var active = isActive();
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
    }, 500);

    // Add pulse animation keyframes
    var styleEl = document.createElement('style');
    styleEl.textContent = [
      '@keyframes voice-pulse {',
      '  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }',
      '  50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }',
      '}',
    ].join('\n');
    document.head.appendChild(styleEl);
  }

  // ── Start ──────────────────────────────────────────────────────────
  // Delay initial search to let React mount and VoiceModeProvider initialize
  setTimeout(startSearch, 3000);
})();

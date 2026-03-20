# Plan: Session Normalization Consolidation

## Goal

Move all session normalization logic into `session_orchestrator.js` as the
single coherent home. Callers become thin wiring — they call the orchestrator,
not their own local implementations. When complete, `local_session_bridge.js`
and `local_session_ipc_adapter.js` are deleted.

## Current State

Session normalization is scattered across 6 files with 7 confirmed duplicates.
Every touchpoint is annotated with `@session-refactor:NORM-NNN` tags
(see `docs/session-normalization-manifest.md` for the full index).

```
frame-fix-wrapper.js     5 tags   (filtering constants + patchEventDispatch)
asar_adapter.js         10 tags   (filterTranscriptMessages, normalizeIpcResult)
session_store.js        20 tags   (normalizeSessionRecord, metadata persistence)
local_session_bridge.js 76 tags   (SDK transform, live dispatch, duplicates of above)
local_session_ipc_adapter.js 3 tags (thin IPC wrapper)
session_orchestrator.js  5 tags   (TARGET insertion points, no logic yet)
```

## Execution Order

Five phases, ordered by dependency depth (shallowest first). Each phase
is independently testable — the codebase works after every phase.

### Phase 1: Message Type Filtering (NORM-100)

**What moves:** The ignored/handled type sets and the filtering functions.

**Tags:** NORM-001, NORM-002, NORM-003, NORM-004, NORM-005, NORM-007, NORM-008

**Current locations:**
- `IGNORED_LIVE_MESSAGE_TYPES` in frame-fix-wrapper.js (4 types)
- `IGNORED_LOCAL_SESSION_MESSAGE_TYPES` in asar_adapter.js (4 types, same values)
- `HANDLED_LIVE_METADATA_MESSAGE_TYPES` in local_session_bridge.js (3 types)
- `IGNORED_LIVE_MESSAGE_TYPES` in local_session_bridge.js (1 type)
- `getIgnoredLiveMessageType()` in frame-fix-wrapper.js
- `getIgnoredLiveMessageType()` in local_session_bridge.js (duplicate)
- `filterTranscriptMessages()` in asar_adapter.js

**Consolidation:**

Add to SessionOrchestrator (or as module-level constants + functions
in session_orchestrator.js since these are stateless):

```
LIVE_EVENT_IGNORED_TYPES    = Set(['queue-operation', 'progress', 'last-prompt', 'rate_limit_event'])
LIVE_EVENT_METADATA_TYPES   = Set(['queue-operation', 'progress', 'last-prompt'])
TRANSCRIPT_IGNORED_TYPES    = Set(['last-prompt', 'progress', 'queue-operation', 'rate_limit_event'])

isIgnoredLiveEventType(channel, payload) -> string|null
filterTranscriptMessages(messages) -> messages
```

**Rewiring:**
- frame-fix-wrapper.js `patchEventDispatch`: import and call orchestrator's `isIgnoredLiveEventType`
- asar_adapter.js `normalizeIpcResult`: import and call orchestrator's `filterTranscriptMessages`
- Delete: NORM-001, NORM-004 constants from their current files
- Delete: NORM-003, NORM-005 functions from their current files

**Test approach:** Existing tests for `getIgnoredLiveMessageType` and
`filterTranscriptMessages` move to session_orchestrator.test.cjs. Frame-fix
and asar_adapter tests verify delegation (call was made, result passed through).

**Dependencies:** None. This phase has zero dependencies on other phases.

---

### Phase 2: Session Record Normalization (NORM-101)

**What moves:** Session record repair (cwd, cliSessionId, audit recovery).

**Tags:** NORM-020, NORM-021, NORM-022, NORM-023, NORM-024, NORM-025

**Current locations:**
- `normalizeSessionRecord()` in session_store.js (entry point)
- `normalizeSessionRecordForMetadataPath()` in session_store.js (implementation)
- `repairLocalSessionMetadataData()` in local_session_bridge.js (DUPLICATE)

**Key difference between the two implementations:**
- session_store.js returns the repaired record directly
- local_session_bridge.js returns `{changed, value, reason}` (richer return)

**Consolidation:**

Add to SessionOrchestrator as instance method (needs access to
sessionStore for transcript candidate selection):

```
normalizeSessionRecord(sessionData, metadataPath)
  -> { record, changed, reason }
```

Unify the richer return signature. Callers that don't need `changed`/`reason`
destructure only `record`.

**Rewiring:**
- asar_adapter.js `normalizeIpcResult`: call `orchestrator.normalizeSessionRecord(result).record`
- session_store.js: internal callers call orchestrator instead of local impl
- local_session_bridge.js callers: rewired in Phase 5 (bridge deletion)

**Dependencies:** None. Independent of Phase 1.

---

### Phase 3: SDK Message Transformation (NORM-102)

**What moves:** The entire stream_event -> synthetic assistant pipeline.

**Tags:** NORM-040, NORM-041, NORM-042, NORM-043, NORM-044, NORM-045, NORM-046, NORM-047

**Current location:** Entirely in local_session_bridge.js. No stubs equivalent.

**Functions:**
- `normalizeSdkMessageList(messages, sessionId)` — entry point
- `mergeConsecutiveAssistantMessages(messages)` — merge pass
- `mergeAssistantSdkMessages(prev, current)` — two-message merge
- `mergeAssistantContent(prevContent, currentContent)` — content block merge
- `mergeAssistantContentBlock(prev, current)` — single block merge
- `buildSyntheticAssistantPayloadFromStreamEvent(sessionId, message)` — stream_event transform
- `isAssistantSdkMessage(message)` — type check helper

**Consolidation:**

These are pure functions (stateless). Move as module-level functions in
session_orchestrator.js. Single public entry point:

```
transformSdkMessages(messages, sessionId) -> messages
```

Internal helpers (`mergeAssistantContent`, `mergeAssistantContentBlock`, etc.)
stay private to the module.

**Rewiring:**
- local_session_bridge.js callers: rewired in Phase 5
- asar_adapter.js can optionally call `transformSdkMessages` in `normalizeIpcResult`
  for getTranscript results (replaces need for bridge's normalizeLocalSessionIpcResult)

**Dependencies:** None. Independent of Phases 1-2.

---

### Phase 4: Live Event Dispatch + Metadata Persistence (NORM-103, NORM-104)

**What moves:** coworkCompatibilityState accumulation and fs.writeFileSync patching.

**Tags:** NORM-060 through NORM-064, NORM-080 through NORM-087

**Current locations:**
- Live dispatch: entirely in local_session_bridge.js (stateful — caches, maps)
- Metadata persistence: session_store.js + local_session_bridge.js (DUPLICATE)

**Live dispatch functions:**
- `normalizeLiveSessionPayloads(channel, payload)` — main dispatcher
- `applyLiveSessionMetadataMessage(sessionId, payload)` — accumulate state
- `getOrCreateLiveSessionCompatibilityState(sessionId)` — state factory
- `attachLiveSessionCompatibilityState(sessionId, payload)` — attach to payload
- `clearLiveAssistantSessionState(sessionId)` — cleanup on session end

**Metadata persistence functions (duplicated):**
- `normalizeSerializedMetadata(filePath, value)` — JSON repair on write
- `normalizeWriteValue(filePath, value)` — Buffer/string dispatch
- `installMetadataPersistenceGuard()` — fs.writeFileSync monkey-patch

**Consolidation:**

Live dispatch becomes instance methods on SessionOrchestrator (needs Maps
for per-session state):

```
normalizeLiveEventPayload(channel, payload) -> payload[]
clearSessionState(sessionId)
```

Metadata persistence stays in session_store.js (it's the natural home for
fs.writeFileSync patching). Remove the duplicate from local_session_bridge.js.
The orchestrator calls `sessionStore.installMetadataPersistenceGuard()` —
no change to that call site.

**Rewiring:**
- frame-fix-wrapper.js `patchEventDispatch`: call `orchestrator.normalizeLiveEventPayload()`
  instead of inline `getIgnoredLiveMessageType` (this upgrades patchEventDispatch
  from simple filtering to full normalization — the deferred stream_event work)
- session_store.js: remove nothing (it's already canonical for persistence)
- local_session_bridge.js: everything here gets deleted in Phase 5

**Dependencies:** Phase 1 (uses the consolidated type sets), Phase 3 (uses
transformSdkMessages for stream_event handling).

---

### Phase 5: Bridge Deletion + Cleanup

**What happens:** local_session_bridge.js and local_session_ipc_adapter.js are deleted.
All @session-refactor tags are removed. Manifest is archived or deleted.

**Preconditions:**
- All 5 NORM-1NN targets implemented in orchestrator
- All callers rewired to orchestrator methods
- `grep -r '@session-refactor:NORM-' stubs/` returns only TARGET tags
  (everything else has been handled)

**Steps:**
1. Delete `stubs/cowork/local_session_bridge.js`
2. Delete `stubs/cowork/local_session_ipc_adapter.js`
3. Remove all `@session-refactor:` comments from all files
4. Delete `docs/session-normalization-manifest.md`
5. Delete this plan file
6. Run full test suite
7. Verify `grep -r '@session-refactor' stubs/` returns empty

**Rewiring:**
- frame-fix-wrapper.js: remove any import of local_session_bridge (already done)
- Any file that imported local_session_bridge or local_session_ipc_adapter:
  verify no remaining references (`grep -r 'local_session_bridge\|local_session_ipc_adapter' stubs/`)

---

## Verification Protocol

After EACH phase:

```bash
# 1. All tests pass
node --test tests/node/current-path/*.test.cjs

# 2. Tag count decreasing (DEFINITION + CALLER tags for that phase should be gone)
grep -r '@session-refactor:NORM-' stubs/ | wc -l

# 3. No orphan references to deleted functions
grep -rn 'FUNCTION_NAME' stubs/ linux-app-extracted/cowork/

# 4. Stubs match extracted (after launch.sh copy)
diff stubs/cowork/FILE.js linux-app-extracted/cowork/FILE.js
```

After Phase 5 (final):

```bash
# Zero tags remain
grep -r '@session-refactor' stubs/ && echo "FAIL: tags remain" || echo "PASS: clean"

# Zero references to deleted modules
grep -r 'local_session_bridge\|local_session_ipc_adapter' stubs/ && echo "FAIL" || echo "PASS"

# Full test suite
node --test tests/node/current-path/*.test.cjs
```

## Estimated Scope

| Phase | New code in orchestrator | Deleted code | Net |
|-------|------------------------|-------------|-----|
| 1     | ~40 lines              | ~40 lines   | 0   |
| 2     | ~80 lines              | ~120 lines  | -40 |
| 3     | ~200 lines             | ~200 lines  | 0   |
| 4     | ~150 lines             | ~250 lines  | -100|
| 5     | 0                      | ~1200 lines | -1200|
| **Total** | **~470 lines**     | **~1810 lines** | **-1340** |

The codebase shrinks by ~1340 lines. The orchestrator grows by ~470 lines
but becomes the single source of truth for all session normalization.

## Notes

- Phases 1, 2, 3 are independent and can be done in parallel or any order
- Phase 4 depends on 1 and 3
- Phase 5 depends on all others
- Each phase should be a separate commit on this branch
- After all phases complete, squash or merge to master

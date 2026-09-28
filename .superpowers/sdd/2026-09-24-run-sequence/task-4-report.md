## Task 4A1 - Sequence record replay foundation

### Files

- Added `scripts/case-runtime/sequence-service.js` with signed record persistence, record-level integrity validation, deterministic reads, terminal lookup, and response replay projection.
- Added and registered `scripts/tests/sequence-record.test.js`.

### RED

- `node scripts/tests/sequence-record.test.js` failed with `MODULE_NOT_FOUND` for `sequence-service.js`.

### GREEN

- `node scripts/tests/sequence-record.test.js` passed after the record/replay helpers were implemented.

### Evidence

- Rewriting the same unsigned record produces the same SHA-256 signature.
- Exact lookup succeeds after `current-scene.json` moves beyond the submitted basis Scene and ignores changed `remainingMs` / `decisionId` metadata.
- A changed stable step produces a different request key and no replay match.
- Tampered and nonterminal same-key records raise `SEQUENCE_RECORD_INCOMPLETE` instead of allowing a duplicate Sequence.

### Self-review

- Integrity checks in 4A1 intentionally cover only record schema, execution binding, reference, request-key shape, and signature.
- Action/event/Scene graph integrity, execution, capture planning, budgets, and crash recovery remain Task 4A/4B work.

## Task 4A2a - Shared action validation

### Files

- Added `scripts/case-runtime/action-request.js` to share action resolution, required-input and visual validation, observation-policy checks, and long-press timing validation.
- Updated `scripts/case-runtime/action-service.js` to use the shared resolver without changing standalone `act` behavior.
- Added and registered `scripts/tests/action-request.test.js`.

### RED

- `node scripts/tests/action-request.test.js` failed because the extracted observation-policy branch prefixed the established standalone error message.

### GREEN

- The focused test passed after restoring the original `Error` message and code shape inside the shared helper.

### Evidence

- Valid visual, input-text, and timed long-press actions resolve through the shared path.
- Unavailable capabilities return the existing stale result; missing input, invalid visual coordinates, invalid observation policy, and invalid long-press timing are rejected.

### Self-review

- The extraction delegates action-shape and platform validation to the existing capability/action contracts instead of duplicating them.
- Sequence-only dispatch controls remain outside this commit for Task 4A2.

## Task 4A2c - Sequence action lifecycle hooks

### Files

- Updated `scripts/case-runtime/action-service.js` with injected prevalidated action context, bounded ACTION timeout forwarding, tagged persistent-boundary interrupts, and complete unknown-result post evidence.
- Added and registered `scripts/tests/action-sequence-hooks.test.js`.

### RED / GREEN

- The hook implementation was inherited as uncommitted work; the new focused characterization passed on its first run, so no additional production fix was required.

### Evidence

- Injected `beforeScene`, `resolvedAction`, and `operationId` are used without changing `current-scene.json`, and `timeoutMs` reaches the ACTION adapter call.
- PREPARED, DISPATCHED, and RESULT_RECORDED interrupts leave their exact draft state, never record `actionOutcomeUnknown`, and invoke the adapter zero, zero, and one time respectively.
- Unknown completion with a captured after Scene persists both before and after Scene/screenshot evidence and closes the draft without promotion.

### Self-review

- Tagged interruption hooks only expose durable boundaries; they do not implement recovery or redispatch.
- Sequence execution and recovery remain outside this commit.

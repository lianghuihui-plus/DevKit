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

## Task 4A2d - Terminal single-action Sequence

### Files

- Extended `scripts/case-runtime/sequence-service.js` with the bounded one-action `runSequence` happy path.
- Added and registered `scripts/tests/sequence-single-action.test.js`.

### RED

- `node scripts/tests/sequence-single-action.test.js` failed because `runSequence` was not exported.

### GREEN

- The focused suite passed after implementing replay-first lookup, prevalidation, signed running/terminal records, bounded dispatch, final Scene promotion, and shared action completion.

### Evidence

- The signed nonterminal record exists before ACTION dispatch; ACTION receives 26000 ms from a clamped 30000 ms Sequence and the final FULL_SCENE receives the full remaining 30000 ms.
- The final Scene carries `ACTION_POST` and `SEQUENCE_FINAL`, exact operation/Sequence/step identity, and before/after action evidence; the action draft is closed with one completion event.
- Exact retry after final promotion ignores changed Runtime metadata and performs no adapter call; changed stable input on the old Scene returns `SCENE_CHANGED` without dispatch.

### Self-review

- Every shape other than exactly one `act` fails with `SEQUENCE_NOT_IMPLEMENTED`; this commit does not fabricate unsupported completion.
- Multi-action, wait, explicit capture, failure closure, budget exhaustion, and recovery remain later phases.

## Task 4A2e1 - Sequence screenshot-only Scene helper

### Files

- Added exported `persistSequenceScreenshotScene` in `scripts/case-runtime/sequence-service.js`.
- Exposed the existing capture metadata normalizer from `scripts/case-runtime/scene-service.js` so full and screenshot-only Scene paths share origin rules.
- Added and registered `scripts/tests/sequence-screenshot-scene.test.js`.

### RED

- `node scripts/tests/sequence-screenshot-scene.test.js` failed because `persistSequenceScreenshotScene` was not exported.

### GREEN

- The focused suite passed after implementing Sequence-only screenshot Scene construction, persistence, promotion control, and event recording.

### Evidence

- Origins are deduplicated and ordered, action association requires `ACTION_POST`, and previous-action evidence gains exact before/after Scene and screenshot refs.
- `promote:false` persists the Scene and event without changing `current-scene.json`; `promote:true` explicitly updates it.
- Persisted Scene/event metadata carries operation, Sequence, and step identity with source operation `runSequence` and no Plan fields.

### Self-review

- The helper only consumes an already-completed screenshot adapter result; device invocation and deadline policy remain the caller's responsibility.
- Two-action orchestration and explicit capture execution remain later phases.

## Task 4A2e2 - Multi-action Sequence execution

### Files

- Extended `scripts/case-runtime/sequence-service.js` from the terminal single-action path to act-only sequences.
- Updated `scripts/case-runtime/scene-service.js` so a final full observation can derive action evidence and scroll state from an unpromoted intermediate Scene.
- Added and registered `scripts/tests/sequence-two-actions.test.js`.

### RED

- `node scripts/tests/sequence-two-actions.test.js` failed with `SEQUENCE_NOT_IMPLEMENTED: this runtime revision supports exactly one act step`.
- After the execution loop was added, the same test failed with `DEVICE_BINDING_CHANGED` because lightweight capture bypassed the Task 4 unified device-operation injection.

### GREEN

- `node scripts/tests/sequence-two-actions.test.js` passed after intermediate capture reused the supplied `CAPTURE` device-operation injection.
- `node scripts/tests/sequence-single-action.test.js` and `node scripts/tests/sequence-screenshot-scene.test.js` passed.

### Evidence

- Every act is resolved against the submitted basis Scene before the Sequence record or any adapter call is written.
- The first action is closed against one unpromoted `SCREENSHOT_ONLY` Scene with `ACTION_POST`; the second action is closed against the promoted final `FULL_SCENE` with `ACTION_POST` and `SEQUENCE_FINAL`.
- Step records form an exact pre/post chain, action drafts close once, and exact replay after final Scene promotion performs no adapter call.

### Self-review

- This phase supports successful act-only chains. Wait, explicit capture, failure closure, timeout terminalization, and crash recovery remain later Task 4 phases.

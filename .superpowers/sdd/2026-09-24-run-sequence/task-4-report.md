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

## Task 4A3 - General Sequence execution and integrity

### Files

- Extended `scripts/case-runtime/sequence-service.js` with wait/capture steps, adjacent capture coalescing, final-reserve enforcement, known/unknown action failure closure, and terminal record integrity.
- Exported the existing capture-failure fact helper from `scripts/case-runtime/action-service.js` for Sequence-owned action closure.
- Added and registered `scripts/tests/sequence-service.test.js`; updated the single-action characterization for the now-supported wait-only path.

### Evidence

- The capture topology matrix covers successful action chains, adjacent screenshot/full captures, terminal screenshot handoff, intermediate full captures, wait-only, and capture-only Sequences.
- Exact replay ignores changed Runtime metadata while changed stable input remains subject to stale-Scene validation.
- Waits and nonterminal adapter calls preserve the 4000 ms final-Scene reserve; insufficient waits are never partially executed.
- Known action failures, unknown outcomes, automatic screenshot failures, and final observation failures all stop the suffix and close any action draft without redispatch.
- Terminal integrity verifies stable request keys, signatures, action/event identity, pre/post Scene chains, final Scene promotion, and input-text redaction.

### Verification

- `node scripts/tests/sequence-service.test.js`
- `node scripts/tests/sequence-two-actions.test.js`
- `node scripts/tests/sequence-single-action.test.js`
- `node scripts/tests/sequence-record.test.js`

All commands passed after correcting the integrity rule for an adjacent explicit capture that intentionally shares the preceding action's post Scene.

### Remaining

- Task 4B still owns crash-matrix recovery, result-integrity integration, combined focused verification, and independent Task 4 review.

## Task 4B - Recovery state machine and evidence integrity

### Files

- Added `recoverInterruptedSequences` and persistent-boundary interruption hooks to `scripts/case-runtime/sequence-service.js`.
- Bound capture-failure technical facts to Sequence/step identity in `scripts/case-runtime/action-service.js`.
- Added Sequence record/event/Scene validation to `scripts/case-runtime/result-integrity.js`.
- Replaced the recovery placeholder with the full crash matrix in `scripts/tests/sequence-recovery.test.js` and registered it in `scripts/self-test.js`.

### RED / GREEN

- The recovery suite first failed because `recoverInterruptedSequences` was not exported.
- The final-capture failure assertion first failed because terminal records did not retain the action's technical-fact reference.
- The result-integrity assertion first failed because no Sequence evidence-graph validator existed.
- The historical replay regression first failed because integrity incorrectly required the final Scene to remain the current Scene instead of proving that it had been promoted through its `sceneObserved` event.

### Evidence

- Recovery covers record-created, PREPARED, DISPATCHED, RESULT_RECORDED, post-Scene-persisted, OBSERVED, and final-Scene-persisted boundaries.
- Every recovery performs zero ACTION dispatches, leaves no Sequence-owned draft, emits at most one action completion, performs at most one additional capture, writes one signed terminal record, and is idempotent on repetition.
- DISPATCHED recovery closes as unknown without redispatch even when final capture also fails.
- Existing post/final Scenes are reused, so the last three crash boundaries require no additional capture.
- Sequence evidence integrity binds request and terminal events, signed records, Scene/screenshot references, technical facts, and historical promoted-final-Scene evidence.

### Verification

- All focused Task 1-4 lifecycle suites passed.
- `node scripts/self-test.js` passed with the Sequence service and recovery suites registered.

### Remaining

- Independent combined Task 4 review is the only remaining Task 4 gate.

## Task 4 Fix Round 1 - Review findings

### Files

- Updated `scripts/case-runtime/sequence-service.js` to redact typed input in signed Sequence records, terminalize direct capture failures, verify null-post capture-failure facts, and stop before an adjacent capture after known action failure.
- Updated `scripts/platform/device-port.js` so every bounded observation honors its requested pre-adapter delay, including `SEQUENCE_FINAL` observations.
- Extended `scripts/tests/sequence-service.test.js` and `scripts/tests/device-operation-timeout.test.js` with focused regressions.

### RED

- Typed-input persistence failed with `true !== false` because the signed record JSON contained `sequence-secret-13223222360`.
- Direct screenshot capture failure escaped `runSequence` as `OBSERVATION_SCREENSHOT_FAILED` instead of returning a partial terminal response.
- The real production `device-port` boundary failed with `0 !== 500` for a `SEQUENCE_FINAL` observation delay.
- Null-post integrity failed with `Missing expected exception` after the completed action was pointed at a foreign Sequence/step technical fact.
- Known action failure followed by explicit capture failed because result steps were `['fails', 'must-not-capture']` instead of stopping at `['fails']`.

### GREEN

- `node scripts/tests/sequence-service.test.js` passed after each Sequence-service fix.
- `node scripts/tests/device-operation-timeout.test.js` passed after the production observation boundary honored the supplied settle delay.
- `node scripts/tests/sequence-recovery.test.js` passed with no action redispatch and unchanged crash recovery behavior.
- `node scripts/tests/action-completion.test.js`, `node scripts/tests/action-recovery-ownership.test.js`, and `node scripts/tests/scene-capture-origin.test.js` passed.
- `node scripts/tests/sequence-record.test.js`, `node scripts/tests/sequence-single-action.test.js`, `node scripts/tests/sequence-two-actions.test.js`, and `node scripts/tests/platform-capture.test.js` passed.

### Evidence and invariants

- Sequence request keys still use the submitted stable request for replay-first lookup, while the persisted recovery request replaces only `input.text` with `[REDACTED]`.
- A failed direct non-final capture records a failed step, stops the suffix, and attempts one final full Scene; a failed terminal full capture records a final-capture fact and returns a signed partial result.
- Null-post action closure now requires the referenced `POST_ACTION_CAPTURE_FAILED` event to match the action operation, Sequence, step, and the record's technical-fact list.
- Adjacent explicit capture coalescing remains active only after successful actions; known failures proceed directly to final full-Scene closure.
- The 4000 ms reserve, exact retry, stale-Scene validation, successful capture coalescing, recovery no-redispatch behavior, and Task 5 public surfaces remain unchanged.

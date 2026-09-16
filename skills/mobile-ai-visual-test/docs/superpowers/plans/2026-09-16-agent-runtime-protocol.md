# Agent-Runtime Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `agent-facing` so Case Agents use compact SDK-style documentation, one stdin call per decision, small Scene projections, piggybacked decision updates, and ledger-based finish without weakening evidence integrity.

**Architecture:** Keep Coordinator and Case Runtime as the only Agent-facing facades. Their contract modules become the source of truth for validation, generated documentation, and future MCP schemas; Runtime remains a deterministic device proxy and persists updates before independently validating the requested effect. Existing adapters, device ports, evidence storage, and final integrity checks remain authoritative.

**Tech Stack:** Node.js CommonJS, filesystem-backed JSON/event stores, built-in `assert`, existing `scripts/tests/*.test.js` harness.

**Spec:** `docs/superpowers/specs/2026-09-16-agent-runtime-protocol-design.md`

## Global Constraints

- Executions use schema `12` and protocol `agent-facing`; no parallel request, response, reader, or writer path is retained.
- A request may execute at most one device effect and may never replay an action whose dispatch outcome is unknown.
- The update bundle is atomic, but valid updates survive contextual rejection of the adjacent effect.
- Agent-facing responses may report an error reason and `documentationRef`, but must not contain usage instructions, templates, examples, `retryWith`, or `nextCall`.
- Default Scene contains at most 24 stable interactive control facts; complete elements/layout are returned only by explicit inspect calls.
- Runtime persists complete internal Scene, evidence, action, event, and transaction facts even when the Agent-facing response is reduced.
- `finish` builds checks from the expectation ledger and still calls the existing full result integrity validation.
- `references/case-runtime.md` is at most 6 KiB/160 lines; `references/coordinator.md` is at most 4 KiB/120 lines; method pages are at most 5 KiB; `action-refs.md` is at most 6 KiB; each errors page is at most 16 KiB.
- All generated Case Runtime docs total at most 64 KiB and Coordinator docs total at most 32 KiB.
- Do not run Android cases 002 or 003 as part of implementation verification; their business and timing acceptance belongs to the user.
- Do not modify `docs/superpowers/plans/2026-09-15-cross-platform-targeted-input.md` or `docs/superpowers/plans/2026-09-16-cross-platform-concurrent-execution.md`.

## File Map

- `scripts/case-runtime/agent-facing-contract.js`: seven public methods, schemas, parameter metadata, public statuses/errors, and compact response validators.
- `scripts/coordinator/agent-facing-contract.js`: four public methods and matching documentation metadata.
- `scripts/build-agent-facing-docs.js`: deterministic generation/checking of short indexes, method pages, action rules, errors, links, anchors, duplicate sections, and size budgets.
- `references/case-runtime.md`, `references/case-runtime/**`: generated Case Runtime SDK-style documentation.
- `references/coordinator.md`, `references/coordinator/**`: generated Coordinator SDK-style documentation.
- `scripts/case-runtime/agent-facing-client.js`: stdin-only transport and compact response/error envelope.
- `scripts/case-runtime/agent-facing-translator.js`: current structural/context translation, Scene projection, and ActionRef mapping.
- `scripts/case-runtime/decision-transaction.js`: recoverable submission state machine and update/effect receipts.
- `scripts/case-runtime/expectation-result-service.js`: append-only ledger, semantic hashes, invalidation, closure, readiness, and CaseResult projection.
- `scripts/case-runtime/case-model-service.js`: prospective model updates and ledger invalidation hooks.
- `scripts/case-runtime/runtime-core.js`: execute update bundle before independently validating/dispatching one effect.
- `scripts/case-runtime/result-service.js`: ledger-backed finish and existing finalization transaction integration.
- `scripts/case-runtime/result-integrity.js`: unchanged integrity rules plus an adapter for ledger-projected checks where needed.
- `scripts/case-runtime/scene-service.js`: complete internal Scene capture remains intact.
- `scripts/case-runtime/capability-catalog.js`: deterministic ActionRef-to-capability mapping helpers.
- `scripts/case-runtime/lifecycle.js`, `prompts/case-agent.md`: compact current brief and stdin-first operating instructions.
- `scripts/coordinator/agent-facing-service.js`, `scripts/coordinator-agent.js`: compact Coordinator responses and stable error documentation links.
- `scripts/lib/agent-contract-manifest.js`, `scripts/build-agent-contract.js`: generated documentation and canonical public contract in protocol SHA.
- `scripts/case-runtime/mcp-server.js`: transport-only MCP adapter created in the final milestone.

---

### Task 1: Public Contract Definitions and Layered Service Documentation

**Files:**
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/coordinator/agent-facing-contract.js`
- Create: `scripts/build-agent-facing-docs.js`
- Create: `references/case-runtime.md`
- Create: `references/case-runtime/methods/observe.md`
- Create: `references/case-runtime/methods/inspect.md`
- Create: `references/case-runtime/methods/plan.md`
- Create: `references/case-runtime/methods/act.md`
- Create: `references/case-runtime/methods/knowledge.md`
- Create: `references/case-runtime/methods/recover.md`
- Create: `references/case-runtime/methods/finish.md`
- Create: `references/case-runtime/action-refs.md`
- Create: `references/case-runtime/errors.md`
- Create: `references/coordinator.md`
- Create: `references/coordinator/methods/prepare-run.md`
- Create: `references/coordinator/methods/confirm-run.md`
- Create: `references/coordinator/methods/advance-run.md`
- Create: `references/coordinator/methods/cancel-run.md`
- Create: `references/coordinator/errors.md`
- Modify: `scripts/lib/agent-contract-manifest.js`
- Modify: `scripts/build-agent-contract.js`
- Modify: `SKILL.md`
- Test: `scripts/tests/agent-capability-contract.test.js`
- Test: `scripts/tests/architecture-boundaries.test.js`
- Create: `scripts/tests/agent-facing-docs.test.js`

**Interfaces:**
- Produces: `caseRuntimeContract.methods`, `coordinatorContract.methods`, `buildDocs({ root, check })`, and canonical public-contract JSON used by validation, docs, SHA, and MCP.
- Produces: `node scripts/build-agent-facing-docs.js` to write docs and `node scripts/build-agent-facing-docs.js --check` to reject drift or budget violations.

- [x] **Step 1: Add failing contract metadata tests**

Add assertions that all 11 methods expose `name`, `summary`, `requestSchema`, `parameterDescriptions`, `conditionalRequirements`, `contextualValidationRules`, `successStatuses`, `errorCodes`, `sideEffects`, `idempotency`, and `minimalExample`, for example:

```javascript
for (const method of Object.values(caseRuntimeContract.methods)) {
  assert.deepStrictEqual(Object.keys(method).sort(), REQUIRED_METHOD_FIELDS);
  assert.ok(method.requestSchema && method.requestSchema.type === 'object');
  assert.ok(method.errorCodes.every((code) => caseRuntimeContract.errors[code]));
}
assert.deepStrictEqual(Object.keys(caseRuntimeContract.methods),
  ['observe', 'inspect', 'plan', 'act', 'knowledge', 'recover', 'finish']);
```

- [x] **Step 2: Run contract tests and confirm RED**

Run: `node scripts/tests/agent-capability-contract.test.js`

Expected: FAIL because the contract modules do not expose the required method metadata and still center capability cards.

- [x] **Step 3: Define the canonical current public contracts**

Implement immutable definitions with explicit schema branches and exported accessors:

```javascript
const AGENT_FACING_PROTOCOL = 'agent-facing';
const METHODS = Object.freeze({
  observe: Object.freeze({
    name: 'observe',
    summary: 'Capture one new Scene without a business action.',
    requestSchema: observeSchema,
    parameterDescriptions: observeParameters,
    conditionalRequirements: ['basedOnSceneRef is required when updates are present after a Scene exists'],
    contextualValidationRules: ['updates bind to basedOnSceneRef; observe captures a new Scene'],
    successStatuses: ['READY'],
    errorCodes: ['AGENT_INPUT_INVALID', 'SCENE_CHANGED', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['persists valid updates', 'captures one Scene'],
    idempotency: 'Updates are submission-idempotent; Scene capture may be recovered by submission.',
    minimalExample: { capability: 'observe' },
  }),
  // Define inspect, plan, act, knowledge, recover, and finish with the exact spec signatures.
});

function canonicalPublicContract() {
  return JSON.parse(JSON.stringify({ protocol: AGENT_FACING_PROTOCOL, methods: METHODS, errors: ERRORS }));
}
```

Delete superseded exports and callers so the canonical public contract is the only Agent-facing definition.

- [x] **Step 4: Add failing generated-document tests**

Cover deterministic output, 11 method pages, every error anchor, relative-link validity, duplicate recovery-section rejection, startup index limits, per-page limits, and aggregate limits:

```javascript
assert.doesNotThrow(() => buildDocs({ root, check: true }));
assert.ok(Buffer.byteLength(read('references/case-runtime.md')) <= 6 * 1024);
assert.ok(read('references/case-runtime.md').split('\n').length <= 160);
assert.match(read('references/case-runtime/errors.md'), /# error-action-not-available/);
assert.doesNotMatch(read('references/case-runtime.md'), /complete internal capability|retryWith|nextCall/);
```

- [x] **Step 5: Run document tests and confirm RED**

Run: `node scripts/tests/agent-facing-docs.test.js`

Expected: FAIL because the generator and generated hierarchy do not exist.

- [x] **Step 6: Implement the deterministic doc generator and generate docs**

Generate short indexes from method summaries and compact signatures, method pages from schemas/metadata, error anchors from the public error table, and ActionRef rules from a shared exported mapping. In `--check` mode compare generated bytes without writing and fail with the first drift/budget/link issue.

Run: `node scripts/build-agent-facing-docs.js`

- [x] **Step 7: Bind docs and canonical definitions into protocol SHA**

Use explicit sorted resource arrays in `agent-contract-manifest.js`; include canonical contract JSON in `build-agent-contract.js`. Update `SKILL.md` to point to `references/coordinator.md`, while the Case Agent prompt remains responsible for the Case Runtime short index.

- [x] **Step 8: Run milestone regression tests and confirm GREEN**

Run:

```bash
node scripts/tests/agent-capability-contract.test.js
node scripts/tests/agent-facing-docs.test.js
node scripts/tests/architecture-boundaries.test.js
node scripts/build-agent-facing-docs.js --check
```

Expected: all pass; changing any generated doc or public method definition changes the protocol SHA.

- [ ] **Step 9: Commit the milestone**

```bash
git add SKILL.md scripts/case-runtime/agent-facing-contract.js scripts/coordinator/agent-facing-contract.js scripts/build-agent-facing-docs.js scripts/lib/agent-contract-manifest.js scripts/build-agent-contract.js scripts/tests/agent-capability-contract.test.js scripts/tests/agent-facing-docs.test.js scripts/tests/architecture-boundaries.test.js references/case-runtime.md references/case-runtime references/coordinator.md references/coordinator
git commit -m "feat: define agent-facing current contracts and docs"
```

---

### Task 2: Stdin-First Transport and Static Response Removal

**Files:**
- Modify: `prompts/case-agent.md`
- Modify: `scripts/case-runtime/lifecycle.js`
- Modify: `scripts/case-runtime/agent-facing-client.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/coordinator/agent-facing-service.js`
- Modify: `scripts/coordinator-agent.js`
- Test: `scripts/tests/agent-facing-case-runtime.test.js`
- Test: `scripts/tests/coordinator-agent-facing.test.js`
- Test: `scripts/tests/formal-entrypoints.test.js`

**Interfaces:**
- Consumes: canonical current methods/errors and generated `documentationRef` anchors from Task 1.
- Produces: stdin-first `CaseBriefRuntimeBinding { interfaceKind, protocol, command, documentation }` and compact current success/error responses.

- [x] **Step 1: Add failing stdin/brief/response-shape tests**

Assert stdin is accepted in one process call, empty stdin is rejected, brief contains only the four binding fields, and recursive response scans reject static instruction keys:

```javascript
const FORBIDDEN = new Set([
  'capabilities', 'actions', 'example', 'template', 'usage', 'useWhen',
  'required', 'optional', 'source', 'returns', 'retryWith', 'nextCall',
]);
assert.deepStrictEqual(Object.keys(brief.runtimeBinding).sort(),
  ['command', 'documentation', 'interfaceKind', 'protocol']);
assertNoForbiddenKeys(run(execDir, { capability: 'observe' }));
```

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```bash
node scripts/tests/agent-facing-case-runtime.test.js
node scripts/tests/coordinator-agent-facing.test.js
node scripts/tests/formal-entrypoints.test.js
```

Expected: FAIL on previous brief fields and response `retryWith`/capability-card content.

- [x] **Step 3: Make stdin the documented normal path**

Implement `parseRequest(argv, stdin)` as the only Shell request path and emit a brief command suitable for a quoted heredoc:

```text
<runtime.command> <<'MAVT_REQUEST'
{"capability":"observe"}
MAVT_REQUEST
```

Do not place a per-call example in Runtime responses. Remove requestPath from `prompts/case-agent.md`, lifecycle metadata, bound clients, tests, and telemetry.

- [x] **Step 4: Centralize compact public errors**

Replace `retryExample`, resume instructions, templates, and attached usage context with:

```javascript
function publicError({ status, code, message, retryable, issues, facts, scene, caseState, updatesApplied, effect }) {
  return compactUndefined({
    protocol: 'agent-facing', status, code, message, retryable,
    issues, facts, scene, caseState, updatesApplied, effect,
    documentationRef: documentationRefFor(code),
  });
}
```

Apply the same rule to Coordinator errors. Preserve specific causes in `message`, `issues`, and safe dynamic `facts`.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run the three commands from Step 2. Expected: all pass and empty stdin is rejected without consulting a request file.

- [ ] **Step 6: Commit the milestone**

```bash
git add prompts/case-agent.md scripts/case-runtime/lifecycle.js scripts/case-runtime/agent-facing-client.js scripts/case-runtime/agent-facing-translator.js scripts/coordinator/agent-facing-service.js scripts/coordinator-agent.js scripts/tests/agent-facing-case-runtime.test.js scripts/tests/coordinator-agent-facing.test.js scripts/tests/formal-entrypoints.test.js
git commit -m "feat: use stdin and compact agent-facing responses"
```

---

### Task 3: Compact Scene Projection and ActionRef Mapping

**Files:**
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/capability-catalog.js`
- Modify: `scripts/case-runtime/scene-inspection-service.js`
- Test: `scripts/tests/agent-facing-case-runtime.test.js`
- Test: `scripts/tests/runtime-enhancements.test.js`
- Test: `scripts/tests/agent-capability-contract.test.js`

**Interfaces:**
- Consumes: current response envelope and ActionRef documentation from Tasks 1-2.
- Produces: `projectScene(scene)`, `actionsForControl(control)`, and `resolveActionRef(scene, actionRef, input)`.

- [x] **Step 1: Add failing Scene projection tests**

Build fixtures with more than 24 controls and assert only visible/enabled interactive facts survive in stable layout order:

```javascript
assert.deepStrictEqual(Object.keys(projected).sort(),
  ['capturedAt', 'controls', 'interactionContext', 'sceneRef', 'screenshot', 'targetApp']);
assert.strictEqual(projected.controls.items.length, 24);
assert.strictEqual(projected.controls.truncated, true);
assert.strictEqual(projected.actions, undefined);
assert.strictEqual(projected.capabilities, undefined);
assert.strictEqual(projected.screenshot.sha256, undefined);
```

Also assert `inspect(elements)` and `inspect(layout)` return only their requested projections.

- [x] **Step 2: Add failing ActionRef equivalence tests**

For fixture controls, compare current mapping to the current capability catalog for `tap`, `toggle`, `doubleTap`, `longPress`, and `inputText`; cover dynamic screen and visual actions and invalid input fields.

- [x] **Step 3: Run tests and confirm RED**

Run:

```bash
node scripts/tests/agent-facing-case-runtime.test.js
node scripts/tests/runtime-enhancements.test.js
node scripts/tests/agent-capability-contract.test.js
```

Expected: FAIL because current Scene includes expanded actions/capabilities and contextual validation reads `scene.actions`.

- [x] **Step 4: Implement focused Compact Scene projection**

Map internal Scene to:

```javascript
{
  sceneRef, capturedAt,
  screenshot: { ref, path, width, height },
  targetApp: { inForeground, ...(inForeground ? {} : { actualApp }) },
  controls: { total, truncated, items },
  interactionContext: { verticalScroll, horizontalScroll, focusedElementRef, keyboardShown, visualGestures },
  ...(signalsNonEmpty ? { signals } : {}),
  ...(conflictsNonEmpty ? { conflicts } : {}),
  ...(previousAction ? { previousAction: projectPreviousAction(previousAction) } : {}),
}
```

Do not modify internal Scene persistence.

- [x] **Step 5: Implement deterministic ActionRef mapping**

Parse element refs at the final colon, reject refs containing colons at publication time, reconstruct internal capabilities from the complete current Scene, and validate dynamic prerequisites before returning an internal capability ID. Return `ACTION_NOT_AVAILABLE` or `ACTION_INPUT_INVALID` without an alternative action catalog.

- [x] **Step 6: Remove the capabilities inspect path**

Remove `inspect(channel="capabilities")`; ActionRef resolution rebuilds internal capabilities from the complete stored Scene without exposing an action catalog.

- [x] **Step 7: Run focused and architecture tests and confirm GREEN**

Run:

```bash
node scripts/tests/agent-facing-case-runtime.test.js
node scripts/tests/runtime-enhancements.test.js
node scripts/tests/agent-capability-contract.test.js
node scripts/tests/architecture-boundaries.test.js
```

Expected: all pass; internal Scene fixtures remain complete while public Scene is compact.

- [ ] **Step 8: Commit the milestone**

```bash
git add scripts/case-runtime/agent-facing-contract.js scripts/case-runtime/agent-facing-translator.js scripts/case-runtime/capability-catalog.js scripts/case-runtime/scene-inspection-service.js scripts/tests/agent-facing-case-runtime.test.js scripts/tests/runtime-enhancements.test.js scripts/tests/agent-capability-contract.test.js
git commit -m "feat: add compact scenes and action references"
```

---

### Task 4: DecisionUpdates and Recoverable Decision Submission

**Files:**
- Create: `scripts/case-runtime/decision-transaction.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/runtime-core.js`
- Modify: `scripts/case-runtime/case-model-service.js`
- Modify: `scripts/case-runtime/visual-inspection-service.js`
- Modify: `scripts/case-runtime/store.js`
- Test: `scripts/tests/agent-facing-case-runtime.test.js`
- Create: `scripts/tests/decision-transaction.test.js`
- Test: `scripts/tests/case-model-service.test.js`

**Interfaces:**
- Consumes: current/historical `sceneRef` lookup, ActionRef resolution, and existing act/observe/finish internal operations.
- Produces: `submitDecision(execDir, submission, handlers)`, `recoverDecision(execDir, handlers)`, atomic `applyUpdates`, and `updatesApplied` receipts.

- [x] **Step 1: Add failing composite validation tests**

Cover `updates.caseModel`, `updates.visual`, and `updates.expectationResults` structural validation; current-Scene requirements for effects; historical-Scene acceptance for facts; and the rule that a new ref assigned in the same case-model update cannot be referenced by that submission.

- [x] **Step 2: Add failing transaction and failure-semantic tests**

Test every state transition and crash boundary. The critical rejection test must prove a misspelled ActionRef retains valid updates:

```javascript
const response = run(execDir, {
  capability: 'act', basedOnSceneRef: sceneRef, actionRef: 'missing:tap', purpose: 'continue',
  updates: {
    visual: { observation: 'The setting is visible.', expectationRefs: ['E1'] },
    expectationResults: [{ expectationRef: 'E1', status: 'PASS', actual: 'Visible', evidence: { sceneRefs: [sceneRef] } }],
  },
});
assert.strictEqual(response.code, 'ACTION_NOT_AVAILABLE');
assert.deepStrictEqual(response.updatesApplied.expectationResults, ['E1']);
assert.strictEqual(response.effect.status, 'REJECTED');
assert.strictEqual(actionDispatchCount(), 0);
assert.strictEqual(events('visualInspected').length, 1);
```

Also prove an invalid update bundle writes no updates and starts no effect.

- [x] **Step 3: Run transaction tests and confirm RED**

Run: `node scripts/tests/decision-transaction.test.js`

Expected: FAIL because no submission transaction exists and current translation rejects ActionRef before persisting updates.

- [x] **Step 4: Implement decision transaction storage and recovery**

Persist `transactions/decision-<submissionId>.draft.json` with states:

```text
PREPARED -> UPDATES_APPLIED -> EFFECT_REJECTED
PREPARED -> UPDATES_APPLIED -> EFFECT_STARTED -> EFFECT_COMPLETED
```

Store request hashes and update event descriptors, not raw sensitive input. Write events with `submissionId` and sequence so recovery can detect already-applied updates.

- [x] **Step 5: Split update validation from effect validation**

Inside the execution lock: validate request binding and referenced Scene identity, compute the prospective model/hashes, validate the whole update bundle, persist it atomically, mark `UPDATES_APPLIED`, then validate effect context. Structural/binding/update errors reject the whole submission; stale Scene, unavailable ActionRef, dynamic input failure, or finish readiness rejects only the effect.

- [x] **Step 6: Integrate exactly one effect and idempotent recovery**

Delegate act/finish to their existing recoverable transactions. Associate observe output Scene with the submission and reuse it after a lost response. If action dispatch outcome is unknown, return `ACTION_OUTCOME_UNKNOWN` and never re-dispatch.

- [x] **Step 7: Run transaction and facade tests and confirm GREEN**

Run:

```bash
node scripts/tests/decision-transaction.test.js
node scripts/tests/agent-facing-case-runtime.test.js
node scripts/tests/case-model-service.test.js
node scripts/tests/case-runtime.test.js
```

Expected: all pass; crash-boundary tests show each update and effect is applied at most once.

- [ ] **Step 8: Commit the milestone**

```bash
git add scripts/case-runtime/decision-transaction.js scripts/case-runtime/agent-facing-contract.js scripts/case-runtime/agent-facing-translator.js scripts/case-runtime/runtime-core.js scripts/case-runtime/case-model-service.js scripts/case-runtime/visual-inspection-service.js scripts/case-runtime/store.js scripts/tests/decision-transaction.test.js scripts/tests/agent-facing-case-runtime.test.js scripts/tests/case-model-service.test.js
git commit -m "feat: persist composite agent decisions"
```

---

### Task 5: Expectation Ledger and Ledger-Backed Finish

**Files:**
- Create: `scripts/case-runtime/expectation-result-service.js`
- Modify: `scripts/case-runtime/case-model-service.js`
- Modify: `scripts/case-runtime/result-service.js`
- Modify: `scripts/case-runtime/result-integrity.js`
- Modify: `scripts/case-runtime/lifecycle.js`
- Modify: `scripts/case-runtime/contract.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/telemetry.js`
- Test: `scripts/tests/case-model-service.test.js`
- Test: `scripts/tests/result-matrix.test.js`
- Test: `scripts/tests/execution-metrics.test.js`
- Create: `scripts/tests/expectation-result-service.test.js`

**Interfaces:**
- Consumes: atomic decision updates from Task 4 and existing evidence/knowledge/search integrity helpers.
- Produces: `expectationSemanticHash(text)`, `applyExpectationResults`, `invalidateForCaseModelChange`, `currentLedger`, `finishReadiness`, and `buildCaseResultFromLedger`.

- [x] **Step 1: Add failing ledger projection tests**

Cover append-only updates, exact idempotency, later revisions, active/current semantic hash selection, and dynamic closure recalculation when visual/knowledge/technical/search evidence arrives after the verdict.

```javascript
assert.strictEqual(expectationSemanticHash(' A\r\nB '), expectationSemanticHash('A\nB'));
assert.strictEqual(currentLedger(execDir).E1.status, 'PASS');
assert.deepStrictEqual(currentLedger(execDir).E1.closure.reasons, ['VISUAL_INSPECTION_REQUIRED']);
```

- [x] **Step 2: Add failing Case Model invalidation tests**

Assert unchanged normalized verification text preserves results, changed text appends `SEMANTICS_CHANGED`, removed refs append `EXPECTATION_RETIRED`, and non-verification model edits do not invalidate results.

- [x] **Step 3: Add failing finish-readiness tests**

Assert missing results, evidence, visual inspection, knowledge review, and search coverage return `CASE_RESULT_INCOMPLETE` with only unresolved/conflict facts. Assert complete ledgers generate full checks and pass the existing `validateResultIntegrity()` before finalization.

- [x] **Step 4: Run ledger/result tests and confirm RED**

Run:

```bash
node scripts/tests/expectation-result-service.test.js
node scripts/tests/case-model-service.test.js
node scripts/tests/result-matrix.test.js
```

Expected: FAIL because verdicts exist only in finish request checks and no ledger events exist.

- [x] **Step 5: Implement append-only expectation events and projection**

Write `expectationResultUpdated` and `expectationResultInvalidated`; compute `expectation-semantic` as SHA-256 over canonical `{ text: normalizedText }`. Reject unknown/retired/cross-execution references before writing. Recalculate closure from current evidence facts rather than trusting the event's diagnostic snapshot.

- [x] **Step 6: Integrate model revision invalidation**

During prospective Case Model application, derive preserved, changed, retired, and assigned refs. Append invalidation events in the same update bundle and return `caseModelChange` only when the model changed.

- [x] **Step 7: Replace finish checks input with ledger projection**

Change public finish to `{ capability, basedOnSceneRef?, summary, uncertainties?, updates? }`. After applying final updates, call `finishReadiness`; if incomplete, reject only the finish effect and return the compact readiness projection. If ready, build the existing CaseResult shape, aggregate verdict, run `validateResultIntegrity()`, then use the existing recoverable result transaction.

- [x] **Step 8: Add schema 12 and telemetry counters**

Executions record schema 12 and protocol `agent-facing`. Add counts/timings for decision submissions, piggybacked updates, effect rejections after applied updates, unresolved finish attempts, Agent-facing response bytes, and scene projection bytes. Readers, writers, Batch, Report, and Facade reject every other execution schema.

- [x] **Step 9: Run milestone regression tests and confirm GREEN**

Run:

```bash
node scripts/tests/expectation-result-service.test.js
node scripts/tests/case-model-service.test.js
node scripts/tests/result-matrix.test.js
node scripts/tests/execution-metrics.test.js
node scripts/tests/case-runtime.test.js
node scripts/tests/report-reader.test.js
```

Expected: all pass; final `result.json` still contains complete checks and case-model revision without the Agent resubmitting all checks at finish.

- [ ] **Step 10: Commit the milestone**

```bash
git add scripts/case-runtime/expectation-result-service.js scripts/case-runtime/case-model-service.js scripts/case-runtime/result-service.js scripts/case-runtime/result-integrity.js scripts/case-runtime/lifecycle.js scripts/case-runtime/contract.js scripts/case-runtime/agent-facing-translator.js scripts/case-runtime/telemetry.js scripts/tests/expectation-result-service.test.js scripts/tests/case-model-service.test.js scripts/tests/result-matrix.test.js scripts/tests/execution-metrics.test.js
git commit -m "feat: finish cases from expectation ledger"
```

---

### Task 6: MCP Transport Adapter and Full Protocol Verification

**Files:**
- Create: `scripts/case-runtime/mcp-server.js`
- Modify: `scripts/case-runtime/agent-facing-client.js`
- Modify: `scripts/case-runtime/runtime-broker.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/lib/agent-contract-manifest.js`
- Create: `scripts/tests/agent-facing-transport-parity.test.js`
- Modify: `scripts/self-test.js`

**Interfaces:**
- Consumes: canonical request schemas and the same facade executor used by Shell.
- Produces: one MCP tool per public Case Runtime method, with execution/dispatch binding injected by registration context rather than exposed to the Agent.

- [x] **Step 1: Add failing transport parity tests**

For every public method, assert Shell/stdin and MCP validate against the same schema, enter the same facade, and produce equivalent normalized responses. Assert MCP schemas contain no `executionId`, dispatch lease, internal `capabilityId`, operation, token, or filesystem request path.

- [x] **Step 2: Run parity tests and confirm RED**

Run: `node scripts/tests/agent-facing-transport-parity.test.js`

Expected: FAIL because MCP registration does not exist.

- [x] **Step 3: Implement a transport-only MCP server**

Generate tool registrations from `canonicalPublicContract().methods`; inject bound execution directory and dispatch sequence in the server context; call the same `run(execDir, request, options)` facade entry used by stdin. Do not introduce an intent planner or separate method schemas.

- [x] **Step 4: Add parity suite to self-test and verify GREEN**

Run:

```bash
node scripts/tests/agent-facing-transport-parity.test.js
node scripts/self-test.js
node scripts/build-agent-facing-docs.js --check
```

Expected: full self-test passes and generated docs have no drift or budget violations.

- [x] **Step 5: Perform static forbidden-field and protocol checks**

Run:

```bash
rg -n 'retryWith|nextCall|requestPath|capabilities.*example|actions.*example' prompts references scripts/case-runtime scripts/coordinator
node scripts/tests/agent-facing-single-contract.test.js
git diff --check
```

Expected: both scans return no matches in the Agent-facing implementation and documentation, and `git diff --check` is clean.

- [ ] **Step 6: Commit the milestone**

```bash
git add scripts/case-runtime/mcp-server.js scripts/case-runtime/agent-facing-client.js scripts/case-runtime/runtime-broker.js scripts/case-runtime/agent-facing-contract.js scripts/lib/agent-contract-manifest.js scripts/tests/agent-facing-transport-parity.test.js scripts/self-test.js
git commit -m "feat: expose case runtime through mcp transport"
```

---

## Final Verification and Handoff

- [x] Run `node scripts/self-test.js` and record the exact pass/fail summary.
- [x] Run `node scripts/build-agent-facing-docs.js --check` and record all byte/line budget results.
- [x] Run `git diff --check` and inspect `git status --short` so unrelated user files are not included.
- [x] Compare representative full internal Scene/response bytes with the compact Agent-facing projection using unit fixtures only; report the reduction without running Android 002/003.
- [x] Record the current `main` workspace, no worktree/commit state, automated verification evidence, deployment notes, and user-owned Android 002/003 acceptance scope.

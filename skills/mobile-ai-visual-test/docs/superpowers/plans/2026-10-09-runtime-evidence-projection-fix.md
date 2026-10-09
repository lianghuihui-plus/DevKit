# Runtime Evidence Projection Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure historical inspections retain the inspected Scene identity, reject checkpoint results whose evidence is not yet closed, and make report provenance and rejected Agent requests explicit.

**Architecture:** Keep the existing internal Runtime response semantics, where `response.scene` is the current Scene and inspection records identify the inspected Scene. Centralize operation-specific Agent-facing Scene selection at the resource boundary, prevent the translator from overwriting that canonical reference, enforce evidence closure before result persistence, and project protocol diagnostics without interpreting Agent-authored prose.

**Tech Stack:** Node.js CommonJS, filesystem-backed Runtime artifacts, assertion-based test scripts, generated Agent-facing documentation.

**Spec:** Conversation-approved repair design from 2026-10-09, captured in the "Repair Design" section below.

## Global Constraints

- Do not change platform applicability or prerequisite modeling.
- Do not add compatibility branches or migrate existing execution artifacts.
- Do not change the internal meaning of `visualInspection.sceneId`, `actionInspection.sceneId`, or `response.scene`.
- A successful `recordResult` must mean every submitted result is closed at commit time.
- Preserve `act` full-Scene responses and `runSequence` final-Scene behavior.
- Do not add a stateful Agent resource cache; existing per-response `ref` deduplication remains authoritative.
- Tests must demonstrate red before production changes and green afterward.

## Repair Design

### Scene identity

Agent-facing Scene identity is selected by operation:

- `inspect` visual: `response.visualInspection.sceneId`
- `inspect` action: `response.actionInspection.sceneId`
- `runSequence`: `response.finalSceneRef`
- `observe`, `act`, and non-external `recover`: current response Scene

`provideOperationResources` publishes that Scene and returns its immutable resource ref. `projectResponseResult` consumes the provider-owned `sceneRef`; it may only fall back to the operation-specific internal identifier when no resource provider is present. The `values` object contains one `sceneRef` assignment.

### Result closure

`prepareExpectationResults` continues structural and reference validation. A new pure closure-issue projection evaluates all prepared results before any event is written. `applyExpectationResults` rejects the whole batch when any submitted result would remain unresolved. Missing visual inspection is surfaced as `VISUAL_INSPECTION_REQUIRED`; missing evidence or search coverage is surfaced as `RECORD_RESULT_INVALID`. No partial or provisional result event is written.

### Resource scope

The existing `Map` in `provideOperationResources` and `uniqueResources` in the envelope already deduplicate refs within one response. No additional generic deduplication is required. Correcting inspect Scene selection removes the erroneous current Scene and its dependency graph from historical inspect responses. Tests assert unique refs and absence of the current Scene.

### Report provenance

The report labels the free-form execution summary as an Agent conclusion. It separately reports Agent-facing `REJECTED` responses and Runtime internal invocation errors. It does not attempt to semantically fact-check Agent-authored text.

---

### Task 1: Preserve historical inspect Scene identity

**Files:**
- Modify: `scripts/tests/agent-facing-publication-flow.test.js`
- Modify: `scripts/tests/agent-facing-case-runtime.test.js`
- Modify: `scripts/case-runtime/agent-resource-store.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`

**Interfaces:**
- Consumes: internal inspect responses containing current `response.scene` plus inspected `visualInspection.sceneId` or `actionInspection.sceneId`.
- Produces: one canonical Agent-facing `result.sceneRef` and an inspected Scene resource descriptor.

- [x] **Step 1: Write the historical visual inspection regression test**

Extend the publication-flow fixture to capture Scene A, advance to Scene B, inspect Scene A, and assert:

```js
assert.strictEqual(inspected.result.sceneRef, observedA.data.ref);
assert.ok(inspected.resources.some((resource) => resource.ref === observedA.data.ref && resource.type === 'scene'));
assert.ok(!inspected.resources.some((resource) => resource.ref === observedB.data.ref));
assert.strictEqual(new Set(inspected.resources.map((resource) => resource.ref)).size, inspected.resources.length);
```

Also assert the persisted `visualInspected.sceneId` is Scene A.

Add the equivalent action-inspection assertion in `agent-facing-case-runtime.test.js`: after producing an action spatial evidence Scene, advance the current Scene, inspect the historical action Scene, and require both `result.sceneRef` and the published Scene descriptor to remain bound to that historical Scene.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node scripts/tests/agent-facing-publication-flow.test.js`

Then run: `node scripts/tests/agent-facing-case-runtime.test.js`

Expected: both historical inspection assertions FAIL because `result.sceneRef` and the published Scene reference point to the current Scene B.

- [x] **Step 3: Add operation-specific Scene selection in the resource store**

Add a focused helper in `agent-resource-store.js`:

```js
function responseSceneId(response, request) {
  if (request.operation === 'inspect') {
    return response.visualInspection?.sceneId || response.actionInspection?.sceneId || response.sceneId;
  }
  return response.scene?.sceneId || response.sceneId;
}
```

Use it in `provideOperationResources` so inspect never prefers the current `response.scene` over its inspected Scene.

- [x] **Step 4: Remove duplicate translator assignment**

Compute one provider-first, operation-aware `sceneRef` before building `values`, preserving explicit `null` for a terminal sequence with no final Scene:

```js
const sceneRef = provided.result?.sceneRef
  ?? response.finalSceneRef
  ?? response.sceneRef
  ?? inspection.sceneId
  ?? response.sceneId
  ?? response.scene?.sceneId
  ?? (Object.hasOwn(response, 'finalSceneRef') ? null : undefined);
```

Keep exactly one `sceneRef` property in `values`.

- [x] **Step 5: Run focused and adjacent Agent-facing tests**

Run:

```bash
node scripts/tests/agent-facing-publication-flow.test.js
node scripts/tests/agent-facing-case-runtime.test.js
node scripts/tests/agent-facing-resources.test.js
node scripts/tests/agent-facing-sequence.test.js
```

Expected: PASS.

### Task 2: Reject unresolved checkpoint results before persistence

**Files:**
- Modify: `scripts/tests/expectation-result-service.test.js`
- Modify: `scripts/tests/agent-facing-publication-flow.test.js`
- Modify: `scripts/case-runtime/expectation-result-service.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `references/case-runtime/methods/record-result.md`
- Regenerate: Agent-facing generated contract documentation through the repository's existing generator/test flow.

**Interfaces:**
- Consumes: prepared expectation results and existing inspection/search evidence events.
- Produces: deterministic closure issues before persistence; `recordResult` either records a closed batch or returns `REJECTED`.

- [x] **Step 1: Change service tests to require closed evidence**

Replace the provisional-result expectation with:

```js
assert.throws(() => applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'PASS', actual: '标题可见',
  evidence: { sceneRefs: ['scene-0001'] },
}]), (error) => error.code === 'CASE_RESULT_INVALID'
  && error.issues.some((issue) => issue.code === 'VISUAL_INSPECTION_REQUIRED'));
assert.strictEqual(store.events(execDir).some((event) => event.type === 'expectationResultUpdated'), false);
```

After appending `visualInspected`, submit the same result and assert it is persisted and resolved.

- [x] **Step 2: Add the public facade regression test**

Before inspection, call `recordResult` with the observed Scene and assert:

```js
assert.strictEqual(response.status, 'REJECTED');
assert.strictEqual(response.error.code, 'VISUAL_INSPECTION_REQUIRED');
assert.strictEqual(response.error.retryable, true);
```

Then inspect and assert the same `recordResult` succeeds.

- [x] **Step 3: Run both focused tests and verify they fail**

Run:

```bash
node scripts/tests/expectation-result-service.test.js
node scripts/tests/agent-facing-publication-flow.test.js
```

Expected: the service still persists an unresolved result and the facade still reports success.

- [x] **Step 4: Implement atomic pre-commit closure validation**

Add and export a helper that returns field-addressed issues for every prepared result. Call it once before the commit loop. Throw `CASE_RESULT_INVALID` with all issues when non-empty, ensuring the batch writes no events.

Map closure reasons as follows:

```js
VISUAL_INSPECTION_REQUIRED -> VISUAL_INSPECTION_REQUIRED
EVIDENCE_REQUIRED          -> RECORD_RESULT_INVALID
SEARCH_COVERAGE_REQUIRED   -> RECORD_RESULT_INVALID
```

Reuse the same helper in Agent-facing request translation so the normal facade returns the existing retryable visual-inspection error rather than a technical failure.

- [x] **Step 5: Update contract metadata and method documentation**

Add `VISUAL_INSPECTION_REQUIRED` to `recordResult.errorCodes`. Document that successful recording means all submitted evidence is closed and that unresolved batches are rejected atomically.

- [x] **Step 6: Run focused tests and generated-doc contract tests**

Run:

```bash
node scripts/tests/expectation-result-service.test.js
node scripts/tests/agent-facing-publication-flow.test.js
node scripts/tests/agent-facing-docs.test.js
node scripts/tests/agent-capability-contract.test.js
```

Expected: PASS.

### Task 3: Expose report provenance and Agent-facing rejections

**Files:**
- Modify: `scripts/tests/report-reader.test.js`
- Modify: `scripts/report/current-report-html.js`
- Modify: `scripts/report/report-service.js`

**Interfaces:**
- Consumes: `report.display.summary`, `report.metrics.invocationErrorCount`, and `report.metrics.agentFacing.statusCounts.REJECTED`.
- Produces: explicit Agent conclusion labeling plus separate rejection and Runtime internal error counts.

- [x] **Step 1: Add report rendering assertions**

Record one rejected Agent-facing telemetry response in the fixture, refresh the projected metrics used to render the report, and assert HTML contains:

```text
Agent 结论
Agent 请求被拒绝
Runtime 内部错误
```

Assert the rejected count is `1` and the internal error count remains the fixture's `invocationErrorCount`.

- [x] **Step 2: Run the focused report test and verify it fails**

Run: `node scripts/tests/report-reader.test.js`

Expected: FAIL because the current report labels neither provenance nor Agent-facing rejections.

- [x] **Step 3: Update the report projection**

Render the summary with a visible `Agent 结论` label. Replace `Runtime 请求错误` with two deterministic metrics:

```js
const rejectedRequests = report.metrics?.agentFacing?.statusCounts?.REJECTED ?? 0;
const internalErrors = report.metrics?.invocationErrorCount ?? 0;
```

Do not inspect or rewrite summary prose.

- [x] **Step 4: Run report tests**

Run:

```bash
node scripts/tests/report-reader.test.js
node scripts/tests/dashboard.test.js
```

Expected: PASS.

### Task 4: Full regression and plan audit

**Files:**
- Review: all files changed by Tasks 1-3
- Update: this plan's checkboxes as work completes

**Interfaces:**
- Consumes: completed task implementations.
- Produces: verified branch ready for review; no merge or commit unless separately requested.

- [x] **Step 1: Run targeted tests together**

Run:

```bash
node scripts/tests/agent-facing-publication-flow.test.js
node scripts/tests/agent-facing-case-runtime.test.js
node scripts/tests/agent-facing-resources.test.js
node scripts/tests/agent-facing-sequence.test.js
node scripts/tests/expectation-result-service.test.js
node scripts/tests/agent-facing-docs.test.js
node scripts/tests/agent-capability-contract.test.js
node scripts/tests/report-reader.test.js
node scripts/tests/dashboard.test.js
```

Expected: all commands exit 0.

- [x] **Step 2: Run the full Skill self-test**

Run: `node scripts/self-test.js`

Expected: `self-test passed` and exit 0.

- [x] **Step 3: Inspect branch diff and status**

Run:

```bash
git status --short --branch
git diff --check
git diff --stat
git diff
```

Confirm only the scoped implementation, tests, documentation, and this plan changed.

- [x] **Step 4: Reconcile implementation against every design requirement**

Confirm historical visual and action inspection identity, atomic closed-only result recording, no redundant generic dedupe code, unchanged runSequence final Scene behavior, report provenance labels, and rejection metrics.

### Review Follow-up: Close shared search validation and provider fallback gaps

**Files:**
- Modify: `scripts/tests/expectation-result-service.test.js`
- Modify: `scripts/tests/agent-facing-case-runtime.test.js`
- Modify: `scripts/case-runtime/result-integrity.js`
- Modify: `scripts/case-runtime/expectation-result-service.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`

- [x] **Step 1: Reproduce incomplete search evidence acceptance**

Add record-time tests for missing `SEARCH_ABSENCE`, PASS with absence evidence, a basis Scene omitted from `sceneRefs`, a stale generation, and valid complete coverage. Assert rejected batches write no `expectationResultUpdated` event.

- [x] **Step 2: Share the final search-absence rules with record-time closure**

Extract pure `searchAbsenceIssues` validation from final integrity checking and reuse it for prepared `recordResult` items. Preserve specific issue reasons while mapping them to `RECORD_RESULT_INVALID` at `results[index].evidence.searchAbsence`.

- [x] **Step 3: Reproduce provider-present Scene fallback**

Configure a resource provider that returns no Scene and assert the Agent-facing result does not synthesize `sceneRef` from top-level or nested internal response fields. Retain internal fallback only when no provider is configured.

- [x] **Step 4: Make provider participation explicit during projection**

Pass `providerPresent` into result projection. When present, accept only a provider-owned Scene ref, except for an explicit terminal `finalSceneRef: null`; preserve providerless error-context fallback and existing runSequence null semantics.

- [x] **Step 5: Run focused and adjacent regressions**

Run expectation-result, Agent-facing projection, publication, resource, sequence, and runtime-enhancement tests before the full self-test.

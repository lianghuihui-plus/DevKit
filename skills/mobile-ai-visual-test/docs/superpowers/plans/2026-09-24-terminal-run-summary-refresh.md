# Terminal Run Summary Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure terminal Coordinator responses expose the latest report publication state while preserving every previously published immutable `runSummary` resource.

**Architecture:** Keep `runSummary` snapshots content-addressed and immutable. Treat `coordinator-resources/terminal.json` as an atomically replaceable pointer: on each terminal projection, compare the latest publication-derived summary with the pointed snapshot, publish a new snapshot only when content changed, and move the pointer to the new ref.

**Tech Stack:** Node.js CommonJS, filesystem-backed immutable resources, `assert`-based self-tests.

**Spec:** `docs/superpowers/plans/2026-09-24-terminal-run-summary-refresh.md` (bounded design and implementation plan).

## Global Constraints

- Do not change the Coordinator public method set, request schemas, or response projections.
- Historical `runSummary` refs must remain readable and byte-stable after the terminal pointer advances.
- Repeated terminal reads with unchanged publication state must return the same ref.
- Terminal pointer replacement must be atomic and remain protected by the existing Coordinator run lock.
- Do not modify report retry classification or publication behavior.

---

### Task 1: Refresh Terminal Summary After Report Publication Recovery

**Files:**
- Modify: `scripts/tests/coordinator-agent-facing.test.js`
- Modify: `scripts/coordinator/agent-resource-store.js`
- Modify: `scripts/coordinator/agent-facing-service.js`
- Modify: `scripts/coordinator/agent-facing-contract.js`
- Regenerate: `references/coordinator/resources.md`
- Regenerate: `references/coordinator/methods/{advance-run,cancel-run,confirm-run}.md`

**Interfaces:**
- Consumes: `currentTerminalPublication(state)`, immutable `publishSnapshot(state, type, content, resources)`, and the existing Coordinator run lock.
- Produces: `bindTerminalResource(state, resource)` with atomic pointer replacement semantics and terminal projection that returns a new `runSummary` ref only when terminal content changes.

- [x] **Step 1: Change the existing recovery assertions to describe the required behavior**

```js
const initialSummaryRef = completeWithReportRetry.data.ref;
// ...write PUBLISHED report-publication.json and call advanceRun...
assert.strictEqual(content(completeAfterReportRecovery).reportStatus, 'PUBLISHED');
assert.strictEqual(content(completeAfterReportRecovery).reportPath, path.join(workspace, 'index.html'));
assert.notStrictEqual(completeAfterReportRecovery.data.ref, initialSummaryRef);
const oldSummary = executeRunRequest(statePath(retryPublicationRun), {
  operation: 'read', input: { ref: initialSummaryRef },
});
assert.strictEqual(content(oldSummary).reportStatus, 'RETRY_REQUIRED');
assert.strictEqual(content(oldSummary).reportPath, undefined);
assert.deepStrictEqual(advanceRun(statePath(retryPublicationRun)).data, completeAfterReportRecovery.data);
```

Import `executeRunRequest` with the other Coordinator service functions at the top of the test file and remove the later duplicate destructuring declaration before the historical-resource loop.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node scripts/tests/coordinator-agent-facing.test.js`

Expected: FAIL because the second terminal response still reports `RETRY_REQUIRED` and reuses the first `runSummary` ref.

- [x] **Step 3: Make the terminal pointer atomically replaceable**

Update `bindTerminalResource` so it validates any existing pointer through `regularFile`, returns without writing when the ref is unchanged, and otherwise uses the repository's `writeJsonAtomic` helper to replace `coordinator-resources/terminal.json` with `{ ref: resource.data.ref }`. Continue validating that callers bind only `runSummary` resources.

- [x] **Step 4: Refresh terminal content only when publication-derived fields changed**

In `projectResponse`, when an existing terminal resource is present:

```js
const nextContent = runSummaryContent(state, response, resource.data.content.diagnosticRefs || []);
if (canonicalJson(resource.data.content) !== canonicalJson(nextContent)) {
  resource = resources.publishSnapshot(state, 'runSummary', nextContent, resource.resources);
  resources.bindTerminalResource(state, resource);
}
```

Extract the existing `runSummary` object construction into `runSummaryContent(state, response, diagnosticRefs)` so initial publication and refresh use one canonical projection. Preserve existing diagnostic descriptors and refs during refresh.

- [x] **Step 5: Run the focused test and verify GREEN**

Run: `node scripts/tests/coordinator-agent-facing.test.js`

Expected: PASS, including new-ref, old-ref readability, and unchanged-state idempotency assertions.

- [x] **Step 6: Align the public contract and generated references**

Change the `runSummary` resource description to state that each snapshot is immutable, a publication-state change creates a new snapshot, and old refs remain valid. Change terminal method idempotency text to state that an unchanged publication state reuses the current summary while a changed state publishes a new one.

Run: `node scripts/build-agent-facing-docs.js && node scripts/build-agent-facing-docs.js --check`

Expected: generated Coordinator resource and method pages contain the new lifecycle semantics, followed by `checked 48 agent-facing documentation files`.

- [x] **Step 7: Run resource and publication regression tests**

Run: `node scripts/tests/agent-facing-publication-flow.test.js && node scripts/tests/publication-integrity.test.js && node scripts/tests/execution-flow-combination.test.js`

Expected: all three test files pass.

- [x] **Step 8: Run the complete Skill verification suite**

Run: `node scripts/self-test.js`

Expected: exit code 0 and final line beginning with `self-test passed:`.

- [x] **Step 9: Review the final diff**

Run: `git diff --check && git diff -- skills/mobile-ai-visual-test/scripts/coordinator skills/mobile-ai-visual-test/scripts/tests/coordinator-agent-facing.test.js skills/mobile-ai-visual-test/docs/superpowers/plans/2026-09-24-terminal-run-summary-refresh.md`

Expected: no whitespace errors; changes remain limited to the plan, focused test, terminal pointer store, terminal response projection, public contract text, and generated Coordinator references.

# Mobile AI Visual Test Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the recovery, idempotency, evidence-integrity, and report-projection gaps found in the full Skill review without adding Agent-facing capabilities, required fields, or Runtime business judgment.

**Architecture:** Keep Runtime responsible only for deterministic execution, references, transactions, and artifact integrity. Keep cancellation in Coordinator, abandoned execution compatibility in Reader, and publication/aggregation in Report. Derive Case Flow idempotency from the normalized request internally so the public nine-capability contract stays unchanged.

**Tech Stack:** Node.js CommonJS, filesystem-backed JSON/JSONL state, shell platform adapters, static HTML reports, existing assertion-based test runner.

**Spec:** Approved remediation design in the 2026-09-21 review conversation; no new public capability or Agent-required field, and execution schema 13 is the only supported execution format.

## Global Constraints

- Runtime must not infer screenshot change, visual meaning, checkpoint applicability, waiver validity, or PASS/FAIL.
- Agent-facing capabilities and request round trips must not increase.
- Report failure must not reopen or block the Batch business terminal state.
- Existing user changes in the dirty main worktree must be preserved.
- Every behavioral fix follows a failing regression test before production changes.

---

### Task 1: Recover Cancellation and Closed Executions

**Files:**
- Modify: `scripts/tests/coordinator-agent-facing.test.js`
- Modify: `scripts/coordinator/agent-facing-service.js`
- Modify: `scripts/tests/report-reader.test.js`
- Modify: `scripts/lib/execution-reader.js`

**Interfaces:**
- Consumes: persisted Coordinator phase `CANCELLING`; `executionSelection(execDir).closure`.
- Produces: resumable cancellation and readable `ABANDONED` reports for valid closed executions.

- [x] Add a cancellation test that interrupts after persisting `CANCELLING`, then resumes through `advanceRun`.
- [x] Run `node scripts/tests/coordinator-agent-facing.test.js` and verify the test fails by returning environment confirmation.
- [x] Route `CANCELLING` through `advanceBatch` and reject unknown phases as technical state errors.
- [x] Run the Coordinator test and verify it passes.
- [x] Add a Reader test for a stale unfinalized schema-13 execution with a valid Closure.
- [x] Run `node scripts/tests/report-reader.test.js` and verify it fails with `REPORT_DATA_INVALID`.
- [x] Validate closed executions with schema/read-only rules instead of current component compatibility.
- [x] Run both focused suites and verify they pass.

### Task 2: Resolve Runtime Plan Inputs Before Providers

**Files:**
- Modify: `scripts/tests/plan-service.test.js`
- Modify: `scripts/case-runtime/plan-service.js`

**Interfaces:**
- Consumes: `resolveValue(step, outputs)` and existing locate/check providers.
- Produces: providers receive resolved step values while plan records retain original `inputRefs`.

- [x] Add a capture-to-locate-to-`REFERENCE_EXISTS` regression test.
- [x] Run `node scripts/tests/plan-service.test.js` and verify `PLAN_CHECK_FAILED`.
- [x] Pass the resolved step to locate/check providers.
- [x] Run plan service and 033 suites and verify they pass.

### Task 3: Make Case Flow Submission Internally Idempotent

**Files:**
- Modify: `scripts/tests/case-flow-service.test.js`
- Modify: `scripts/tests/agent-facing-case-flow.test.js`
- Modify: `scripts/case-runtime/case-flow-service.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/runtime-core.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `references/case-runtime/methods/plan.md`

**Interfaces:**
- Consumes: unchanged `plan({ capability, caseFlow })` public request.
- Produces: internally derived normalized request digest; identical retries return the original revision with `idempotent: true`.

- [x] Add a lost-response retry test using the unchanged public request.
- [x] Run focused Case Flow tests and verify the retry fails with `CASE_FLOW_REVISION_CONFLICT`.
- [x] Derive and propagate a request digest internally, check it before revision validation, and reject digest collisions with different content.
- [x] Update generated method wording to describe identical-request idempotency without a submission field.
- [x] Rebuild Agent-facing docs and run focused contract tests.

### Task 4: Enforce Execution-Local Regular Artifacts

**Files:**
- Modify: `scripts/tests/publication-integrity.test.js`
- Modify: `scripts/tests/report-reader.test.js`
- Modify: `scripts/lib/execution-evidence.js`
- Modify: `scripts/lib/execution-artifact-manifest.js`

**Interfaces:**
- Consumes: execution-relative artifact references.
- Produces: a shared path assertion that rejects symlinks and canonical escapes at write, manifest, and read validation boundaries.

- [x] Add file-symlink, directory-symlink, and published-artifact replacement tests.
- [x] Run publication and Reader tests and verify external symlinks are incorrectly accepted.
- [x] Add component-wise `lstat` plus canonical-root validation and reuse it from manifest traversal.
- [x] Run focused integrity suites and verify they pass.

### Task 5: Close Publication and Multi-Platform Projection

**Files:**
- Modify: `scripts/tests/coordinator-agent-facing.test.js`
- Modify: `scripts/tests/publication-integrity.test.js`
- Modify: `scripts/tests/dashboard.test.js`
- Modify: `scripts/coordinator/agent-facing-service.js`
- Modify: `scripts/report/publication-state.js`
- Modify: `scripts/report/report-service.js`
- Modify: `scripts/report/current-index.js`

**Interfaces:**
- Consumes: `report-publication.json`, frozen Batch targets, per-platform readability.
- Produces: current terminal publication status and separate aggregate report health without changing Batch outcome.

- [x] Add a test where publication sidecar becomes `PUBLISHED` after Coordinator stores `RETRY_REQUIRED`.
- [x] Add mixed readable/unreadable platform dashboard tests.
- [x] Run focused tests and verify stale Coordinator status and masked report errors.
- [x] Refresh terminal publication facts from the sidecar without reopening Batch or involving Runtime.
- [x] Add aggregate `reportHealth` and report issue projection while retaining readable business verdicts.
- [x] Run Coordinator, publication, and dashboard suites.

### Task 6: Synchronize Documentation and Remove Retired Renderer

**Files:**
- Modify: `docs/architecture.md`
- Modify: `references/interfaces.md`
- Modify: `references/case-format.md`
- Modify: `scripts/report/current-report-html.js`
- Modify: `scripts/tests/dashboard.test.js`
- Modify: `scripts/tests/architecture-boundaries.test.js`

**Interfaces:**
- Consumes: current nine-capability contract and the schema 13 Reader behavior.
- Produces: accurate maintenance documentation and Mermaid-only report rendering.

- [x] Add behavioral HTML assertions proving Mermaid flow interaction remains available without the retired viewer markup.
- [x] Remove unused custom flow renderer, viewer behavior, and CSS.
- [x] Correct capability, Workspace Facade, and schema compatibility documentation.
- [x] Run dashboard, boundary, and generated-doc checks.

### Task 7: Full Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: evidence that the current dirty worktree is internally consistent.

- [x] Run `node scripts/self-test.js` and require exit code 0.
- [x] Run `node scripts/build-agent-facing-docs.js --check` and require exit code 0.
- [x] Run `git diff --check` and require no output.
- [x] Review `git diff` for accidental public capability, screenshot-change, or unrelated changes.

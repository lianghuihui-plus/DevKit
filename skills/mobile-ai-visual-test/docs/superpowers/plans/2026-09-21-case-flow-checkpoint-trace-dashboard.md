# Case Flow Checkpoint Trace Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate source-derived Baseline Flow from actual Execution Trace, preserve every baseline checkpoint through execution closure, support auditable checkpoint waivers, and render both views with offline Mermaid reports.

**Architecture:** Keep append-only runtime events as the source of truth. Project Baseline Flow, Working Flow, Checkpoint Registry/Ledger, and compressed Execution Trace from those events; Runtime validates structure and references only, while Agent owns business meaning and dispositions. Reports consume structured ViewModels and generate escaped Mermaid DSL only at render time.

**Tech Stack:** Node.js CommonJS, JSON/JSONL execution artifacts, static HTML/CSS/JavaScript reports, vendored Mermaid browser runtime, repository self-test runner.

**Spec:** `docs/superpowers/specs/2026-09-21-case-flow-checkpoint-trace-dashboard-design.md`

## Global Constraints

- Work directly on `main` because the user explicitly confirmed the skill is not currently in use.
- Execution schema 13 is the only supported format; older executions are not read or resumed and require a rerun.
- Runtime performs deterministic structure, enum, lifecycle, and reference checks only.
- Agent decides applicability, checkpoint outcome, and waiver justification.
- Mermaid DSL is derived report output, never persisted runtime input or source-of-truth data.
- Preserve unrelated untracked files and existing user changes.

---

### Task 1: Schema 13 Flow And Checkpoint Registry

**Files:**
- Modify: `scripts/case-runtime/case-flow-service.js`
- Modify: `scripts/case-runtime/lifecycle.js`
- Modify: `scripts/case-runtime/agent-facing-client.js`
- Modify: `scripts/lib/readers/current-execution.js`
- Modify: `scripts/lib/execution-reader.js`
- Modify: `scripts/execution/contracts/validation-profile-contract.js`
- Modify: `scripts/tests/case-flow-service.test.js`
- Modify: `scripts/tests/report-reader.test.js`

**Interfaces:**
- Produces: `caseFlowService.baseline(execDir)`, `caseFlowService.checkpointRegistry(execDir)`, and a schema 13 execution reader.
- Consumes: append-only `caseFlowRevised` events and `execution.json`.

- [x] Write failing tests proving CHECK requires `requirement`, conditional checks require `applicability`, first revision has null Scene provenance, and Baseline node/edge identities cannot be rewritten.
- [x] Run `node scripts/self-test.js caseFlow report` and confirm failures are caused by missing schema 13 behavior.
- [x] Implement schema 13 creation/client gates, flow normalization, immutable Baseline identity, registry projection, and rejection of unsupported execution formats.
- [x] Run `node scripts/self-test.js caseFlow report` and confirm both suites pass.

### Task 2: Ledger, Waiver, And Finish Closure

**Files:**
- Modify: `scripts/case-runtime/expectation-result-service.js`
- Modify: `scripts/case-runtime/result-integrity.js`
- Modify: `scripts/case-runtime/contract.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/lifecycle.js`
- Modify: `scripts/tests/expectation-result-service.test.js`
- Modify: `scripts/tests/case-flow-result-integrity.test.js`
- Modify: `scripts/tests/agent-facing-case-runtime.test.js`

**Interfaces:**
- Consumes: `checkpointRegistry(execDir)` from Task 1.
- Produces: `currentLedger(execDir)` covering all baseline plus active supplemental checkpoints; `WAIVED` result with mandatory `reason`.

- [x] Write failing tests for baseline checkpoint retention, supplemental retirement, `WAIVED` reason, conditional-only `NOT_APPLICABLE`, technical evidence on waiver, and PASS aggregation with waivers.
- [x] Run `node scripts/self-test.js expectationResult caseFlowResultIntegrity agentFacingCaseRuntime` and confirm expected failures.
- [x] Implement registry-based reference resolution, immutable checkpoint semantics, disposition validation, ledger closure, result snapshots, and continuation summary.
- [x] Run the same suites and confirm they pass.

### Task 3: Remove Mandatory Negative Knowledge Gate

**Files:**
- Modify: `scripts/execution/contracts/validation-profile-contract.js`
- Modify: `scripts/case-runtime/expectation-result-service.js`
- Modify: `scripts/case-runtime/result-integrity.js`
- Modify: `scripts/case-runtime/result-service.js`
- Modify: `scripts/tests/knowledge-closure.test.js`
- Modify: `scripts/tests/result-matrix.test.js`

**Interfaces:**
- Produces: validation profile version 2 with optional knowledge closure and dashboard quality metrics.
- Preserves: invalid submitted `knowledgeRefs` remain rejected.

- [x] Write failing tests proving FAIL, INCONCLUSIVE, BLOCKED, and WAIVED can close without a knowledge query while invalid supplied references fail.
- [x] Run `node scripts/self-test.js knowledgeClosure resultMatrix` and confirm the old mandatory gate causes failures.
- [x] Remove completion gating, upgrade the profile contract, and retain optional investigation projection.
- [x] Run the same suites and confirm they pass.

### Task 4: Baseline, Trace, And Ledger Report ViewModels

**Files:**
- Create: `scripts/report/case-flow-projection.js`
- Modify: `scripts/report/execution-trace.js`
- Modify: `scripts/report/execution-narrative.js`
- Modify: `scripts/report/report-service.js`
- Modify: `scripts/report/current-report.js`
- Modify: `scripts/tests/execution-trace.test.js`
- Modify: `scripts/tests/execution-narrative.test.js`
- Modify: `scripts/tests/report-reader.test.js`

**Interfaces:**
- Produces: `projectCaseFlowViews(report)` returning `{ baselineFlow, workingFlow, checkpointLedger, executionTrace, coverage }`.
- Consumes: structured execution events/results only.

- [x] Write failing fixtures showing revision 1 remains Baseline, revision 2 popup handling is trace-only adaptation, retries/plans collapse, and checkpoint status remains visible.
- [x] Run `node scripts/self-test.js trace narrative report` and confirm projection failures.
- [x] Implement deterministic projections for supported executions without mutating artifacts.
- [x] Run the same suites and confirm they pass.

### Task 5: Offline Mermaid Publication

**Files:**
- Add: `assets/vendor/mermaid/mermaid.min.js`
- Add: `assets/vendor/mermaid/LICENSE`
- Modify: `scripts/report/report-publisher.js`
- Modify: `scripts/report/report-service.js`
- Modify: `scripts/tests/publication-integrity.test.js`

**Interfaces:**
- Produces: content-addressed workspace dependencies recorded in `report-metadata.json`.
- Enforces: canonical dependency path remains under workspace root and matches bytes/SHA-256.

- [x] Write failing publication tests for dependency creation, reuse, missing file, hash mismatch, traversal, and concurrent publication.
- [x] Run `node scripts/self-test.js publication` and confirm dependency support is absent.
- [x] Vendor the pinned licensed build and implement atomic content-addressed dependency publication/validation.
- [x] Run `node scripts/self-test.js publication` and confirm it passes.

### Task 6: Dashboard Tabs And Mermaid Rendering

**Files:**
- Modify: `scripts/report/current-report-html.js`
- Modify: `scripts/report/current-index.js`
- Modify: `scripts/tests/dashboard.test.js`
- Modify: `scripts/tests/plan-report.test.js`

**Interfaces:**
- Consumes: Task 4 ViewModels and Task 5 Mermaid dependency metadata.
- Produces: tabs for Case Flow, Execution Trace, conditional Runtime Plans, and Logs; Case Flow uses a desktop split layout with the node inspector and Checkpoint Ledger in its right column; accessible graph fallback.

- [x] Write failing HTML assertions for PASS-with-waiver disclosure, tabs, escaped Mermaid source, checkpoint filters, and fallback list.
- [x] Run `node scripts/self-test.js dashboard planReport` and confirm failures.
- [x] Implement compact tabs, a split Case Flow workspace with embedded Checkpoint Ledger, node inspector, full-screen pan/zoom graph, responsive fallback, and overview metrics.
- [x] Run the same suites and confirm they pass.

### Task 7: Full Regression And Documentation

**Files:**
- Modify: `SKILL.md`
- Modify: `references/case-runtime/methods/plan.md`
- Modify: `references/case-runtime/methods/record-result.md`
- Modify: protocol/schema references discovered by contract generation.

**Interfaces:**
- Documents: Agent owns semantic decisions; Runtime owns deterministic validation and evidence persistence.

- [x] Update Agent-facing docs and examples for Baseline, conditional checks, waiver, and actual-trace behavior.
- [x] Run focused contract generation/tests and repair only regressions caused by this feature.
- [x] Run `node scripts/self-test.js` and require zero failures.
- [x] Inspect `git diff --check`, generated report HTML, and the final requirement-to-test mapping before completion.

# Agent-facing Unified Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every formal Agent-facing entry point with one allowlisted request/response protocol, immutable typed resources, and a single `read(ref)` operation while preserving the Agent/Runtime responsibility boundary.

**Architecture:** A shared envelope module owns only protocol-level status, resource descriptors, errors, and builders. Coordinator and Case Runtime keep separate domain contracts, translators, and resource resolvers; Bootstrap consumes the same response builder once. Existing runtime cores remain authoritative for effects and persistence, while Facades project their results from explicit allowlists.

**Tech Stack:** Node.js CommonJS, JSON Schema-like validators, filesystem-backed immutable execution artifacts, MCP stdio transport, repository self-test runner.

**Spec:** `skills/mobile-ai-visual-test/docs/superpowers/specs/2026-09-22-agent-facing-protocol-design.md`

## Global Constraints

- Public requests have exactly `{ operation, input }`; pre-bound scope and transport facts are never Agent inputs.
- Public statuses are exactly `SUCCEEDED`, `REJECTED`, `FAILED`, and `UNKNOWN`; domain states live in `result.outcome`.
- Every response contains `protocol`, `status`, `operation`, `result`, and `resources`; `data` appears only for one successful primary complex resource and `error` appears only for non-success.
- Projection starts from an empty object and copies only fields declared by the selected operation, mode, and outcome.
- Complex primary data is returned in full; associated complex data is represented only by immutable typed refs, without byte caps, sampling, or silent truncation.
- `read` accepts exactly one required field, `input.ref`, and refs are copied from prior responses rather than constructed by the Agent.
- Runtime remains deterministic execution, validation, persistence, and reference resolution; it gains no visual or business intelligence.
- Agent retains both published ActionRef actions and arbitrary normalized coordinate gestures.
- Finalized Case Runtime accepts only `read`; terminal Coordinator accepts `read` and preserves idempotent terminal `advanceRun`/`cancelRun` behavior.
- Upgrade executions directly from schema 13 to schema 14; do not add old-schema readers, converters, dual writers, or compatibility branches.
- Reports and dashboards continue to read authoritative events and artifacts, never Agent response replay.
- Telemetry records sizes, resource counts, and read target types, never resource bodies, commands, or secrets.

---

### Task 1: Shared Envelope Contract

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/lib/agent-facing-envelope.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-single-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/architecture-boundaries.test.js`

**Interfaces:**
- Consumes: `validateAgentJson` conventions and existing `documentationRefFor` output strings.
- Produces: `AGENT_FACING_PROTOCOL`, `AGENT_FACING_STATUSES`, `RESOURCE_DESCRIPTOR_SCHEMA`, `requestEnvelopeSchema(operationSchemas)`, `successEnvelope(options)`, and `errorEnvelope(options)`.

- [ ] **Step 1: Add failing contract tests**

Add assertions proving the public status set is exact, success builders always emit empty `result`/`resources`, primary data is allowed only on success, error builders require stable `code` and boolean `retryable`, resource descriptors require `ref/type/role`, and neither builder accepts unlisted top-level properties.

```js
assert.deepStrictEqual([...AGENT_FACING_STATUSES], ['SUCCEEDED', 'REJECTED', 'FAILED', 'UNKNOWN']);
assert.deepStrictEqual(successEnvelope({ operation: 'observe' }), {
  protocol: 'agent-facing', status: 'SUCCEEDED', operation: 'observe', result: {}, resources: [],
});
assert.throws(() => errorEnvelope({ status: 'UNKNOWN', operation: 'act', code: 'X', retryable: true }), /UNKNOWN.*retryable/);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentFacingSingleContract boundaries`

Expected: FAIL because `scripts/lib/agent-facing-envelope.js` does not exist.

- [ ] **Step 3: Implement protocol-only builders**

Implement frozen public constants, strict envelope validation, deterministic resource de-duplication by `ref`, and builders that construct from explicit arguments. Do not import Coordinator, execution, scene, knowledge, or report modules.

```js
function successEnvelope({ operation, result = {}, data, resources = [] }) {
  return Object.freeze({
    protocol: AGENT_FACING_PROTOCOL,
    status: 'SUCCEEDED',
    operation,
    result: { ...result },
    ...(data ? { data } : {}),
    resources: uniqueResources(resources),
  });
}
```

- [ ] **Step 4: Run focused tests and confirm pass**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentFacingSingleContract boundaries`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/lib/agent-facing-envelope.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-single-contract.test.js skills/mobile-ai-visual-test/scripts/tests/architecture-boundaries.test.js
git commit -m "feat(mavt): add shared agent-facing envelope"
```

### Task 2: Case Runtime Request Contract and Allowlist Projection

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-translator.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-client.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-capability-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-case-runtime.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-boundary.test.js`

**Interfaces:**
- Consumes: Task 1 envelope builders and existing internal runtime operations.
- Produces: `validateAgentFacingRequest({operation,input})`, public methods including `read`, mode-discriminated input schemas, `responseProjection` metadata, and allowlist-only Case Runtime envelopes.

- [ ] **Step 1: Add failing request and response tests**

Cover all ten operations, exact `{operation,input}` shape, `inspect/knowledge/recover/finish` mode discriminators, ActionRef and coordinate gesture branches, absence of `capability`, and rejection of mixed branches. Add assertions that `recordResult`/`plan` contain no Scene or global knowledge state and that every method defines `responseProjection`.

```js
assert.deepStrictEqual(validateAgentFacingRequest({ operation: 'read', input: { ref: 'scene-1' } }), []);
assert.deepStrictEqual(validateAgentFacingRequest({ capability: 'observe' })[0].code, 'FIELD_REQUIRED');
assert.ok(PUBLIC_CONTRACT.methods.act.responseProjection);
assert.strictEqual(Object.hasOwn(projected, 'scene'), false);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentCapabilityContract agentFacingCaseRuntime agentFacingBoundary`

Expected: FAIL because the current contract accepts `capability`, has nine operations, and copies internal response fields.

- [ ] **Step 3: Replace the public request schemas**

Define shared input types once, make each method schema validate its `input`, add `read`, encode the four mode unions, and preserve the published-action versus coordinate-action union. Each method must include explicit `responseProjection.resultFields`, `primaryResourceType`, `associatedResourceTypes`, plus outcome branches where the spec requires them.

- [ ] **Step 4: Replace spread-and-delete projection**

Build each response through Task 1 builders and a projection selected by operation/mode/outcome. Translate public input to the existing core request without changing core domain behavior. Map known validation failures to `REJECTED`, known technical failures to `FAILED`, and uncertain effects to `UNKNOWN`.

- [ ] **Step 5: Enforce finalized behavior and compact CLI JSON**

Allow `read` through the finalized guard while rejecting every mutating operation with `CASE_RUNTIME_FINALIZED`. Write one compact JSON object to stdout in normal CLI mode; retain pretty formatting only in explicit human-debug code paths.

- [ ] **Step 6: Run focused tests and confirm pass**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentCapabilityContract agentFacingCaseRuntime agentFacingBoundary`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-contract.js skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-translator.js skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-client.js skills/mobile-ai-visual-test/scripts/tests/agent-capability-contract.test.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-case-runtime.test.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-boundary.test.js
git commit -m "feat(mavt): unify case runtime agent protocol"
```

### Task 3: Case Runtime Immutable Resource Catalog and read(ref)

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/case-runtime/agent-resource-store.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-translator.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/lifecycle.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-agent-bootstrap.js`
- Create: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-resources.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: existing immutable Scene/event/evidence/result artifacts and Bootstrap handoff envelope.
- Produces: `publishResource(execDir, descriptor, content)`, `readPublishedResource(execDir, ref)`, resource-specific projectors, `operations/resources/` snapshots only where no immutable source already exists, and Case Brief handoff registration.

- [ ] **Step 1: Add failing resource tests and register the suite**

Test exact-ref reads for every catalog family that has a fixture, resource scope mismatch, unknown ref, digest mismatch, canonical-path escape, ref immutability, main-resource omission from `resources`, association descriptors, finalized reads, Case Brief re-read, complete `elementSet`, immutable Case Flow revisions, and checkpoint Ledger snapshots.

```js
const observed = run(execDir, { operation: 'observe', input: {} });
const reread = run(execDir, { operation: 'read', input: { ref: observed.data.ref } });
assert.deepStrictEqual(reread.data, observed.data);
assert.ok(!reread.resources.some((item) => item.ref === reread.data.ref));
```

- [ ] **Step 2: Run the new suite and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentFacingResources`

Expected: FAIL because the resource store and `read` resolver do not exist.

- [ ] **Step 3: Implement scoped publication and resolution**

Persist only composite snapshots lacking an immutable authority. For existing artifacts, store a descriptor binding ref, type, canonical relative path/event identity, and SHA-256. Reject conflicting re-publication and never recompute a mutable latest view during read.

- [ ] **Step 4: Implement canonical resource projectors**

Implement the catalog in the spec: `caseBrief`, `scene`, `screenshot`, `layout`, `elementSet`, `caseFlow`, `checkpointLedger`, `checkpointResult`, `knowledgeQuery`, `candidateSet`, `knowledgeDocument`, `knowledgeReview`, `actionSpatialEvidence`, `planResult`, `planEvidence`, `externalActionDeclaration`, `technicalFact`, and `caseResult`. Scene contains all published actions but not raw layout/non-interactive elements.

- [ ] **Step 5: Wire primary and associated resources**

Ensure `observe`, `act`, `runPlan`, `knowledge.query`, and scene-producing recovery return their complete primary resource in `data`; all other complex information is descriptors only. Bootstrap registers its handoff-backed `caseBriefRef` for the bound execution without creating a second mutable Brief copy.

- [ ] **Step 6: Run resource and runtime regressions**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentFacingResources agentFacingCaseRuntime agentFacingPlan agentFacingCaseFlow knowledge expectationResult runPlan033`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime/agent-resource-store.js skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-translator.js skills/mobile-ai-visual-test/scripts/case-runtime/lifecycle.js skills/mobile-ai-visual-test/scripts/case-agent-bootstrap.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-resources.test.js skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): add immutable runtime resources"
```

### Task 4: Coordinator Unified Transport, Projection, and Resources

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-service.js`
- Modify: `skills/mobile-ai-visual-test/scripts/coordinator-agent.js`
- Create: `skills/mobile-ai-visual-test/scripts/coordinator/agent-resource-store.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/coordinator-agent-facing.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/execution-flow-combination.test.js`

**Interfaces:**
- Consumes: Task 1 envelope builders and existing Coordinator state machine outputs.
- Produces: workspace-bound `prepareRun`, one returned run-bound command for all later requests, Coordinator `read(ref)`, and immutable `runDecision`, `caseDispatch`, `runProgress`, `runSummary`, and `coordinatorDiagnostic` resources.

- [ ] **Step 1: Add failing transport and projection tests**

Replace request-file and per-operation command assertions with stdin `{operation,input}` calls. Assert `prepareRun.input` only requires `caseNos`, all later responses return the same command, known Coordinator outcomes use top-level `SUCCEEDED`, internal paths never escape, and every outcome matches the spec's result/data/resource allowlist.

- [ ] **Step 2: Run Coordinator suites and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js coordinatorAgentFacing executionFlowCombination`

Expected: FAIL because the current Coordinator exposes request paths, several commands, and domain status at the top level.

- [ ] **Step 3: Migrate Coordinator request contract and CLI**

Parse exactly one stdin request per invocation. Bind workspace in the initial command and run state in the returned command. Remove public `requestPath`, confirm/advance/cancel command maps, and any need for the Agent to resubmit workspace/platform facts already bound by state.

- [ ] **Step 4: Add allowlisted outcome projectors**

Project `runDecision`, `caseDispatch`, `runProgress`, and `runSummary` according to the spec table. Keep domain state machine semantics unchanged. `BLOCKED` is a successful known Coordinator result, not a technical error.

- [ ] **Step 5: Add immutable Coordinator resources and reads**

Snapshot decision/progress/summary projections atomically with state revision and SHA-256, bind dispatch refs to the immutable handoff public reference, and resolve diagnostics only inside the run. Terminal repeated `advanceRun`/`cancelRun` must return the original `runSummary` ref; terminal `confirmRun` must return `COORDINATOR_TERMINAL`.

- [ ] **Step 6: Run Coordinator suites and confirm pass**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js coordinatorAgentFacing executionFlowCombination control batchCancellation batchReconcile`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-contract.js skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-service.js skills/mobile-ai-visual-test/scripts/coordinator-agent.js skills/mobile-ai-visual-test/scripts/coordinator/agent-resource-store.js skills/mobile-ai-visual-test/scripts/tests/coordinator-agent-facing.test.js skills/mobile-ai-visual-test/scripts/tests/execution-flow-combination.test.js
git commit -m "feat(mavt): unify coordinator agent protocol"
```

### Task 5: Bootstrap, MCP, Generated Documentation, and Contract Manifest

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/case-agent-bootstrap.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/mcp-server.js`
- Modify: `skills/mobile-ai-visual-test/scripts/build-agent-facing-docs.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/agent-contract-manifest.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-handoff.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-transport-parity.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/formal-entrypoints.test.js`
- Modify generated files under: `skills/mobile-ai-visual-test/references/coordinator/`
- Modify generated files under: `skills/mobile-ai-visual-test/references/case-runtime/`

**Interfaces:**
- Consumes: domain `PUBLIC_CONTRACT` definitions, shared envelope, and Task 3 Case Brief resource registration.
- Produces: Bootstrap `CASE_BRIEF_READY` envelope, MCP argument-to-canonical-request mapping, generated protocol indexes/method/error/resource pages, and role manifests containing those generated files.

- [ ] **Step 1: Add failing Bootstrap/MCP/docs tests**

Assert Bootstrap success has one `caseBrief` primary `data`, no sibling `casePrompt/brief/scene`, MCP schemas are method `input` schemas while handlers produce `{operation,input}`, MCP `isError` is exactly `status !== 'SUCCEEDED'`, and malformed recognized operations include both documentation refs.

- [ ] **Step 2: Run focused suites and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentHandoff agentFacingTransportParity agentFacingDocs entrypoints`

Expected: FAIL against old Bootstrap shape, capability mapping, and generated pages.

- [ ] **Step 3: Migrate Bootstrap envelope**

After the existing one-time lease claim, emit `successEnvelope` with `operation: 'bootstrap'`, simple dispatch result fields, complete `caseBrief` primary data, and associated startup resource descriptors. Preserve existing deterministic rejection on duplicate claim.

- [ ] **Step 4: Migrate MCP from the public contract**

Generate one tool per public method from its `inputSchema`; map `{name,args}` to `{operation:name,input:args}`. Do not remove a synthetic `capability` field because none exists. Preserve the same validator and projector used by CLI.

- [ ] **Step 5: Generate short indexes and detailed pages**

Generate request/response rules, operation directory, method signatures, resource catalog, and error pages from `PUBLIC_CONTRACT`. Method pages include primary/associated resources and minimal valid examples. Error projection emits `documentationRef` plus `operationDocumentationRef` only for a recognized invalid operation request.

- [ ] **Step 6: Update manifest and regenerate artifacts**

Add each role's protocol index, `read` page, and resource catalog to `agent-contract-manifest`; run the repository's docs builder and assert generated artifacts are current rather than hand-editing their content.

- [ ] **Step 7: Run focused suites and confirm pass**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js agentHandoff agentFacingTransportParity agentFacingDocs agentFacingSingleContract entrypoints boundaries`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-agent-bootstrap.js skills/mobile-ai-visual-test/scripts/case-runtime/mcp-server.js skills/mobile-ai-visual-test/scripts/build-agent-facing-docs.js skills/mobile-ai-visual-test/scripts/lib/agent-contract-manifest.js skills/mobile-ai-visual-test/scripts/tests/agent-handoff.test.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-transport-parity.test.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js skills/mobile-ai-visual-test/scripts/tests/formal-entrypoints.test.js skills/mobile-ai-visual-test/references/coordinator skills/mobile-ai-visual-test/references/case-runtime
git commit -m "docs(mavt): publish unified agent protocol"
```

### Task 6: Protocol Telemetry and Report Projection

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/telemetry.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-client.js`
- Modify: `skills/mobile-ai-visual-test/scripts/report/report-service.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/execution-metrics.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/report-reader.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/dashboard.test.js`

**Interfaces:**
- Consumes: finalized public envelopes and authoritative execution metrics events.
- Produces: per-call `resultBytes`, `dataBytes`, `resourceDescriptorBytes`, total bytes, resource type counts, and `readTargetType`, plus report summary without body or command capture.

- [ ] **Step 1: Add failing telemetry and report tests**

Assert measurements are computed from the serialized public response sections, resource type counts are correct, `readTargetType` is present only for reads, resource content and command strings are absent, and dashboards can display protocol summaries without reading Agent response logs as business truth.

- [ ] **Step 2: Run focused suites and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js metrics report dashboard`

Expected: FAIL because current telemetry does not expose the unified section/resource measurements.

- [ ] **Step 3: Record bounded metadata after projection**

Measure the final envelope just before transport write. Persist scalar byte counts and type counters through existing telemetry events; never persist `data.content`, request payloads, full refs containing unsafe paths, or commands.

- [ ] **Step 4: Aggregate authoritative protocol summaries**

Extend report metrics projection with per-operation totals, section byte totals, resource type counts, and read target type counts. Leave Case Flow, checkpoint, trace, and verdict projections sourced from their existing authoritative artifacts.

- [ ] **Step 5: Run focused suites and confirm pass**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js metrics report dashboard narrative trace`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime/telemetry.js skills/mobile-ai-visual-test/scripts/case-runtime/agent-facing-client.js skills/mobile-ai-visual-test/scripts/report/report-service.js skills/mobile-ai-visual-test/scripts/tests/execution-metrics.test.js skills/mobile-ai-visual-test/scripts/tests/report-reader.test.js skills/mobile-ai-visual-test/scripts/tests/dashboard.test.js
git commit -m "feat(mavt): observe agent protocol usage"
```

### Task 7: Execution Schema 14 and Production Boundary Migration

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/lifecycle.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/store.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/result-integrity.js`
- Modify: `skills/mobile-ai-visual-test/scripts/case-runtime/telemetry.js`
- Modify: `skills/mobile-ai-visual-test/scripts/batch/completion-service.js`
- Modify: `skills/mobile-ai-visual-test/scripts/batch/completion.js`
- Modify: `skills/mobile-ai-visual-test/scripts/batch/dispatch-service.js`
- Modify: `skills/mobile-ai-visual-test/scripts/batch/reconcile-service.js`
- Modify: `skills/mobile-ai-visual-test/scripts/execution/contracts/validation-profile-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/completion-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/execution-artifact-manifest.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/execution-closure.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/execution-evidence-graph.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/execution-lifecycle.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/readers/current-execution.js`
- Modify schema fixtures across: `skills/mobile-ai-visual-test/scripts/tests/`

**Interfaces:**
- Consumes: the completed schema-14 writers and resource artifacts from Tasks 2-6.
- Produces: one current execution schema value of `14` at every production boundary, with no schema-13 compatibility path.

- [ ] **Step 1: Add failing schema-boundary assertions**

Change representative creation, completion, batch, reader, evidence, and report fixtures to schema 14. Add source scans proving production code contains no `schemaVersion === 13`, `schemaVersion !== 13`, old Reader branch, conversion function, or dual writer.

- [ ] **Step 2: Run schema-sensitive suites and confirm failure**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js caseRuntime caseFlow caseFlowResultIntegrity metrics report publication batchReconcile boundaries`

Expected: FAIL because production boundaries still require schema 13.

- [ ] **Step 3: Switch writers and strict readers to schema 14**

Set `EXECUTION_SCHEMA_VERSION` and the current Reader `SCHEMA_VERSION` to `14`, then update every explicit production comparison listed above. A schema-13 execution must fail with `FORMAT_UNSUPPORTED`; do not convert it or partially read it.

- [ ] **Step 4: Update all fixtures mechanically**

Change only execution schema fixtures from 13 to 14; preserve unrelated artifact schema versions. Keep explicit tests proving schema 13 is rejected at current-reader boundaries.

- [ ] **Step 5: Run schema-sensitive suites and confirm pass**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js caseRuntime caseFlow caseFlowResultIntegrity metrics report publication batchReconcile boundaries`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime skills/mobile-ai-visual-test/scripts/batch skills/mobile-ai-visual-test/scripts/execution skills/mobile-ai-visual-test/scripts/lib skills/mobile-ai-visual-test/scripts/tests
git commit -m "refactor(mavt): require execution schema 14"
```

### Task 8: End-to-End Migration and Legacy Protocol Removal

**Files:**
- Modify remaining references under: `skills/mobile-ai-visual-test/scripts/tests/`
- Modify generated/current docs under: `skills/mobile-ai-visual-test/references/`
- Modify: `skills/mobile-ai-visual-test/SKILL.md`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: a repository with no formal `capability` request, request-file transport, implicit complex-data append, old execution Reader, or stale Agent documentation.

- [ ] **Step 1: Add final invariant scans**

Extend architecture tests to reject formal Agent-facing `capability` fields, public `requestPath`, `requiredBeforeNegativeConclusion`, spread-copy response projection, schema-13 production comparisons, duplicated primary refs, and resource descriptions lacking `ref/type/role`. Exempt internal runtime capability IDs and non-Agent fixture schemas explicitly by path and syntax.

- [ ] **Step 2: Run the full suite and capture all failures**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js`

Expected: any remaining failures identify stale formal entry points, tests, or generated documentation; product-domain behavior tests should remain unchanged.

- [ ] **Step 3: Migrate remaining formal consumers**

Update publication-flow, cross-platform, warm-session, action-plan, and formal-entrypoint fixtures to call the canonical request envelope and consume result/data/resource refs. Remove obsolete helpers that write request files or branch on old top-level domain statuses.

- [ ] **Step 4: Rebuild generated artifacts and scan legacy vocabulary**

Run the official docs/contract builders used by the test suite, then use `rg` assertions scoped to formal Agent interfaces. Internal `capabilityId` remains valid inside Runtime core; public `capability`, `requestPath`, and response-global Scene/knowledge append do not.

- [ ] **Step 5: Run critical workflow regressions**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js runPlan033 platformRuntime crossPlatformExecution agentFacingPublicationFlow agentHandoff coordinatorAgentFacing`

Expected: PASS, including the short-lived child-lock plan and all three platform adapters.

- [ ] **Step 6: Run the complete verification**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js`

Expected: PASS for every registered suite.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Commit**

```bash
git add skills/mobile-ai-visual-test/SKILL.md skills/mobile-ai-visual-test/references skills/mobile-ai-visual-test/scripts
git commit -m "refactor(mavt): remove legacy agent protocol"
```

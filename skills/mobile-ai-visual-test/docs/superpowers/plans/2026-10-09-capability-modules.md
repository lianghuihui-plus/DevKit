# MAVT Capability Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently discoverable and invokable capability modules to the Case Agent runtime, with `bcm-cs` as the first provider.

**Architecture:** A synchronous capability broker owns a frozen execution-scoped catalog and invocation records. The existing Agent-facing Broker dispatches only two new public operations, while provider-specific discovery and invocation remain isolated under `case-runtime/capability-modules/`; device Runtime Core, Handoff, Brief, Case Flow, and verdict aggregation remain unchanged.

**Tech Stack:** Node.js CommonJS, existing MAVT JSON-contract validator and typed-resource/event stores, synchronous child processes, fixture-based executable tests.

**Spec:** `docs/superpowers/specs/2026-10-09-capability-modules-design.md`

## Global Constraints

- Keep execution schema at `14`; capability catalog uses independent `schemaVersion: 1`.
- Every successfully exposed capability is authorized; do not add allowlists, approval, or confirmation.
- Do not add rollback, cleanup, old-value snapshots, locks, mandatory read-after-write, or automatic retry.
- Query once after Baseline Flow and before the first business action; reuse the frozen catalog thereafter.
- Provider methods are synchronous: `probe(context)`, `listCapabilities(context, probeResult)`, and `invoke(request, context)`.
- stdin and MCP expose the same fixed `queryCapabilities` and `useCapability` methods.
- Do not modify Handoff, Case Brief, device Runtime Core, Coordinator, Batch state, Case Flow, Knowledge, CHECK ledger, or verdict aggregation.
- Live `bcm-cs` discovery is auth-blocked by HTTP 403, so provider coverage uses a fake executable and live smoke testing is optional.

---

### Task 1: Provider Contract And Registry

**Files:**
- Create: `scripts/case-runtime/capability-modules/contract.js`
- Create: `scripts/case-runtime/capability-modules/registry.js`
- Create: `scripts/tests/capability-module-contract.test.js`
- Modify: `scripts/self-test.js`

**Interfaces:**
- Consumes: `validateAgentJson(value, schema, options)` from `scripts/lib/agent-json-contract.js`.
- Produces: `validateProvider(provider)`, `validateCapabilityDefinition(definition)`, `createRegistry(providers)`, and `registry.discover(context)`.

- [x] **Step 1: Write the failing provider and registry tests**

```js
assert.throws(() => validateProvider({ manifest: { id: 'Bad ID' } }), /manifest/i);
assert.throws(() => createRegistry([readyProvider, readyProvider]), /duplicate/i);
assert.deepStrictEqual(createRegistry([readyProvider, unavailableProvider]).discover(context), {
  available: [{ moduleId: 'fixture', moduleVersion: '1.0.0', implementationVersion: 'fixture 1', definitions: [definition] }],
  unavailable: [{ moduleId: 'offline', summary: 'Offline fixture', diagnostic: 'not configured' }],
});
```

- [x] **Step 2: Run the focused suite and verify RED**

Run: `node scripts/tests/capability-module-contract.test.js`

Expected: FAIL because `capability-modules/contract.js` does not exist.

- [x] **Step 3: Implement strict manifest, definition, and registry validation**

```js
function createRegistry(providers) {
  const registered = providers.map(validateProvider);
  return {
    discover(context) {
      // Probe each provider independently; READY providers list definitions,
      // UNAVAILABLE and thrown probes become compact module diagnostics.
    },
    get(moduleId) { return registered.find((provider) => provider.manifest.id === moduleId) || null; },
  };
}
```

- [x] **Step 4: Run the suite and verify GREEN**

Run: `node scripts/tests/capability-module-contract.test.js`

Expected: PASS with READY, UNAVAILABLE, malformed, and duplicate-provider cases covered.

- [x] **Step 5: Register the suite and commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime/capability-modules/contract.js skills/mobile-ai-visual-test/scripts/case-runtime/capability-modules/registry.js skills/mobile-ai-visual-test/scripts/tests/capability-module-contract.test.js skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): define capability provider contract"
```

### Task 2: Frozen Catalog And Typed Resources

**Files:**
- Create: `scripts/case-runtime/capability-modules/snapshot-store.js`
- Modify: `scripts/case-runtime/agent-resource-store.js`
- Modify: `scripts/tests/agent-facing-resources.test.js`
- Create: `scripts/tests/capability-catalog-store.test.js`
- Modify: `scripts/self-test.js`

**Interfaces:**
- Consumes: `appendEvent(execDir, type, payload, options)` and existing opaque resource helpers.
- Produces: `loadCatalog(execDir)`, `freezeCatalog(execDir, discovery, options)`, `resolveCapability(execDir, capabilityRef)`, and typed resources `capabilityCatalog` / `capabilityDefinition`.

- [x] **Step 1: Write failing freeze and integrity tests**

```js
const first = freezeCatalog(execDir, discovery, { now: () => '2026-10-09T10:00:00.000Z' });
const second = freezeCatalog(execDir, changedDiscovery);
assert.deepStrictEqual(second, first);
assert.strictEqual(readPublishedResource(execDir, first.available[0].capabilityRef).data.type, 'capabilityDefinition');
assert.throws(() => resolveCapability(otherExecDir, first.available[0].capabilityRef), /scope|integrity/i);
```

- [x] **Step 2: Run the focused suites and verify RED**

Run: `node scripts/tests/capability-catalog-store.test.js`

Expected: FAIL because `snapshot-store.js` does not exist.

- [x] **Step 3: Implement immutable schema-1 snapshots**

```js
// capability-modules/catalog.json
{
  schemaVersion: 1,
  executionId,
  frozenAt,
  digest,
  available,
  unavailable,
}
```

Write the catalog and per-definition JSON atomically, publish opaque refs through the existing store, and append one `capabilityCatalogFrozen` event containing only schema version, digest, and counts.

- [x] **Step 4: Run focused resource suites and verify GREEN**

Run: `node scripts/self-test.js agentFacingResources capabilityCatalogStore`

Expected: PASS; a second freeze reuses byte-equivalent data and never probes or rewrites.

- [x] **Step 5: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime/capability-modules/snapshot-store.js skills/mobile-ai-visual-test/scripts/case-runtime/agent-resource-store.js skills/mobile-ai-visual-test/scripts/tests/agent-facing-resources.test.js skills/mobile-ai-visual-test/scripts/tests/capability-catalog-store.test.js skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): freeze capability catalogs per execution"
```

### Task 3: Public Query Operation

**Files:**
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/runtime-operation-contract.js`
- Modify: `scripts/case-runtime/runtime-broker.js`
- Create: `scripts/case-runtime/capability-modules/broker.js`
- Create: `scripts/tests/agent-facing-capability-query.test.js`
- Modify: `scripts/tests/agent-capability-contract.test.js`
- Modify: `scripts/tests/agent-facing-transport-parity.test.js`
- Modify: `scripts/self-test.js`

**Interfaces:**
- Consumes: `createRegistry(providers)`, `freezeCatalog(execDir, discovery, options)`, and the existing Agent-facing response envelope.
- Produces: public `queryCapabilities({})` and `queryCapabilities(execDir, options)` in the capability broker.

- [x] **Step 1: Write failing public-contract and query tests**

```js
assert.deepStrictEqual(validateAgentFacingRequest({ operation: 'queryCapabilities', input: {} }), []);
const response = executeFacadeRequest(execDir, { operation: 'queryCapabilities', input: {} }, { capabilityProviders: [provider] });
assert.strictEqual(response.status, 'SUCCEEDED');
assert.deepStrictEqual(response.result.available.map((item) => item.name), ['fixture.student.update']);
assert.strictEqual(response.data.type, 'capabilityCatalog');
```

- [x] **Step 2: Run focused suites and verify RED**

Run: `node scripts/tests/agent-facing-capability-query.test.js`

Expected: FAIL because `queryCapabilities` is not in the public contract.

- [x] **Step 3: Add the fixed operation and direct Broker dispatch**

```js
if (request.operation === 'queryCapabilities') {
  return capabilityBroker.queryCapabilities(resolved, options);
}
```

The operation must not enter `runtimeCore.execute`; it returns compact names, summaries, refs, unavailable diagnostics, and the catalog as primary data.

- [x] **Step 4: Run public-contract, transport, and query suites and verify GREEN**

Run: `node scripts/self-test.js agentCapabilityContract agentFacingTransportParity agentFacingCapabilityQuery`

Expected: PASS with identical stdin/MCP translation and repeated-query snapshot reuse.

- [x] **Step 5: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime skills/mobile-ai-visual-test/scripts/tests skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): expose capability discovery to case agents"
```

### Task 4: Validated Invocation And Durable Records

**Files:**
- Create: `scripts/case-runtime/capability-modules/invocation-store.js`
- Modify: `scripts/case-runtime/capability-modules/broker.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/runtime-broker.js`
- Modify: `scripts/case-runtime/agent-resource-store.js`
- Create: `scripts/tests/agent-facing-capability-invocation.test.js`
- Modify: `scripts/self-test.js`

**Interfaces:**
- Consumes: frozen `capabilityDefinition`, `validateAgentJson(input, inputSchema)`, and provider `invoke({ capability, input }, context)`.
- Produces: public `useCapability({ capabilityRef, input, purpose, flowContext? })`, `invokeCapability(execDir, request, options)`, and typed resource `capabilityInvocation`.

- [x] **Step 1: Write failing invocation tests**

```js
const invalid = executeFacadeRequest(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: {}, purpose: '准备学员数据',
} }, options);
assert.strictEqual(invalid.status, 'REJECTED');
assert.strictEqual(provider.calls.length, 0);

const success = executeFacadeRequest(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: '42' }, purpose: '准备学员数据', flowContext: { nodeRef: 'N1' },
} }, options);
assert.strictEqual(success.status, 'SUCCEEDED');
assert.strictEqual(success.data.type, 'capabilityInvocation');
```

- [x] **Step 2: Run the focused suite and verify RED**

Run: `node scripts/tests/agent-facing-capability-invocation.test.js`

Expected: FAIL because `useCapability` is absent.

- [x] **Step 3: Implement ref resolution, dynamic validation, invocation, and redaction**

```js
function invokeCapability(execDir, request, options = {}) {
  const definition = resolveCapability(execDir, request.capabilityRef);
  const issues = validateAgentJson(request.input, definition.inputSchema);
  if (issues.length) return rejectedDynamicInput(issues);
  return persistProviderOutcome(execDir, definition, request, options);
}
```

Persist requested and terminal events, map provider `SUCCEEDED | FAILED | UNKNOWN` without retry, omit secret-like keys from summaries/diagnostics, and retain bounded structured output only in `capabilityInvocation`.

- [x] **Step 4: Run the focused suite and verify GREEN**

Run: `node scripts/self-test.js agentFacingCapabilityInvocation agentFacingResources agentFacingBoundary`

Expected: PASS for success, failed, unknown, timeout, thrown provider, invalid input, forged ref, cross-execution ref, and finalized-execution rejection.

- [x] **Step 5: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime skills/mobile-ai-visual-test/scripts/tests skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): invoke frozen agent capabilities"
```

### Task 5: bcm-cs Provider

**Files:**
- Create: `scripts/case-runtime/capability-modules/modules/bcm-cs/index.js`
- Create: `scripts/case-runtime/capability-modules/modules/bcm-cs/adapter.js`
- Create: `scripts/case-runtime/capability-modules/modules/bcm-cs/response-mapper.js`
- Modify: `scripts/case-runtime/capability-modules/registry.js`
- Create: `scripts/tests/bcm-cs-capability-provider.test.js`
- Modify: `scripts/self-test.js`

**Interfaces:**
- Consumes: `/Users/cm/.bcm-cs/bin/bcm-cs` by default, overrideable as `context.bcmCsExecutable` in tests, and controlled `execFileSync` injection.
- Produces: provider manifest `id: 'bcm-cs'`; discovery from `--output json capabilities list/describe`; invocation from the frozen CLI execution descriptor.

- [x] **Step 1: Write a fake executable and failing provider tests**

```js
const provider = createBcmCsProvider({ executable: fakeExecutable });
const probe = provider.probe(context);
const definitions = provider.listCapabilities(context, probe);
assert.deepStrictEqual(definitions.map((item) => item.name), ['student.update']);
assert.deepStrictEqual(provider.invoke({ capability: definitions[0], input: { studentId: '42' } }, context).status, 'SUCCEEDED');
```

The fixture must record argv and return realistic complete JSON for version, list, describe, success, failure, malformed output, 403, and timeout cases.

- [x] **Step 2: Run the focused suite and verify RED**

Run: `node scripts/tests/bcm-cs-capability-provider.test.js`

Expected: FAIL because the provider does not exist.

- [x] **Step 3: Implement bounded CLI discovery and invocation**

```js
execFileSync(executable, ['--output', 'json', 'capabilities', 'describe', capabilityId], {
  encoding: 'utf8', timeout: discoveryTimeoutMs, maxBuffer,
});
```

Reuse `probeResult.discoverySeed`, exclude malformed individual descriptions with diagnostics, never use a shell, never accept executable/path/flags from Agent input, and map uncertain process outcomes to `UNKNOWN`.

- [x] **Step 4: Run provider and broker suites and verify GREEN**

Run: `node scripts/self-test.js bcmCsCapabilityProvider capabilityModuleContract agentFacingCapabilityQuery agentFacingCapabilityInvocation`

Expected: PASS without contacting the live BCM service.

- [x] **Step 5: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/case-runtime/capability-modules skills/mobile-ai-visual-test/scripts/tests/bcm-cs-capability-provider.test.js skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): add bcm-cs capability provider"
```

### Task 6: Artifacts, Trace, Generated Docs, And Agent Guidance

**Files:**
- Modify: `scripts/lib/execution-artifact-manifest.js`
- Modify: `scripts/report/execution-trace.js`
- Modify: `scripts/report/current-report-html.js`
- Modify: `scripts/tests/execution-trace.test.js`
- Modify: `scripts/tests/report-reader.test.js`
- Modify: `scripts/tests/agent-facing-docs.test.js`
- Modify: `prompts/case-agent.md`
- Modify: `references/case-execution-principles.md`
- Modify: generated files under `references/case-runtime/`

**Interfaces:**
- Consumes: `capabilityCatalogFrozen` and capability invocation events/resources.
- Produces: artifact manifest entries, redacted capability trace rows, generated method/resource/error docs, and explicit Case Agent timing guidance.

- [ ] **Step 1: Write failing artifact, trace, and guidance tests**

```js
assert.ok(manifest.artifacts.some((item) => item.path.endsWith('capability-modules/catalog.json')));
assert.deepStrictEqual(trace.capabilityInvocations[0].status, 'SUCCEEDED');
assert.match(casePrompt, /Baseline Flow.*queryCapabilities.*首次业务动作/s);
assert.doesNotMatch(renderedHtml, /secret-token-value/);
```

- [ ] **Step 2: Run the focused suites and verify RED**

Run: `node scripts/self-test.js trace report agentFacingDocs agentCapabilityContract`

Expected: FAIL on missing capability artifacts, trace projection, and generated documentation.

- [ ] **Step 3: Implement projections and regenerate docs**

Run: `node scripts/build-agent-facing-docs.js`

The report shows capability name, purpose, outcome, time, and flow context; it does not expose raw secrets or turn capability outcomes into product verdicts.

- [ ] **Step 4: Run focused suites and verify GREEN**

Run: `node scripts/self-test.js trace report agentFacingDocs agentCapabilityContract boundaries`

Expected: PASS and generated files match the authoritative contract.

- [ ] **Step 5: Commit**

```bash
git add skills/mobile-ai-visual-test/scripts/lib/execution-artifact-manifest.js skills/mobile-ai-visual-test/scripts/report skills/mobile-ai-visual-test/scripts/tests skills/mobile-ai-visual-test/prompts/case-agent.md skills/mobile-ai-visual-test/references
git commit -m "docs(mavt): publish capability usage to agents and reports"
```

### Task 7: End-To-End Compatibility Verification

**Files:**
- Modify: `scripts/tests/agent-facing-case-runtime.test.js`
- Modify: `scripts/tests/architecture-boundaries.test.js`
- Modify: `scripts/tests/formal-entrypoints.test.js`

**Interfaces:**
- Consumes: complete Agent-facing capability flow.
- Produces: regression proof that capability query/use is additive and old executions remain governed by existing protocol digest checks.

- [ ] **Step 1: Add a failing end-to-end test**

```js
// plan -> queryCapabilities -> read(definition) -> useCapability -> observe/finish
assert.strictEqual(runtimeCoreCallsForCapabilities, 0);
assert.strictEqual(readJson(path.join(execDir, 'execution.json')).schemaVersion, 14);
assert.strictEqual(loadCatalog(execDir).schemaVersion, 1);
```

- [ ] **Step 2: Run focused end-to-end tests and verify RED**

Run: `node scripts/self-test.js agentFacingCaseRuntime boundaries entrypoints`

Expected: FAIL until formal entrypoints and architecture assertions recognize the two additive operations.

- [ ] **Step 3: Complete only the compatibility wiring exposed by the failing tests**

Keep finalized execution behavior unchanged: only `read` remains available after finalization. Keep `runtimeSha` coverage automatic through the existing recursive `scripts/case-runtime/` implementation digest.

- [ ] **Step 4: Run full verification**

Run: `node scripts/self-test.js`

Expected: every registered suite passes with no warnings.

- [ ] **Step 5: Inspect the diff and commit**

```bash
git diff --check
git status --short
git add skills/mobile-ai-visual-test/scripts/tests
git commit -m "test(mavt): verify capability module integration"
```

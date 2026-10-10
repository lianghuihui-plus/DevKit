# Direct bcm-cs CLI Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `bcm-cs` to Case Agent as one native CLI capability without changing MAVT's capability query or invocation workflow.

**Architecture:** Keep Registry, Broker, catalog freezing, `queryCapabilities`, `read`, and `useCapability` unchanged. Replace only the BCM Provider's REST-oriented discovery and invocation with a static `bcm-cs.cli` definition that executes a fixed binary with validated argv and maps process results to the existing provider outcome contract.

**Tech Stack:** Node.js CommonJS, `child_process.spawnSync`, existing MAVT capability Provider/Broker contracts, assertion-based Node tests.

**Spec:** `docs/superpowers/specs/2026-10-09-capability-modules-design.md`

## Global Constraints

- Work only in branch `codex/mavt-direct-bcm-cli` under the isolated worktree.
- Do not change Coordinator, Handoff, Case Flow, device Runtime, result aggregation, `queryCapabilities`, or `useCapability` timing.
- Execute only the configured `bcm-cs` binary with argv arrays and `shell: false`.
- Do not translate BCM commands to REST, interpret business parameters, auto-retry, or add permission checks.
- Preserve timeout handling, `SUCCEEDED / FAILED / UNKNOWN`, redaction, immutable invocation records, and report projection.

---

### Task 1: Define The Native CLI Provider Contract

**Files:**
- Modify: `scripts/tests/bcm-cs-capability-provider.test.js`
- Modify: `scripts/case-runtime/capability-modules/modules/bcm-cs/index.js`
- Modify: `scripts/case-runtime/capability-modules/modules/bcm-cs/adapter.js`

**Interfaces:**
- Consumes: configured `bcm-cs` executable and validated `{ args: string[] }` input.
- Produces: one capability definition named `cli`; `createAdapter().version()` and `createAdapter().invoke(args)`.

- [x] **Step 1: Replace the REST fixture with native CLI behavior tests**

Create a fake executable that records argv and supports `version`, `--help`, JSON output, a high-level `live instant create` command, deterministic failure, and timeout-like failure. Assert that discovery publishes only `cli`, with a required non-empty `args` array, and does not run BCM business discovery commands.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node scripts/tests/bcm-cs-capability-provider.test.js`

Expected: FAIL because the current Provider publishes per-business REST capabilities and does not accept `{ args }`.

- [x] **Step 3: Implement the static definition and argv passthrough**

Make `probe` depend only on `bcm-cs version`, have `listCapabilities` return the validated `cli` definition, and have `invoke` pass `request.input.args` unchanged to the fixed executable. Keep discovery timeout 15 seconds, invocation timeout 60 seconds, 4 MiB buffer, UTF-8, and `shell: false`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node scripts/tests/bcm-cs-capability-provider.test.js`

Expected: PASS; recorded argv exactly match Agent input and contain no `api METHOD PATH --body` translation.

### Task 2: Preserve Native Output And Existing Runtime Semantics

**Files:**
- Modify: `scripts/tests/bcm-cs-capability-provider.test.js`
- Modify: `scripts/case-runtime/capability-modules/modules/bcm-cs/response-mapper.js`

**Interfaces:**
- Consumes: spawn result `{ status, signal, error, stdout, stderr }`.
- Produces: existing Provider outcome `{ status, summary, output, diagnostic }` with JSON objects or plain text output.

- [x] **Step 1: Add failing output and error classification tests**

Assert exit-zero JSON remains an object, exit-zero help remains a string and succeeds, deterministic non-zero exit is `FAILED`, and timeout/signal outcomes are `UNKNOWN`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node scripts/tests/bcm-cs-capability-provider.test.js`

Expected: FAIL because the current response mapper treats non-JSON successful stdout as `UNKNOWN`.

- [x] **Step 3: Implement JSON-or-text success mapping**

Trim stdout; return `null` for empty success output, parsed JSON when valid, and the original trimmed string otherwise. Retain current failure diagnostics and uncertainty detection without retries.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node scripts/tests/bcm-cs-capability-provider.test.js`

Expected: PASS for success, failure, and unknown paths.

### Task 3: Verify Broker Integration And Regression Boundary

**Files:**
- Modify: `scripts/tests/bcm-cs-capability-provider.test.js`
- Modify: `scripts/case-runtime/capability-modules/invocation-store.js`
- Verify unchanged: `scripts/case-runtime/capability-modules/broker.js`
- Verify unchanged: `scripts/case-runtime/runtime-broker.js`
- Verify unchanged: `references/case-execution-principles.md`

**Interfaces:**
- Consumes: the existing `queryCapabilities -> read -> useCapability` workflow.
- Produces: frozen `bcm-cs.cli` catalog entry and redacted invocation records through the unchanged Broker.

- [x] **Step 1: Add a failing end-to-end Broker assertion**

Query the catalog, assert it contains only `bcm-cs.cli`, invoke it through `useCapability`, and verify the fake executable receives exact argv. Persisted argv must retain commands, flags, and non-sensitive values while redacting split/equal-form phone or credential values from input, output, diagnostics, and events.

- [x] **Step 2: Run the focused integration test**

Run: `node scripts/tests/bcm-cs-capability-provider.test.js`

Expected: PASS after Tasks 1 and 2, proving no public workflow changes are required.

- [x] **Step 3: Run capability and documentation regression suites**

Run: `node scripts/self-test.js bcmCsCapabilityProvider capabilityModuleContract capabilityCatalogStore agentFacingCapabilityQuery agentFacingCapabilityInvocation agentFacingDocs boundaries`

Expected: PASS with the existing public operations and timing guidance unchanged.

- [x] **Step 4: Run the full self-test**

Run: `node scripts/self-test.js`

Expected: PASS with zero failures.

# Runtime Command Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded Agent-facing `runPlan` capability that executes short action/capture/locate/check sequences atomically while preserving the Agent/Runtime responsibility boundary.

**Architecture:** Keep existing `observe`, `act`, and `inspect` semantics unchanged. Add a plan contract and service that validates a finite declarative step list, dispatches low-level device actions and screenshot-only captures under one Runtime lock, persists immutable step/evidence events, and returns facts for the Agent to interpret. Runtime performs only deterministic technical checks; Agent remains responsible for visual interpretation and business results.

**Tech Stack:** Node.js CommonJS modules, JSON schema-like repository contracts, shell platform adapters for Android/HarmonyOS/iOS, JSONL event/telemetry stores, Node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-09-18-runtime-command-plan-design.md`

## Global Constraints

- `runPlan` is an allowlisted declarative plan, never arbitrary Shell, JavaScript, file mutation, or unbounded loop execution.
- Runtime may return technical facts and evidence only; it must not call an LLM or decide PASS/FAIL/INCONCLUSIVE.
- Existing `observe`, `act`, `inspect`, and `recordResult` behavior remains backward compatible.
- Every device action has an operation/transaction identity; unknown device outcomes are never replayed automatically.
- `SCREENSHOT_ONLY` captures must preserve PNG validation, sha256, dimensions, capture timing, and immutable evidence references.
- All new public methods, errors, docs, and tests must be generated or registered through the repository's existing contract/manifests.

### Task 1: Define the plan schema and public contract

**Files:**
- Create: `scripts/case-runtime/plan-contract.js`
- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/runtime-operation-contract.js`
- Modify: `scripts/case-runtime/contract.js`
- Test: `scripts/tests/agent-facing-boundary.test.js`
- Test: `scripts/tests/agent-facing-case-runtime.test.js`
- Test: `scripts/tests/plan-contract.test.js`

**Interfaces:**
- `plan-contract.js` exports `PLAN_STEP_TYPES`, `PLAN_LOCATOR_KINDS`, `PLAN_CHECK_KINDS`, `validatePlanRequest(request, context)`, and `normalizePlanRequest(request)`.
- The public Agent capability list gains `runPlan`; the internal operation contract gains an agent-accessible `runPlan` operation with request fields `basedOnSceneId`, `steps`, `purpose`, `flowContext`, and `decision`.
- A valid normalized step has `{ id, type, ...typeSpecificFields }`; IDs are unique, references use `$stepId.field`, and the plan has a finite `maxDurationMs` plus at most 12 steps.

- [ ] **Step 1: Write failing contract tests** for unsupported capability fields, duplicate step IDs, unknown step types, missing `basedOnSceneId`, invalid references, unbounded duration, unsupported locator/check providers, and the valid 033-shaped plan.
- [ ] **Step 2: Run the focused tests** with `node scripts/tests/plan-contract.test.js` and confirm they fail because the contract module and capability are absent.
- [ ] **Step 3: Implement the schema and normalization** with explicit allowlists for `act`, `wait`, `capture`, `locate`, `check`, and `checkpoint`; reject arbitrary nested commands and reject `doubleTap` as a substitute for an explicitly planned pair of taps when the plan declares an interval.
- [ ] **Step 4: Wire Agent-facing and internal contracts** so `runPlan` has documented success statuses `PLAN_COMPLETED`, `PLAN_PARTIAL`, `PLAN_INTERRUPTED`, `REQUEST_INVALID`, and `TECHNICAL`.
- [ ] **Step 5: Run the focused tests** and then `node scripts/tests/agent-facing-boundary.test.js` and `node scripts/tests/agent-facing-case-runtime.test.js`.

### Task 2: Add low-level screenshot-only capture

**Files:**
- Create: `scripts/platform/capture.sh`
- Create: `scripts/platform/adapters/android/capture.sh`
- Create: `scripts/platform/adapters/harmony/capture.sh`
- Modify: `scripts/platform/adapters/ios/lib/ios-driver.js`
- Create: `scripts/platform/adapters/ios/capture.sh`
- Modify: `scripts/platform/device-port.js`
- Test: `scripts/tests/platform-capture.test.js`
- Test: `scripts/tests/platform-contract.test.js`

**Interfaces:**
- `invokeScreenshotCapture(execDir, validated, options)` runs the platform capture adapter and returns `{ binding, adapterResult, evidence }` without invoking layout/control-tree capture.
- Adapter output is `{ schemaVersion: 1, type: "capture", platform, time, artifacts: { screenshot }, device, app, captureTiming }`.

- [ ] **Step 1: Write adapter contract tests** that assert every platform returns a valid PNG artifact, frozen device/App identity, and capture timing, and that no layout artifact is required.
- [ ] **Step 2: Run the focused platform tests** and confirm the new capture entrypoint is missing.
- [ ] **Step 3: Implement Android capture** using `adb exec-out screencap -p`, HarmonyOS capture using `hdc uitest screenCap` plus `file recv`, and iOS capture by reusing the active Appium session screenshot path and PNG decoder.
- [ ] **Step 4: Implement `device-port.js` validation** for capture artifacts using the existing safe artifact, PNG inspection, binding, and sha256 helpers.
- [ ] **Step 5: Run the focused platform tests** and the existing Android/Harmony/iOS adapter contract suites.

### Task 3: Refactor action dispatch for plan execution

**Files:**
- Modify: `scripts/case-runtime/action-service.js`
- Modify: `scripts/platform/device-port.js`
- Modify: `scripts/case-runtime/transaction-manager.js`
- Test: `scripts/tests/action-plan-dispatch.test.js`
- Test: `scripts/tests/case-runtime.test.js`

**Interfaces:**
- `action-service.js` exposes an internal `dispatchAction(execDir, request, options)` that prepares and dispatches one action, records the device result, but does not automatically call post-action `observe`.
- Existing `act()` calls `dispatchAction()` and keeps its current post-action full Scene behavior.
- Plan execution receives a `planId` and step ID so action transactions and events remain attributable to the plan.

- [ ] **Step 1: Add failing tests** proving a plan action can return after device dispatch without the 500ms post-action settle/full Scene, while ordinary `act` still produces `POST_ACTION` Scene and `actionCompleted` exactly as before.
- [ ] **Step 2: Run the focused action tests** and record the current coupling between `act` and `sceneService.observe`.
- [ ] **Step 3: Extract the dispatch transaction path** from `act()` without changing action validation, stale Scene guards, spatial evidence, iOS unknown-outcome handling, or input redaction.
- [ ] **Step 4: Add plan attribution** to action transaction/event payloads and preserve the no-replay rule for dispatch failures.
- [ ] **Step 5: Run action/runtime regression tests** including `node scripts/tests/case-runtime.test.js`.

### Task 4: Implement deterministic locate and check providers

**Files:**
- Create: `scripts/case-runtime/plan-locator.js`
- Create: `scripts/case-runtime/plan-checks.js`
- Create: `scripts/case-runtime/plan-evidence.js`
- Test: `scripts/tests/plan-locator.test.js`
- Test: `scripts/tests/plan-checks.test.js`

**Interfaces:**
- `locate(execDir, step, context)` returns `{ status: "LOCATED", point, bounds, provider, confidence, evidenceRef }` or a typed technical failure; first providers are `ELEMENT_REF`, `POINT`, and `REGION`.
- `check(execDir, step, context)` returns `{ status: "CHECKED", predicate, outcome, technicalFactRef }`; first predicates are `CAPTURE_AVAILABLE`, `ELEMENT_VISIBLE`, `ELEMENT_ENABLED`, `APP_IN_FOREGROUND`, `SCREEN_CHANGED`, and `REFERENCE_EXISTS`.
- `plan-evidence.js` validates and records locator/check inputs and outputs without writing a business result.

- [ ] **Step 1: Write failing tests** for element lookup against a full Scene, normalized point validation, region bounds, missing source capture, unsupported provider, and each deterministic check predicate.
- [ ] **Step 2: Run the focused tests** and confirm the provider modules are absent.
- [ ] **Step 3: Implement `ELEMENT_REF` from existing Scene elements** and `POINT`/`REGION` normalization against the source screenshot dimensions; make confidence `1` only for direct references and never fabricate a point.
- [ ] **Step 4: Implement technical checks** using existing Scene/evidence stores and screenshot hashes; do not compare free-form business text or emit PASS/FAIL case verdicts.
- [ ] **Step 5: Run focused tests** and add explicit `LOCATOR_UNSUPPORTED`, `TARGET_NOT_FOUND`, and `PLAN_CHECK_FAILED` diagnostics.

### Task 5: Implement plan execution and immutable evidence

**Files:**
- Create: `scripts/case-runtime/plan-service.js`
- Modify: `scripts/case-runtime/runtime-core.js`
- Modify: `scripts/case-runtime/store.js`
- Modify: `scripts/case-runtime/scene-service.js`
- Modify: `scripts/case-runtime/telemetry.js`
- Test: `scripts/tests/plan-service.test.js`
- Test: `scripts/tests/execution-metrics.test.js`

**Interfaces:**
- `plan-service.runPlan(execDir, request, options)` returns `{ status, planId, steps, sceneRefs, remainingMs, technicalFacts }` and executes under `store.withRuntimeLock`.
- A screenshot-only capture writes a Scene with `captureMode: "SCREENSHOT_ONLY"`, `sourceOperation: "runPlan"`, unavailable layout evidence, and normal screenshot integrity fields; it does not replace `current-scene.json` unless `promote: true`.
- Plan events are append-only: `planRequested`, `planStepStarted`, `planStepCompleted`/`planStepFailed`, and `planCompleted`/`planInterrupted`.

- [ ] **Step 1: Write failing service tests** for ordered execution, `$step.field` references, wait budget, screenshot-only Scene persistence, non-promotion of transient captures, step-level events, and partial failure output.
- [ ] **Step 2: Run the focused service test** and confirm there is no plan executor.
- [ ] **Step 3: Implement the sequential executor** with a finite deadline, dispatching actions through the extracted low-level path, captures through `invokeScreenshotCapture`, locators through `plan-locator`, and checks through `plan-checks`.
- [ ] **Step 4: Implement failure semantics**: stop on device/locator/check failure, preserve the completed prefix, bind technical facts, and never replay an unknown action.
- [ ] **Step 5: Add telemetry** for plan duration, per-step duration, action device time, capture time, locator time, check time, and Agent/runtime gap; keep request redaction consistent with existing telemetry.
- [ ] **Step 6: Run plan service, metrics, and runtime regression tests**.

### Task 6: Expose the Agent-facing capability and documentation

**Files:**
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/agent-facing-client.js`
- Modify: `scripts/lib/agent-contract-manifest.js`
- Create: `references/case-runtime/methods/run-plan.md`
- Modify: `references/case-runtime.md`
- Modify: `references/case-runtime/errors.md`
- Modify: `references/case-runtime/errors/scene-action.md`
- Modify: `prompts/case-agent.md`
- Test: `scripts/tests/agent-facing-plan.test.js`
- Test: `scripts/tests/agent-facing-docs.test.js`
- Test: `scripts/tests/agent-facing-transport-parity.test.js`

**Interfaces:**
- Agent-facing request `{ capability: "runPlan", basedOnSceneRef, purpose, steps, flowContext }` translates to internal `{ operation: "runPlan", basedOnSceneId, purpose, steps, flowContext }`.
- Agent-facing response projects step summaries, Scene refs, technical outcomes, and documentation refs without exposing internal shell commands, locator implementation, or result instructions.
- Add targeted error documentation for `PLAN_INVALID`, `PLAN_STEP_FAILED`, `LOCATOR_UNSUPPORTED`, `TARGET_NOT_FOUND`, `PLAN_CHECK_FAILED`, `PLAN_ACTION_OUTCOME_UNKNOWN`, and `PLAN_TIMEOUT`.

- [ ] **Step 1: Write failing Agent-facing tests** for translation, response projection, unsupported fields, documentation refs, and stdin/MCP parity.
- [ ] **Step 2: Run the focused Agent-facing tests** and confirm the new capability is absent from the public contract and generated docs.
- [ ] **Step 3: Implement translation/client dispatch** and expose only compact plan summaries and evidence refs.
- [ ] **Step 4: Write the method/error docs** with the 033 example, explicit Runtime/Agent responsibility boundary, and guidance that `doubleTap` is not a substitute for two timed taps.
- [ ] **Step 5: Update the prompt** to tell Case Agents to use `runPlan` only for short-lived UI, to keep business checks outside Runtime, and to stop on unsupported locators instead of guessing.
- [ ] **Step 6: Run generated-doc and transport parity tests**.

### Task 7: Add 033 regression coverage and platform contract checks

**Files:**
- Create: `scripts/tests/fixtures/run-plan-transient-controls.json`
- Modify: `scripts/tests/cross-platform-execution.test.js`
- Modify: `scripts/tests/result-matrix.test.js`
- Modify: `scripts/self-test.js`
- Test: `scripts/tests/run-plan-033.test.js`

**Interfaces:**
- The fixture simulates a control bar that is visible only during a 3000ms window and an Android-like full Scene capture that takes 4500ms; plan capture/action steps must complete before the window expires.
- The regression asserts that ordinary `act` still misses the transient control in the simulation, while `runPlan` completes the reveal/capture/locate/tap/capture sequence and returns evidence refs for Agent-side inspection.

- [ ] **Step 1: Write the failing 033 simulation** with fake adapter clocks and a transient target that disappears after 3000ms.
- [ ] **Step 2: Run `node scripts/tests/run-plan-033.test.js`** and confirm the new plan path is absent.
- [ ] **Step 3: Implement the fake adapter/provider hooks** needed to exercise the plan without a real device.
- [ ] **Step 4: Assert evidence integrity and role separation**: Runtime reports technical outcomes; no case verdict or automatic `recordResult` is written.
- [ ] **Step 5: Register the new suite in `scripts/self-test.js`** and register the pre-existing `tests/harmony-layout-capture.test.js` baseline suite before claiming the complete self-test is healthy.
- [ ] **Step 6: Run the focused suites and then the full self-test**; report any unrelated baseline failure separately.

### Task 8: Review, security audit, and rollout decision

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-runtime-command-plan-design.md`
- Modify: `docs/superpowers/plans/2026-09-18-runtime-command-plan.md`
- Review: all files from Tasks 1-7

- [ ] **Step 1: Audit allowlists** for command types, locator/check providers, step references, budgets, loops, and file paths.
- [ ] **Step 2: Audit ownership boundaries** to ensure Runtime never authors business observations, verdicts, knowledge conclusions, or Agent instructions.
- [ ] **Step 3: Audit recovery paths** for partial plans, unknown actions, stale Scenes, finalized executions, and concurrent Runtime calls.
- [ ] **Step 4: Run the complete focused and full test commands** and capture the existing self-test baseline issue if it remains.
- [ ] **Step 5: Commit the implementation in task-sized commits** and present the worktree branch and verification summary for review.


# Runtime Command Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded Agent-facing `runPlan` capability that executes short action/capture/locate/check sequences continuously under one Runtime lock while preserving the Agent/Runtime responsibility boundary; the plan has no rollback semantics.

**Architecture:** Keep existing `observe`, `act`, and `inspect` device, stale-Scene, and evidence-capture semantics, while removing Runtime-derived screenshot-change judgments from new outputs. Add a plan contract and service that validates a finite declarative step list, dispatches low-level device actions and screenshot-only captures under one Runtime lock, persists an immutable plan record plus step/evidence events, and returns facts for the Agent to interpret. Runtime performs only deterministic technical checks; Agent remains responsible for visual interpretation and business results. The lock provides execution exclusion, not rollback.

**Tech Stack:** Node.js CommonJS modules, JSON schema-like repository contracts, shell platform adapters for Android/HarmonyOS/iOS, JSONL event/telemetry stores, Node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-09-18-runtime-command-plan-design.md`

## Global Constraints

- `runPlan` is an allowlisted declarative plan, never arbitrary Shell, JavaScript, file mutation, or unbounded loop execution.
- Runtime may return technical facts and evidence only; it must not call an LLM or decide PASS/FAIL/INCONCLUSIVE.
- Runtime must not derive or return generic visual-change conclusions from before/after screenshot comparison; screenshot hashes are integrity facts only, and Agent owns visual-change and business interpretation.
- Existing `observe`, `act`, `inspect`, and `recordResult` device, stale-Scene, evidence, and result-integrity behavior remains backward compatible; the new output contract intentionally removes Runtime-derived visual-change fields.
- Every device action has an operation/transaction identity; unknown device outcomes are never replayed automatically.
- `SCREENSHOT_ONLY` captures must preserve PNG validation, sha256, dimensions, capture timing, and immutable evidence references.
- All new public methods, errors, docs, and tests must be generated or registered through the repository's existing contract/manifests.
- Plan retries must be idempotent by `submissionId` and normalized request digest; an unknown device outcome can never be replayed.
- Existing metrics schema 3 remains readable; plan-specific metrics are additive under a versioned `planMetrics` object.

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
- The public Agent capability list gains `runPlan`; the internal operation contract gains an agent-accessible `runPlan` operation with request fields `submissionId`, `basedOnSceneId`, `steps`, `purpose`, `maxDurationMs`, `onFailure`, `flowContext`, and `decision`.
- A valid normalized step has `{ id, type, ...typeSpecificFields }`; IDs are unique, references use `$stepId.field`, references only point to completed prior steps, and the plan has a finite `maxDurationMs` plus at most 12 steps.
- The normalized public shape uses `submissionId`, `maxDurationMs`, `onFailure`, and explicit step fields: `act.actionRef/input`, `wait.ms`, `capture.mode/promote`, `locate.sourceRef/locator`, `check.sourceRef/predicate`, and `checkpoint`; `SCREEN_CHANGED` is not an allowed check predicate.

- [x] **Step 1: Write failing contract tests** for unsupported capability fields, duplicate step IDs, unknown step types, missing `basedOnSceneId`, invalid references, unbounded duration, unsupported locator/check providers, and the valid 033-shaped plan.
- [x] **Step 2: Run the focused tests** with `node scripts/tests/plan-contract.test.js` and confirm they fail because the contract module and capability are absent.
- [x] **Step 3: Implement the schema and normalization** with explicit allowlists for `act`, `wait`, `capture`, `locate`, `check`, and `checkpoint`; normalize `capture.promote` to `false` for `SCREENSHOT_ONLY` and `true` for `FULL_SCENE` when omitted; reject arbitrary nested commands and reject `doubleTap` as a substitute for an explicitly planned pair of taps when the plan declares an interval.
- [x] **Step 4: Wire Agent-facing and internal contracts** so `runPlan` has documented success statuses `PLAN_COMPLETED`, `PLAN_PARTIAL`, `PLAN_INTERRUPTED`, `REQUEST_INVALID`, and `TECHNICAL`.
- [x] **Step 5: Run the focused tests** and then `node scripts/tests/agent-facing-boundary.test.js` and `node scripts/tests/agent-facing-case-runtime.test.js`.
- [x] **Step 6: Add idempotency tests** for same `submissionId`/same digest, same `submissionId`/different digest, and retry after an unknown action outcome.

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

- [x] **Step 1: Write adapter contract tests** that assert every platform returns a valid PNG artifact, frozen device/App identity, and capture timing, and that no layout artifact is required.
- [x] **Step 2: Run the focused platform tests** and confirm the new capture entrypoint is missing.
- [x] **Step 3: Implement Android capture** using `adb exec-out screencap -p`, HarmonyOS capture using `hdc uitest screenCap` plus `file recv`, and iOS capture by reusing the active Appium session screenshot path and PNG decoder.
- [x] **Step 4: Implement `device-port.js` validation** for capture artifacts using the existing safe artifact, PNG inspection, binding, and sha256 helpers.
- [x] **Step 5: Run the focused platform tests** and the existing Android/Harmony/iOS adapter contract suites.
- [x] **Step 6: Verify capture timing uses the plan's remaining deadline and returns a structured timeout instead of an unbounded adapter call.**

### Task 3: Refactor action dispatch for plan execution

**Files:**
- Modify: `scripts/case-runtime/action-service.js`
- Modify: `scripts/case-runtime/scene-service.js`
- Modify: `scripts/platform/device-port.js`
- Modify: `scripts/case-runtime/transaction-manager.js`
- Modify: `scripts/lib/scroll-context.js`
- Test: `scripts/tests/action-plan-dispatch.test.js`
- Test: `scripts/tests/case-runtime.test.js`
- Test: `scripts/tests/runtime-enhancements.test.js`

**Interfaces:**
- `action-service.js` exposes an internal `dispatchAction(execDir, request, options)` that prepares and dispatches one action, records the device result, but does not automatically call post-action `observe`; action results expose before/after Scene refs as evidence and never synthesize screenshot-change status.
- Existing `act()` calls `dispatchAction()` and keeps its current post-action full Scene behavior.
- Plan execution receives a `planId` and step ID so action transactions and events remain attributable to the plan.
- `scroll-context.js` no longer consumes `observedEffect`; it derives only structural anchor continuity/movement evidence and marks uncertain layout as `GAPPED`.

- [x] **Step 1: Add failing tests** proving a plan action can return after device dispatch without the 500ms post-action settle/full Scene, while ordinary `act` still produces `POST_ACTION` Scene and `actionCompleted` exactly as before.
- [x] **Step 2: Run the focused action tests** and record the current coupling between `act` and `sceneService.observe`.
- [x] **Step 3: Extract the dispatch transaction path** from `act()` without changing action validation, stale Scene guards, spatial evidence, iOS unknown-outcome handling, or input redaction; replace `observedEffect` with explicit before/after Scene evidence refs.
- [x] **Step 4: Add plan attribution** to action transaction/event payloads and preserve the no-replay rule for dispatch failures.
- [x] **Step 5: Refactor scroll-context tests and implementation** so identical anchor order with no significant shared-item displacement increments technical `noProgress`, shared anchors with direction-consistent displacement mark searched coverage, and all other cases remain `GAPPED`; preserve safe behavior when layout evidence is insufficient without producing a generic change label.
- [x] **Step 6: Run action/runtime regression tests** including `node scripts/tests/case-runtime.test.js`.
- [x] **Step 7: Verify plan actions normalize to the existing ActionRef contract; `pointRef` is resolved before dispatch and is never passed through to a platform adapter.**

### Task 4: Implement deterministic locate and check providers

**Files:**
- Create: `scripts/case-runtime/plan-locator.js`
- Create: `scripts/case-runtime/plan-checks.js`
- Create: `scripts/case-runtime/plan-evidence.js`
- Test: `scripts/tests/plan-locator.test.js`
- Test: `scripts/tests/plan-checks.test.js`

**Interfaces:**
- `locate(execDir, step, context)` returns `{ status: "LOCATED", resolution: { point, bounds, provider, confidence, basis }, locatorRef }` or a typed technical failure; first providers are `ELEMENT_REF`, `POINT`, and `REGION`.
- `check(execDir, step, context)` returns `{ status: "CHECKED", result: { checkRef, predicate, sourceRefs, status, value }, technicalFactRef }`; first predicates are `CAPTURE_AVAILABLE`, `ELEMENT_VISIBLE`, `ELEMENT_ENABLED`, `APP_IN_FOREGROUND`, and `REFERENCE_EXISTS`; `SCREEN_CHANGED` is explicitly unsupported.
- `plan-evidence.js` validates and records locator/check inputs and outputs without writing a business result.

- [x] **Step 1: Write failing tests** for element lookup against a full Scene, normalized point validation, region bounds, missing source capture, unsupported provider, and each deterministic check predicate.
- [x] **Step 2: Run the focused tests** and confirm the provider modules are absent.
- [x] **Step 3: Implement `ELEMENT_REF` from existing Scene elements** and `POINT`/`REGION` normalization against the source screenshot dimensions; distinguish declared-coordinate resolution from semantic target matching and never fabricate a point.
- [x] **Step 4: Implement technical checks** using existing Scene/evidence stores and artifact integrity metadata; do not compare screenshot hashes to infer visual change, compare free-form business text, or emit PASS/FAIL case verdicts.
- [x] **Step 5: Run focused tests** and add explicit `LOCATOR_UNSUPPORTED`, `TARGET_NOT_FOUND`, and `PLAN_CHECK_FAILED` diagnostics.
- [x] **Step 6: Test that `NOT_SATISFIED` and `UNAVAILABLE` remain technical check outcomes and are not converted into CaseResult verdicts.**

### Task 5: Implement plan execution and immutable evidence

**Files:**
- Create: `scripts/case-runtime/plan-service.js`
- Modify: `scripts/case-runtime/runtime-core.js`
- Modify: `scripts/case-runtime/store.js`
- Modify: `scripts/case-runtime/scene-service.js`
- Modify: `scripts/case-runtime/result-integrity.js`
- Modify: `scripts/case-runtime/telemetry.js`
- Test: `scripts/tests/plan-service.test.js`
- Test: `scripts/tests/execution-metrics.test.js`

**Interfaces:**
- `plan-service.runPlan(execDir, request, options)` returns `{ status, planId, planRecordRef, idempotent, steps, sceneRefs, remainingMs, technicalFacts }` and executes under `store.withRuntimeLock`.
- A screenshot-only capture writes a Scene with `captureMode: "SCREENSHOT_ONLY"`, `source: { operation: "runPlan", planId, stepId }`, unavailable layout evidence, and normal screenshot integrity fields; it does not replace `current-scene.json` unless `promote: true`.
- Plan events are append-only: `planRequested`, `planStepStarted`, `planStepCompleted`/`planStepFailed`, and `planCompleted`/`planInterrupted`.

- [x] **Step 1: Write failing service tests** for ordered execution, `$step.field` references, wait budget, screenshot-only Scene persistence, non-promotion of transient captures, promoted Scene basis updates, step-level events, partial failure output, recovery of an accepted/running snapshot without a terminal event, and absence of screenshot-change fields from new action/plan results.
- [x] **Step 2: Run the focused service test** and confirm there is no plan executor.
- [x] **Step 3: Implement the sequential executor** with a finite deadline, dispatching actions through the extracted low-level path, captures through `invokeScreenshotCapture`, locators through `plan-locator`, and checks through `plan-checks`.
- [x] **Step 4: Implement failure semantics**: stop on device/locator/check failure, preserve the completed prefix, bind technical facts, never replay an unknown action, and preserve before/after Scene refs without emitting a change conclusion.
- [x] **Step 5: Persist the plan snapshot before the first device action, atomically update it after every step and before the terminal event, add `submissionId`/digest idempotency, and write `sceneObserved` evidence events without promoting screenshot-only captures to `current-scene.json` unless explicitly requested.**
- [x] **Step 6: Add telemetry** for plan duration, per-step duration, action device time, capture time, locator time, check time, and plan status; keep request redaction consistent with existing telemetry and do not classify internal plan gaps as Agent time.
- [x] **Step 7: Add `planMetrics: { schemaVersion: 1 }`** as an additive metrics projection while keeping top-level metrics schema 3 unchanged.
- [x] **Step 8: Make the event writer reject reserved-field overrides and add evidence-graph validation for non-promoted Scene records, plan snapshot references, terminal `recordSha256`, and atomic snapshot publication.**
- [x] **Step 9: Run plan service, metrics, result-integrity, and runtime regression tests**.

### Task 6: Expose the Agent-facing capability and documentation

**Files:**
- Modify: `scripts/case-runtime/agent-facing-translator.js`
- Modify: `scripts/case-runtime/agent-facing-client.js`
- Modify: `scripts/lib/agent-contract-manifest.js`
- Create: `references/case-runtime/methods/run-plan.md`
- Modify: `references/case-runtime.md`
- Modify: `references/case-runtime/errors.md`
- Modify: `references/case-runtime/errors/scene-action.md`
- Modify: `references/case-runtime/methods/act.md`
- Modify: `references/failure-policy.md`
- Modify: `prompts/case-agent.md`
- Test: `scripts/tests/agent-facing-plan.test.js`
- Test: `scripts/tests/agent-facing-docs.test.js`
- Test: `scripts/tests/agent-facing-transport-parity.test.js`

**Interfaces:**
- Agent-facing request `{ capability: "runPlan", submissionId, basedOnSceneRef, purpose, maxDurationMs, onFailure, steps, flowContext }` translates to internal `{ operation: "runPlan", submissionId, basedOnSceneId, purpose, maxDurationMs, onFailure, steps, flowContext }`.
- Agent-facing response projects step summaries, before/after Scene refs, technical outcomes, and documentation refs without exposing internal shell commands, locator implementation, screenshot-change conclusions, or result instructions.
- Agent-facing retries with the same `submissionId` return the original plan result with `idempotent: true`; the response includes `planId`, `status`, completed/failed step refs, evidence refs, and technical facts but never a CaseResult verdict.
- Add targeted error documentation for `PLAN_INVALID`, `PLAN_STEP_FAILED`, `PLAN_SUBMISSION_CONFLICT`, `PLAN_RECORD_INCOMPLETE`, `LOCATOR_UNSUPPORTED`, `TARGET_NOT_FOUND`, `PLAN_CHECK_FAILED`, `PLAN_ACTION_OUTCOME_UNKNOWN`, and `PLAN_TIMEOUT`.

- [x] **Step 1: Write failing Agent-facing tests** for translation, response projection, unsupported fields, documentation refs, stdin/MCP parity, and the absence of `screenComparison`/`observedEffect` in new responses while before/after evidence refs remain available.
- [x] **Step 2: Run the focused Agent-facing tests** and confirm the new capability is absent from the public contract and generated docs.
- [x] **Step 3: Implement translation/client dispatch** and expose only compact plan summaries and evidence refs.
- [x] **Step 4: Write the method/error docs** with the 033 example, explicit Runtime/Agent responsibility boundary, the rule that screenshot hashes are integrity facts rather than visual-change judgments, and guidance that `doubleTap` is not a substitute for two timed taps.
- [x] **Step 5: Update the prompt** to tell Case Agents to use `runPlan` only for short-lived UI, inspect before/after evidence themselves when judging visual change, keep business checks outside Runtime, and stop on unsupported locators instead of guessing.
- [x] **Step 6: Run generated-doc and transport parity tests**.
- [x] **Step 7: Verify that historical `SCREENSHOT_ONLY` Scene refs can be passed to `inspect`/`recordResult` without changing the current Scene basis.**

### Task 7: Add 033 regression coverage and platform contract checks

**Files:**
- Create: `scripts/tests/fixtures/run-plan-transient-controls.json`
- Modify: `scripts/tests/cross-platform-execution.test.js`
- Modify: `scripts/tests/result-matrix.test.js`
- Modify: `scripts/self-test.js`
- Test: `scripts/tests/run-plan-033.test.js`

**Interfaces:**
- The fixture simulates a control bar that is visible only during a 3000ms window and an Android-like full Scene capture that takes 4500ms; plan capture/action steps must complete before the window expires.
- The regression asserts that ordinary `act` still misses the transient control in the simulation, while `runPlan` completes the reveal/capture/locate/tap/capture sequence and returns evidence refs for Agent-side inspection; neither path returns a screenshot-change verdict.
- The fixture also asserts that a screenshot-only capture does not replace the prior full Scene, and that a transport retry does not repeat either action.

- [x] **Step 1: Write the failing 033 simulation** with fake adapter clocks and a transient target that disappears after 3000ms.
- [x] **Step 2: Run `node scripts/tests/run-plan-033.test.js`** and confirm the new plan path is absent.
- [x] **Step 3: Implement the fake adapter/provider hooks** needed to exercise the plan without a real device.
- [x] **Step 4: Assert evidence integrity and role separation**: Runtime reports technical outcomes and before/after Scene refs; no screenshot-change verdict, case verdict, or automatic `recordResult` is written, while an Agent-side visual inspection can form the change/business conclusion.
- [x] **Step 5: Register the new suite in `scripts/self-test.js`** and register the pre-existing `tests/harmony-layout-capture.test.js` baseline suite before claiming the complete self-test is healthy.
- [x] **Step 6: Run the focused suites and then the full self-test**; report any unrelated baseline failure separately.

### Task 8: Project plan execution data into the existing dashboard

**Files:**
- Modify: `scripts/report/execution-trace.js`
- Modify: `scripts/report/execution-narrative.js`
- Modify: `scripts/report/current-report-html.js`
- Modify: `scripts/report/current-index.js`
- Modify: `scripts/case-runtime/result-service.js`
- Modify: `scripts/case-runtime/telemetry.js`
- Test: `scripts/tests/execution-trace.test.js`
- Test: `scripts/tests/dashboard.test.js`
- Test: `scripts/tests/plan-report.test.js`

**Interfaces:**
- The existing execution artifact directories remain the source of truth; no parallel dashboard database is introduced.
- The detail report projects `planRequested`, `planStepStarted`, `planStepCompleted`, `planStepFailed`, `planCompleted`, and `planInterrupted` into a plan timeline.
- `SCREENSHOT_ONLY` Scenes remain selectable evidence and are labeled separately from full Scenes; before/after Scene refs remain visible evidence, while locator and technical-check results remain technical facts and never become case verdicts or screenshot-change judgments.
- The index dashboard may consume aggregate plan counters from the existing metrics projection, but plan-level debugging belongs in the execution detail report.

- [x] **Step 1: Add failing report fixtures** containing a successful 033-shaped plan, a locator failure with a completed prefix, a screenshot-only Scene, and a technical check returning `UNAVAILABLE`.
- [x] **Step 2: Extend the execution projection** with plan summaries, step timing/status, capture mode, before/after evidence refs, locator/check facts, plan record integrity, and plan-specific counts while preserving existing action/observation projections; treat `partialCount + interruptedCount` as Runtime plan failures and keep them separate from CaseResult verdicts.
- [x] **Step 3: Add the detail-page plan timeline** and evidence labels; show before/after screenshots without `DIFFERENT`/`IDENTICAL` Runtime labels, and show Runtime technical status separately from Agent business conclusions.
- [x] **Step 4: Add minimal index aggregates** from `metrics.planMetrics` for plan count, plan failure count, and transient capture count if metrics are available; keep the existing case verdict filters unchanged.
- [x] **Step 5: Run focused report/dashboard tests and verify raw event compatibility with executions that do not contain plan events, plus read-only compatibility for historical `observedEffect` records without exposing them in new Agent-facing responses.**

### Task 9: Review, security audit, and rollout decision

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-runtime-command-plan-design.md`
- Modify: `docs/superpowers/plans/2026-09-18-runtime-command-plan.md`
- Review: all files from Tasks 1-8

- [x] **Step 1: Audit allowlists** for command types, locator/check providers, step references, budgets, loops, and file paths.
- [x] **Step 2: Audit ownership boundaries** to ensure Runtime never authors business observations, verdicts, knowledge conclusions, or Agent instructions.
- [x] **Step 3: Audit change-removal migration** to ensure new executions omit `observedEffect`, `screenComparison`, and `SCREEN_CHANGED`, retain only artifact hashes and before/after evidence refs, and keep historical records readable without treating legacy comparisons as current facts.
- [x] **Step 4: Audit recovery paths** for partial plans, unknown actions, stale Scenes, finalized executions, and concurrent Runtime calls.
- [x] **Step 5: Audit evidence graph and publication integrity** for non-promoted Scene artifacts, plan snapshots, event/record digest mismatches, and historical Scene references.
- [x] **Step 6: Run the complete focused and full test commands** and capture the existing self-test baseline issue if it remains.
- [x] **Step 7: Commit the implementation in task-sized commits** and present the worktree branch and verification summary for review.

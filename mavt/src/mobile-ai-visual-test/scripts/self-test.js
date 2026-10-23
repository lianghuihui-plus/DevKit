#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = Object.freeze({
  setupDependencies: 'tests/setup-dependencies.test.js',
  contract: 'tests/contract.test.js',
  platform: 'tests/platform-contract.test.js',
  deviceOperationTimeout: 'tests/device-operation-timeout.test.js',
  platformRuntime: 'tests/platform-runtime.test.js',
  iosProbe: 'tests/ios-probe.test.js',
  iosAppPreparation: 'tests/ios-app-preparation.test.js',
  iosSessionLifecycle: 'tests/ios-session-lifecycle.test.js',
  iosRuntimeOwnership: 'tests/ios-runtime-ownership.test.js',
  iosInput: 'tests/ios-input.test.js',
  layout: 'tests/layout-observation.test.js',
  androidLayout: 'tests/android-layout-capture.test.js',
  androidHelperBundle: 'tests/android-helper-bundle.test.js',
  androidHelperClient: 'tests/android-helper-client.test.js',
  androidHelperRuntime: 'tests/android-helper-runtime.test.js',
  androidHelperSessionLifecycle: 'tests/android-helper-session-lifecycle.test.js',
  androidHelperObservation: 'tests/android-helper-observation.test.js',
  androidHelperAction: 'tests/android-helper-action.test.js',
  androidHelperDeviceSmoke: 'tests/android-helper-device-smoke.test.js',
  harmonyLayout: 'tests/harmony-layout-capture.test.js',
  platformCapture: 'tests/platform-capture.test.js',
  spatialEvidence: 'tests/action-spatial-evidence.test.js',
  harmonyInput: 'tests/harmony-input-effect.test.js',
  metrics: 'tests/execution-metrics.test.js',
  executionRetention: 'tests/execution-retention.test.js',
  report: 'tests/report-reader.test.js',
  trace: 'tests/execution-trace.test.js',
  narrative: 'tests/execution-narrative.test.js',
  dashboard: 'tests/dashboard.test.js',
  workspace: 'tests/workspace.test.js',
  caseAuthoring: 'tests/case-authoring.test.js',
  control: 'tests/run-control.test.js',
  appProvisioning: 'tests/app-provisioning.test.js',
  appPreparation: 'tests/app-preparation.test.js',
  publication: 'tests/publication-integrity.test.js',
  knowledge: 'tests/knowledge.test.js',
  knowledgeClosure: 'tests/knowledge-closure.test.js',
  caseFlow: 'tests/case-flow-service.test.js',
  caseFlowResultIntegrity: 'tests/case-flow-result-integrity.test.js',
  caseStatusProjection: 'tests/case-status-projection.test.js',
  capabilityCatalogStore: 'tests/capability-catalog-store.test.js',
  capabilityModuleContract: 'tests/capability-module-contract.test.js',
  caseRuntime: 'tests/case-runtime.test.js',
  lifecycleRuntimeBinding: 'tests/lifecycle-runtime-binding.test.js',
  runtimeBinding: 'tests/runtime-binding.test.js',
  runtimeBundle: 'tests/runtime-bundle.test.js',
  actionRequest: 'tests/action-request.test.js',
  actionSequenceHooks: 'tests/action-sequence-hooks.test.js',
  actionCompletion: 'tests/action-completion.test.js',
  actionSequenceDispatch: 'tests/action-sequence-dispatch.test.js',
  actionRecoveryOwnership: 'tests/action-recovery-ownership.test.js',
  sequenceReport: 'tests/sequence-report.test.js',
  sequenceContract: 'tests/sequence-contract.test.js',
  sequenceRecord: 'tests/sequence-record.test.js',
  sequenceRecovery: 'tests/sequence-recovery.test.js',
  sequenceService: 'tests/sequence-service.test.js',
  sequenceScreenshotScene: 'tests/sequence-screenshot-scene.test.js',
  sequenceSingleAction: 'tests/sequence-single-action.test.js',
  sequenceTwoActions: 'tests/sequence-two-actions.test.js',
  sceneCaptureOrigin: 'tests/scene-capture-origin.test.js',
  batchCancellation: 'tests/batch-cancellation.test.js',
  batchReconcile: 'tests/batch-reconcile.test.js',
  bcmCsCapabilityProvider: 'tests/bcm-cs-capability-provider.test.js',
  crossPlatformExecution: 'tests/cross-platform-execution.test.js',
  runtimeEnhancements: 'tests/runtime-enhancements.test.js',
  resultMatrix: 'tests/result-matrix.test.js',
  warmSession: 'tests/warm-session-current.test.js',
  boundaries: 'tests/architecture-boundaries.test.js',
  agentCapabilityContract: 'tests/agent-capability-contract.test.js',
  agentFacingCaseRuntime: 'tests/agent-facing-case-runtime.test.js',
  agentFacingCapabilityInvocation: 'tests/agent-facing-capability-invocation.test.js',
  agentFacingCapabilityQuery: 'tests/agent-facing-capability-query.test.js',
  agentFacingResources: 'tests/agent-facing-resources.test.js',
  agentFacingSequence: 'tests/agent-facing-sequence.test.js',
  agentFacingCaseFlow: 'tests/agent-facing-case-flow.test.js',
  agentFacingDocs: 'tests/agent-facing-docs.test.js',
  agentFacingSingleContract: 'tests/agent-facing-single-contract.test.js',
  actionRefMapping: 'tests/action-ref-mapping.test.js',
  agentFacingBoundary: 'tests/agent-facing-boundary.test.js',
  agentFacingPublicationFlow: 'tests/agent-facing-publication-flow.test.js',
  expectationResult: 'tests/expectation-result-service.test.js',
  finalReviewGate: 'tests/final-review-gate.test.js',
  finalReviewIntegrity: 'tests/final-review-integrity.test.js',
  agentFacingTransportParity: 'tests/agent-facing-transport-parity.test.js',
  visualCoordinateGrid: 'tests/visual-coordinate-grid.test.js',
  agentHandoff: 'tests/agent-handoff.test.js',
  coordinatorAgentFacing: 'tests/coordinator-agent-facing.test.js',
  executionFlowCombination: 'tests/execution-flow-combination.test.js',
  entrypoints: 'tests/formal-entrypoints.test.js',
});

const registeredFiles = Object.values(suites).sort();
const testFiles = fs.readdirSync(path.join(__dirname, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `tests/${name}`)
  .sort();
assert.deepStrictEqual(registeredFiles, testFiles, 'Every test suite must be registered in scripts/self-test.js');

const requested = process.argv.slice(2);
for (const name of requested) {
  assert.ok(suites[name], `Unknown self-test suite: ${name}. Expected one of: ${Object.keys(suites).join(', ')}`);
}

const selected = requested.length ? requested : Object.keys(suites);
for (const name of selected) {
  const file = path.join(__dirname, suites[name]);
  process.stdout.write(`[self-test] ${name}\n`);
  childProcess.execFileSync(process.execPath, [file], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
}

console.log(`self-test passed: ${selected.join(', ')}`);

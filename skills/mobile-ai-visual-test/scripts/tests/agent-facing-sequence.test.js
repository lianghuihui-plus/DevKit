#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENT_FACING_CAPABILITIES, validateAgentFacingRequest } = require('../case-runtime/agent-facing-contract');
const { translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');
const store = require('../case-runtime/store');
const resources = require('../case-runtime/agent-resource-store');
const { run } = require('../case-runtime/agent-facing-client');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-broker');
const { execute } = require('../case-runtime/runtime-core');
const { readSequences, runSequence } = require('../case-runtime/sequence-service');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-public-sequence-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'public-sequence' });
store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));
const sceneRef = resources.publishScene(fixture.execDir, 'scene-0002').data.ref;
const request = { operation: 'runSequence', input: {
  sceneRef, purpose: '连续点击', steps: [
    { id: 'first', type: 'act', action: { type: 'tap', target: { point: [5000, 5000] } } },
    { id: 'pause', type: 'wait', ms: 100 },
  ],
} };
assert.ok(AGENT_FACING_CAPABILITIES.includes('runSequence'));
assert.deepStrictEqual(validateAgentFacingRequest(request), []);
assert.deepStrictEqual(translateAgentFacingRequest(fixture.execDir, request), {
  operation: 'runSequence', basedOnSceneId: 'scene-0002', purpose: '连续点击',
  steps: [
    { id: 'first', type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } },
    { id: 'pause', type: 'wait', ms: 100 },
  ], decision: { purpose: '连续点击', expectationRefs: [] },
});
assert.ok(validateAgentFacingRequest({ ...request, input: { ...request.input, submissionId: 'old' } }).length);
assert.ok(validateAgentFacingRequest({ ...request, input: { ...request.input,
  steps: [{ id: 'same', type: 'wait', ms: 1 }, { id: 'same', type: 'wait', ms: 2 }],
} }).length);
assert.throws(() => translateAgentFacingRequest(fixture.execDir, { ...request, input: {
  ...request.input, steps: [{ id: 'missing', type: 'act', action: { ref: 'missing:tap' } }],
} }), (error) => error.code === 'AGENT_INPUT_INVALID'
  && error.issues.some((item) => item.field === 'input.steps[0].action.ref'));
assert.throws(() => translateAgentFacingRequest(fixture.execDir, { ...request, input: {
  ...request.input, flowContext: { nodeRef: 'N999' },
} }), (error) => error.code === 'AGENT_INPUT_INVALID'
  && error.issues.some((item) => item.field === 'input.flowContext'));
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({ ...execution, finalized: false, status: 'RUNNING', lifecycle: 'RUNNING' }, null, 2)}\n`);
fs.writeFileSync(path.join(fixture.execDir, 'runtime.json'), `${JSON.stringify({
  schemaVersion: 1, executionId: execution.executionId, status: 'READY',
  entry: path.join(fixture.execDir, 'agent-facing-client.js'),
  broker: { allowedOperations: AGENT_OPERATIONS },
}, null, 2)}\n`);
const basisScene = store.readCurrentScene(fixture.execDir);
const basisScreenshot = fs.readFileSync(path.join(fixture.execDir, basisScene.screenshot.ref));
let actionCalls = 0;
let captureCalls = 0;
const options = {
  now: '2026-08-13T10:00:06.000+08:00',
  invokeDeviceOperation(execDir, payload, kind) {
    if (kind === 'OBSERVE') return options.invokeScreenshotCapture(execDir, payload);
    actionCalls += 1;
    return { adapterResult: {
      schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: 'tap',
      command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 20 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    } };
  },
  invokeScreenshotCapture(execDir, payload) {
    captureCalls += 1;
    const ref = `screenshots/${payload.operationId}.png`;
    fs.writeFileSync(path.join(execDir, ref), basisScreenshot);
    return { adapterResult: {
      schemaVersion: 1, type: 'capture', platform: 'harmony', time: '2026-09-23T01:00:00.000Z',
      artifacts: { screenshot: ref }, app: basisScene.app,
      captureTiming: { order: ['screenshot'], spanMs: 100 },
    }, evidence: { ref, sha256: basisScene.screenshot.sha256,
      width: basisScene.screenshot.width, height: basisScene.screenshot.height, usable: true } };
  },
};
const rejectedChain = run(fixture.execDir, { ...request, input: { ...request.input, steps: [
  request.input.steps[0], { id: 'missing', type: 'act', action: { ref: 'missing:tap' } },
] } }, options);
assert.strictEqual(rejectedChain.status, 'REJECTED');
assert.strictEqual(actionCalls, 0);
const oneAction = { ...request, input: { ...request.input, steps: request.input.steps.slice(0, 1) } };
const result = run(fixture.execDir, oneAction, options);
assert.strictEqual(result.status, 'SUCCEEDED', JSON.stringify(result));
assert.strictEqual(result.result.outcome, 'SEQUENCE_COMPLETED');
assert.strictEqual(result.data.type, 'scene');
assert.strictEqual(result.data.ref, result.result.sceneRef);
assert.ok(result.resources.some((item) => item.type === 'sequenceResult' && item.ref === result.result.sequenceResultRef));
const publicSequence = resources.readPublishedResource(fixture.execDir, result.result.sequenceResultRef);
assert.deepStrictEqual(publicSequence.data.content.request.steps[0].visual.point, [5000, 5000]);
assert.ok(publicSequence.data.content.evidence.screenshotRefs.every((ref) => ref.includes(':screenshot:')),
  JSON.stringify(publicSequence.data.content.evidence.screenshotRefs));
const sequenceScreenshots = publicSequence.resources.filter((item) => item.type === 'screenshot');
assert.ok(sequenceScreenshots.length >= 1);
for (const descriptor of sequenceScreenshots) {
  const screenshot = resources.readPublishedResource(fixture.execDir, descriptor.ref);
  assert.match(screenshot.data.content.path, /screenshots\/coordinate-grid\//);
  assert.strictEqual(screenshot.data.content.coordinateSpace.maximum, 10000);
}
const decisionsBeforeReplay = store.events(fixture.execDir).filter((event) => event.type === 'agentDecisionRecorded').length;
const replay = run(fixture.execDir, oneAction, options);
assert.strictEqual(replay.status, 'SUCCEEDED', JSON.stringify(replay));
assert.strictEqual(replay.result.idempotent, true);
assert.strictEqual(actionCalls, 1);
assert.strictEqual(captureCalls, 1);
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'agentDecisionRecorded').length, decisionsBeforeReplay);
const directReplay = execute(fixture.execDir, translateAgentFacingRequest(fixture.execDir, oneAction), options);
assert.strictEqual(directReplay.status, 'SEQUENCE_COMPLETED');
assert.strictEqual(directReplay.idempotent, true);
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'agentDecisionRecorded').length, decisionsBeforeReplay);
const nextSceneRef = resources.publishScene(fixture.execDir, store.readCurrentScene(fixture.execDir).sceneId).data.ref;
const timedOut = run(fixture.execDir, { operation: 'runSequence', input: {
  sceneRef: nextSceneRef, purpose: '等待状态稳定', steps: [{ id: 'wait', type: 'wait', ms: 30000 }],
} }, options);
assert.strictEqual(timedOut.status, 'FAILED', JSON.stringify(timedOut));
assert.strictEqual(timedOut.error.code, 'SEQUENCE_TIMEOUT');
assert.ok(timedOut.result.sequenceResultRef);
assert.ok(timedOut.result.sceneRef);
assert.strictEqual(timedOut.data, undefined);
assert.ok(timedOut.resources.some((item) => item.ref === timedOut.result.sceneRef));
assert.ok(timedOut.resources.some((item) => item.ref === timedOut.result.sequenceResultRef));
const failureSceneRef = resources.publishScene(fixture.execDir, store.readCurrentScene(fixture.execDir).sceneId).data.ref;
assert.strictEqual(run(fixture.execDir, { operation: 'inspect', input: {
  mode: 'visual', sceneRef: failureSceneRef, observation: '可见目标位置',
} }, options).status, 'SUCCEEDED');
const captureFailed = run(fixture.execDir, { operation: 'runSequence', input: {
  sceneRef: failureSceneRef, purpose: '采集失败后保留证据',
  steps: [{ id: 'tapAgain', type: 'act', action: { type: 'tap', target: { point: [5000, 5000] } } }],
} }, { ...options, invokeDeviceOperation(execDir, payload, kind) {
  if (kind === 'OBSERVE') throw new Error('capture unavailable');
  return options.invokeDeviceOperation(execDir, payload, kind);
} });
assert.strictEqual(captureFailed.status, 'FAILED', JSON.stringify(captureFailed));
assert.ok(captureFailed.result.sequenceResultRef);
assert.strictEqual(captureFailed.result.sceneRef, null);
assert.ok(captureFailed.resources.some((item) => item.type === 'technicalFact'));
assert.ok(captureFailed.resources.some((item) => item.type === 'sequenceResult'));

{
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-public-sequence-incomplete-'));
  createTestWorkspace(recoveryRoot);
  const incompleteFixture = createCurrentFixture(recoveryRoot, { suffix: 'incomplete-sequence' });
  const incompleteExecutionPath = path.join(incompleteFixture.execDir, 'execution.json');
  const incompleteExecution = JSON.parse(fs.readFileSync(incompleteExecutionPath, 'utf8'));
  fs.writeFileSync(incompleteExecutionPath, `${JSON.stringify({
    ...incompleteExecution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(incompleteFixture.execDir, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    executionId: incompleteExecution.executionId,
    status: 'READY',
    entry: path.join(incompleteFixture.execDir, 'agent-facing-client.js'),
    broker: { allowedOperations: AGENT_OPERATIONS },
  }, null, 2)}\n`);
  store.writeScene(incompleteFixture.execDir, JSON.parse(fs.readFileSync(
    path.join(incompleteFixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));
  const incompleteSceneRef = resources.publishScene(incompleteFixture.execDir, 'scene-0002').data.ref;
  const incompleteRequest = { operation: 'runSequence', input: {
    sceneRef: incompleteSceneRef, purpose: 'retry interrupted work',
    steps: [{ id: 'wait', type: 'wait', ms: 0 }],
  } };
  const internal = translateAgentFacingRequest(incompleteFixture.execDir, incompleteRequest);
  assert.throws(() => runSequence(incompleteFixture.execDir, internal, {
    remainingMs: 30000, clock: () => 0, interruptAfter: 'sequence-created',
  }));
  const retry = run(incompleteFixture.execDir, incompleteRequest, { ...options, clock: () => 0 });
  assert.strictEqual(retry.status, 'FAILED', JSON.stringify(retry));
  assert.strictEqual(retry.error.code, 'SEQUENCE_INTERRUPTED', JSON.stringify(retry));
  assert.strictEqual(retry.result.sequenceId, 'sequence-0001');
  assert.ok(retry.result.sequenceResultRef);
  assert.ok(retry.result.sceneRef);
  assert.ok(retry.resources.some((item) => item.ref === retry.result.sequenceResultRef));
  assert.ok(retry.resources.some((item) => item.ref === retry.result.sceneRef));
}

{
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-public-sequence-terminal-repair-'));
  createTestWorkspace(recoveryRoot);
  const recoveryFixture = createCurrentFixture(recoveryRoot, { suffix: 'terminal-sequence-repair' });
  const recoveryExecutionPath = path.join(recoveryFixture.execDir, 'execution.json');
  const recoveryExecution = JSON.parse(fs.readFileSync(recoveryExecutionPath, 'utf8'));
  fs.writeFileSync(recoveryExecutionPath, `${JSON.stringify({
    ...recoveryExecution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(recoveryFixture.execDir, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    executionId: recoveryExecution.executionId,
    status: 'READY',
    entry: path.join(recoveryFixture.execDir, 'agent-facing-client.js'),
    broker: { allowedOperations: AGENT_OPERATIONS },
  }, null, 2)}\n`);
  const recoveryBasis = JSON.parse(fs.readFileSync(
    path.join(recoveryFixture.execDir, 'scenes', 'scene-0002.json'), 'utf8'));
  store.writeScene(recoveryFixture.execDir, recoveryBasis);
  const recoverySceneRef = resources.publishScene(recoveryFixture.execDir, recoveryBasis.sceneId).data.ref;
  const recoveryRequest = { operation: 'runSequence', input: {
    sceneRef: recoverySceneRef,
    purpose: 'retry completed work after terminal event repair',
    steps: [{ id: 'wait', type: 'wait', ms: 0 }],
  } };
  const internal = translateAgentFacingRequest(recoveryFixture.execDir, recoveryRequest);
  let adapterCalls = 0;
  const recoveryOptions = {
    remainingMs: 30000,
    clock: () => 0,
    invokeDeviceOperation(_execDir, _payload, kind) {
      adapterCalls += 1;
      assert.strictEqual(kind, 'OBSERVE');
      return {
        adapterResult: {
          schemaVersion: 1, type: 'observation', platform: 'harmony', app: recoveryBasis.app,
          artifacts: { screenshot: recoveryBasis.screenshot.ref, layout: null, logs: [] },
        },
        evidence: {
          ref: recoveryBasis.screenshot.ref, sha256: recoveryBasis.screenshot.sha256,
          width: recoveryBasis.screenshot.width, height: recoveryBasis.screenshot.height, usable: true,
        },
      };
    },
  };
  assert.throws(() => runSequence(recoveryFixture.execDir, internal, {
    ...recoveryOptions, interruptAfter: 'sequence-terminal-record-persisted',
  }), (error) => error.code === 'MAVT_SEQUENCE_INTERRUPTED');
  const terminalRecord = readSequences(recoveryFixture.execDir)[0];
  const callsBeforeRetry = adapterCalls;
  const retry = run(recoveryFixture.execDir, recoveryRequest, recoveryOptions);
  assert.strictEqual(retry.status, 'SUCCEEDED', JSON.stringify(retry));
  assert.strictEqual(retry.result.outcome, 'SEQUENCE_COMPLETED');
  assert.strictEqual(retry.result.sequenceId, terminalRecord.sequenceId);
  assert.strictEqual(retry.result.idempotent, true);
  assert.strictEqual(retry.result.sceneRef.endsWith(`:${terminalRecord.finalSceneRef}`), true);
  assert.ok(retry.result.sequenceResultRef);
  assert.strictEqual(adapterCalls, callsBeforeRetry);
}
console.log('agent-facing sequence passed');

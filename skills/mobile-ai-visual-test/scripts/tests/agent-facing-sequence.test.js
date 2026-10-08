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
assert.strictEqual(captureFailed.result.sceneRef, undefined);
assert.ok(captureFailed.resources.some((item) => item.type === 'technicalFact'));
assert.ok(captureFailed.resources.some((item) => item.type === 'sequenceResult'));
console.log('agent-facing sequence passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyActionOutcome,
  act,
  completeDispatchedAction,
  dispatchAction,
} = require('../case-runtime/action-service');
const { buildCapabilities } = require('../case-runtime/capability-catalog');
const sceneService = require('../case-runtime/scene-service');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const legacyPlanKey = ['plan', 'Id'].join('');

function makeFixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-action-completion-${suffix}-`));
  createTestWorkspace(root);
  const fixture = createCurrentFixture(root, { suffix });
  const executionPath = path.join(fixture.execDir, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  fs.writeFileSync(executionPath, `${JSON.stringify({
    ...execution,
    endedAt: null,
    status: 'RUNNING',
    lifecycle: 'RUNNING',
    finalized: false,
    executionStatus: 'RUNNING',
  }, null, 2)}\n`);
  store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));
  return fixture;
}

function acceptedResult(action) {
  return {
    adapterResult: {
      schemaVersion: 2,
      type: 'actionResult',
      platform: 'harmony',
      action,
      command: { status: 'ACCEPTED', transport: 'HDC_UITEST', elapsedMs: 10 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    },
  };
}

function postScene(beforeScene, sceneId) {
  return { ...beforeScene, sceneId, previousAction: null };
}

function observationResult(scene, layoutRef) {
  return {
    adapterResult: {
      schemaVersion: 1,
      type: 'observation',
      platform: 'harmony',
      app: scene.app,
      artifacts: { screenshot: scene.screenshot.ref, layout: layoutRef, logs: [] },
    },
    evidence: {
      ref: scene.screenshot.ref,
      sha256: scene.screenshot.sha256,
      width: scene.screenshot.width,
      height: scene.screenshot.height,
      usable: true,
    },
  };
}

function inputSceneFixture(suffix) {
  const fixture = makeFixture(suffix);
  const scene = store.readCurrentScene(fixture.execDir);
  scene.elements = [{
    id: 'account-field', text: '账号', role: 'TextField', bounds: [80, 210, 360, 270],
    clickable: false, checkable: false, editable: true, enabled: true, visible: true, focused: false,
  }];
  scene.capabilities = buildCapabilities(scene, 'harmony');
  store.writeScene(fixture.execDir, scene);
  return { fixture, scene };
}

function inputRequest(scene, text) {
  return {
    basedOnSceneId: scene.sceneId,
    capabilityId: `${scene.sceneId}:inputText:account-field`,
    input: { text, mode: 'replace' },
    decision: { purpose: '输入账号' },
  };
}

function persistedText(execDir) {
  const target = store.paths(execDir);
  const files = [target.transactions, target.operations]
    .flatMap((directory) => fs.existsSync(directory)
      ? fs.readdirSync(directory).map((name) => path.join(directory, name)) : []);
  return JSON.stringify([store.events(execDir), ...files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))]);
}

const fixture = makeFixture('known');
const beforeScene = store.readCurrentScene(fixture.execDir);

assert.strictEqual(classifyActionOutcome({ command: { status: 'REJECTED' } }), 'FAILED');
assert.strictEqual(classifyActionOutcome({ deviceExecution: { status: 'FAILED' } }), 'FAILED');
assert.strictEqual(classifyActionOutcome({ failureCode: 'ACTION_EFFECT_MISMATCH' }), 'FAILED');

let knownActionDispatches = 0;
const dispatched = dispatchAction(fixture.execDir, {
  basedOnSceneId: beforeScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '完成共享动作' },
  sequenceId: 'sequence-0001',
  stepId: 'tap',
  [legacyPlanKey]: 'retired-plan',
}, {
  now: '2026-09-24T10:00:00.000Z',
  invokeDeviceOperation: () => {
    knownActionDispatches += 1;
    return acceptedResult('tap');
  },
});
const completed = completeDispatchedAction(fixture.execDir, dispatched, postScene(beforeScene, 'scene-0099'), {
  sequenceId: 'sequence-0001', stepId: 'tap', preSceneRef: beforeScene.sceneId,
}, { promoteScene: false, now: '2026-09-24T10:00:00.100Z' });

assert.strictEqual(completed.lifecycle.status, 'COMPLETED');
assert.strictEqual(completed.evidence.sceneRefs.after, 'scene-0099');
assert.strictEqual(store.readCurrentScene(fixture.execDir).sceneId, beforeScene.sceneId);
assert.strictEqual(transactions.readAction(fixture.execDir, dispatched.operationId), null);
const storedCompleted = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'operations', `${dispatched.operationId}.json`), 'utf8'));
assert.strictEqual(storedCompleted.sequenceId, 'sequence-0001');
assert.strictEqual(storedCompleted.stepId, 'tap');
assert.strictEqual(Object.hasOwn(storedCompleted, legacyPlanKey), false);
assert.strictEqual(storedCompleted.actionResult.evidence.sceneRefs.after, 'scene-0099');
const requested = store.events(fixture.execDir).find((event) => event.type === 'actionRequested' && event.operationId === dispatched.operationId);
const completion = store.events(fixture.execDir).find((event) => event.type === 'actionCompleted' && event.operationId === dispatched.operationId);
assert.strictEqual(requested.sequenceId, 'sequence-0001');
assert.strictEqual(requested.stepId, 'tap');
assert.strictEqual(completion.sequenceId, 'sequence-0001');
assert.strictEqual(completion.stepId, 'tap');
assert.strictEqual(Object.hasOwn(completion, legacyPlanKey), false);

const interruptedCompletion = dispatchAction(fixture.execDir, {
  basedOnSceneId: beforeScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '验证完成事件后的恢复' },
}, {
  now: '2026-09-24T10:00:00.200Z',
  invokeDeviceOperation: () => {
    knownActionDispatches += 1;
    return acceptedResult('tap');
  },
});
assert.throws(() => completeDispatchedAction(fixture.execDir, interruptedCompletion, postScene(beforeScene, 'scene-0098'), {
  preSceneRef: beforeScene.sceneId,
}, {
  promoteScene: false,
  interruptAfter: 'action-completed',
  now: '2026-09-24T10:00:00.210Z',
}), /MAVT_CASE_ACTION_INTERRUPTED: action-completed/);
assert.strictEqual(transactions.readAction(fixture.execDir, interruptedCompletion.operationId).status, 'RESULT_RECORDED');
assert.strictEqual(store.events(fixture.execDir)
  .filter((event) => event.type === 'actionCompleted' && event.operationId === interruptedCompletion.operationId).length, 1);
completeDispatchedAction(fixture.execDir, interruptedCompletion, postScene(beforeScene, 'scene-0098'), {
  preSceneRef: beforeScene.sceneId,
}, { promoteScene: false, now: '2026-09-24T10:00:00.220Z' });
assert.strictEqual(transactions.readAction(fixture.execDir, interruptedCompletion.operationId), null);
assert.strictEqual(store.events(fixture.execDir)
  .filter((event) => event.type === 'actionCompleted' && event.operationId === interruptedCompletion.operationId).length, 1);
completeDispatchedAction(fixture.execDir, dispatched, postScene(beforeScene, 'scene-0099'), {
  sequenceId: 'sequence-0001', stepId: 'tap', preSceneRef: beforeScene.sceneId,
}, { promoteScene: false, now: '2026-09-24T10:00:00.230Z' });
assert.strictEqual(store.events(fixture.execDir)
  .filter((event) => event.type === 'actionCompleted' && event.operationId === dispatched.operationId).length, 1);
assert.strictEqual(knownActionDispatches, 2);

const publicInterruptFixture = makeFixture('public-action-completion-interrupt');
const publicInterruptBefore = store.readCurrentScene(publicInterruptFixture.execDir);
let publicInterruptActionCalls = 0;
assert.throws(() => act(publicInterruptFixture.execDir, {
  basedOnSceneId: publicInterruptBefore.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '验证动作完成事件后的中断恢复' },
}, {
  now: '2026-09-24T10:00:00.300Z',
  interruptAfter: 'action-completed',
  invokeDeviceOperation: (_execDir, _payload, kind) => {
    if (kind === 'ACTION') {
      publicInterruptActionCalls += 1;
      return acceptedResult('tap');
    }
    return observationResult(publicInterruptBefore, null);
  },
}), /MAVT_CASE_ACTION_INTERRUPTED: action-completed/);
const publicInterruptOperationId = store.events(publicInterruptFixture.execDir)
  .filter((event) => event.type === 'actionRequested').at(-1).operationId;
const publicInterruptDraft = transactions.readAction(publicInterruptFixture.execDir, publicInterruptOperationId);
const publicInterruptPostScene = store.readCurrentScene(publicInterruptFixture.execDir);
assert.strictEqual(publicInterruptDraft.status, 'RESULT_RECORDED');
assert.strictEqual(store.events(publicInterruptFixture.execDir)
  .filter((event) => event.type === 'technicalIssue' && event.operationId === publicInterruptOperationId).length, 0);
assert.strictEqual(store.events(publicInterruptFixture.execDir)
  .filter((event) => event.type === 'actionCompleted' && event.operationId === publicInterruptOperationId).length, 1);
assert.strictEqual(store.events(publicInterruptFixture.execDir)
  .find((event) => event.type === 'actionCompleted' && event.operationId === publicInterruptOperationId).sceneIdAfter,
publicInterruptPostScene.sceneId);
completeDispatchedAction(publicInterruptFixture.execDir, {
  operationId: publicInterruptOperationId,
  beforeScene: publicInterruptBefore,
  action: {
    action: publicInterruptDraft.action,
    command: publicInterruptDraft.deviceResult.command,
    deviceExecution: publicInterruptDraft.deviceResult.deviceExecution,
  },
  adapterResult: publicInterruptDraft.deviceResult,
}, publicInterruptPostScene, {
  preSceneRef: publicInterruptBefore.sceneId,
}, { promoteScene: true, now: '2026-09-24T10:00:00.310Z' });
assert.strictEqual(transactions.readAction(publicInterruptFixture.execDir, publicInterruptOperationId), null);
assert.strictEqual(store.events(publicInterruptFixture.execDir)
  .filter((event) => event.type === 'actionCompleted' && event.operationId === publicInterruptOperationId).length, 1);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(
  publicInterruptFixture.execDir, 'operations', `${publicInterruptOperationId}.json`), 'utf8')).sceneIdAfter,
publicInterruptPostScene.sceneId);
assert.strictEqual(publicInterruptActionCalls, 1);

const inputScene = store.readCurrentScene(fixture.execDir);
inputScene.elements = [{
  id: 'account-field', text: '账号', role: 'TextField', bounds: [80, 210, 360, 270],
  clickable: false, checkable: false, editable: true, enabled: true, visible: true, focused: false,
}];
inputScene.capabilities = buildCapabilities(inputScene, 'harmony');
store.writeScene(fixture.execDir, inputScene);
const inputText = '13223222360';
const inputDispatched = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId,
  capabilityId: `${inputScene.sceneId}:inputText:account-field`,
  input: { text: inputText, mode: 'replace' },
  decision: { purpose: '输入账号' },
  sequenceId: 'sequence-0001',
  stepId: 'input',
}, {
  now: '2026-09-24T10:00:01.000Z',
  invokeDeviceOperation: () => acceptedResult('inputText'),
});
const inputCompleted = completeDispatchedAction(fixture.execDir, inputDispatched, postScene(inputScene, 'scene-0100'), {
  sequenceId: 'sequence-0001', stepId: 'input', preSceneRef: inputScene.sceneId,
}, { promoteScene: false, now: '2026-09-24T10:00:01.100Z' });
const inputOperation = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'operations', `${inputDispatched.operationId}.json`), 'utf8'));
const inputEvents = store.events(fixture.execDir).filter((event) => event.operationId === inputDispatched.operationId);
for (const persisted of [inputCompleted, inputOperation, ...inputEvents]) {
  assert.strictEqual(JSON.stringify(persisted).includes(inputText), false);
  assert.strictEqual(JSON.stringify(persisted).includes('[REDACTED]'), true);
}

const failedCapture = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '验证采集失败收口' },
}, {
  now: '2026-09-24T10:00:02.010Z',
  invokeDeviceOperation: () => acceptedResult('tap'),
});
const captureFailure = store.appendEvent(fixture.execDir, 'technicalIssue', {
  operationId: failedCapture.operationId,
  code: 'POST_ACTION_CAPTURE_FAILED', message: 'post-action capture failed', operation: 'act',
}, { now: '2026-09-24T10:00:02.000Z' });
completeDispatchedAction(fixture.execDir, failedCapture, null, {
  preSceneRef: inputScene.sceneId,
}, {
  promoteScene: false,
  captureFailureTechnicalFactRef: captureFailure.technicalFactRef,
  now: '2026-09-24T10:00:02.020Z',
});
const captureFailureOperation = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'operations', `${failedCapture.operationId}.json`), 'utf8'));
assert.strictEqual(captureFailureOperation.observationStatus, 'FAILED');
assert.strictEqual(captureFailureOperation.sceneIdAfter, null);
assert.strictEqual(captureFailureOperation.captureFailureTechnicalFactRef, captureFailure.technicalFactRef);
assert.strictEqual(store.events(fixture.execDir).some((event) => event.type === 'actionCompleted' && event.operationId === failedCapture.operationId), false);

const wrongOperationCapture = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '拒绝其他动作的采集事实' },
}, {
  now: '2026-09-24T10:00:02.030Z',
  invokeDeviceOperation: () => acceptedResult('tap'),
});
const foreignCaptureFailure = store.appendEvent(fixture.execDir, 'technicalIssue', {
  operationId: 'action-foreign',
  code: 'POST_ACTION_CAPTURE_FAILED', message: 'foreign capture failed', operation: 'act',
}, { now: '2026-09-24T10:00:02.040Z' });
assert.throws(() => completeDispatchedAction(fixture.execDir, wrongOperationCapture, null, {
  preSceneRef: inputScene.sceneId,
}, {
  promoteScene: false,
  captureFailureTechnicalFactRef: foreignCaptureFailure.technicalFactRef,
}), /capture-failure technical fact/);
assert.strictEqual(transactions.readAction(fixture.execDir, wrongOperationCapture.operationId).status, 'RESULT_RECORDED');

const wrongCodeCapture = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '拒绝非采集错误事实' },
}, {
  now: '2026-09-24T10:00:02.050Z',
  invokeDeviceOperation: () => acceptedResult('tap'),
});
const wrongCodeFact = store.appendEvent(fixture.execDir, 'technicalIssue', {
  operationId: wrongCodeCapture.operationId,
  code: 'DEVICE_ACTION_FAILED', message: 'the action failed', operation: 'act',
}, { now: '2026-09-24T10:00:02.060Z' });
assert.throws(() => completeDispatchedAction(fixture.execDir, wrongCodeCapture, null, {
  preSceneRef: inputScene.sceneId,
}, {
  promoteScene: false,
  captureFailureTechnicalFactRef: wrongCodeFact.technicalFactRef,
}), /capture-failure technical fact/);
assert.strictEqual(transactions.readAction(fixture.execDir, wrongCodeCapture.operationId).status, 'RESULT_RECORDED');

const scrollFixture = makeFixture('standalone-scroll');
const scrollLayoutRef = 'layouts/scroll-feed.xml';
fs.mkdirSync(path.join(scrollFixture.execDir, 'layouts'), { recursive: true });
fs.writeFileSync(path.join(scrollFixture.execDir, scrollLayoutRef), [
  '<hierarchy>',
  '<node class="android.widget.ListView" resource-id="feed" scrollable="true" visible="true" bounds="[0,0][1000,900]">',
  '<node class="android.widget.ListItem" text="A" visible="true" bounds="[0,100][1000,200]"/>',
  '<node class="android.widget.ListItem" text="B" visible="true" bounds="[0,300][1000,400]"/>',
  '</node>',
  '</hierarchy>',
].join(''));
const initialScrollScene = store.readCurrentScene(scrollFixture.execDir);
sceneService.observe(scrollFixture.execDir, {
  now: '2026-09-24T10:00:03.000Z',
  invokeDeviceOperation: () => observationResult(initialScrollScene, scrollLayoutRef),
});
const scrollBefore = store.readCurrentScene(scrollFixture.execDir);
scrollBefore.screenshot = { ...scrollBefore.screenshot, width: 1000, height: 1000 };
store.writeScene(scrollFixture.execDir, scrollBefore);
assert.strictEqual(scrollBefore.scrollContexts.length, 1);
const scrolled = act(scrollFixture.execDir, {
  basedOnSceneId: scrollBefore.sceneId,
  visual: { gesture: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] },
  decision: { purpose: '继续向下搜索列表' },
}, {
  now: '2026-09-24T10:00:03.100Z',
  invokeDeviceOperation: (_execDir, _payload, kind) => kind === 'ACTION'
    ? acceptedResult('swipe')
    : observationResult(scrollBefore, scrollLayoutRef),
});
const scrollAfter = store.readCurrentScene(scrollFixture.execDir);
assert.strictEqual(scrolled.scene.sceneId, scrollAfter.sceneId);
assert.strictEqual(scrollAfter.source.operation, 'act');
assert.strictEqual(scrollAfter.scrollContexts[0].lastDirection, 'DOWN');
assert.strictEqual(scrollAfter.scrollContexts[0].noProgress.DOWN, 1);

const adapterErrorSecret = 'adapter-secret-13223222360';
const { fixture: adapterErrorFixture, scene: adapterErrorScene } = inputSceneFixture('adapter-error-redaction');
const adapterErrorAction = act(adapterErrorFixture.execDir, inputRequest(adapterErrorScene, adapterErrorSecret), {
  now: '2026-09-24T10:00:04.000Z',
  invokeDeviceOperation: (_execDir, _payload, kind) => {
    if (kind === 'ACTION') {
      throw Object.assign(new Error(`input adapter failed for ${adapterErrorSecret}`), { code: 'DEVICE_ACTION_FAILED' });
    }
    return observationResult(adapterErrorScene, null);
  },
});
assert.strictEqual(adapterErrorAction.status, 'SCENE');
assert.strictEqual(adapterErrorAction.action.outcomeKnown, false);
assert.strictEqual(JSON.stringify(adapterErrorAction).includes(adapterErrorSecret), false);
assert.strictEqual(persistedText(adapterErrorFixture.execDir).includes(adapterErrorSecret), false);

const observeErrorSecret = 'observe-secret-13223222360';
const { fixture: observeErrorFixture, scene: observeErrorScene } = inputSceneFixture('observe-error-redaction');
assert.throws(() => act(observeErrorFixture.execDir, inputRequest(observeErrorScene, observeErrorSecret), {
  now: '2026-09-24T10:00:04.100Z',
  invokeDeviceOperation: (_execDir, _payload, kind) => {
    if (kind === 'ACTION') return acceptedResult('inputText');
    throw Object.assign(new Error(`post-action observation failed for ${observeErrorSecret}`), {
      code: 'OBSERVATION_SCREENSHOT_FAILED',
    });
  },
}), (error) => !error.message.includes(observeErrorSecret));
assert.strictEqual(persistedText(observeErrorFixture.execDir).includes(observeErrorSecret), false);
const observeErrorOperationId = store.events(observeErrorFixture.execDir)
  .filter((event) => event.type === 'actionRequested').at(-1).operationId;
assert.strictEqual(transactions.readAction(observeErrorFixture.execDir, observeErrorOperationId), null);
assert.strictEqual(fs.existsSync(path.join(observeErrorFixture.execDir, 'operations', `${observeErrorOperationId}.json`)), true);

console.log('action-completion.test.js: all assertions passed');

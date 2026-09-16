'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { buildCapabilities } = require('../case-runtime/capability-catalog');
const caseModelService = require('../case-runtime/case-model-service');
const decisionTransaction = require('../case-runtime/decision-transaction');
const { run } = require('../case-runtime/agent-facing-client');
const { translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const store = require('../case-runtime/store');

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-decision-transaction-'));
fs.mkdirSync(path.join(execDir, 'scenes'));
fs.mkdirSync(path.join(execDir, 'screenshots'));
fs.mkdirSync(path.join(execDir, 'transactions'));
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 12, runtime: 'case-runtime', executionId: 'execution-decision', status: 'RUNNING', lifecycle: 'RUNNING', finalized: false,
  platform: 'android', startedAt: '2026-09-16T00:00:00.000Z', targetBinding: { appId: 'com.example' },
});
writeJsonAtomic(path.join(execDir, 'runtime.json'), {
  executionId: 'execution-decision', status: 'READY',
  entry: path.join(execDir, 'agent-facing-client.js'),
  broker: { allowedOperations: ['observe', 'act', 'inspectVisual', 'inspectScene', 'knowledge', 'recover', 'finish', 'status'] },
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const screenshotPath = path.join(execDir, 'screenshots', 'scene-0001.png');
fs.writeFileSync(screenshotPath, png);
const digest = crypto.createHash('sha256').update(png).digest('hex');
const scene = {
  sceneId: 'scene-0001', capturedAt: '2026-09-16T00:00:01.000Z',
  screenshot: { ref: 'screenshots/scene-0001.png', path: screenshotPath, sha256: digest, width: 1, height: 1 },
  evidenceChannels: { visual: { available: true, ref: 'screenshots/scene-0001.png', attachment: { path: screenshotPath, mediaType: 'image/png', sha256: digest } } },
  app: { appId: 'com.example', inTargetApp: true }, signals: {}, conflicts: [], scrollContexts: [],
  elements: [{ id: 'record-button', text: '录音', role: 'Button', bounds: [0, 0, 1, 1], clickable: true, checkable: false, editable: false, enabled: true, visible: true }],
  visual: { gestures: ['tap'] }, previousAction: null,
};
scene.capabilities = buildCapabilities(scene, 'android');
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-0001.json'), scene);
store.appendEvent(execDir, 'sceneObserved', {
  sceneId: scene.sceneId, screenshotRef: scene.screenshot.ref, screenshotSha256: digest,
  layoutRef: null, app: scene.app,
});
caseModelService.revise(execDir, {
  understanding: '验证录音按钮', preconditions: [], verificationPoints: [{ text: '录音按钮可见' }],
  items: ['观察并点击'], uncertainties: [],
});

let brokerCalls = 0;
const executeRequest = () => {
  brokerCalls += 1;
  return { status: 'READY' };
};
const rejected = run(execDir, {
  capability: 'act', basedOnSceneRef: 'scene-0001', actionRef: 'missing:tap', purpose: '继续',
  updates: {
    visual: { observation: '录音按钮可见', expectationRefs: ['E1'] },
    expectationResults: [{ expectationRef: 'E1', status: 'PASS', actual: '录音按钮可见', evidence: { sceneRefs: ['scene-0001'] } }],
  },
}, { executeRequest });
assert.strictEqual(rejected.code, 'ACTION_NOT_AVAILABLE');
assert.deepStrictEqual(rejected.updatesApplied, { visual: true, expectationResults: ['E1'] });
assert.deepStrictEqual(rejected.effect, { type: 'act', status: 'REJECTED' });
assert.strictEqual(brokerCalls, 0);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'visualInspected').length, 1);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length, 1);

const finishRequest = { capability: 'finish', summary: '录音按钮验证完成', uncertainties: [] };
const translatedFinish = translateAgentFacingRequest(execDir, finishRequest);
assert.strictEqual(translatedFinish.operation, 'finish');
assert.deepStrictEqual(translatedFinish.result.checks.map((item) => item.expectationRef), ['E1']);
assert.strictEqual(Object.prototype.hasOwnProperty.call(finishRequest, 'checks'), false);
const finishResponse = run(execDir, finishRequest, {
  executeRequest: () => ({
    status: 'COMPLETED', executionId: 'execution-decision', verdict: 'PASS',
    result: translatedFinish.result, evidenceDiagnostics: { validatedSceneRefs: ['scene-0001'] },
  }),
});
assert.deepStrictEqual(finishResponse, {
  protocol: 'agent-facing', status: 'COMPLETED', verdict: 'PASS',
  executionRef: 'execution-decision', resultRef: 'result.json',
});
assert.strictEqual(finishResponse.result, undefined);

const visualCount = store.events(execDir).filter((event) => event.type === 'visualInspected').length;
const invalidBundle = run(execDir, {
  capability: 'act', basedOnSceneRef: 'scene-0001', actionRef: 'record-button:tap', purpose: '继续',
  updates: {
    visual: { observation: '补充事实', expectationRefs: ['E1'] },
    expectationResults: [{ expectationRef: 'E9', status: 'PASS', actual: '未知', evidence: { sceneRefs: ['scene-0001'] } }],
  },
}, { executeRequest });
assert.strictEqual(invalidBundle.status, 'INPUT_INVALID');
assert.strictEqual(invalidBundle.code, 'AGENT_INPUT_INVALID');
assert.strictEqual(brokerCalls, 0);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'visualInspected').length, visualCount,
  'invalid update bundle must not partially persist visual facts');

const preparedCrashRequest = {
  capability: 'observe', basedOnSceneRef: 'scene-0001', purpose: '验证 draft 恢复',
  updates: { visual: { observation: 'draft 写入后等待恢复', expectationRefs: ['E1'] } },
};
const preparedCrashSubmission = decisionTransaction.submissionIdFor(preparedCrashRequest);
assert.throws(() => decisionTransaction.applyUpdates(execDir, preparedCrashRequest, {
  interruptAfterDecisionStage: 'prepared',
}), /MAVT_DECISION_INTERRUPTED/);
const recoveredPrepared = decisionTransaction.applyUpdates(execDir, preparedCrashRequest);
assert.strictEqual(recoveredPrepared.status, 'UPDATES_APPLIED');
assert.strictEqual(store.events(execDir).filter((event) => (
  event.type === 'visualInspected' && event.submissionId === preparedCrashSubmission
)).length, 1, 'a prepared draft must resume with one visual fact');

const appliedCrashRequest = {
  capability: 'observe', basedOnSceneRef: 'scene-0001', purpose: '验证 updates receipt 恢复',
  updates: {
    expectationResults: [{
      expectationRef: 'E1', status: 'PASS', actual: 'receipt 写入前结论已保存', evidence: { sceneRefs: ['scene-0001'] },
    }],
  },
};
const appliedCrashSubmission = decisionTransaction.submissionIdFor(appliedCrashRequest);
assert.throws(() => decisionTransaction.applyUpdates(execDir, appliedCrashRequest, {
  interruptAfterDecisionStage: 'updates-applied',
}), /MAVT_DECISION_INTERRUPTED/);
const recoveredApplied = decisionTransaction.applyUpdates(execDir, appliedCrashRequest);
assert.strictEqual(recoveredApplied.status, 'UPDATES_APPLIED');
assert.strictEqual(store.events(execDir).filter((event) => (
  event.type === 'expectationResultUpdated' && event.submissionId === appliedCrashSubmission
)).length, 1, 'an applied receipt must be returned without writing the verdict twice');

const visualCrashRequest = {
  capability: 'observe', basedOnSceneRef: 'scene-0001', purpose: '刷新视觉事实',
  updates: { visual: { observation: '中断前录音按钮仍然可见', expectationRefs: ['E1'] } },
};
const visualCrashSubmission = decisionTransaction.submissionIdFor(visualCrashRequest);
assert.throws(() => decisionTransaction.applyUpdates(execDir, visualCrashRequest, {
  interruptAfterDecisionUpdate: 'visual',
}), /MAVT_DECISION_INTERRUPTED/);
const recoveredVisual = decisionTransaction.applyUpdates(execDir, visualCrashRequest);
assert.strictEqual(recoveredVisual.status, 'UPDATES_APPLIED');
assert.strictEqual(store.events(execDir).filter((event) => (
  event.type === 'visualInspected' && event.submissionId === visualCrashSubmission
)).length, 1, 'visual update recovery must not append the fact twice');

const resultCrashRequest = {
  capability: 'observe', basedOnSceneRef: 'scene-0001', purpose: '保存验证结论',
  updates: {
    expectationResults: [{
      expectationRef: 'E1', status: 'PASS', actual: '中断前录音按钮可见', evidence: { sceneRefs: ['scene-0001'] },
    }],
  },
};
const resultCrashSubmission = decisionTransaction.submissionIdFor(resultCrashRequest);
assert.throws(() => decisionTransaction.applyUpdates(execDir, resultCrashRequest, {
  interruptAfterDecisionUpdate: 'expectationResults',
}), /MAVT_DECISION_INTERRUPTED/);
const recoveredResult = decisionTransaction.applyUpdates(execDir, resultCrashRequest);
assert.strictEqual(recoveredResult.status, 'UPDATES_APPLIED');
assert.strictEqual(store.events(execDir).filter((event) => (
  event.type === 'expectationResultUpdated' && event.submissionId === resultCrashSubmission
)).length, 1, 'expectation result recovery must not append the verdict twice');

const modelCountBeforeNewRef = caseModelService.history(execDir).length;
const newRefInSameSubmission = run(execDir, {
  capability: 'observe', basedOnSceneRef: 'scene-0001', purpose: '尝试引用同请求新建验证点',
  updates: {
    caseModel: {
      baseRevision: 1,
      understanding: '验证录音按钮和录音状态',
      preconditions: [],
      verificationPoints: [{ ref: 'E1', text: '录音按钮可见' }, { text: '录音状态可见' }],
      items: ['观察并点击', '验证录音状态'],
      uncertainties: [],
      reason: '增加录音状态验证点',
    },
    expectationResults: [{
      expectationRef: 'E2', status: 'PASS', actual: '录音状态可见', evidence: { sceneRefs: ['scene-0001'] },
    }],
  },
}, { executeRequest });
assert.strictEqual(newRefInSameSubmission.status, 'INPUT_INVALID');
assert.ok(newRefInSameSubmission.issues.some((item) => item.code === 'EXPECTATION_UNKNOWN'));
assert.strictEqual(caseModelService.history(execDir).length, modelCountBeforeNewRef,
  'a rejected update bundle must not create the new verification point');
assert.strictEqual(brokerCalls, 0);

const modelCountBeforeCrash = caseModelService.history(execDir).length;
const recoverableUpdate = {
  capability: 'observe',
  basedOnSceneRef: 'scene-0001',
  purpose: '刷新修订后的现场',
  updates: {
    caseModel: {
      understanding: '验证录音按钮和页面状态',
      preconditions: [],
      verificationPoints: [{ ref: 'E1', text: '录音按钮可见' }],
      items: ['观察并点击'],
      uncertainties: [],
      reason: '现场补充了页面状态信息',
    },
  },
};
assert.throws(() => decisionTransaction.applyUpdates(execDir, recoverableUpdate, {
  interruptAfterDecisionUpdate: 'caseModel',
}), /MAVT_DECISION_INTERRUPTED/);
const recoveredUpdate = decisionTransaction.applyUpdates(execDir, recoverableUpdate);
assert.strictEqual(recoveredUpdate.status, 'UPDATES_APPLIED');
assert.strictEqual(caseModelService.history(execDir).length, modelCountBeforeCrash + 1,
  'recovery must not append the Case Model revision twice');
assert.strictEqual(store.events(execDir).filter((event) => (
  event.type === 'caseModelRevised' && event.submissionId === recoveredUpdate.submissionId
)).length, 1);

let unknownDispatches = 0;
const unknownRequest = {
  capability: 'act', basedOnSceneRef: 'scene-0001', actionRef: 'record-button:tap', purpose: '验证未知投递恢复',
  updates: { visual: { observation: '录音按钮仍然可见', expectationRefs: ['E1'] } },
};
assert.throws(() => run(execDir, unknownRequest, {
  executeRequest: () => {
    unknownDispatches += 1;
    throw new Error('response lost after dispatch');
  },
}), /response lost after dispatch/);
const unknownRetry = run(execDir, unknownRequest, {
  executeRequest: () => {
    unknownDispatches += 1;
    return { status: 'READY' };
  },
});
assert.strictEqual(unknownRetry.code, 'ACTION_OUTCOME_UNKNOWN');
assert.strictEqual(unknownRetry.effect.status, 'OUTCOME_UNKNOWN');
assert.strictEqual(unknownDispatches, 1, 'an effect with unknown dispatch outcome must never replay');

let completedDispatches = 0;
const completedRequest = {
  capability: 'act', basedOnSceneRef: 'scene-0001', actionRef: 'record-button:tap', purpose: '验证完成响应复用',
  updates: {
    expectationResults: [{
      expectationRef: 'E1', status: 'PASS', actual: '录音按钮仍然可见', evidence: { sceneRefs: ['scene-0001'] },
    }],
  },
};
const completedOnce = run(execDir, completedRequest, {
  executeRequest: () => {
    completedDispatches += 1;
    return { status: 'READY' };
  },
});
const completedAgain = run(execDir, completedRequest, {
  executeRequest: () => {
    completedDispatches += 1;
    return { status: 'READY' };
  },
});
assert.deepStrictEqual(completedAgain, completedOnce);
assert.strictEqual(completedDispatches, 1, 'a completed effect must reuse its persisted response');

const observeRecoveryRequest = {
  capability: 'observe', basedOnSceneRef: 'scene-0001', purpose: '恢复现场采集',
  updates: { visual: { observation: '恢复前页面仍显示录音按钮', expectationRefs: ['E1'] } },
};
const observeSubmission = decisionTransaction.applyUpdates(execDir, observeRecoveryRequest);
decisionTransaction.startEffect(execDir, observeSubmission.submissionId);
let recoveredObservations = 0;
const recoveredObservation = run(execDir, observeRecoveryRequest, {
  executeRequest: () => {
    recoveredObservations += 1;
    return { status: 'READY' };
  },
});
assert.strictEqual(recoveredObservation.status, 'READY');
assert.strictEqual(recoveredObservations, 1, 'an interrupted observation may capture a fresh Scene');

const finishRecoveryRequest = {
  capability: 'finish', summary: '恢复收口',
  updates: {
    expectationResults: [{
      expectationRef: 'E1', status: 'PASS', actual: '录音按钮仍然可见', evidence: { sceneRefs: ['scene-0001'] },
    }],
  },
};
const finishSubmission = decisionTransaction.applyUpdates(execDir, finishRecoveryRequest);
decisionTransaction.startEffect(execDir, finishSubmission.submissionId);
let recoveredFinishes = 0;
const recoveredFinish = run(execDir, finishRecoveryRequest, {
  executeRequest: () => {
    recoveredFinishes += 1;
    return { status: 'COMPLETED', executionId: 'execution-decision', verdict: 'PASS' };
  },
});
assert.strictEqual(recoveredFinish.status, 'COMPLETED');
assert.strictEqual(recoveredFinishes, 1, 'an interrupted finish must resume through the idempotent finalization path');

const sceneTwo = { ...scene, sceneId: 'scene-0002', capturedAt: '2026-09-16T00:00:02.000Z' };
sceneTwo.capabilities = buildCapabilities(sceneTwo, 'android');
writeJsonAtomic(path.join(execDir, 'current-scene.json'), sceneTwo);
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-0002.json'), sceneTwo);
let staleEffectCalls = 0;
const staleEffect = run(execDir, {
  capability: 'act', basedOnSceneRef: 'scene-0001', actionRef: 'record-button:tap', purpose: '基于旧现场继续',
  updates: { visual: { observation: '旧现场中的录音按钮可见', expectationRefs: ['E1'] } },
}, {
  executeRequest: () => {
    staleEffectCalls += 1;
    return { status: 'READY' };
  },
});
assert.strictEqual(staleEffect.code, 'SCENE_CHANGED');
assert.deepStrictEqual(staleEffect.updatesApplied, { visual: true });
assert.deepStrictEqual(staleEffect.effect, { type: 'act', status: 'REJECTED' });
assert.strictEqual(staleEffectCalls, 0, 'a stale effect must not reach the Runtime broker');
assert.ok(store.events(execDir).some((event) => (
  event.type === 'visualInspected' && event.sceneId === 'scene-0001' && event.observation === '旧现场中的录音按钮可见'
)), 'facts about a historical Scene must survive rejection of the stale effect');

fs.rmSync(execDir, { recursive: true, force: true });
console.log('decision transaction passed');

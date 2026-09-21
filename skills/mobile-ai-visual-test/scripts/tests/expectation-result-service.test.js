'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const store = require('../case-runtime/store');
const caseFlowService = require('../case-runtime/case-flow-service');
const {
  applyExpectationResults,
  buildCaseResultFromLedger,
  caseStateSummary,
  expectationSemanticHash,
  finishReadiness,
} = require('../case-runtime/expectation-result-service');

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-expectation-ledger-'));
fs.mkdirSync(path.join(execDir, 'scenes'));
fs.mkdirSync(path.join(execDir, 'transactions'));
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 13, runtime: 'case-runtime', executionId: 'execution-ledger', status: 'RUNNING', finalized: false,
  platform: 'android', startedAt: '2026-09-16T00:00:00.000Z', targetBinding: { appId: 'com.example' },
});
const scene = {
  sceneId: 'scene-0001',
  screenshot: { ref: 'screenshots/scene-0001.png', sha256: 'scene-sha' },
  app: { appId: 'com.example', inTargetApp: true },
};
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-0001.json'), scene);
store.appendEvent(execDir, 'sceneObserved', {
  sceneId: 'scene-0001', screenshotRef: scene.screenshot.ref,
  screenshotSha256: scene.screenshot.sha256, app: scene.app,
});

assert.strictEqual(expectationSemanticHash(' A\r\nB ', 'DIRECT_OBSERVATION'), expectationSemanticHash('A\nB', 'DIRECT_OBSERVATION'));
assert.notStrictEqual(expectationSemanticHash('A\nB', 'DIRECT_OBSERVATION'), expectationSemanticHash('A\nB', 'SEARCH_EXISTENCE'));
caseFlowService.revise(execDir, {
  baseRevision: null, summary: '验证首页', entryNodeRef: 'N1',
  nodes: [
    { ref: 'N1', type: 'CHECK', text: '首页标题可见', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期', requirement: 'REQUIRED' },
    { ref: 'N2', type: 'END', text: '完成' },
  ],
  edges: [{ ref: 'L1', from: 'N1', to: 'N2' }], uncertainties: [],
});

let receipt = applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'PASS', actual: '标题可见', evidence: { sceneRefs: ['scene-0001'] },
}], { submissionId: 'decision-1', basedOnSceneRef: 'scene-0001' });
assert.deepStrictEqual(receipt.updated, ['N1']);
assert.deepStrictEqual(finishReadiness(execDir).unresolved, [{
  expectationRef: 'N1', reasons: ['VISUAL_INSPECTION_REQUIRED'],
}]);

store.appendEvent(execDir, 'visualInspected', {
  inspectionId: 'inspection-0001', sceneId: 'scene-0001', screenshotRef: 'screenshots/scene.png',
  screenshotSha256: 'sha', observation: '标题可见', expectationRefs: ['N1'],
});
assert.strictEqual(finishReadiness(execDir).ready, true);
assert.deepStrictEqual(caseStateSummary(execDir).expectations, {
  active: 1, resolved: 1, unresolved: [], conflicts: [],
});

assert.throws(() => applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'PASS', actual: '标题可见',
  evidence: { sceneRefs: ['scene-0001'], knowledgeRefs: ['K-unknown'] },
}], { submissionId: 'decision-invalid-knowledge', basedOnSceneRef: 'scene-0001' }),
(error) => error.code === 'EVIDENCE_REFERENCE_INVALID');

writeJsonAtomic(path.join(execDir, 'scenes', 'scene-0001.json'), {
  ...scene, screenshot: { ...scene.screenshot, sha256: 'changed-sha' },
});
assert.deepStrictEqual(finishReadiness(execDir), {
  ready: false,
  resolved: [],
  unresolved: [],
  conflicts: [{ expectationRef: 'N1', codes: ['SCENE_EVIDENCE_CHANGED'] }],
});
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-0001.json'), scene);
assert.strictEqual(finishReadiness(execDir).ready, true);

const beforeDuplicate = store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length;
receipt = applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'PASS', actual: '标题可见', evidence: { sceneRefs: ['scene-0001'] },
}], { submissionId: 'decision-2', basedOnSceneRef: 'scene-0001' });
assert.deepStrictEqual(receipt.idempotent, ['N1']);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length, beforeDuplicate);

const beforeInvalidBatch = store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length;
assert.throws(() => applyExpectationResults(execDir, [
  { expectationRef: 'N1', status: 'PASS', actual: '标题仍然可见', evidence: { sceneRefs: ['scene-0001'] } },
  { expectationRef: 'N9', status: 'PASS', actual: '未知验证点', evidence: { sceneRefs: ['scene-0001'] } },
]), (error) => error.code === 'EXPECTATION_UNKNOWN');
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length, beforeInvalidBatch,
  'an invalid recordResult batch must not partially persist valid items');

assert.deepStrictEqual(buildCaseResultFromLedger(execDir, { summary: '验证完成', uncertainties: [] }), {
  verdict: 'PASS', summary: '验证完成',
  checks: [{ checkNodeRef: 'N1', status: 'PASS', actual: '标题可见', sceneRefs: ['scene-0001'] }],
  uncertainties: [], caseFlowRevision: 1,
});

caseFlowService.revise(execDir, {
  baseRevision: 1, summary: '现场导航不再经过首页检查', entryNodeRef: 'N2',
  nodes: [
    { ref: 'N2', type: 'END', text: '完成' },
  ],
  edges: [], uncertainties: [], reason: '当前页面已经位于检查点之后',
});
assert.strictEqual(finishReadiness(execDir).ready, true, 'baseline result survives removal from working flow');
assert.strictEqual(caseStateSummary(execDir).expectations.active, 0);
assert.throws(() => applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'NOT_APPLICABLE', actual: '不能用未适用绕过必检项', evidence: {},
}]), (error) => error.code === 'EXPECTATION_RESULT_INVALID');
assert.throws(() => applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'WAIVED', actual: '本次不执行', evidence: {},
}]), (error) => error.code === 'EXPECTATION_RESULT_INVALID');
applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'WAIVED', actual: '本次未执行该检查', reason: '已获得本次执行例外', evidence: {},
}]);
assert.strictEqual(finishReadiness(execDir).ready, true);

caseFlowService.revise(execDir, {
  baseRevision: 2,
  summary: '增加现场条件检查',
  entryNodeRef: 'N3',
  nodes: [
    { ref: 'N3', type: 'CHECK', text: '可选弹窗文案正确', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '现场补充', requirement: 'CONDITIONAL', applicability: '出现可选弹窗' },
    { ref: 'N2', type: 'END', text: '完成' },
  ],
  edges: [{ ref: 'L3', from: 'N3', to: 'N2' }],
  uncertainties: [], reason: '现场出现原始流程未声明的可选弹窗',
});
assert.deepStrictEqual(finishReadiness(execDir).unresolved, [{ expectationRef: 'N3', reasons: ['RESULT_MISSING'] }]);
applyExpectationResults(execDir, [{
  expectationRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未出现可选弹窗', evidence: {},
}]);
assert.deepStrictEqual(buildCaseResultFromLedger(execDir, { summary: '检查点均已处置', uncertainties: [] }), {
  verdict: 'PASS', summary: '检查点均已处置',
  checks: [
    { checkNodeRef: 'N1', status: 'WAIVED', actual: '本次未执行该检查', reason: '已获得本次执行例外' },
    { checkNodeRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未出现可选弹窗' },
  ],
  uncertainties: [], caseFlowRevision: 3,
});

caseFlowService.revise(execDir, {
  baseRevision: 3, summary: '退休现场条件检查', entryNodeRef: 'N2',
  nodes: [{ ref: 'N2', type: 'END', text: '完成' }], edges: [], uncertainties: [],
  reason: '确认弹窗不属于最终工作路径',
});
assert.strictEqual(finishReadiness(execDir).ready, true);
assert.deepStrictEqual(buildCaseResultFromLedger(execDir, { summary: '仅基线责任进入最终结果', uncertainties: [] }).checks, [
  { checkNodeRef: 'N1', status: 'WAIVED', actual: '本次未执行该检查', reason: '已获得本次执行例外' },
]);

fs.rmSync(execDir, { recursive: true, force: true });
console.log('expectation result ledger passed');

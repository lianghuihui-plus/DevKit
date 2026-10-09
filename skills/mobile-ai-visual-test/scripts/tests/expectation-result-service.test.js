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
  schemaVersion: 14, runtime: 'case-runtime', executionId: 'execution-ledger', status: 'RUNNING', finalized: false,
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

assert.throws(() => applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'PASS', actual: '标题可见', evidence: { sceneRefs: ['scene-0001'] },
}], { submissionId: 'decision-1', basedOnSceneRef: 'scene-0001' }),
(error) => error.code === 'CASE_RESULT_INVALID'
  && error.issues.some((issue) => issue.code === 'VISUAL_INSPECTION_REQUIRED'));
assert.strictEqual(store.events(execDir).some((event) => event.type === 'expectationResultUpdated'), false,
  'an unresolved result batch must not persist any result event');

store.appendEvent(execDir, 'visualInspected', {
  inspectionId: 'inspection-0001', sceneId: 'scene-0001', screenshotRef: 'screenshots/scene.png',
  screenshotSha256: 'sha', observation: '标题可见', expectationRefs: ['N1'],
});
let receipt = applyExpectationResults(execDir, [{
  expectationRef: 'N1', status: 'PASS', actual: '标题可见', evidence: { sceneRefs: ['scene-0001'] },
}], { submissionId: 'decision-1', basedOnSceneRef: 'scene-0001' });
assert.deepStrictEqual(receipt.updated, ['N1']);
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

const searchExecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-expectation-search-ledger-'));
fs.mkdirSync(path.join(searchExecDir, 'scenes'));
fs.mkdirSync(path.join(searchExecDir, 'transactions'));
fs.writeFileSync(path.join(searchExecDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(searchExecDir, 'execution.json'), {
  schemaVersion: 14, runtime: 'case-runtime', executionId: 'execution-search-ledger', status: 'RUNNING', finalized: false,
  platform: 'android', startedAt: '2026-09-16T00:00:00.000Z', warmSessionGeneration: 3,
  targetBinding: { appId: 'com.example' },
});
const searchScene = {
  sceneId: 'scene-search-complete', generation: 3,
  screenshot: { ref: 'screenshots/scene-search-complete.png', sha256: 'search-scene-sha' },
  app: { appId: 'com.example', inTargetApp: true },
  scrollContexts: [{
    id: 'scroll-complete', generation: 3, trackingStatus: 'TRACKING', coverage: 'CONTIGUOUS',
    reachedStart: 'CONFIRMED', reachedEnd: 'CONFIRMED', absenceConclusionSupported: true,
  }],
};
const otherScene = {
  sceneId: 'scene-other', generation: 3,
  screenshot: { ref: 'screenshots/scene-other.png', sha256: 'other-scene-sha' },
  app: { appId: 'com.example', inTargetApp: true }, scrollContexts: [],
};
for (const candidate of [searchScene, otherScene]) {
  writeJsonAtomic(path.join(searchExecDir, 'scenes', `${candidate.sceneId}.json`), candidate);
  store.appendEvent(searchExecDir, 'sceneObserved', {
    sceneId: candidate.sceneId, screenshotRef: candidate.screenshot.ref,
    screenshotSha256: candidate.screenshot.sha256, app: candidate.app,
  });
  store.appendEvent(searchExecDir, 'visualInspected', {
    inspectionId: `inspection-${candidate.sceneId}`, sceneId: candidate.sceneId,
    screenshotRef: candidate.screenshot.ref, screenshotSha256: candidate.screenshot.sha256,
    observation: '已检查搜索列表', expectationRefs: ['N1'],
  });
}
writeJsonAtomic(path.join(searchExecDir, 'current-scene.json'), searchScene);
caseFlowService.revise(searchExecDir, {
  baseRevision: null, summary: '验证完整列表中不存在目标', entryNodeRef: 'N1',
  nodes: [
    { ref: 'N1', type: 'CHECK', text: '列表中存在目标', verificationKind: 'SEARCH_EXISTENCE', sourceBasis: '原始用例预期', requirement: 'REQUIRED' },
    { ref: 'N2', type: 'END', text: '完成' },
  ],
  edges: [{ ref: 'L1', from: 'N1', to: 'N2' }], uncertainties: [],
});
const searchAbsence = {
  sceneRef: searchScene.sceneId, scrollContextRef: searchScene.scrollContexts[0].id,
};
function assertSearchResultRejected(result, messagePart) {
  const before = store.events(searchExecDir).filter((event) => event.type === 'expectationResultUpdated').length;
  assert.throws(() => applyExpectationResults(searchExecDir, [result]),
    (error) => error.code === 'CASE_RESULT_INVALID'
      && error.issues.some((issue) => issue.code === 'RECORD_RESULT_INVALID'
        && issue.field === 'results[0].evidence.searchAbsence'
        && issue.message.includes(messagePart)));
  assert.strictEqual(store.events(searchExecDir).filter((event) => event.type === 'expectationResultUpdated').length, before,
    'invalid search evidence must not persist a result event');
}

assertSearchResultRejected({
  expectationRef: 'N1', status: 'FAIL', actual: '完整列表未发现目标',
  evidence: { sceneRefs: [searchScene.sceneId] },
}, '必须引用完整列表覆盖');
assertSearchResultRejected({
  expectationRef: 'N1', status: 'PASS', actual: '目标存在',
  evidence: { sceneRefs: [searchScene.sceneId], searchAbsence },
}, 'PASS');
assertSearchResultRejected({
  expectationRef: 'N1', status: 'FAIL', actual: '完整列表未发现目标',
  evidence: { sceneRefs: [otherScene.sceneId], searchAbsence },
}, '未被该检查引用');
writeJsonAtomic(path.join(searchExecDir, 'scenes', `${searchScene.sceneId}.json`), {
  ...searchScene,
  scrollContexts: searchScene.scrollContexts.map((context) => ({ ...context, generation: 2 })),
});
assertSearchResultRejected({
  expectationRef: 'N1', status: 'FAIL', actual: '完整列表未发现目标',
  evidence: { sceneRefs: [searchScene.sceneId], searchAbsence },
}, '不属于当前 generation');
writeJsonAtomic(path.join(searchExecDir, 'scenes', `${searchScene.sceneId}.json`), searchScene);
assert.deepStrictEqual(applyExpectationResults(searchExecDir, [{
  expectationRef: 'N1', status: 'FAIL', actual: '完整列表未发现目标',
  evidence: { sceneRefs: [searchScene.sceneId], searchAbsence },
}]), { updated: ['N1'], idempotent: [] });
assert.strictEqual(finishReadiness(searchExecDir).ready, true);

fs.rmSync(execDir, { recursive: true, force: true });
fs.rmSync(searchExecDir, { recursive: true, force: true });
console.log('expectation result ledger passed');

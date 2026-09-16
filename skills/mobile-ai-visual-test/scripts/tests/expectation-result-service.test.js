'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const store = require('../case-runtime/store');
const caseModelService = require('../case-runtime/case-model-service');
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
  schemaVersion: 12, runtime: 'case-runtime', executionId: 'execution-ledger', status: 'RUNNING', finalized: false,
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

assert.strictEqual(expectationSemanticHash(' A\r\nB '), expectationSemanticHash('A\nB'));
caseModelService.revise(execDir, {
  understanding: '验证首页', preconditions: [], verificationPoints: [{ text: '首页标题可见' }],
  items: ['观察首页'], uncertainties: [],
});

let receipt = applyExpectationResults(execDir, [{
  expectationRef: 'E1', status: 'PASS', actual: '标题可见', evidence: { sceneRefs: ['scene-0001'] },
}], { submissionId: 'decision-1', basedOnSceneRef: 'scene-0001' });
assert.deepStrictEqual(receipt.updated, ['E1']);
assert.deepStrictEqual(finishReadiness(execDir).unresolved, [{
  expectationRef: 'E1', reasons: ['VISUAL_INSPECTION_REQUIRED'],
}]);

store.appendEvent(execDir, 'visualInspected', {
  inspectionId: 'inspection-0001', sceneId: 'scene-0001', screenshotRef: 'screenshots/scene.png',
  screenshotSha256: 'sha', observation: '标题可见', expectationRefs: ['E1'],
});
assert.strictEqual(finishReadiness(execDir).ready, true);
assert.deepStrictEqual(caseStateSummary(execDir).expectations, {
  active: 1, resolved: 1, unresolved: [], conflicts: [],
});

assert.throws(() => applyExpectationResults(execDir, [{
  expectationRef: 'E1', status: 'PASS', actual: '标题可见',
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
  conflicts: [{ expectationRef: 'E1', codes: ['SCENE_EVIDENCE_CHANGED'] }],
});
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-0001.json'), scene);
assert.strictEqual(finishReadiness(execDir).ready, true);

const beforeDuplicate = store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length;
receipt = applyExpectationResults(execDir, [{
  expectationRef: 'E1', status: 'PASS', actual: '标题可见', evidence: { sceneRefs: ['scene-0001'] },
}], { submissionId: 'decision-2', basedOnSceneRef: 'scene-0001' });
assert.deepStrictEqual(receipt.idempotent, ['E1']);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length, beforeDuplicate);

assert.deepStrictEqual(buildCaseResultFromLedger(execDir, { summary: '验证完成', uncertainties: [] }), {
  verdict: 'PASS', summary: '验证完成',
  checks: [{ expectationRef: 'E1', status: 'PASS', actual: '标题可见', sceneRefs: ['scene-0001'] }],
  uncertainties: [], caseModelRevision: 1,
});

caseModelService.revise(execDir, {
  understanding: '验证首页', preconditions: [], verificationPoints: [{ ref: 'E1', text: '首页副标题可见' }],
  items: ['观察首页'], uncertainties: [], reason: '验证点语义发生变化',
});
assert.deepStrictEqual(finishReadiness(execDir).unresolved, [{ expectationRef: 'E1', reasons: ['RESULT_MISSING'] }]);
assert.ok(store.events(execDir).some((event) => event.type === 'expectationResultInvalidated'
  && event.expectationRef === 'E1' && event.reason === 'SEMANTICS_CHANGED'));

fs.rmSync(execDir, { recursive: true, force: true });
console.log('expectation result ledger passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { validateKnowledgeClosure } = require('../case-runtime/result-integrity');
const { technicalFactState } = require('../lib/technical-facts');

function query(queryId, expectationRefs, candidates = []) {
  return {
    type: 'knowledgeQueried', queryId, expectationRefs,
    candidateCount: candidates.length, candidates,
  };
}

function review(queryId, expectationRefs, conclusion, assessments = []) {
  return { type: 'knowledgeReviewed', queryId, expectationRefs, conclusion, assessments, automatic: conclusion === 'NO_MATCH' };
}

const directChecks = [
  { expectationRef: 'E1', status: 'PASS', actual: '全部 TAB 已显示', sceneRefs: ['scene-0002'] },
  { expectationRef: 'E2', status: 'PASS', actual: 'Kids TAB 已显示', sceneRefs: ['scene-0002'] },
];
const nemoCandidate = { entryId: 'K-editor-001', expired: false };
const nemoEvents = [
  query('knowledge-0001', ['E3'], [nemoCandidate]),
  review('knowledge-0001', ['E3'], 'APPLICABLE_FOUND', [
    { entryId: 'K-editor-001', status: 'APPLICABLE', reason: 'HarmonyOS 不支持 Nemo，与现场一致' },
  ]),
];
const nemoPass = {
  verdict: 'PASS',
  checks: [...directChecks, {
    expectationRef: 'E3', status: 'PASS', actual: '按平台规则忽略 Nemo，Kids 已显示',
    sceneRefs: ['scene-0002'], knowledgeRefs: ['K-editor-001'],
  }],
};
assert.deepStrictEqual(validateKnowledgeClosure(nemoPass, nemoEvents).applicableEntryIds, ['K-editor-001']);

const fail = { verdict: 'FAIL', checks: [{ expectationRef: 'E1', status: 'FAIL', actual: '目标缺失', sceneRefs: ['scene-0002'] }] };
assert.throws(() => validateKnowledgeClosure(fail, []),
  (error) => error.code === 'CASE_RESULT_INCOMPLETE'
    && error.missing.some((item) => item.field === 'checks.E1.knowledgeInvestigation'));
assert.throws(() => validateKnowledgeClosure({
  verdict: 'INCONCLUSIVE',
  checks: [{ expectationRef: 'E1', status: 'INCONCLUSIVE', actual: '现场不足以判断', sceneRefs: [] }],
}, []),
(error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((item) => item.field === 'checks.E1.knowledgeInvestigation'));

const noMatchEvents = [
  query('knowledge-0002', ['E1']),
  review('knowledge-0002', ['E1'], 'NO_MATCH'),
];
assert.doesNotThrow(() => validateKnowledgeClosure(fail, noMatchEvents));

const unrelated = { entryId: 'K-unrelated-001', expired: false };
const notApplicableEvents = [
  query('knowledge-0003', ['E1'], [unrelated]),
  review('knowledge-0003', ['E1'], 'NO_APPLICABLE', [
    { entryId: unrelated.entryId, status: 'NOT_APPLICABLE', reason: '条目仅适用于 Android' },
  ]),
];
assert.doesNotThrow(() => validateKnowledgeClosure(fail, notApplicableEvents));

const blocked = { verdict: 'BLOCKED', checks: [{ expectationRef: 'E1', status: 'BLOCKED', actual: '前置账号不满足', sceneRefs: [] }] };
const execution = { executionId: 'execution-knowledge', warmSessionGeneration: 2 };
const transientTechnicalEvents = [
  {
    sequence: 1, executionId: execution.executionId, type: 'technicalIssue', technicalFactRef: 'technical-fact-0001',
    code: 'SCREENSHOT_TEMPORARY_FAILURE', expectationRefs: ['E1'], sceneId: 'scene-0001', generation: 2,
  },
  { sequence: 2, executionId: execution.executionId, type: 'sceneObserved', sceneId: 'scene-0002', generation: 2, screenshotRef: 'screenshots/scene-0002.png' },
];
assert.throws(() => validateKnowledgeClosure(blocked, transientTechnicalEvents, execution),
  (error) => error.code === 'CASE_RESULT_INCOMPLETE'
    && error.missing.some((item) => item.field === 'checks.E1.knowledgeInvestigation'));
assert.throws(() => validateKnowledgeClosure({
  verdict: 'BLOCKED',
  checks: [{ ...blocked.checks[0], actual: '设备连接中断，无法继续验证', technicalRefs: ['technical-fact-0001'] }],
}, transientTechnicalEvents, execution), (error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((item) => item.reason.includes('有效现场消除')));

const unknownActionFact = {
  sequence: 3, executionId: execution.executionId, type: 'actionOutcomeUnknown', technicalFactRef: 'technical-fact-0003',
  code: 'ACTION_OUTCOME_UNKNOWN', operationId: 'action-0001', expectationRefs: ['E1'], sceneId: 'scene-0002', generation: 2,
};
const continuedAfterUnknownAction = [
  unknownActionFact,
  { sequence: 4, executionId: execution.executionId, type: 'actionCompleted', operationId: 'action-0002', ok: true },
  { sequence: 5, executionId: execution.executionId, type: 'sceneObserved', sceneId: 'scene-0003', screenshotRef: 'screenshots/scene-0003.png' },
];
assert.strictEqual(technicalFactState(unknownActionFact, continuedAfterUnknownAction, execution, 'E1').state, 'INVALID');
assert.throws(() => validateKnowledgeClosure({
  verdict: 'BLOCKED',
  checks: [{ ...blocked.checks[0], actual: '历史动作结果未知', technicalRefs: ['technical-fact-0003'] }],
}, continuedAfterUnknownAction, execution), (error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((item) => item.field === 'checks.E1.technicalRefs'));

const validTechnicalEvent = {
  sequence: 3, executionId: execution.executionId, type: 'timeBudgetExhausted', technicalFactRef: 'technical-fact-0003',
  code: 'TIME_BUDGET_EXHAUSTED', message: '用例时间预算已耗尽', operation: 'observe', operationId: null,
  decisionId: 'decision-0002', expectationRefs: ['E1'], sceneId: 'scene-0002', generation: 2,
};
assert.doesNotThrow(() => validateKnowledgeClosure({
  verdict: 'BLOCKED',
  checks: [{ ...blocked.checks[0], actual: '时间预算耗尽，无法继续验证', technicalRefs: ['technical-fact-0003'] }],
}, [...transientTechnicalEvents, validTechnicalEvent], execution));
assert.throws(() => validateKnowledgeClosure({
  verdict: 'PASS',
  checks: [{ ...directChecks[0], technicalRefs: ['technical-fact-0001'] }],
}, transientTechnicalEvents, execution), (error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((item) => item.reason.includes('只有被 Runtime 技术事实直接阻止')));
assert.throws(() => validateKnowledgeClosure({
  verdict: 'BLOCKED',
  checks: [{ ...blocked.checks[0], technicalRefs: ['technical-fact-missing'] }],
}, transientTechnicalEvents, execution), (error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((item) => item.field === 'checks.E1.technicalRefs'));
assert.throws(() => validateKnowledgeClosure({
  verdict: 'BLOCKED',
  checks: [{ ...blocked.checks[0], technicalRefs: ['technical-fact-0004'] }],
}, [{ ...validTechnicalEvent, sequence: 4, technicalFactRef: 'technical-fact-0004', expectationRefs: ['E2'] }], execution),
(error) => error.code === 'CASE_RESULT_INCOMPLETE' && error.missing.some((item) => item.reason.includes('未关联验证点 E1')));
assert.throws(() => validateKnowledgeClosure({
  verdict: 'BLOCKED',
  checks: [{ ...blocked.checks[0], technicalRefs: ['technical-fact-0005'] }],
}, [{ ...validTechnicalEvent, sequence: 5, technicalFactRef: 'technical-fact-0005', generation: 1 }], execution),
(error) => error.code === 'CASE_RESULT_INCOMPLETE' && error.missing.some((item) => item.reason.includes('不属于当前 generation')));

assert.doesNotThrow(() => validateKnowledgeClosure({
  verdict: 'PASS',
  checks: [{ expectationRef: 'E3', status: 'PASS', actual: '按平台规则通过', sceneRefs: ['scene-0002'] }],
}, nemoEvents));

assert.throws(() => validateKnowledgeClosure({
  verdict: 'PASS',
  checks: [{
    expectationRef: 'E3', status: 'PASS', actual: '按平台规则通过',
    sceneRefs: ['scene-0002'], knowledgeRefs: ['K-never-queried'],
  }],
}, nemoEvents), (error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((item) => item.reason.includes('未在该验证点的调查中评估为 APPLICABLE')));

assert.throws(() => validateKnowledgeClosure(nemoPass, [
  query('knowledge-0004', ['E3'], [{ entryId: 'K-editor-001', expired: true }]),
  review('knowledge-0004', ['E3'], 'APPLICABLE_FOUND', [
    { entryId: 'K-editor-001', status: 'APPLICABLE', reason: '错误地采用过期知识' },
  ]),
]), (error) => error.code === 'CASE_NARRATIVE_INVALID' && error.message.includes('expired knowledge'));

console.log('knowledge closure passed');

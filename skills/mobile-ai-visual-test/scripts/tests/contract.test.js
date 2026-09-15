#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createCaseContract, sourceSha, validateCaseContract, validateSourceText } = require('../execution/contracts/case-contract');
const { validateCaseResult, validateRuntimeRequest } = require('../case-runtime/contract');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const sourceText = [
  '# AI 回复语音按钮',
  '',
  '进入包含 AI 回复的会话',
  '最新回复展示单条语音播放按钮',
].join('\n');

assert.strictEqual(validateSourceText('\ufeff任意描述'), '任意描述');
for (const value of ['', ' \n\t ', '\ufeff \r\n\t']) expectCode(() => validateSourceText(value), 'CASE_INPUT_EMPTY');

const currentCase = createCaseContract({
  caseKey: 'ck-0123456789ab', caseNo: '004', title: '', sourceText, importPath: '/external/cases/audio.md',
});
assert.strictEqual(currentCase.identity.title, 'Untitled case');
assert.strictEqual(currentCase.identity.caseNo, '004');
assert.strictEqual(currentCase.identity.sourceSha, sourceSha(sourceText));
assert.strictEqual(validateCaseContract(currentCase), currentCase);
expectCode(() => validateCaseContract({ ...currentCase, schemaVersion: 99 }), 'CASE_SCHEMA_UNSUPPORTED');
expectCode(() => validateCaseContract({ ...currentCase, identity: { ...currentCase.identity, caseNo: '4' } }), 'CASE_CONTRACT_INVALID');

const result = {
  verdict: 'PASS', summary: '语音播放按钮正常显示',
  checks: [{ expectationRef: 'E1', status: 'PASS', actual: '最新回复显示一个播放按钮', sceneRefs: ['scene-0002'] }],
  uncertainties: [],
};
assert.strictEqual(validateCaseResult(result), result);
assert.doesNotThrow(() => validateCaseResult({
  ...result,
  checks: [{ ...result.checks[0], technicalRefs: ['technical-fact-0007'] }],
}));
expectCode(() => validateCaseResult({
  ...result,
  checks: [{ ...result.checks[0], technicalRefs: ['technical-fact-0007', 'technical-fact-0007'] }],
}), 'CASE_RESULT_INVALID');
expectCode(() => validateCaseResult({ ...result, schemaVersion: 1 }), 'CASE_RESULT_INVALID');
expectCode(() => validateCaseResult({ ...result, executionStatus: 'COMPLETED' }), 'CASE_RESULT_INVALID');
expectCode(() => validateCaseResult({ ...result, verdictBasis: 'DIRECT_EVIDENCE' }), 'CASE_RESULT_INVALID');
expectCode(() => validateCaseResult({ ...result, technicalFailureCode: 'ANY' }), 'CASE_RESULT_INVALID');
expectCode(() => validateCaseResult({ ...result, checks: [{ ...result.checks[0], expectationRef: '' }] }), 'CASE_RESULT_INVALID');
expectCode(() => validateCaseResult({ ...result, checks: [{ ...result.checks[0], expectation: '非协议字段' }] }), 'CASE_RESULT_INVALID');

for (const request of [
  { operation: 'observe' },
  { operation: 'knowledge', basedOnSceneId: 'scene-0001', query: '语音按钮未显示' },
  { operation: 'knowledge', basedOnSceneId: 'scene-0001', query: '入口未显示', context: { page: '创作页', operation: '横向滑动入口' } },
  { operation: 'recover', basedOnSceneId: 'scene-0001', reason: '恢复目标 App' },
  { operation: 'recover', reason: '登记 Scene 建立前的技术处置', externalAction: { summary: '已恢复设备连接' } },
  { operation: 'status' },
  { operation: 'prepare', preparation: { targetState: 'APP_LOCAL_STATE_EMPTY' } },
  { operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:tap:el-1', decision: { purpose: '进入目标页', expectationRefs: ['E1'] } },
  { operation: 'finish', basedOnSceneId: 'scene-0002', result, decision: { purpose: '保存结论', expectationRefs: ['E1'] } },
]) assert.doesNotThrow(() => validateRuntimeRequest(request));
expectCode(() => validateRuntimeRequest({ operation: 'act' }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'unknown' }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'status', extra: true }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'observe', caseContext: {} }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'recover', reason: '恢复目标 App' }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'knowledge', query: '异常', context: { app: 'com.example.other' } }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'act', capabilityId: 'scene-0001:tap:el-1', intent: 'legacy' }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({
  operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:tap:el-1',
  decision: { purpose: '进入目标页', expectationRefs: [], extra: true },
}), 'CASE_NARRATIVE_INVALID');

assert.throws(() => validateRuntimeRequest({
  operation: 'recover',
  basedOnSceneId: '',
  reason: 42,
  unexpected: true,
}), (error) => {
  assert.strictEqual(error.code, 'CASE_RUNTIME_REQUEST_INVALID');
  assert.deepStrictEqual(error.issues.map((issue) => issue.fieldPath).sort(), [
    'basedOnSceneId',
    'reason',
    'unexpected',
  ]);
  return true;
});

console.log('contract tests passed');

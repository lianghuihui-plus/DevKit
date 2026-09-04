#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createCaseContract, sourceSha, validateCaseContract, validateSourceText } = require('../execution/contracts/case-contract');
const { validateCaseResult, validateRuntimeRequest } = require('../case-runtime/contract');
const { validateSourceReference, validateSourceReferences } = require('../lib/source-reference');

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

const sourceRefs = [
  { id: 'src-001', sourceSha: sourceSha(sourceText), lineStart: 3, lineEnd: 3, quote: '进入包含 AI 回复的会话' },
  { id: 'src-002', sourceSha: sourceSha(sourceText), lineStart: 4, lineEnd: 4, quote: '最新回复展示单条语音播放按钮' },
];
assert.strictEqual(validateSourceReference(sourceRefs[0], { sourceText }), sourceRefs[0]);
assert.deepStrictEqual([...validateSourceReferences(sourceRefs, { sourceText })], ['src-001', 'src-002']);
expectCode(() => validateSourceReference({ ...sourceRefs[0], quote: '错误摘录' }, { sourceText }), 'SOURCE_REFERENCE_MISMATCH');

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
  { operation: 'observe', caseContext: { summary: '验证语音按钮', preconditions: [], expectations: ['播放按钮显示'], initialPlan: ['观察页面'], uncertainties: [] } },
  { operation: 'act', capabilityId: 'scene-0001:tap:el-1', intent: '点击播放按钮' },
  { operation: 'knowledge', query: '语音按钮未显示' },
  { operation: 'recover', reason: '恢复目标 App' },
  { operation: 'status' },
  { operation: 'finish', result },
]) assert.doesNotThrow(() => validateRuntimeRequest(request));
expectCode(() => validateRuntimeRequest({ operation: 'act' }), 'CASE_RUNTIME_REQUEST_INVALID');
expectCode(() => validateRuntimeRequest({ operation: 'unknown' }), 'CASE_RUNTIME_REQUEST_INVALID');

console.log('contract tests passed');

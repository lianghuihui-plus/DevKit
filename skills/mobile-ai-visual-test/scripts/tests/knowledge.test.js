#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_KNOWLEDGE_FILE_BYTES,
  loadKnowledgeEntries,
  parseKnowledgeEntry,
  queryKnowledge,
  validateKnowledgeRoots,
  versionMatches,
} = require('../lib/knowledge-query');

function entry(id, options = {}) {
  return `# ${id} ${options.title || '登录后的已知刷新现象'}

## 适用范围
- App: ${options.app || '测试应用'}
- Platform: ${options.platform || 'harmony, android'}
- Version: ${options.version || '3.2.x'}
- Page: ${options.page || '首页'}
- Operation: ${options.operation || '登录后返回首页'}
${options.validUntil ? `- Valid until: ${options.validUntil}\n` : ''}${options.conflictsWith ? `- Conflicts with: ${options.conflictsWith}\n` : ''}
## 可观察现象
${options.symptom || '登录成功后首页可能短暂显示游客入口，随后刷新为用户头像。'}

## 结论与处理建议
${options.advice || '等待页面稳定并重新观察，第一次截图不能单独证明登录失败。'}

## 追溯信息
${options.trace || '登录专项验证记录，2026-07-18。'}
`;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-knowledge-'));
const skill = path.join(temp, 'skill');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(skill);
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(skill, 'login.md'), entry('K-login-001'));
fs.mkdirSync(path.join(workspace, 'nested'));
fs.writeFileSync(path.join(workspace, 'nested', 'voice.md'), entry('K-voice-001', {
  title: '语音入口加载延迟', app: '测试应用', platform: 'ios', version: '4.0-4.5', page: '课程页',
  operation: '打开语音练习', symptom: '语音按钮会在课程内容加载完成后出现。', advice: '重新观察课程页后再判断入口缺失。',
  validUntil: '2026-08-12', conflictsWith: 'K-voice-009',
}));
fs.writeFileSync(path.join(workspace, 'nested', 'voice-conflict.md'), entry('K-voice-009', { conflictsWith: 'K-voice-001' }));

const loaded = loadKnowledgeEntries([skill, workspace]);
assert.strictEqual(loaded.length, 3);
assert.strictEqual(loaded[0].sourceNamespace, 'skill');
assert.strictEqual(loaded.find((item) => item.entryId === 'K-voice-001').relativePath, 'nested/voice.md');
assert.strictEqual(loaded[0].contentSha.length, 64);
assert.strictEqual(parseKnowledgeEntry(entry('K-cn-001')).entryId, 'K-cn-001');
assert.strictEqual(versionMatches('3.2.7', '3.2.x'), true);
assert.strictEqual(versionMatches('4.3', '4.0-4.5'), true);
assert.strictEqual(versionMatches('5.0', '4.0-4.5'), false);

const login = queryKnowledge({
  roots: [skill, workspace], now: '2026-08-13T00:00:00.000Z',
  query: { platform: 'harmony', app: '测试应用', version: '3.2.7', page: '首页', symptom: '游客入口', keywords: ['头像'] },
});
assert.strictEqual(login.candidates[0].entryId, 'K-login-001');
assert.ok(login.candidates[0].score > 0);
assert.strictEqual(login.candidates[0].expired, false);
assert.deepStrictEqual(login.candidates[0].metadata.platform, ['harmony', 'android']);
assert.match(login.candidates[0].applicability, /Platform: harmony, android/);
assert.match(login.candidates[0].traceability, /登录专项验证记录/);
assert.strictEqual(login.candidates[0].snapshotContent, undefined);
const loginWithContent = queryKnowledge({
  roots: [skill, workspace], includeContent: true,
  query: { platform: 'harmony', page: '首页', keywords: ['头像'] },
});
assert.match(loginWithContent.candidates[0].snapshotContent, /^# K-login-001/);

const voice = queryKnowledge({
  roots: [skill, workspace], now: '2026-08-13T00:00:00.000Z',
  query: { platform: 'ios', version: '4.3', page: '课程页', operation: '打开语音练习', keywords: ['语音按钮'] },
});
assert.strictEqual(voice.candidates[0].entryId, 'K-voice-001');
assert.strictEqual(voice.candidates[0].expired, true);
assert.deepStrictEqual(voice.candidates[0].conflictsWith, ['K-voice-009']);
assert.strictEqual(queryKnowledge({ roots: [skill, workspace], query: { keywords: ['完全不存在的词'] } }).candidates.length, 0);
assert.strictEqual(validateKnowledgeRoots([skill, workspace], { now: '2026-08-13T00:00:00.000Z' }).entryCount, 3);

const oldSha = loaded[0].contentSha;
fs.writeFileSync(path.join(skill, 'login.md'), entry('K-login-001', { advice: '更新后的处理建议。' }));
assert.notStrictEqual(loadKnowledgeEntries([skill, workspace])[0].contentSha, oldSha);
fs.writeFileSync(path.join(workspace, 'duplicate.md'), entry('K-login-001'));
expectCode(() => loadKnowledgeEntries([skill, workspace]), 'KNOWLEDGE_ENTRY_DUPLICATE');
fs.unlinkSync(path.join(workspace, 'duplicate.md'));
fs.unlinkSync(path.join(workspace, 'nested', 'voice-conflict.md'));
expectCode(() => validateKnowledgeRoots([skill, workspace]), 'KNOWLEDGE_CONFLICT_REFERENCE_INVALID');

expectCode(() => parseKnowledgeEntry('# K-bad-001 缺少章节\n\n## 适用范围\n内容'), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(entry('K-date-001', { validUntil: '2026/08/13' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => queryKnowledge({ roots: [skill, workspace], query: {} }), 'KNOWLEDGE_QUERY_INVALID');
const outside = path.join(temp, 'outside.md');
fs.writeFileSync(outside, entry('K-outside-001'));
fs.symlinkSync(outside, path.join(workspace, 'escape.md'));
expectCode(() => loadKnowledgeEntries([skill, workspace]), 'KNOWLEDGE_PATH_INVALID');
fs.unlinkSync(path.join(workspace, 'escape.md'));
fs.writeFileSync(path.join(workspace, 'large.md'), `${entry('K-large-001')}\n${'x'.repeat(MAX_KNOWLEDGE_FILE_BYTES)}`);
expectCode(() => loadKnowledgeEntries([skill, workspace]), 'KNOWLEDGE_ENTRY_TOO_LARGE');

fs.rmSync(temp, { recursive: true, force: true });
console.log('knowledge passed');

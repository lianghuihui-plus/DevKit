#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_KNOWLEDGE_CANDIDATES,
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
- App: ${options.app || 'com.example.test'}
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
  title: '语音入口加载延迟', app: 'com.example.test', platform: 'ios', version: '4.0-4.5', page: '课程页',
  operation: '打开语音练习', symptom: '语音按钮会在课程内容加载完成后出现。', advice: '重新观察课程页后再判断入口缺失。',
  validUntil: '2026-08-12', conflictsWith: 'K-voice-009',
}));
fs.writeFileSync(path.join(workspace, 'nested', 'voice-conflict.md'), entry('K-voice-009', { conflictsWith: 'K-voice-001' }));
fs.writeFileSync(path.join(workspace, 'nemo.md'), entry('K-editor-001', {
  title: 'HarmonyOS 我的作品页不展示 Nemo 分类', app: 'com.codemao.hos.lunar', platform: 'harmony',
  page: '我的作品', operation: '查看作品分类 TAB',
  symptom: '将作品分类 TAB 滑动到最右端后显示 Kids，但不显示 Nemo TAB。',
  advice: 'Nemo 缺失属于已知 HarmonyOS 平台差异，独立验证其他分类。',
}));
fs.writeFileSync(path.join(workspace, 'multi-app.md'), entry('K-multi-app-001', {
  app: 'com.example.one, com.example.two', platform: 'harmony',
}));

const loaded = loadKnowledgeEntries([skill, workspace]);
assert.strictEqual(loaded.length, 5);
assert.strictEqual(loaded[0].sourceNamespace, 'skill');
assert.strictEqual(loaded.find((item) => item.entryId === 'K-voice-001').relativePath, 'nested/voice.md');
assert.strictEqual(loaded[0].contentSha.length, 64);
assert.strictEqual(parseKnowledgeEntry(entry('K-cn-001')).entryId, 'K-cn-001');
assert.strictEqual(versionMatches('3.2.7', '3.2.x'), true);
assert.strictEqual(versionMatches('4.3', '4.0-4.5'), true);
assert.strictEqual(versionMatches('5.0', '4.0-4.5'), false);

const login = queryKnowledge({
  roots: [skill, workspace], now: '2026-08-13T00:00:00.000Z',
  query: { platform: 'harmony', app: 'com.example.test', version: '3.2.7', page: '首页', symptom: '游客入口', keywords: ['头像'] },
});
assert.strictEqual(login.candidates[0].entryId, 'K-login-001');
assert.ok(login.candidates[0].score > 0);
assert.strictEqual(login.candidates[0].expired, false);
assert.deepStrictEqual(login.candidates[0].metadata.platform, ['harmony', 'android']);
assert.deepStrictEqual(login.candidates[0].metadata.app, ['com.example.test']);
assert.match(login.candidates[0].applicability, /Platform: harmony, android/);
assert.match(login.candidates[0].traceability, /登录专项验证记录/);
assert.strictEqual(login.candidates[0].snapshotContent, undefined);
assert.strictEqual(login.candidateCount, login.candidates.length);
assert.strictEqual(login.truncated, false);
const loginWithContent = queryKnowledge({
  roots: [skill, workspace], includeContent: true,
  query: { platform: 'harmony', page: '首页', keywords: ['头像'] },
});
assert.match(loginWithContent.candidates[0].snapshotContent, /^# K-login-001/);

const nemo = queryKnowledge({
  roots: [skill, workspace],
  query: {
    platform: 'harmony', app: 'com.codemao.hos.lunar', page: '我的作品',
    symptom: '页面已经滑到最右端，Kids 可见但没有 Nemo', keywords: ['Nemo', 'Kids'],
  },
});
assert.strictEqual(nemo.candidateCount, 1);
assert.strictEqual(nemo.candidates[0].entryId, 'K-editor-001');

const nemoWithSoftContext = queryKnowledge({
  roots: [skill, workspace],
  softFields: ['page', 'operation'],
  query: {
    platform: 'harmony', app: 'com.codemao.hos.lunar', page: '创作中心', operation: '横向滑动入口',
    symptom: 'Kids 可见但没有 Nemo', keywords: ['Nemo', 'Kids'],
  },
});
assert.strictEqual(nemoWithSoftContext.candidateCount, 1);
assert.strictEqual(nemoWithSoftContext.candidates[0].entryId, 'K-editor-001');

const nemoWithHardPageMismatch = queryKnowledge({
  roots: [skill, workspace],
  query: {
    platform: 'harmony', app: 'com.codemao.hos.lunar', page: '创作中心',
    symptom: 'Kids 可见但没有 Nemo', keywords: ['Nemo', 'Kids'],
  },
});
assert.strictEqual(nemoWithHardPageMismatch.candidateCount, 0);

const multiApp = queryKnowledge({
  roots: [skill, workspace],
  query: { platform: 'harmony', app: 'com.example.two', keywords: ['游客入口'] },
});
assert.strictEqual(multiApp.candidates[0].entryId, 'K-multi-app-001');
assert.deepStrictEqual(multiApp.candidates[0].metadata.app, ['com.example.one', 'com.example.two']);

const voice = queryKnowledge({
  roots: [skill, workspace], now: '2026-08-13T00:00:00.000Z',
  query: { platform: 'ios', version: '4.3', page: '课程页', operation: '打开语音练习', keywords: ['语音按钮'] },
});
assert.strictEqual(voice.candidates[0].entryId, 'K-voice-001');
assert.strictEqual(voice.candidates[0].expired, true);
assert.deepStrictEqual(voice.candidates[0].conflictsWith, ['K-voice-009']);
assert.strictEqual(queryKnowledge({ roots: [skill, workspace], query: { keywords: ['完全不存在的词'] } }).candidates.length, 0);
assert.strictEqual(validateKnowledgeRoots([skill, workspace], { now: '2026-08-13T00:00:00.000Z' }).entryCount, 5);

const metadataDiscovery = queryKnowledge({
  roots: [skill, workspace],
  query: { platform: 'ios', page: '课程页', symptom: '词面完全不一致' },
});
assert.strictEqual(metadataDiscovery.candidateCount, 1);
assert.strictEqual(metadataDiscovery.candidates[0].entryId, 'K-voice-001');

const incompatibleMetadata = queryKnowledge({
  roots: [skill, workspace],
  query: { platform: 'android', page: '课程页', keywords: ['语音按钮'] },
});
assert.strictEqual(incompatibleMetadata.candidateCount, 0);

const appMismatch = queryKnowledge({
  roots: [skill, workspace],
  query: { platform: 'harmony', app: 'com.other.app', keywords: ['Nemo'] },
});
assert.strictEqual(appMismatch.candidateCount, 0);
assert.strictEqual(appMismatch.filterDiagnostics.excludedBy.app, 5);
assert.ok(appMismatch.filterDiagnostics.rejected.some((item) => item.entryId === 'K-editor-001'
  && item.mismatches.some((mismatch) => mismatch.field === 'app'
    && mismatch.query === 'com.other.app'
    && mismatch.declared.includes('com.codemao.hos.lunar'))));

for (let index = 0; index < MAX_KNOWLEDGE_CANDIDATES + 2; index += 1) {
  fs.writeFileSync(path.join(workspace, `bounded-${index}.md`), entry(`K-bounded-${index}`, {
    title: `候选 ${index}`,
    platform: 'ios',
    page: '发现页',
    symptom: `候选现象 ${index}`,
  }));
}
const bounded = queryKnowledge({
  roots: [skill, workspace],
  query: { platform: 'ios', page: '发现页', symptom: '没有词面命中' },
});
assert.strictEqual(bounded.candidateCount, MAX_KNOWLEDGE_CANDIDATES);
assert.strictEqual(bounded.candidates.length, MAX_KNOWLEDGE_CANDIDATES);
assert.strictEqual(bounded.truncated, true);

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
expectCode(() => parseKnowledgeEntry(entry('K-app-name-001', { app: '测试应用' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(entry('K-platform-001', { platform: 'windows' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(entry('K-version-001', { version: 'latest' })), 'KNOWLEDGE_ENTRY_INVALID');
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

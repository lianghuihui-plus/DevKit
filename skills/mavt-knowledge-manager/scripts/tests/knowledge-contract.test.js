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
  validateKnowledgeEntries,
  validateKnowledgeRoot,
} = require('../lib/knowledge-contract');
const { assertMavtWorkspace } = require('../lib/workspace');

function knowledge(id, options = {}) {
  const scope = options.scope || [
    `- App: ${options.app || 'com.example.test'}`,
    `- Platform: ${options.platform || 'harmony'}`,
    `- Version: ${options.version || '3.2.x'}`,
    `- Page: ${options.page || '我的作品'}`,
    `- Operation: ${options.operation || '查看作品分类'}`,
    ...(options.validUntil ? [`- Valid until: ${options.validUntil}`] : []),
    ...(options.conflictsWith ? [`- Conflicts with: ${options.conflictsWith}`] : []),
  ].join('\n');
  return `# ${id} ${options.title || '已知页面行为'}

## 适用范围
${scope}

## 可观察现象
${options.symptom || '页面展示已知业务入口，但当前平台不展示 Nemo 分类。'}

## 结论与处理建议
${options.advice || '该现象属于已确认的平台差异，独立验证其他分类。'}

## 追溯信息
${options.trace || '产品确认，2026-09-18。'}
`;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function createWorkspace(root, marker = {}) {
  fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace.json'), `${JSON.stringify({
    schemaVersion: 1,
    type: 'mobile-ai-visual-test-workspace',
    initializationState: 'READY',
    ...marker,
  }, null, 2)}\n`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-knowledge-contract-'));
const workspace = path.join(temp, 'workspace');
createWorkspace(workspace);

const asserted = assertMavtWorkspace(workspace);
assert.strictEqual(asserted.root, workspace);
assert.strictEqual(asserted.knowledgeRoot, path.join(workspace, 'knowledge'));
assert.strictEqual(asserted.maintenanceRoot, path.join(workspace, '.mavt', 'knowledge-maintenance'));

expectCode(() => assertMavtWorkspace(path.join(temp, 'missing')), 'WORKSPACE_INVALID');
const noMarker = path.join(temp, 'no-marker');
fs.mkdirSync(noMarker);
expectCode(() => assertMavtWorkspace(noMarker), 'WORKSPACE_INVALID');
const wrongType = path.join(temp, 'wrong-type');
createWorkspace(wrongType, { type: 'something-else' });
expectCode(() => assertMavtWorkspace(wrongType), 'WORKSPACE_INVALID');
const initializing = path.join(temp, 'initializing');
createWorkspace(initializing, { initializationState: 'INITIALIZING' });
expectCode(() => assertMavtWorkspace(initializing), 'WORKSPACE_INVALID');
const escapedKnowledge = path.join(temp, 'escaped-knowledge');
fs.mkdirSync(escapedKnowledge);
const linkedWorkspace = path.join(temp, 'linked-workspace');
fs.mkdirSync(linkedWorkspace);
fs.writeFileSync(path.join(linkedWorkspace, 'workspace.json'), `${JSON.stringify({
  schemaVersion: 1,
  type: 'mobile-ai-visual-test-workspace',
  initializationState: 'READY',
}, null, 2)}\n`);
fs.symlinkSync(escapedKnowledge, path.join(linkedWorkspace, 'knowledge'));
expectCode(() => assertMavtWorkspace(linkedWorkspace), 'WORKSPACE_INVALID');

const parsed = parseKnowledgeEntry(knowledge('K-editor-001'), { relativePath: 'K-editor-001.md' });
assert.strictEqual(parsed.entryId, 'K-editor-001');
assert.strictEqual(parsed.title, '已知页面行为');
assert.deepStrictEqual(parsed.metadata.app, ['com.example.test']);
assert.deepStrictEqual(parsed.metadata.platform, ['harmony']);
assert.deepStrictEqual(parsed.metadata.version, ['3.2.x']);
assert.strictEqual(parsed.relativePath, 'K-editor-001.md');
assert.match(parsed.contentSha, /^[a-f0-9]{64}$/);

expectCode(() => parseKnowledgeEntry(knowledge('bad-id')), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(knowledge('K-order-001').replace(
  '## 可观察现象\n页面展示已知业务入口，但当前平台不展示 Nemo 分类。\n\n## 结论与处理建议',
  '## 结论与处理建议\n该现象属于已确认的平台差异，独立验证其他分类。\n\n## 可观察现象',
)), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(knowledge('K-app-001', { app: '测试应用' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(knowledge('K-platform-001', { platform: 'windows' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(knowledge('K-version-001', { version: 'latest' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => parseKnowledgeEntry(knowledge('K-date-001', { validUntil: '2026/09/18' })), 'KNOWLEDGE_ENTRY_INVALID');

fs.writeFileSync(path.join(workspace, 'knowledge', 'first.md'), knowledge('K-first-001', {
  conflictsWith: 'K-second-001',
}));
fs.writeFileSync(path.join(workspace, 'knowledge', 'second.md'), knowledge('K-second-001'));
const loaded = loadKnowledgeEntries(path.join(workspace, 'knowledge'));
assert.deepStrictEqual(loaded.map((entry) => entry.entryId), ['K-first-001', 'K-second-001']);
assert.deepStrictEqual(validateKnowledgeEntries(loaded, { now: '2026-09-18T00:00:00Z' }), {
  entryCount: 2,
  expiredCount: 0,
});
const validated = validateKnowledgeRoot(path.join(workspace, 'knowledge'), { now: '2026-09-18T00:00:00Z' });
assert.strictEqual(validated.entries.length, 2);
assert.deepStrictEqual(validated.summary, { entryCount: 2, expiredCount: 0 });

fs.writeFileSync(path.join(workspace, 'knowledge', 'duplicate.md'), knowledge('K-first-001'));
expectCode(() => loadKnowledgeEntries(path.join(workspace, 'knowledge')), 'KNOWLEDGE_ENTRY_DUPLICATE');
fs.unlinkSync(path.join(workspace, 'knowledge', 'duplicate.md'));

fs.unlinkSync(path.join(workspace, 'knowledge', 'second.md'));
expectCode(() => validateKnowledgeRoot(path.join(workspace, 'knowledge')), 'KNOWLEDGE_CONFLICT_REFERENCE_INVALID');
fs.writeFileSync(path.join(workspace, 'knowledge', 'second.md'), knowledge('K-second-001', {
  conflictsWith: 'K-second-001',
}));
expectCode(() => validateKnowledgeRoot(path.join(workspace, 'knowledge')), 'KNOWLEDGE_CONFLICT_REFERENCE_INVALID');
fs.writeFileSync(path.join(workspace, 'knowledge', 'second.md'), knowledge('K-second-001'));

const outside = path.join(temp, 'outside.md');
fs.writeFileSync(outside, knowledge('K-outside-001'));
fs.symlinkSync(outside, path.join(workspace, 'knowledge', 'link.md'));
expectCode(() => loadKnowledgeEntries(path.join(workspace, 'knowledge')), 'KNOWLEDGE_PATH_INVALID');
fs.unlinkSync(path.join(workspace, 'knowledge', 'link.md'));

const large = `${knowledge('K-large-001')}\n${'x'.repeat(MAX_KNOWLEDGE_FILE_BYTES)}`;
fs.writeFileSync(path.join(workspace, 'knowledge', 'large.md'), large);
expectCode(() => loadKnowledgeEntries(path.join(workspace, 'knowledge')), 'KNOWLEDGE_ENTRY_TOO_LARGE');

fs.rmSync(temp, { recursive: true, force: true });
console.log('knowledge contract passed');

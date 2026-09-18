#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectKnowledge, listKnowledge, showKnowledge } = require('../lib/knowledge-store');

function entry(id, options = {}) {
  return `# ${id} ${options.title || '页面规则'}

## 适用范围
${options.scope || '- App: com.example.test\n- Platform: harmony\n- Page: 首页'}

## 可观察现象
${options.symptom || '首页的 Nemo 分类入口没有展示，但 Kids 分类正常可见。'}

## 结论与处理建议
${options.advice || '该现象是已确认的平台差异。'}

## 追溯信息
${options.trace || '产品确认，2026-09-18。'}
`;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-knowledge-store-'));
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(path.join(workspace, 'knowledge', 'nested'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'workspace.json'), `${JSON.stringify({
  schemaVersion: 1,
  type: 'mobile-ai-visual-test-workspace',
  initializationState: 'READY',
}, null, 2)}\n`);
fs.writeFileSync(path.join(workspace, 'knowledge', 'nested', 'a.md'), entry('K-a-001'));
fs.writeFileSync(path.join(workspace, 'knowledge', 'b.md'), entry('K-b-001', {
  scope: '- Page: 设置页\n- Valid until: 2026-09-17',
  symptom: '页面显示正常。',
  trace: '历史记录。',
}));

const inspection = inspectKnowledge(workspace, { now: '2026-09-18T00:00:00Z' });
assert.strictEqual(inspection.schemaVersion, 1);
assert.strictEqual(inspection.status, 'VALID');
assert.strictEqual(inspection.workspace, workspace);
assert.strictEqual(inspection.entryCount, 2);
assert.strictEqual(inspection.expiredCount, 1);
assert.strictEqual(inspection.warningCount, inspection.warnings.length);
assert.deepStrictEqual(new Set(inspection.warnings.filter((item) => item.entryId === 'K-b-001').map((item) => item.code)), new Set([
  'KNOWLEDGE_SCOPE_APP_MISSING',
  'KNOWLEDGE_SCOPE_PLATFORM_MISSING',
  'KNOWLEDGE_ENTRY_EXPIRED',
  'KNOWLEDGE_SYMPTOM_TOO_SHORT',
  'KNOWLEDGE_SYMPTOM_GENERIC',
  'KNOWLEDGE_TRACE_DATE_MISSING',
]));

const listed = listKnowledge(workspace, { now: '2026-09-18T00:00:00Z' });
assert.strictEqual(listed.schemaVersion, 1);
assert.strictEqual(listed.status, 'VALID');
assert.deepStrictEqual(listed.entries.map((item) => item.entryId), ['K-a-001', 'K-b-001']);
assert.strictEqual(listed.entries[0].relativePath, 'nested/a.md');
assert.strictEqual(listed.entries[0].content, undefined);
assert.strictEqual(listed.entries[1].expired, true);
assert.ok(listed.entries[1].warningCodes.includes('KNOWLEDGE_ENTRY_EXPIRED'));

const shown = showKnowledge(workspace, 'K-a-001', { now: '2026-09-18T00:00:00Z' });
assert.strictEqual(shown.schemaVersion, 1);
assert.strictEqual(shown.status, 'VALID');
assert.strictEqual(shown.entryId, 'K-a-001');
assert.strictEqual(shown.relativePath, 'nested/a.md');
assert.match(shown.content, /^# K-a-001/);
assert.match(shown.contentSha, /^[a-f0-9]{64}$/);
assert.deepStrictEqual(shown.warnings, []);

expectCode(() => showKnowledge(workspace, 'K-missing'), 'KNOWLEDGE_ENTRY_NOT_FOUND');

fs.rmSync(temp, { recursive: true, force: true });
console.log('knowledge store passed');

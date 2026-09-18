#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyTransaction, prepareTransaction } = require('../lib/knowledge-transaction');

function entry(id, options = {}) {
  return `# ${id} ${options.title || '页面规则'}

## 适用范围
- App: com.example.test
- Platform: harmony
${options.conflictsWith ? `- Conflicts with: ${options.conflictsWith}\n` : ''}
## 可观察现象
${options.symptom || '首页中的 Nemo 分类入口没有展示，但 Kids 分类正常可见。'}

## 结论与处理建议
${options.advice || '该现象是已确认的平台差异。'}

## 追溯信息
产品确认，2026-09-18。
`;
}

function createWorkspace(root, entries = {}) {
  fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace.json'), `${JSON.stringify({
    schemaVersion: 1,
    type: 'mobile-ai-visual-test-workspace',
    initializationState: 'READY',
  }, null, 2)}\n`);
  for (const [relative, content] of Object.entries(entries)) {
    const target = path.join(root, 'knowledge', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function markdownSnapshot(root) {
  const values = {};
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) walk(target);
      else if (path.extname(name) === '.md') values[path.relative(root, target).replace(/\\/g, '/')] = fs.readFileSync(target, 'utf8');
    }
  }
  walk(root);
  return values;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-knowledge-transaction-'));
const drafts = path.join(temp, 'drafts');
fs.mkdirSync(drafts);
const now = '2026-09-18T08:00:00.000Z';

const workspace = path.join(temp, 'workspace');
createWorkspace(workspace, {
  'nested/update.md': entry('K-update-001', { advice: '旧处理建议。' }),
  'delete.md': entry('K-delete-001'),
});
const addDraft = path.join(drafts, 'add.md');
const updateDraft = path.join(drafts, 'update.md');
fs.writeFileSync(addDraft, entry('K-add-001'));
fs.writeFileSync(updateDraft, entry('K-update-001', { advice: '新的处理建议。' }));
const mixedRequest = writeJson(path.join(temp, 'mixed-request.json'), {
  schemaVersion: 1,
  reason: '同步已确认的知识变更',
  operations: [
    { type: 'ADD', draftPath: addDraft },
    { type: 'UPDATE', entryId: 'K-update-001', draftPath: updateDraft },
    { type: 'DELETE', entryId: 'K-delete-001' },
  ],
});

const plan = prepareTransaction(workspace, mixedRequest, { now });
assert.strictEqual(plan.schemaVersion, 1);
assert.strictEqual(plan.status, 'PREPARED');
assert.match(plan.planHash, /^[a-f0-9]{64}$/);
assert.deepStrictEqual(plan.changes.map((item) => item.type), ['ADD', 'UPDATE', 'DELETE']);
assert.deepStrictEqual(plan.changes.map((item) => item.entryId), ['K-add-001', 'K-update-001', 'K-delete-001']);
assert.strictEqual(plan.validation.entryCount, 2);

const applied = applyTransaction(workspace, mixedRequest, plan.planHash, { now });
assert.strictEqual(applied.schemaVersion, 1);
assert.strictEqual(applied.status, 'APPLIED');
assert.strictEqual(applied.planHash, plan.planHash);
assert.strictEqual(applied.validation.entryCount, 2);
assert.ok(fs.existsSync(applied.backupPath));
assert.strictEqual(fs.existsSync(path.join(workspace, 'knowledge', 'K-add-001.md')), true);
assert.match(fs.readFileSync(path.join(workspace, 'knowledge', 'nested', 'update.md'), 'utf8'), /新的处理建议/);
assert.strictEqual(fs.existsSync(path.join(workspace, 'knowledge', 'delete.md')), false);
assert.match(fs.readFileSync(path.join(applied.backupPath, 'original', 'nested', 'update.md'), 'utf8'), /旧处理建议/);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(applied.backupPath, 'result.json'), 'utf8')).status, 'APPLIED');
expectCode(() => applyTransaction(workspace, mixedRequest, plan.planHash, { now }), 'KNOWLEDGE_PLAN_STALE');

const duplicateAddRequest = writeJson(path.join(temp, 'duplicate-add.json'), {
  schemaVersion: 1,
  reason: '重复新增',
  operations: [{ type: 'ADD', draftPath: addDraft }],
});
expectCode(() => prepareTransaction(workspace, duplicateAddRequest), 'KNOWLEDGE_ENTRY_DUPLICATE');

const missingUpdateRequest = writeJson(path.join(temp, 'missing-update.json'), {
  schemaVersion: 1,
  reason: '更新不存在条目',
  operations: [{ type: 'UPDATE', entryId: 'K-missing-001', draftPath: updateDraft }],
});
expectCode(() => prepareTransaction(workspace, missingUpdateRequest), 'KNOWLEDGE_ENTRY_NOT_FOUND');

const changedIdDraft = path.join(drafts, 'changed-id.md');
fs.writeFileSync(changedIdDraft, entry('K-changed-001'));
const changedIdRequest = writeJson(path.join(temp, 'changed-id.json'), {
  schemaVersion: 1,
  reason: '错误修改 ID',
  operations: [{ type: 'UPDATE', entryId: 'K-update-001', draftPath: changedIdDraft }],
});
expectCode(() => prepareTransaction(workspace, changedIdRequest), 'KNOWLEDGE_ENTRY_ID_CHANGED');

const missingDeleteRequest = writeJson(path.join(temp, 'missing-delete.json'), {
  schemaVersion: 1,
  reason: '删除不存在条目',
  operations: [{ type: 'DELETE', entryId: 'K-missing-001' }],
});
expectCode(() => prepareTransaction(workspace, missingDeleteRequest), 'KNOWLEDGE_ENTRY_NOT_FOUND');

const conflictWorkspace = path.join(temp, 'conflict-workspace');
createWorkspace(conflictWorkspace, {
  'left.md': entry('K-left-001', { conflictsWith: 'K-right-001' }),
  'right.md': entry('K-right-001'),
});
const blockedDelete = writeJson(path.join(temp, 'blocked-delete.json'), {
  schemaVersion: 1,
  reason: '删除仍被引用的条目',
  operations: [{ type: 'DELETE', entryId: 'K-right-001' }],
});
expectCode(() => prepareTransaction(conflictWorkspace, blockedDelete), 'KNOWLEDGE_CONFLICT_REFERENCE_INVALID');
const relatedDelete = writeJson(path.join(temp, 'related-delete.json'), {
  schemaVersion: 1,
  reason: '一起删除冲突条目',
  operations: [
    { type: 'DELETE', entryId: 'K-left-001' },
    { type: 'DELETE', entryId: 'K-right-001' },
  ],
});
assert.strictEqual(prepareTransaction(conflictWorkspace, relatedDelete).validation.entryCount, 0);

const staleWorkspace = path.join(temp, 'stale-workspace');
createWorkspace(staleWorkspace);
const staleDraft = path.join(drafts, 'stale.md');
fs.writeFileSync(staleDraft, entry('K-stale-001'));
const staleRequest = writeJson(path.join(temp, 'stale-request.json'), {
  schemaVersion: 1,
  reason: '验证过期计划',
  operations: [{ type: 'ADD', draftPath: staleDraft }],
});
const stalePlan = prepareTransaction(staleWorkspace, staleRequest, { now });
fs.writeFileSync(path.join(staleWorkspace, 'knowledge', 'external.md'), entry('K-external-001'));
expectCode(() => applyTransaction(staleWorkspace, staleRequest, stalePlan.planHash, { now }), 'KNOWLEDGE_PLAN_STALE');

const rollbackWorkspace = path.join(temp, 'rollback-workspace');
createWorkspace(rollbackWorkspace, {
  'nested/update.md': entry('K-rollback-update-001', { advice: '回滚前内容。' }),
  'delete.md': entry('K-rollback-delete-001'),
});
const rollbackAddDraft = path.join(drafts, 'rollback-add.md');
const rollbackUpdateDraft = path.join(drafts, 'rollback-update.md');
fs.writeFileSync(rollbackAddDraft, entry('K-rollback-add-001'));
fs.writeFileSync(rollbackUpdateDraft, entry('K-rollback-update-001', { advice: '不应保留的内容。' }));
const rollbackRequest = writeJson(path.join(temp, 'rollback-request.json'), {
  schemaVersion: 1,
  reason: '验证失败恢复',
  operations: [
    { type: 'ADD', draftPath: rollbackAddDraft },
    { type: 'UPDATE', entryId: 'K-rollback-update-001', draftPath: rollbackUpdateDraft },
    { type: 'DELETE', entryId: 'K-rollback-delete-001' },
  ],
});
const beforeRollback = markdownSnapshot(path.join(rollbackWorkspace, 'knowledge'));
const rollbackPlan = prepareTransaction(rollbackWorkspace, rollbackRequest, { now });
expectCode(() => applyTransaction(rollbackWorkspace, rollbackRequest, rollbackPlan.planHash, {
  now,
  interruptAfter: 'writes',
}), 'KNOWLEDGE_TRANSACTION_INTERRUPTED');
assert.deepStrictEqual(markdownSnapshot(path.join(rollbackWorkspace, 'knowledge')), beforeRollback);
assert.ok(fs.readdirSync(path.join(rollbackWorkspace, '.mavt', 'knowledge-maintenance', 'backups')).length >= 1);

fs.rmSync(temp, { recursive: true, force: true });
console.log('knowledge transaction passed');

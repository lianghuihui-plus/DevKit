'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../design-prototypes/dashboard-redesign/app.js'), 'utf8');

for (const text of ['执行记录', '验证点覆盖', '动作可追溯', 'Runtime 请求错误']) {
  assert.ok(source.includes(text), `report overview must use contract-backed metric: ${text}`);
}

for (const text of ['理解摘要', '前置条件', '验证点', '不确定项', '初始计划', '计划调整']) {
  assert.ok(source.includes(text), `report narrative must expose contract-backed field: ${text}`);
}

for (const unsupported of ['执行健康度', '关键路径', '失败边界', '最小操作集', '观察后行动', '异常时先复核现场', '全部 18']) {
  assert.strictEqual(source.includes(unsupported), false, `prototype must not assume unsupported data: ${unsupported}`);
}

for (const hook of ['data-log-filter', 'data-log-search', 'data-export-logs', 'data-log-context', 'function initLogs']) {
  assert.ok(source.includes(hook), `log control must be implemented: ${hook}`);
}

for (const text of [
  'knowledgeInvestigations',
  'knowledgeRefs',
  '知识调查',
  '查询目的',
  '候选知识',
  '适用性判断',
  '对执行的影响',
  '本次执行未触发知识库查询',
]) {
  assert.ok(source.includes(text), `report prototype must expose knowledge evidence: ${text}`);
}

assert.ok(source.includes('data-log-filter="KNOWLEDGE"'), 'detailed logs must provide a knowledge category');
assert.ok(source.includes("category:'KNOWLEDGE'"), 'knowledge query and review events must appear in detailed logs');
assert.ok(source.includes("'profile-fail'"), 'the iOS failed check must render a visitor-state screenshot');

console.log('report prototype tests passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { parseKnowledgeEntry: managerParse } = require('../lib/knowledge-contract');
const { parseKnowledgeEntry: mavtParse } = require(path.resolve(
  __dirname,
  '../../../mobile-ai-visual-test/scripts/lib/knowledge-query',
));

function entry(id, scope, options = {}) {
  return `# ${id} ${options.title || '页面规则'}

## 适用范围
${scope}

## 可观察现象
${options.symptom || '我的作品页面显示 Kids 分类，但不显示 Nemo 分类入口。'}

## 结论与处理建议
${options.advice || '这是已确认的平台差异。'}

## 追溯信息
${options.trace || '产品确认，2026-09-18。'}
`;
}

function project(value) {
  return {
    entryId: value.entryId,
    title: value.title,
    contentSha: value.contentSha,
    metadata: value.metadata,
    sections: value.sections,
  };
}

const validFixtures = [
  entry('K-exact-001', '- App: com.example.test\n- Platform: harmony\n- Version: 3.2.7'),
  entry('K-wildcard-001', '- App: com.example.one, com.example.two\n- Platform: android, ios\n- Version: 3.2.x, 4.1.*'),
  entry('K-range-001', '- Version: 4.0-4.5\n- Page: 课程页\n- Operation: 打开语音练习'),
  entry('K-minimal-001', '未知范围但正文仍然有效。'),
];

for (const fixture of validFixtures) {
  assert.deepStrictEqual(project(managerParse(fixture)), project(mavtParse(fixture)));
}

const invalidFixtures = [
  entry('K-platform-001', '- Platform: windows'),
  entry('K-version-001', '- Version: latest'),
  entry('K-app-001', '- App: 测试应用'),
  entry('K-date-001', '- Valid until: 2026/09/18'),
  entry('K-order-001', '- Platform: harmony').replace('## 可观察现象', '## 未知章节'),
];

for (const fixture of invalidFixtures) {
  assert.throws(() => managerParse(fixture), `manager must reject fixture: ${fixture.split('\n')[0]}`);
  assert.throws(() => mavtParse(fixture), `MAVT must reject fixture: ${fixture.split('\n')[0]}`);
}

console.log('MAVT knowledge compatibility passed');

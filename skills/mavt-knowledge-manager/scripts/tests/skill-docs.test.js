#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseKnowledgeEntry } = require('../lib/knowledge-contract');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const skill = read('SKILL.md');
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
assert.ok(frontmatter, 'SKILL.md must have YAML frontmatter');
assert.match(frontmatter[1], /^name: mavt-knowledge-manager$/m);
assert.match(frontmatter[1], /^description: .+$/m);
assert.match(frontmatter[1], /MAVT.*工作空间.*知识库/);

const linkedResources = [...skill.matchAll(/\]\((references\/[^)]+|assets\/[^)]+)\)/g)].map((match) => match[1]);
assert.deepStrictEqual(new Set(linkedResources), new Set([
  'references/workflow.md',
  'references/knowledge-contract.md',
  'references/writing-guide.md',
  'assets/knowledge-entry-template.md',
]));
for (const resource of linkedResources) {
  assert.strictEqual(fs.existsSync(path.join(root, resource)), true, `${resource} must exist`);
}

const workflow = read('references/workflow.md');
for (const command of ['inspect', 'list', 'show', 'validate', 'prepare', 'apply']) {
  assert.match(workflow, new RegExp(`knowledge-manager\\.js ${command}\\b`), `${command} command must be documented`);
}
assert.match(workflow, /用户明确要求删除/);
assert.match(workflow, /直接.*apply|apply.*直接/);

const contract = read('references/knowledge-contract.md');
for (const section of ['适用范围', '可观察现象', '结论与处理建议', '追溯信息']) {
  assert.match(contract, new RegExp(section));
}
assert.match(contract, /未知.*省略|省略.*未知/);

const guide = read('references/writing-guide.md');
assert.match(guide, /一条知识.*一个|一个.*一条知识/);
assert.match(guide, /不得猜测|不能猜测/);
assert.match(guide, /词面|召回/);

const template = read('assets/knowledge-entry-template.md');
const rendered = template
  .replace('<stable-id>', 'sample-001')
  .replace('<title>', 'HarmonyOS 页面已知差异')
  .replace('<stable-app-id>', 'com.example.test')
  .replace('<harmony|android|ios>', 'harmony')
  .replace('<optional-version>', '3.2.x')
  .replace('<optional-page>', '我的作品')
  .replace('<optional-operation>', '查看作品分类')
  .replace('<observable-facts>', '我的作品页面显示 Kids 分类，但不显示 Nemo 分类入口。')
  .replace('<conclusion-and-boundary>', '这是已确认的平台差异，仅适用于当前页面和平台。')
  .replace('<source-and-date>', '产品确认，2026-09-18。');
assert.doesNotMatch(rendered, /<[^>]+>/);
assert.strictEqual(parseKnowledgeEntry(rendered).entryId, 'K-sample-001');

console.log('skill documentation passed');

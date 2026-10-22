#!/usr/bin/env node
'use strict';

// Runs exclusively from an already built package; can run with source reads denied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let [pluginRoot, workspace] = process.argv.slice(2);
assert.ok(pluginRoot && workspace && path.isAbsolute(pluginRoot) && path.isAbsolute(workspace));
function invoke(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), cwd: workspace });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
const entry = path.join(pluginRoot, 'scripts/mavt-entry.js');
const opened = invoke(entry, ['workspace', '--cwd', workspace]);
workspace = opened.root;
const runtime = opened.runtimeRoot;
const draft = path.join(workspace, 'draft.json');
fs.writeFileSync(draft, JSON.stringify({ cases: [{ sourceLocator: '/input/中文.xlsx#逻辑用例1', title: '离线用例', sourceText: '打开页面，检查标题。' }] }));
invoke(path.join(runtime, 'scripts/import-cases.js'), ['--workspace', workspace, '--request-file', draft]);
const started = invoke(path.join(runtime, 'scripts/coordinator-agent.js'), ['--workspace', workspace], { operation: 'prepareRun', input: { caseNos: ['001'] } });
assert.equal(started.result.outcome, 'NEED_USER_CONFIRMATION');
const run = fs.readdirSync(path.join(workspace, 'runs'))[0];
const resumed = invoke(entry, ['resume', '--workspace', workspace, '--run', run]);
assert.equal(resumed.bundleId, opened.bundleId);
const cancelled = invoke(path.join(runtime, 'scripts/coordinator-agent.js'), ['--state', path.join(workspace, 'runs', run, 'coordinator-state.json')], { operation: 'cancelRun', input: { reason: '离线冒烟，不运行设备' } });
assert.equal(cancelled.data.content.runOutcome, 'CANCELLED');
for (const platform of ['android', 'harmony', 'ios']) for (const role of ['case-executor', 'batch-coordinator']) {
  const contract = invoke(path.join(runtime, 'scripts/build-agent-contract.js'), ['--role', role, '--platform', platform]);
  assert.ok(contract.protocolSha && contract.runtimeSha && contract.adapterSha);
  assert.equal(contract.requiredResources.includes('SKILL.md'), false);
}
assert.equal(invoke(entry, ['knowledge', '--workspace', workspace]).knowledgeRoot, opened.knowledgeRoot);
assert.equal(invoke(entry, ['doctor', '--workspace', workspace]).status, 'SUCCEEDED');
console.log(JSON.stringify({ status: 'PASS', bundleId: opened.bundleId, checks: ['workspace', 'case import', 'paired Run', 'resume', 'cancel before device confirmation', '3 platforms x 2 role contracts', 'knowledge entry', 'read-only doctor'] }));

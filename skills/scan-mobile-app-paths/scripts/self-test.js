#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SELF_TEST_DIR = path.join(__dirname, 'self-tests');
const SUITES = {
  restore: 'restore.js',
  protocol: 'protocol.js',
  scheduler: 'scheduler.js',
  'goal-verification': 'goal-verification.js',
  'source-matcher': 'source-matcher.js',
  'frontier-candidates': 'frontier-candidates.js',
  'flow-export': 'flow-export.js'
};
const FULL_PREFLIGHT_SCOPES = [
  'scheduler',
  'goal-verification',
  'source-matcher',
  'frontier-candidates',
  'flow-export'
];

function requestedScope(argv = process.argv.slice(2)) {
  const index = argv.findIndex(value => value === '--scope');
  if (index >= 0) return argv[index + 1] || null;
  const inline = argv.find(value => value.startsWith('--scope='));
  return inline ? inline.slice('--scope='.length) : null;
}

function printHelp(ok) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    ok,
    code: ok ? null : 'SELF_TEST_SCOPE_REQUIRED',
    message: '请选择自测范围；日常 Restore 修改优先运行轻量专项，完成后再显式运行一次全量自测。',
    commands: {
      restore: 'node scripts/self-test.js --scope restore',
      protocol: 'node scripts/self-test.js --scope protocol',
      scheduler: 'node scripts/self-test.js --scope scheduler',
      goalVerification: 'node scripts/self-test.js --scope goal-verification',
      sourceMatcher: 'node scripts/self-test.js --scope source-matcher',
      frontierCandidates: 'node scripts/self-test.js --scope frontier-candidates',
      flowExport: 'node scripts/self-test.js --scope flow-export',
      full: 'node scripts/self-test.js --scope full'
    }
  }, null, 2));
}

function runFile(file) {
  const result = spawnSync(process.execPath, [path.join(SELF_TEST_DIR, file)], { stdio: 'inherit' });
  return result.status == null ? 1 : result.status;
}

function runScope(scope) {
  return runFile(SUITES[scope]);
}

const scope = requestedScope();
const help = process.argv.includes('--help') || process.argv.includes('-h');
if (help || !scope) {
  printHelp(help);
  process.exit(help ? 0 : 2);
}

if (scope === 'full') {
  process.stderr.write('[SMAP] 正在运行全量自测；开发迭代请优先使用专项 --scope。\n');
  for (const preflightScope of FULL_PREFLIGHT_SCOPES) {
    const status = runScope(preflightScope);
    if (status !== 0) process.exit(status);
  }
  process.exit(runFile('full-integration.js'));
}

if (!SUITES[scope]) {
  console.error(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'SELF_TEST_SCOPE_INVALID', message: `Unsupported self-test scope: ${scope}` } }));
  process.exit(2);
}

process.exit(runScope(scope));

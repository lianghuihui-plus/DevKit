#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');

const suites = Object.freeze({
  contract: 'tests/contract.test.js',
  platform: 'tests/platform-contract.test.js',
  harmonyInput: 'tests/harmony-input-effect.test.js',
  metrics: 'tests/execution-metrics.test.js',
  report: 'tests/report-reader.test.js',
  trace: 'tests/execution-trace.test.js',
  dashboard: 'tests/dashboard.test.js',
  workspace: 'tests/workspace.test.js',
  control: 'tests/run-control.test.js',
  core: 'tests/execution-core.test.js',
  warm: 'tests/warm-session.test.js',
  agent: 'tests/agent-driven.test.js',
  facade: 'tests/agent-facade.test.js',
  knowledge: 'tests/knowledge.test.js',
  eval: 'tests/agent-eval.test.js',
  integration: 'tests/agent-integration.test.js',
  gateway: 'tests/device-gateway.test.js',
  entrypoints: 'tests/formal-entrypoints.test.js',
  cutover: 'tests/cutover-readiness.test.js',
});

const requested = process.argv.slice(2);
for (const name of requested) {
  assert.ok(suites[name], `Unknown self-test suite: ${name}. Expected one of: ${Object.keys(suites).join(', ')}`);
}

const selected = requested.length ? requested : Object.keys(suites);
for (const name of selected) {
  const file = path.join(__dirname, suites[name]);
  process.stdout.write(`[self-test] ${name}\n`);
  childProcess.execFileSync(process.execPath, [file], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
}

console.log(`self-test passed: ${selected.join(', ')}`);

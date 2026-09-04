#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');

const suites = Object.freeze({
  contract: 'tests/contract.test.js',
  platform: 'tests/platform-contract.test.js',
  platformRuntime: 'tests/platform-runtime.test.js',
  iosInput: 'tests/ios-input.test.js',
  layout: 'tests/layout-observation.test.js',
  androidLayout: 'tests/android-layout-capture.test.js',
  coordinateAudit: 'tests/action-coordinate-audit.test.js',
  harmonyInput: 'tests/harmony-input-effect.test.js',
  metrics: 'tests/execution-metrics.test.js',
  report: 'tests/report-reader.test.js',
  trace: 'tests/execution-trace.test.js',
  narrative: 'tests/execution-narrative.test.js',
  dashboard: 'tests/dashboard.test.js',
  workspace: 'tests/workspace.test.js',
  control: 'tests/run-control.test.js',
  publication: 'tests/publication-integrity.test.js',
  knowledge: 'tests/knowledge.test.js',
  knowledgeClosure: 'tests/knowledge-closure.test.js',
  caseRuntime: 'tests/case-runtime.test.js',
  resultMatrix: 'tests/result-matrix.test.js',
  warmSession: 'tests/warm-session-current.test.js',
  boundaries: 'tests/architecture-boundaries.test.js',
  entrypoints: 'tests/formal-entrypoints.test.js',
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

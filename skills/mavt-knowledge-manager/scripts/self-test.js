#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = Object.freeze({
  contract: 'tests/knowledge-contract.test.js',
  store: 'tests/knowledge-store.test.js',
  transaction: 'tests/knowledge-transaction.test.js',
  cli: 'tests/cli.test.js',
  docs: 'tests/skill-docs.test.js',
  mavtCompatibility: 'tests/mavt-compatibility.test.js',
});

const registered = Object.values(suites).sort();
const discovered = fs.readdirSync(path.join(__dirname, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `tests/${name}`)
  .sort();
assert.deepStrictEqual(registered, discovered, 'Every test suite must be registered in scripts/self-test.js');

const requested = process.argv.slice(2);
for (const name of requested) assert.ok(suites[name], `Unknown self-test suite: ${name}`);
const selected = requested.length ? requested : Object.keys(suites);
for (const name of selected) {
  process.stdout.write(`[self-test] ${name}\n`);
  childProcess.execFileSync(process.execPath, [path.join(__dirname, suites[name])], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
}
console.log(`self-test passed: ${selected.join(', ')}`);

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');
const { readPlan, verifySwitched } = require('../release/verify-cutover');

const repo = path.resolve(__dirname, '../..');
const result = verifySwitched(readPlan());
assert.strictEqual(result.state, 'SWITCHED');
assert.deepStrictEqual(result.platforms.map((entry) => entry.platform), ['harmony', 'android', 'ios']);

const invalid = childProcess.spawnSync(process.execPath, [
  'scripts/release/verify-cutover.js', '--state', 'invalid',
], { cwd: repo, encoding: 'utf8' });
assert.notStrictEqual(invalid.status, 0);
assert.match(invalid.stderr, /CUTOVER_CLI_INVALID/);

console.log('cutover-readiness passed');

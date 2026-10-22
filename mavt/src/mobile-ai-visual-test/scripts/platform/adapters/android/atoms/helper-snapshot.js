#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { snapshotToFiles } = require('../lib/android-helper-client');
const { ensureAndroidHelperSession, repairAndroidHelperSession } = require('../lib/android-helper-session');

function parseArgs(argv) {
  const values = {};
  const names = new Map([
    ['--session-state', 'sessionStatePath'],
    ['--screenshot-out', 'screenshotPath'],
    ['--layout-out', 'layoutPath'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || value === undefined || value.startsWith('--')) throw new Error(`invalid argument: ${argv[index] || 'missing'}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate argument: ${argv[index]}`);
    values[name] = value;
  }
  for (const name of ['sessionStatePath', 'screenshotPath', 'layoutPath', 'timeoutMs']) {
    if (!values[name]) throw new Error(`missing ${name}`);
  }
  values.timeoutMs = Number(values.timeoutMs);
  if (!Number.isInteger(values.timeoutMs) || values.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  return values;
}

function readSecureSession(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('session state must not be a symbolic link');
  if (!stat.isFile()) throw new Error('session state must be a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('session state permissions must deny group and other access');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(Number(value.localPort)) || !String(value.token || '')) throw new Error('session state is incomplete');
  return value;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  readSecureSession(options.sessionStatePath);
  const ensureSession = dependencies.ensureSession || ensureAndroidHelperSession;
  const repairSession = dependencies.repairSession || repairAndroidHelperSession;
  const capture = dependencies.snapshotToFiles || snapshotToFiles;
  let session = await ensureSession({ sessionStatePath: options.sessionStatePath, kind: 'READ_ONLY' });
  let metadata;
  try {
    metadata = await capture(session, options);
  } catch (error) {
    session = await repairSession({ sessionStatePath: options.sessionStatePath, kind: 'READ_ONLY', cause: error.code });
    metadata = await capture(session, options);
  }
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'ANDROID_HELPER_SNAPSHOT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, readSecureSession };

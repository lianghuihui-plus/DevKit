#!/usr/bin/env node
'use strict';

const { inspectAndroidHelper } = require('../lib/android-helper-session');

function parseArgs(argv) {
  const values = { androidUiBackend: 'auto' };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`invalid argument: ${flag || 'missing'}`);
    if (flag === '--device') values.deviceId = value;
    else if (flag === '--android-ui-backend') values.androidUiBackend = value;
    else throw new Error(`invalid argument: ${flag}`);
  }
  if (!values.deviceId) throw new Error('missing device');
  if (!['auto', 'helper', 'uiautomator'].includes(values.androidUiBackend)) throw new Error('invalid android UI backend');
  return values;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const inspect = dependencies.inspectAndroidHelper || inspectAndroidHelper;
  const result = await inspect(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'ANDROID_HELPER_STATUS_FAILED'}: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { main, parseArgs };

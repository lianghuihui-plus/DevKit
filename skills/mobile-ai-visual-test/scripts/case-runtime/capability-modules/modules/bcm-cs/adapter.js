'use strict';

const childProcess = require('child_process');

const DISCOVERY_TIMEOUT_MS = 15_000;
const INVOCATION_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

function createAdapter(context = {}, options = {}) {
  const executable = options.executable || context.bcmCsExecutable || process.env.BCM_CS_BIN || 'bcm-cs';
  const runner = context.processRunner || options.runner || childProcess.spawnSync;
  const env = options.env || process.env;
  const run = (args, timeout) => runner(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER, env, shell: false,
  });
  return {
    executable,
    version() { return run(['version'], DISCOVERY_TIMEOUT_MS); },
    invoke(args) { return run([...args], INVOCATION_TIMEOUT_MS); },
  };
}

module.exports = {
  DISCOVERY_TIMEOUT_MS,
  INVOCATION_TIMEOUT_MS,
  MAX_BUFFER,
  createAdapter,
};

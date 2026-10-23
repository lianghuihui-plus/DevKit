'use strict';

const { spawnSync } = require('node:child_process');

// Argument arrays are intentional: package names and device IDs never become shell code.
function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    ...options, shell: false,
  });
  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

module.exports = { run };

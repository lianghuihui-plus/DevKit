#!/usr/bin/env node
'use strict';

const path = require('path');
const { ensureWorkspace } = require('./lib/workspace');

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--cwd') throw new Error('WORKSPACE_CLI_INVALID: --cwd is required');
  const result = ensureWorkspace(path.resolve(argv[1]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { main };

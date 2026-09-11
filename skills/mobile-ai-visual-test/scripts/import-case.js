#!/usr/bin/env node
'use strict';

const path = require('path');
const { importSource } = require('./case/import-source');
const { writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function main(argv = process.argv.slice(2)) {
  let input;
  let workspace;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--workspace') workspace = path.resolve(argv[++index]);
    else if (!argv[index].startsWith('--') && !input) input = path.resolve(argv[index]);
    else throw new Error(`CASE_IMPORT_CLI_INVALID: unknown argument ${argv[index]}`);
  }
  if (!input || !workspace) throw new Error('CASE_IMPORT_CLI_INVALID: input path and --workspace are required');
  process.stdout.write(`${JSON.stringify(importSource(workspace, input), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/import-case.js'); process.exit(error.exitCode || 2); }
}

module.exports = { main };

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { importDrafts } = require('./case/import-drafts');
const { writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function main(argv = process.argv.slice(2)) {
  let requestFile;
  let workspace;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--request-file') requestFile = path.resolve(argv[++index]);
    else if (argv[index] === '--workspace') workspace = path.resolve(argv[++index]);
    else throw new Error(`CASE_AUTHORING_CLI_INVALID: unknown argument ${argv[index]}`);
  }
  if (!requestFile || !workspace) {
    throw new Error('CASE_AUTHORING_CLI_INVALID: --request-file and --workspace are required');
  }
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  } catch (error) {
    throw new Error(`CASE_AUTHORING_INPUT_INVALID: request file is not readable JSON: ${error.message}`);
  }
  process.stdout.write(`${JSON.stringify(importDrafts(workspace, request), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/import-cases.js'); process.exit(error.exitCode || 2); }
}

module.exports = { main };

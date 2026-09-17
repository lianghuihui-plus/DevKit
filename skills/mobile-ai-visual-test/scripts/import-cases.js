#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { importDrafts } = require('./case/import-drafts');
const { parseCoordinatorCliArgs, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function main(argv = process.argv.slice(2)) {
  const options = parseCoordinatorCliArgs(argv, 'scripts/import-cases.js');
  const requestFile = path.resolve(options.requestFile);
  const workspace = path.resolve(options.workspace);
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

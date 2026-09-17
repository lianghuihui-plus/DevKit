#!/usr/bin/env node
'use strict';

const path = require('path');
const { importSource } = require('./case/import-source');
const { parseCoordinatorCliArgs, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function main(argv = process.argv.slice(2)) {
  const options = parseCoordinatorCliArgs(argv, 'scripts/import-case.js');
  process.stdout.write(`${JSON.stringify(importSource(path.resolve(options.workspace), path.resolve(options.inputFile)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/import-case.js'); process.exit(error.exitCode || 2); }
}

module.exports = { main };

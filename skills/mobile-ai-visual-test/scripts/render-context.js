#!/usr/bin/env node
'use strict';

const { main } = require('./report/render-context');
const { writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

try { main(); } catch (error) {
  writeCoordinatorCliError(error, 'scripts/render-context.js');
  process.exit(error.exitCode || 2);
}

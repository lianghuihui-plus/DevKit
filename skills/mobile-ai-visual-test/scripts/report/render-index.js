#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  renderIndexForRoot,
} = require('./report-service');
const { parseCliArgsOrExit } = require('../lib/cli-args');
const { assertWorkspace } = require('../lib/workspace');

function usage() {
  console.error('Usage: render-index.js [workspace-cwd]');
  process.exit(2);
}

const parsedArgs = parseCliArgsOrExit(process.argv.slice(2), {
  context: 'render-index.js',
  maxPositionals: 1,
});
const input = parsedArgs.positionals[0] ? path.resolve(parsedArgs.positionals[0]) : process.cwd();
const rootDir = assertWorkspace(input).root;
const casesRoot = path.join(rootDir, 'cases');

if (!fs.existsSync(casesRoot)) {
  usage();
}

console.log(renderIndexForRoot(rootDir));

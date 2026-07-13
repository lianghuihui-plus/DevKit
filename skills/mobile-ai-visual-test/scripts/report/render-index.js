#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  renderIndexForRoot,
  workspaceRoot,
} = require('../common');

function usage() {
  console.error('Usage: render-index.js [workspace-cwd]');
  process.exit(2);
}

const input = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const rootDir = workspaceRoot(input);
const casesRoot = path.join(rootDir, 'cases');

if (!fs.existsSync(casesRoot)) {
  usage();
}

console.log(renderIndexForRoot(rootDir));

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildPreconditionPlan } = require('../lib/precondition-flow');

function usage() {
  console.error('Usage: resolve-precondition-flow.js <case-dir> --platform <harmony|android|ios> [--cwd <workspace-cwd>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();
const caseDir = path.resolve(args[0]);
let cwd = process.cwd();
let platform = '';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else if (args[i] === '--platform') platform = args[++i];
  else usage();
}
if (!platform) usage();

try {
  const caseJsonPath = path.join(caseDir, 'case.json');
  if (!fs.existsSync(caseJsonPath)) throw new Error(`Missing case.json in ${caseDir}`);
  const caseJson = JSON.parse(fs.readFileSync(caseJsonPath, 'utf8'));
  console.log(JSON.stringify(buildPreconditionPlan(caseJson, cwd, platform), null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

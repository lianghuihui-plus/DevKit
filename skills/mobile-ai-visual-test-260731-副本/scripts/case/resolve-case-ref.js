#!/usr/bin/env node
'use strict';

const path = require('path');
const { resolveCaseRef } = require('../lib/case-ref');

function usage() {
  console.error('Usage: resolve-case-ref.js <caseNo|caseKey|title-keyword> [--cwd <workspace-cwd>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();
let ref = '';
let cwd = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else if (!ref) ref = args[i];
  else usage();
}
if (!ref) usage();

try {
  console.log(JSON.stringify(resolveCaseRef(ref, cwd), null, 2));
} catch (error) {
  if (error.code === 'AMBIGUOUS_CASE_REF') {
    console.error(JSON.stringify({ error: error.code, ref, matches: error.matches }, null, 2));
    process.exit(3);
  }
  console.error(error.message || String(error));
  process.exit(1);
}

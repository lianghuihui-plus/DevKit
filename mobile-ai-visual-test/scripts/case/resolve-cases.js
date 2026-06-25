#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: resolve-cases.js <case.md|dir> [...]');
  process.exit(2);
}

function collect(input, out) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new Error(`Path not found: ${input}`);
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (isCaseFile(abs)) out.push(abs);
    return;
  }
  if (stat.isDirectory()) walk(abs, out);
}

function walk(dir, out) {
  const base = path.basename(dir);
  if (base.startsWith('.') || base === 'ai-visual-test') return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file, out);
    else if (isCaseFile(file)) out.push(file);
  }
}

function isCaseFile(file) {
  const base = path.basename(file);
  return file.endsWith('.md') && base !== 'README.md' && !base.startsWith('_');
}

const inputs = process.argv.slice(2);
if (!inputs.length) usage();

const files = [];
for (const input of inputs) collect(input, files);
const unique = Array.from(new Set(files)).sort();
console.log(JSON.stringify({ files: unique }, null, 2));

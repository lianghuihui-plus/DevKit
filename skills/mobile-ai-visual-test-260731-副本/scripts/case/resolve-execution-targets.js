#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  hasWorkspaceShape,
  workspaceRoot,
} = require('../common');
const { parseCliArgsOrExit } = require('../lib/cli-args');
const { resolveCaseRef } = require('../lib/case-ref');

function usage() {
  console.error('Usage: resolve-execution-targets.js <case-ref|case.md|dir> [...] [--cwd <workspace-cwd>]');
  process.exit(2);
}

function isCaseFile(file) {
  const base = path.basename(file);
  return file.endsWith('.md') && base !== 'README.md' && !base.startsWith('_');
}

function collectMarkdown(input, out) {
  const abs = resolveInputPath(input);
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (isCaseFile(abs)) out.push(abs);
    return;
  }
  if (stat.isDirectory()) walk(abs, out);
}

function walk(dir, out) {
  const base = path.basename(dir);
  if (base.startsWith('.') || fs.existsSync(path.join(dir, 'workspace.json')) || hasWorkspaceShape(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file, out);
    else if (isCaseFile(file)) out.push(file);
  }
}

const args = process.argv.slice(2);
if (!args.length) usage();

const parsedArgs = parseCliArgsOrExit(args, {
  context: 'resolve-execution-targets.js',
  valueOptions: ['--cwd'],
});
const cwd = parsedArgs.values['--cwd'] ? path.resolve(parsedArgs.values['--cwd']) : process.cwd();
const inputs = parsedArgs.positionals;
if (!inputs.length) usage();

try {
  workspaceRoot(cwd);
  const markdownFiles = [];
  const existingCases = [];
  const seenCases = new Set();
  for (const input of inputs) {
    if (fs.existsSync(resolveInputPath(input))) {
      collectMarkdown(input, markdownFiles);
      continue;
    }
    const item = resolveCaseRef(input, cwd);
    if (!seenCases.has(item.caseDir)) {
      existingCases.push(item);
      seenCases.add(item.caseDir);
    }
  }
  console.log(JSON.stringify({
    existingCases,
    markdownFiles: Array.from(new Set(markdownFiles)).sort(),
  }, null, 2));
} catch (error) {
  if (error.code === 'AMBIGUOUS_CASE_REF') {
    console.error(JSON.stringify({ error: error.code, matches: error.matches }, null, 2));
    process.exit(3);
  }
  console.error(error.message);
  process.exit(1);
}

function resolveInputPath(input) {
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

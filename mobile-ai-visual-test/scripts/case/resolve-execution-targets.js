#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  casesRoot,
  normalizeCaseNo,
  readCaseEntries,
} = require('../common');

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
  if (base.startsWith('.') || base === 'ai-visual-test') return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file, out);
    else if (isCaseFile(file)) out.push(file);
  }
}

function resolveCaseRef(ref, cwd) {
  const entries = readCaseEntries(casesRoot(cwd)).sort((a, b) => {
    const noA = normalizeCaseNo(a.caseJson.identity?.caseNo);
    const noB = normalizeCaseNo(b.caseJson.identity?.caseNo);
    return noA.localeCompare(noB) || a.caseDir.localeCompare(b.caseDir);
  });
  const normalizedRef = normalizeCaseNo(ref);
  const directMatches = normalizedRef
    ? entries.filter((entry) => normalizeCaseNo(entry.caseJson.identity?.caseNo) === normalizedRef)
    : entries.filter((entry) => entry.caseJson.identity?.caseKey === ref);
  const matches = directMatches.length ? directMatches : matchByTitle(entries, ref);
  if (!matches.length) {
    throw new Error(`No path or case matched: ${ref}`);
  }
  if (matches.length > 1) {
    const error = new Error(`Ambiguous case ref: ${ref}`);
    error.code = 'AMBIGUOUS_CASE_REF';
    error.matches = matches.map(toSummary);
    throw error;
  }
  return toSummary(matches[0]);
}

function matchByTitle(items, keyword) {
  const exact = items.filter((entry) => entry.caseJson.identity?.title === keyword);
  if (exact.length) return exact;
  return items.filter((entry) => String(entry.caseJson.identity?.title || '').includes(keyword));
}

function toSummary(entry) {
  return {
    caseNo: normalizeCaseNo(entry.caseJson.identity?.caseNo),
    title: entry.caseJson.identity?.title || '',
    caseKey: entry.caseJson.identity?.caseKey || '',
    caseDir: entry.caseDir,
    context: path.join(entry.caseDir, 'CONTEXT.md'),
    contextHtml: path.join(entry.caseDir, 'CONTEXT.html'),
  };
}

const args = process.argv.slice(2);
if (!args.length) usage();

let cwd = process.cwd();
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else inputs.push(args[i]);
}
if (!inputs.length) usage();

try {
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

#!/usr/bin/env node
'use strict';

const fs = require('fs');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function boundsOf(attributes = {}) {
  const raw = String(attributes.bounds || attributes.bound || '');
  const values = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  return values.length >= 4 ? values.slice(0, 4) : null;
}

function visit(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  const attributes = value.attributes && typeof value.attributes === 'object' ? value.attributes : value;
  const bounds = boundsOf(attributes);
  const kind = String(attributes.type || attributes.componentType || attributes.className || attributes.bundleName || '').toLowerCase();
  const editable = /textinput|textfield|textarea|searchfield/.test(kind) || attributes.editable === true || attributes.editable === 'true';
  if (editable && bounds) output.push({ attributes, bounds });
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attributes') continue;
    if (child && typeof child === 'object') visit(child, output);
  }
  return output;
}

const layout = JSON.parse(fs.readFileSync(option('--layout'), 'utf8'));
const x = Number(option('--x'));
const y = Number(option('--y'));
const expectedText = option('--text');
const mode = option('--mode') || 'replace';
const candidates = visit(layout).filter(({ bounds }) => x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]);
candidates.sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]));
const target = candidates[0];
if (!target) {
  process.stdout.write(JSON.stringify({ status: 'UNVERIFIABLE', reason: 'no editable layout node contains the input coordinate' }));
  process.exit(0);
}
const actualText = ['text', 'value', 'content', 'accessibilityText'].map((key) => target.attributes[key]).find((value) => typeof value === 'string');
if (mode !== 'replace' || actualText === undefined) {
  process.stdout.write(JSON.stringify({ status: 'UNVERIFIABLE', reason: mode !== 'replace' ? 'append mode has no deterministic full-value expectation' : 'editable layout node does not expose text' }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ status: actualText === expectedText ? 'VERIFIED' : 'MISMATCH', expectedText, actualText, targetBounds: target.bounds }));

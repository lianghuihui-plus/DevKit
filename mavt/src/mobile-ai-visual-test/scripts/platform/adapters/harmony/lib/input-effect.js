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

function exposedText(attributes = {}) {
  return ['text', 'value', 'content', 'accessibilityText']
    .map((key) => attributes[key])
    .find((value) => typeof value === 'string');
}

function isSecureInput(attributes = {}) {
  const booleanSignals = ['password', 'secure', 'secureTextEntry', 'isPassword']
    .some((key) => attributes[key] === true || String(attributes[key]).toLowerCase() === 'true');
  const typeSignals = ['type', 'inputType', 'contentType', 'textContentType', 'keyboardType']
    .map((key) => String(attributes[key] || '').toLowerCase())
    .some((value) => /password|secure/.test(value));
  return booleanSignals || typeSignals;
}

function isMaskedValue(actualText, expectedText) {
  if (!actualText || actualText === expectedText) return false;
  return /^[*\u2022\u25cf\u25e6\u00b7\u2219\u22c5\u25aa\u25a0\u25a1\uff0a]+$/u.test(actualText);
}

function evaluateInputEffect(layout, { x, y, expectedText, mode = 'replace' }) {
  const candidates = visit(layout).filter(({ bounds }) => x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]);
  candidates.sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]));
  const target = candidates[0];
  if (!target) return { status: 'UNVERIFIABLE', reason: 'no editable layout node contains the input coordinate' };
  if (mode !== 'replace') {
    return { status: 'UNVERIFIABLE', reason: 'append mode has no deterministic full-value expectation', targetBounds: target.bounds };
  }
  const actualText = exposedText(target.attributes);
  const secureInput = isSecureInput(target.attributes);
  if (actualText === undefined) {
    return {
      status: 'UNVERIFIABLE',
      reason: secureInput ? 'secure input does not expose text' : 'editable layout node does not expose text',
      secureInput,
      targetBounds: target.bounds,
    };
  }
  if (actualText === expectedText) {
    return { status: 'VERIFIED', expectedText, actualText, secureInput, targetBounds: target.bounds };
  }
  if (isMaskedValue(actualText, expectedText)) {
    return {
      status: 'MASKED',
      reason: 'input value is masked by the editable control and cannot be compared as clear text',
      secureInput: true,
      expectedLength: String(expectedText).length,
      actualLength: actualText.length,
      targetBounds: target.bounds,
    };
  }
  return { status: 'MISMATCH', expectedText, actualText, secureInput, targetBounds: target.bounds };
}

function main() {
  const layout = JSON.parse(fs.readFileSync(option('--layout'), 'utf8'));
  const effect = evaluateInputEffect(layout, {
    x: Number(option('--x')),
    y: Number(option('--y')),
    expectedText: option('--text'),
    mode: option('--mode') || 'replace',
  });
  process.stdout.write(JSON.stringify(effect));
}

if (require.main === module) main();

module.exports = {
  evaluateInputEffect,
  exposedText,
  isMaskedValue,
  isSecureInput,
  visit,
};

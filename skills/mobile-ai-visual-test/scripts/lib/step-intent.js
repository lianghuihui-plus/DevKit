#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const AUTHORIZATION_SOURCE = 'case-step';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function intentFields(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step) || !String(step.id || '').trim()) {
    throw new Error('ACTION_OUTSIDE_CASE_INTENT: frozen case step is required');
  }
  return {
    stepId: String(step.id),
    kind: String(step.kind || ''),
    goal: String(step.goal || ''),
    target: String(step.target || ''),
    sourceText: String(step.sourceText || ''),
  };
}

function buildStepIntent(step) {
  const fields = intentFields(step);
  return {
    ...fields,
    intentSha: `step-intent-${crypto.createHash('sha256').update(canonicalJson(fields)).digest('hex').slice(0, 16)}`,
  };
}

function validateStepIntent(step, stepIntent) {
  const expected = buildStepIntent(step);
  if (!stepIntent || canonicalJson(stepIntent) !== canonicalJson(expected)) {
    throw new Error(`ACTION_OUTSIDE_CASE_INTENT: stepIntent does not match frozen step ${expected.stepId}`);
  }
  return expected;
}

function actionAuthorization(step) {
  const intent = buildStepIntent(step);
  return {
    source: AUTHORIZATION_SOURCE,
    stepId: intent.stepId,
    intentSha: intent.intentSha,
  };
}

function validateActionAuthorization(step, authorization) {
  const expected = actionAuthorization(step);
  if (!authorization || canonicalJson(authorization) !== canonicalJson(expected)) {
    throw new Error(`ACTION_OUTSIDE_CASE_INTENT: action authorization does not match frozen step ${expected.stepId}`);
  }
  return expected;
}

function verifySnapshot(snapshotPath, stepId, intentSha) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const step = (snapshot.steps || []).find((item) => item.id === stepId);
  if (!step) throw new Error(`ACTION_OUTSIDE_CASE_INTENT: step ${stepId} is not present in frozen case snapshot`);
  return validateActionAuthorization(step, {
    source: AUTHORIZATION_SOURCE,
    stepId,
    intentSha,
  });
}

function cli() {
  const args = process.argv.slice(2);
  if (args[0] !== 'verify' || args.length !== 4) {
    console.error('Usage: step-intent.js verify <case.snapshot.json> <step-id> <intent-sha>');
    process.exit(2);
  }
  console.log(JSON.stringify(verifySnapshot(args[1], args[2], args[3])));
}

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  AUTHORIZATION_SOURCE,
  actionAuthorization,
  buildStepIntent,
  canonicalJson,
  validateActionAuthorization,
  validateStepIntent,
  verifySnapshot,
};

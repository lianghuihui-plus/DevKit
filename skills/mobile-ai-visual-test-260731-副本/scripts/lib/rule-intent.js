#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { stableJson } = require('./case-contract');

function ruleSha(rule) {
  return `rule-${crypto.createHash('sha256').update(stableJson(rule)).digest('hex').slice(0, 16)}`;
}

function ruleAuthorization(rule, stepId) {
  return {
    source: 'global-rule',
    ruleId: rule.id,
    ruleSha: ruleSha(rule),
    stepId,
  };
}

function validateRuleAuthorization(rule, stepId, authorization) {
  const expected = ruleAuthorization(rule, stepId);
  if (stableJson(expected) !== stableJson(authorization)) {
    throw new Error(`ACTION_OUTSIDE_CASE_INTENT: global rule authorization does not match ${rule.id}`);
  }
  return expected;
}

function verifySnapshot(snapshotPath, ruleId, stepId, suppliedRuleSha) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const step = (snapshot.steps || []).find((item) => item.id === stepId);
  const rule = (snapshot.globalRules || []).find((item) => item.id === ruleId);
  if (!step) throw new Error(`ACTION_OUTSIDE_CASE_INTENT: step ${stepId} is not present in frozen case snapshot`);
  if (!rule) throw new Error(`ACTION_OUTSIDE_CASE_INTENT: global rule ${ruleId} is not present in frozen case snapshot`);
  return validateRuleAuthorization(rule, stepId, { source: 'global-rule', ruleId, ruleSha: suppliedRuleSha, stepId });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] !== 'verify' || args.length !== 5) {
    console.error('Usage: rule-intent.js verify <case.snapshot.json> <rule-id> <step-id> <rule-sha>');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(verifySnapshot(args[1], args[2], args[3], args[4])));
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = { ruleAuthorization, ruleSha, validateRuleAuthorization, verifySnapshot };

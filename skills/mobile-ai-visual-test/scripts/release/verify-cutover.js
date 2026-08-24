#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '../..');
const PLAN_PATH = path.join(__dirname, 'cutover-plan.json');
const PLATFORMS = Object.freeze(['harmony', 'android', 'ios']);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.exitCode = 2;
  throw error;
}

function readPlan() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  if (plan.schemaVersion !== 1 || !plan.switch) {
    fail('CUTOVER_PLAN_INVALID', 'cutover plan schema is invalid');
  }
  return plan;
}

function absolute(relative) {
  return path.join(SKILL_ROOT, relative);
}

function assertPaths(paths, expected, label) {
  for (const relative of paths) {
    const exists = fs.existsSync(absolute(relative));
    if (exists !== expected) {
      fail('CUTOVER_STATE_INVALID', `${label} ${relative} must ${expected ? 'exist' : 'be absent'}`);
    }
  }
}

function buildContract(platform) {
  const args = [
    path.join(SKILL_ROOT, 'scripts/build-agent-contract.js'),
    '--role', 'case-executor',
    '--platform', platform,
  ];
  const output = childProcess.execFileSync(process.execPath, args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(output);
}

function assertSame(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('CUTOVER_CONTRACT_INVALID', `${label} does not match the frozen cutover plan`);
  }
}

function assertProtocolTermsAbsent(resources, forbiddenTerms) {
  for (const relative of resources) {
    const content = fs.readFileSync(absolute(relative), 'utf8');
    for (const term of forbiddenTerms) {
      if (content.includes(term)) fail('CUTOVER_PROTOCOL_INVALID', `${relative} still references ${term}`);
    }
  }
}

function assertNeutralNames(paths) {
  for (const relative of paths) {
    if (/(^|[/_.-])v\d+([/_.-]|$)/i.test(relative)) {
      fail('CUTOVER_NAMING_INVALID', `versioned release path is forbidden: ${relative}`);
    }
  }
}

function verifySwitched(plan) {
  assertPaths(plan.switch.removePaths, false, 'removed path');
  assertPaths([
    ...plan.switch.requiredResources,
    ...plan.switch.allowedEntrypoints,
    ...plan.switch.retainPaths,
  ], true, 'switched path');
  assertNeutralNames([
    ...plan.switch.requiredResources,
    ...plan.switch.allowedEntrypoints,
    ...plan.switch.retainPaths,
  ]);
  assertProtocolTermsAbsent(plan.switch.requiredResources, plan.switch.forbiddenProtocolTerms);
  const contracts = PLATFORMS.map((platform) => buildContract(platform));
  for (const contract of contracts) {
    assertSame(contract.requiredResources, plan.switch.requiredResources, `${contract.platform} requiredResources`);
    assertSame(contract.allowedEntrypoints, plan.switch.allowedEntrypoints, `${contract.platform} allowedEntrypoints`);
    if (contract.profile !== undefined) fail('CUTOVER_CONTRACT_INVALID', 'switched contract must not expose a profile selector');
  }
  return {
    state: 'SWITCHED',
    releaseUnit: plan.releaseUnit,
    platforms: contracts.map((contract) => ({
      platform: contract.platform,
      protocolSha: contract.protocolSha,
      implementationSha: contract.implementationSha,
    })),
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--state' || argv[1] !== 'switched') {
    fail('CUTOVER_CLI_INVALID', 'usage: verify-cutover.js --state switched');
  }
  const plan = readPlan();
  const result = verifySwitched(plan);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = {
  readPlan,
  verifySwitched,
};

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROLE_ENTRYPOINTS = Object.freeze({
  'case-executor': Object.freeze([
    'scripts/build-agent-contract.js',
    'scripts/execute-next-work.js',
    'scripts/build-case-agent-result.js',
  ]),
  'batch-coordinator': Object.freeze([
    'scripts/build-agent-contract.js',
    'scripts/resolve-execution-targets.js',
    'scripts/parse-case.js',
    'scripts/probe-env.sh',
    'scripts/update-env.js',
    'scripts/preflight-preconditions.js',
    'scripts/prepare-env.sh',
    'scripts/run-case.js',
    'scripts/agent-runtime.js',
    'scripts/batch-runtime.js',
  ]),
});

const CASE_EXECUTOR_RESOURCES = Object.freeze([
  'SKILL.md',
  'references/case-executor-contract.md',
  'references/action-schema.md',
]);

const BATCH_COORDINATOR_RESOURCES = Object.freeze([
  'SKILL.md',
  'references/agent-runtime.md',
  'references/workflow.md',
  'references/interfaces.md',
  'references/environment-probing.md',
  'references/failure-policy.md',
  'references/flow-format.md',
  'references/case-executor-contract.md',
  'references/context-format.md',
]);

const PROVIDER_RESOURCES = Object.freeze({
  codex: 'references/agent-runtimes/codex.md',
});

const CASE_EXECUTOR_CORE = new Set([
  'scripts/build-agent-contract.js',
  'scripts/build-case-agent-result.js',
  'scripts/commit-agent-turn.js',
  'scripts/execute-next-work.js',
  'scripts/common.js',
  'scripts/run-case.js',
  'scripts/action.sh',
  'scripts/action-observe.sh',
  'scripts/observe.sh',
  'scripts/platform/action.sh',
  'scripts/platform/observe.sh',
  'scripts/execution/resolve-execution-environment.js',
  'scripts/execution/run-case.js',
]);

function walkFiles(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  const values = [];
  for (const name of fs.readdirSync(absolute).sort()) {
    values.push(...walkFiles(root, path.posix.join(relative, name)));
  }
  return values;
}

function roleResources(role, provider) {
  if (role === 'case-executor') return [...CASE_EXECUTOR_RESOURCES];
  if (role === 'batch-coordinator') {
    const values = [...BATCH_COORDINATOR_RESOURCES];
    if (PROVIDER_RESOURCES[provider]) values.splice(2, 0, PROVIDER_RESOURCES[provider]);
    return values;
  }
  throw new Error(`Unsupported Agent role: ${role}`);
}

function roleEntrypoints(role) {
  if (!ROLE_ENTRYPOINTS[role]) throw new Error(`Unsupported Agent role: ${role}`);
  return [...ROLE_ENTRYPOINTS[role]];
}

function implementationFiles(skillRoot, role, platform) {
  const allScripts = walkFiles(skillRoot, 'scripts')
    .filter((relative) => !/(^|[-.])self-test\.js$/.test(path.basename(relative)));
  const selectedAdapterPrefix = `scripts/platform/adapters/${platform}/`;
  const withoutOtherAdapters = allScripts.filter((relative) =>
    !relative.startsWith('scripts/platform/adapters/') || relative.startsWith(selectedAdapterPrefix));
  if (role === 'batch-coordinator') return withoutOtherAdapters;
  if (role !== 'case-executor') throw new Error(`Unsupported Agent role: ${role}`);
  return withoutOtherAdapters.filter((relative) => CASE_EXECUTOR_CORE.has(relative)
    || relative.startsWith('scripts/lib/')
    || relative.startsWith(selectedAdapterPrefix));
}

module.exports = {
  implementationFiles,
  roleEntrypoints,
  roleResources,
};

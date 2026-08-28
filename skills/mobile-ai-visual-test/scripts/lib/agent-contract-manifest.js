#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROLE_ENTRYPOINTS = Object.freeze({
  'case-executor': Object.freeze([
    'scripts/agent/status.js',
    'scripts/agent/understand.js',
    'scripts/agent/inspect.js',
    'scripts/agent/step.js',
    'scripts/agent/mark-start.js',
    'scripts/agent/request-recovery.js',
    'scripts/agent/investigate.js',
    'scripts/agent/conclude.js',
  ]),
  'batch-coordinator': Object.freeze([
    'scripts/workspace.js',
    'scripts/import-case.js',
    'scripts/build-agent-contract.js',
    'scripts/probe-env.sh',
    'scripts/prepare-env.sh',
    'scripts/environment.js',
    'scripts/execution-request.js',
    'scripts/knowledge.js',
    'scripts/batch.js',
    'scripts/render-context.js',
    'scripts/render-index.js',
  ]),
});

const ROLE_RESOURCES = Object.freeze({
  'case-executor': Object.freeze([
    'SKILL.md',
    'references/agent-execution.md',
    'references/knowledge.md',
  ]),
  'batch-coordinator': Object.freeze([
    'SKILL.md',
    'references/workflow.md',
    'references/interfaces.md',
    'references/environment-probing.md',
    'references/failure-policy.md',
    'references/case-format.md',
    'references/agent-runtime.md',
    'references/agent-runtimes/codex.md',
  ]),
});

const SHARED_IMPLEMENTATION_FILES = new Set([
  'scripts/build-agent-contract.js',
  'scripts/lib/agent-contract-manifest.js',
]);

const REPORT_ONLY_LIB_FILES = new Set([
  'scripts/lib/agent-eval.js',
  'scripts/lib/cli-args.js',
  'scripts/lib/display-format.js',
  'scripts/lib/execution-reader.js',
  'scripts/lib/failure-catalog.js',
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

function roleResources(role) {
  if (!ROLE_RESOURCES[role]) throw new Error(`Unsupported Agent role: ${role}`);
  return [...ROLE_RESOURCES[role]];
}

function roleEntrypoints(role) {
  if (!ROLE_ENTRYPOINTS[role]) throw new Error(`Unsupported Agent role: ${role}`);
  return [...ROLE_ENTRYPOINTS[role]];
}

function implementationFiles(skillRoot, role, platform) {
  if (!ROLE_ENTRYPOINTS[role]) throw new Error(`Unsupported Agent role: ${role}`);
  const files = new Set(SHARED_IMPLEMENTATION_FILES);
  for (const relative of walkFiles(skillRoot, 'scripts/agent')) files.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/batch')) files.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/case')) files.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/execution')) files.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/lib')) {
    if (!REPORT_ONLY_LIB_FILES.has(relative)) files.add(relative);
  }
  for (const relative of [
    'scripts/batch.js',
    'scripts/environment.js',
    'scripts/execution-request.js',
    'scripts/import-case.js',
    'scripts/knowledge.js',
    'scripts/workspace.js',
    'scripts/probe-env.sh',
    'scripts/prepare-env.sh',
    'scripts/platform/action.sh',
    'scripts/platform/observe.sh',
    'scripts/platform/probe-env.sh',
    'scripts/platform/prepare-env.sh',
    'scripts/platform/runtime.sh',
  ]) files.add(relative);
  for (const relative of walkFiles(skillRoot, `scripts/platform/adapters/${platform}`)) files.add(relative);
  return [...files].sort();
}

module.exports = {
  REPORT_ONLY_LIB_FILES,
  implementationFiles,
  roleEntrypoints,
  roleResources,
};

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROLE_ENTRYPOINTS = Object.freeze({
  'case-executor': Object.freeze([
    'scripts/case-runtime/agent-facing-client.js',
    'scripts/case-runtime/mcp-server.js',
  ]),
  'batch-coordinator': Object.freeze([
    'scripts/coordinator-agent.js',
  ]),
});

const ROLE_RESOURCES = Object.freeze({
  'case-executor': Object.freeze([
    'prompts/case-agent.md',
    'references/case-reasoning.md',
    'references/case-runtime.md',
    'references/case-runtime/methods/observe.md',
    'references/case-runtime/methods/inspect.md',
    'references/case-runtime/methods/plan.md',
    'references/case-runtime/methods/record-result.md',
    'references/case-runtime/methods/act.md',
    'references/case-runtime/methods/knowledge.md',
    'references/case-runtime/methods/recover.md',
    'references/case-runtime/methods/finish.md',
    'references/case-runtime/action-refs.md',
    'references/case-runtime/errors.md',
  ]),
  'batch-coordinator': Object.freeze([
    'SKILL.md',
    'references/coordinator.md',
    'references/coordinator/methods/prepare-run.md',
    'references/coordinator/methods/confirm-run.md',
    'references/coordinator/methods/advance-run.md',
    'references/coordinator/methods/cancel-run.md',
    'references/coordinator/errors.md',
  ]),
});

const SHARED_IMPLEMENTATION_FILES = new Set([
  'scripts/build-agent-contract.js',
  'scripts/lib/agent-contract-manifest.js',
  'scripts/lib/app-provisioning.js',
  'scripts/lib/contract-utils.js',
  'scripts/lib/dispatch-lease.js',
  'scripts/lib/execution-lifecycle.js',
  'scripts/lib/execution-evidence.js',
  'scripts/lib/image-evidence.js',
  'scripts/lib/batch-contract.js',
  'scripts/lib/execution-environment.js',
  'scripts/lib/target-binding.js',
  'scripts/lib/startup-display.js',
]);

const REPORT_ONLY_LIB_FILES = new Set([
  'scripts/lib/cli-args.js',
  'scripts/lib/display-format.js',
  'scripts/lib/execution-reader.js',
  'scripts/lib/failure-catalog.js',
]);

const PLATFORM_ENTRYPOINTS = Object.freeze([
  'scripts/platform/action.sh',
  'scripts/platform/observe.sh',
  'scripts/platform/prepare-app.sh',
  'scripts/platform/probe-env.sh',
  'scripts/platform/prepare-env.sh',
  'scripts/platform/runtime.sh',
]);

const COORDINATOR_ENTRYPOINTS = Object.freeze([
  'scripts/coordinator-agent.js',
  'scripts/app-artifact.js',
  'scripts/batch.js',
  'scripts/environment.js',
  'scripts/execution-request.js',
  'scripts/import-case.js',
  'scripts/import-cases.js',
  'scripts/knowledge.js',
  'scripts/workspace.js',
  'scripts/probe-env.sh',
  'scripts/prepare-env.sh',
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

function implementationGroups(skillRoot, platform) {
  const sharedRuntime = new Set(SHARED_IMPLEMENTATION_FILES);
  const adapter = new Set(PLATFORM_ENTRYPOINTS);
  adapter.add('scripts/lib/action-result.js');
  for (const relative of walkFiles(skillRoot, `scripts/platform/adapters/${platform}`)) adapter.add(relative);

  const runtime = new Set([...sharedRuntime]);
  for (const relative of walkFiles(skillRoot, 'scripts/case-runtime')) {
    if (relative !== 'scripts/case-runtime/lifecycle.js') runtime.add(relative);
  }
  runtime.add('scripts/platform/device-port.js');
  for (const relative of walkFiles(skillRoot, 'scripts/session')) runtime.add(relative);
  for (const relative of [
    'scripts/execution/contracts/case-contract.js',
    'scripts/execution/contracts/validation-profile-contract.js',
    'scripts/lib/action-contract.js',
    'scripts/lib/execution-timing.js',
    'scripts/lib/action-result.js',
    'scripts/lib/action-spatial-evidence.js',
    'scripts/lib/knowledge-query.js',
    'scripts/lib/layout-observation.js',
    'scripts/lib/observation-consistency.js',
    'scripts/lib/observation-model.js',
    'scripts/lib/scroll-context.js',
    'scripts/lib/technical-facts.js',
    'scripts/lib/technical-context.js',
    'scripts/lib/warm-session-contract.js',
    'scripts/lib/workspace.js',
  ]) runtime.add(relative);

  const coordinator = new Set([...sharedRuntime, ...COORDINATOR_ENTRYPOINTS]);
  coordinator.add('scripts/case-runtime/lifecycle.js');
  for (const relative of walkFiles(skillRoot, 'scripts/batch')) coordinator.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/case')) coordinator.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/coordinator')) coordinator.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/execution')) coordinator.add(relative);
  for (const relative of walkFiles(skillRoot, 'scripts/lib')) {
    if (!REPORT_ONLY_LIB_FILES.has(relative)) coordinator.add(relative);
  }

  const report = new Set(walkFiles(skillRoot, 'scripts/report'));
  report.add('scripts/render-context.js');
  report.add('scripts/render-index.js');
  for (const relative of REPORT_ONLY_LIB_FILES) report.add(relative);
  for (const relative of [
    'scripts/build-agent-contract.js',
    'scripts/execution/contracts/case-contract.js',
    'scripts/execution/contracts/validation-profile-contract.js',
    'scripts/lib/agent-contract-manifest.js',
    'scripts/lib/batch-contract.js',
    'scripts/lib/completion-contract.js',
    'scripts/lib/contract-utils.js',
    'scripts/lib/execution-evidence.js',
    'scripts/lib/execution-evidence-graph.js',
    'scripts/lib/execution-lifecycle.js',
    'scripts/lib/execution-timing.js',
    'scripts/lib/execution-artifact-manifest.js',
    'scripts/lib/action-spatial-evidence.js',
    'scripts/lib/image-evidence.js',
    'scripts/lib/observation-consistency.js',
    'scripts/lib/technical-facts.js',
  ]) report.add(relative);

  const caseExecutor = new Set([...runtime, ...adapter]);

  return {
    sharedRuntime: [...sharedRuntime].sort(),
    runtime: [...runtime].sort(),
    caseExecutor: [...caseExecutor].sort(),
    coordinator: [...coordinator].sort(),
    adapter: [...adapter].sort(),
    report: [...report].sort(),
  };
}

function implementationFiles(skillRoot, role, platform) {
  if (!ROLE_ENTRYPOINTS[role]) throw new Error(`Unsupported Agent role: ${role}`);
  const groups = implementationGroups(skillRoot, platform);
  return role === 'case-executor' ? groups.caseExecutor : groups.coordinator;
}

module.exports = {
  REPORT_ONLY_LIB_FILES,
  implementationGroups,
  implementationFiles,
  roleEntrypoints,
  roleResources,
};

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { roleEntrypoints, roleResources } = require('../lib/agent-contract-manifest');
const { buildContract } = require('../build-agent-contract');
const { validateCaseContext, validateDecision, validateRuntimeRequest } = require('../case-runtime/contract');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-broker');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

assert.deepStrictEqual(roleResources('case-executor'), ['prompts/case-agent.md']);
assert.deepStrictEqual(roleEntrypoints('case-executor'), ['scripts/case-runtime/runtime-client.js']);
assert.strictEqual(roleResources('batch-coordinator').includes('prompts/case-agent.md'), false);
assert.strictEqual(roleResources('batch-coordinator')[0], 'SKILL.md');
assert.strictEqual(fs.existsSync(path.join(root, 'prompts/main-agent.md')), false);

const casePrompt = read('prompts/case-agent.md');
for (const obsolete of ['UNDERSTAND', 'START_READY', 'allowedDecisions', 'checkpointId', 'turnId']) {
  assert.strictEqual(casePrompt.includes(obsolete), false, `Case Prompt must not expose ${obsolete}`);
}
assert.match(casePrompt, /Runtime/);
assert.match(casePrompt, /业务执行/);
assert.match(casePrompt, /Frozen CaseSpec/);
assert.match(casePrompt, /decision/);
assert.match(casePrompt, /expectationRef/);
assert.match(casePrompt, /purpose \+ expectationRefs/);
assert.strictEqual(casePrompt.includes('"operation": "prepare"'), false);
assert.deepStrictEqual(AGENT_OPERATIONS, ['observe', 'act', 'knowledge', 'recover', 'finish', 'status']);
for (const hidden of ['CLEAR_APP_DATA', 'REINSTALL_APP', 'artifactPath', 'appiumSessionId']) {
  assert.strictEqual(casePrompt.includes(hidden), false, `Case Prompt must not expose ${hidden}`);
}
const promptRequests = [...casePrompt.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
assert.ok(promptRequests.length >= 3);
for (const request of promptRequests) assert.doesNotThrow(() => validateRuntimeRequest(request));
for (const request of promptRequests) {
  if (request.caseContext) assert.doesNotThrow(() => validateCaseContext(request.caseContext));
  if (request.decision) assert.doesNotThrow(() => validateDecision(request.decision));
}
assert.throws(() => validateCaseContext({
  summary: '验证目标页面', preconditions: [], expectations: ['目标内容显示'], initialPlan: '观察页面', uncertainties: [],
}), (error) => error?.code === 'CASE_NARRATIVE_INVALID' && error.fieldPath === 'caseContext.initialPlan');
assert.doesNotThrow(() => validateDecision({ purpose: '检查结果', expectationRefs: ['E1'] }));
assert.throws(() => validateDecision({ expectationRefs: ['E1'] }),
  (error) => error?.code === 'CASE_NARRATIVE_INVALID' && error.fieldPath === 'decision.purpose');

const mainPrompt = read('SKILL.md');
assert.match(mainPrompt, /你是本次测试的主 Agent/);
assert.match(mainPrompt, /WAIT_CASE_AGENT/);
assert.match(mainPrompt, /NEED_CASE_AGENT/);
assert.match(mainPrompt, /agentRequired=false/);
assert.match(mainPrompt, /一个用例只委托一次|创建一个全新的原生 Case Agent/);
assert.match(mainPrompt, /读取 `prompts\/case-agent\.md`/);
assert.strictEqual(mainPrompt.includes('allowedDecisions'), false);

const currentReportSource = read('scripts/report/current-report.js');
assert.strictEqual(currentReportSource.includes('report.events'), false, 'Renderer must consume projected ViewModels');
for (const obsolete of ['execution-story', 'checkpoint-accordion', 'process-workspace', 'case-plan-workspace']) {
  assert.strictEqual(currentReportSource.includes(obsolete), false, `Renderer must not retain obsolete ${obsolete} UI`);
}
for (const artifact of ['binding.snapshot.json', 'case.snapshot.json', 'case-spec.snapshot.json', 'source.snapshot.md', 'logs/', 'action-spatial-evidence/']) {
  assert.ok(read('docs/architecture.md').includes(artifact), `architecture must list ${artifact}`);
}

for (const name of fs.readdirSync(path.join(root, 'scripts/case-runtime')).filter((item) => item.endsWith('.js'))) {
  assert.strictEqual(read(`scripts/case-runtime/${name}`).includes("require('../batch/"), false, `${name} must not depend on Batch`);
}

const runtimeClient = require('../case-runtime/runtime-client');
const lifecycle = require('../case-runtime/lifecycle');
const batchCore = require('../batch/core');
assert.deepStrictEqual(Object.keys(runtimeClient).sort(), ['main', 'parseRequest', 'run']);
assert.deepStrictEqual(Object.keys(lifecycle).sort(), ['EXECUTION_SCHEMA_VERSION', 'buildContinuationBrief', 'cancelExecution', 'commitExecution', 'createExecution', 'establishInitialState', 'readCompletion', 'reconcileExecution', 'recordAgentContinuation', 'resumeExecution']);
assert.strictEqual(batchCore.BATCH_SCHEMA_VERSION, 8);
assert.strictEqual(Object.prototype.hasOwnProperty.call(runtimeClient, 'createExecution'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(lifecycle, 'act'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(batchCore, 'recoverApp'), false);

const batchCoreSource = read('scripts/batch/core.js');
for (const obsolete of ["require('../agent/", "require('../execution/core')", 'recoveryDraft', 'RESUME_RECOVERY']) {
  assert.strictEqual(batchCoreSource.includes(obsolete), false, `Batch must not retain replaced recovery path: ${obsolete}`);
}
for (const relative of fs.readdirSync(path.join(root, 'scripts/batch')).filter((name) => name.endsWith('.js'))) {
  const source = read(`scripts/batch/${relative}`);
  assert.strictEqual(/require\(['"]\.\.\/case-runtime\/(?!lifecycle)/.test(source), false, `${relative} must use the Case Runtime lifecycle facade`);
}

const caseContract = buildContract({ skillRoot: root, role: 'case-executor', platform: 'harmony' });
assert.strictEqual(caseContract.implementationFiles.some((file) => file.startsWith('scripts/agent/')), false);
assert.strictEqual(caseContract.implementationFiles.some((file) => file.startsWith('scripts/batch/')), false);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/case-runtime/lifecycle.js'), false);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/platform/prepare-app.sh'), true);
const iosContract = buildContract({ skillRoot: root, role: 'case-executor', platform: 'ios' });
assert.strictEqual(iosContract.implementationFiles.includes('scripts/platform/adapters/ios/lib/input-service.js'), true);
assert.strictEqual(iosContract.implementationFiles.includes('scripts/platform/adapters/ios/lib/pointer-actions.js'), true);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/lib/app-provisioning.js'), true);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/execution/contracts/case-spec-contract.js'), true);

const coordinatorContract = buildContract({ skillRoot: root, role: 'batch-coordinator', platform: 'harmony' });
assert.strictEqual(coordinatorContract.allowedEntrypoints.includes('scripts/app-artifact.js'), true);
assert.strictEqual(coordinatorContract.requiredResources.includes('references/knowledge.md'), true);
assert.strictEqual(coordinatorContract.requiredResources.includes('references/installation.md'), true);
const platformSpecific = /\b(?:codex|spawn_agent|fork_turns|provider|mcp)\b/i;
for (const relative of new Set([...caseContract.requiredResources, ...coordinatorContract.requiredResources])) {
  assert.strictEqual(platformSpecific.test(read(relative)), false, `${relative} must remain Agent-host neutral`);
}
assert.strictEqual(platformSpecific.test(JSON.stringify({ caseContract, coordinatorContract })), false, 'Agent contracts must remain host neutral');

const digestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-digest-boundaries-'));
fs.cpSync(root, digestRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) });
const harmonyBefore = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
const androidBefore = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'android' });
const coordinatorBefore = buildContract({ skillRoot: digestRoot, role: 'batch-coordinator', platform: 'harmony' });
fs.appendFileSync(path.join(digestRoot, 'references/knowledge.md'), '\nBehavior-bearing knowledge protocol fixture.\n');
const coordinatorAfterKnowledge = buildContract({ skillRoot: digestRoot, role: 'batch-coordinator', platform: 'harmony' });
assert.notStrictEqual(coordinatorAfterKnowledge.protocolSha, coordinatorBefore.protocolSha);
assert.strictEqual(buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' }).protocolSha, harmonyBefore.protocolSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/report/current-report.js'), '\n// renderer digest boundary fixture\n');
const afterReport = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
assert.strictEqual(afterReport.runtimeSha, harmonyBefore.runtimeSha);
assert.strictEqual(afterReport.adapterSha, harmonyBefore.adapterSha);
assert.strictEqual(afterReport.coordinatorSha, harmonyBefore.coordinatorSha);
assert.notStrictEqual(afterReport.reportRendererSha, harmonyBefore.reportRendererSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/lib/technical-facts.js'), '\n// technical fact digest boundary fixture\n');
const afterTechnicalFacts = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
assert.notStrictEqual(afterTechnicalFacts.runtimeSha, afterReport.runtimeSha);
assert.notStrictEqual(afterTechnicalFacts.reportRendererSha, afterReport.reportRendererSha);
assert.strictEqual(afterTechnicalFacts.adapterSha, afterReport.adapterSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/lib/observation-consistency.js'), '\n// observation consistency digest boundary fixture\n');
const afterObservationConsistency = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
assert.notStrictEqual(afterObservationConsistency.runtimeSha, afterTechnicalFacts.runtimeSha);
assert.notStrictEqual(afterObservationConsistency.reportRendererSha, afterTechnicalFacts.reportRendererSha);
assert.strictEqual(afterObservationConsistency.adapterSha, afterTechnicalFacts.adapterSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/platform/adapters/harmony/probe.sh'), '\n# adapter digest boundary fixture\n');
const harmonyAfterAdapter = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
const androidAfterAdapter = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'android' });
assert.notStrictEqual(harmonyAfterAdapter.adapterSha, afterObservationConsistency.adapterSha);
assert.strictEqual(harmonyAfterAdapter.runtimeSha, afterObservationConsistency.runtimeSha);
assert.strictEqual(harmonyAfterAdapter.coordinatorSha, afterObservationConsistency.coordinatorSha);
assert.strictEqual(androidAfterAdapter.adapterSha, androidBefore.adapterSha);
fs.rmSync(digestRoot, { recursive: true, force: true });

for (const relative of fs.readdirSync(path.join(root, 'scripts/platform/adapters'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => `scripts/platform/adapters/${entry.name}`)) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const child = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(js|sh)$/.test(entry.name)) files.push(child);
    }
  };
  walk(relative);
  for (const file of files) {
    const source = read(file);
    assert.strictEqual(/require\([^)]*(?:batch|case-runtime|report)/.test(source), false, `${file} must not depend on orchestration`);
  }
}

for (const relative of ['references/shared-agent-principles.md', 'references/shared-decision-protocol.md', 'references/agent-execution.md']) {
  assert.strictEqual(fs.existsSync(path.join(root, relative)), false, `${relative} should be retired`);
}

for (const relative of [
  'scripts/agent',
  'scripts/execution/core.js',
  'scripts/batch/internal-recovery.js',
  'scripts/batch/recovery-validation.js',
  'scripts/lib/agent-attempt-lifecycle.js',
  'scripts/lib/agent-driven-contract.js',
  'scripts/lib/agent-entrypoint.js',
  'scripts/lib/agent-input-contract.js',
  'scripts/lib/case-agent-guidance.js',
  'scripts/lib/case-agent-runtime-contract.js',
  'scripts/lib/execution-time-limit.js',
  'scripts/lib/knowledge-context.js',
  'scripts/lib/recovery-contract.js',
  'scripts/lib/source-reference.js',
]) assert.strictEqual(fs.existsSync(path.join(root, relative)), false, `${relative} should be retired`);

console.log('architecture boundaries passed');

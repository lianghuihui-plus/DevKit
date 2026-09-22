#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { implementationGroups, roleEntrypoints, roleResources } = require('../lib/agent-contract-manifest');
const { AGENT_FACING_INTERFACE_KIND: COORDINATOR_INTERFACE_KIND, COORDINATOR_CAPABILITIES } = require('../coordinator/agent-facing-contract');
const { AGENT_FACING_CAPABILITIES, AGENT_FACING_INTERFACE_KIND: CASE_INTERFACE_KIND } = require('../case-runtime/agent-facing-contract');
const { buildContract } = require('../build-agent-contract');
const { REQUEST_FIELDS, validateDecision, validateRuntimeRequest } = require('../case-runtime/contract');
const runtimeBroker = require('../case-runtime/runtime-broker');
const runtimeOperationContract = require('../case-runtime/runtime-operation-contract');
const { AGENT_OPERATIONS, isSupportedBroker } = runtimeBroker;
const { OPERATION_CONTRACT } = runtimeOperationContract;

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const envelopeSource = read('scripts/lib/agent-facing-envelope.js');
for (const forbiddenDependency of [
  "require('../case-runtime/", "require('../coordinator/", "require('../report/", "require('../execution/", "require('../batch/",
]) {
  assert.strictEqual(envelopeSource.includes(forbiddenDependency), false,
    `Shared envelope must remain domain-neutral: ${forbiddenDependency}`);
}

assert.strictEqual(fs.existsSync(path.join(root, 'scripts/lib/readers/current-execution.js')), true);

assert.deepStrictEqual(roleResources('case-executor').sort(), [
  'prompts/case-agent.md',
  'references/case-execution-principles.md',
  'references/case-runtime.md',
  'references/case-runtime/resources.md',
  'references/case-runtime/methods/read.md',
  'references/case-runtime/methods/observe.md',
  'references/case-runtime/methods/inspect.md',
  'references/case-runtime/methods/plan.md',
  'references/case-runtime/methods/record-result.md',
  'references/case-runtime/methods/act.md',
  'references/case-runtime/methods/run-plan.md',
  'references/case-runtime/methods/knowledge.md',
  'references/case-runtime/methods/recover.md',
  'references/case-runtime/methods/finish.md',
  'references/case-runtime/action-refs.md',
  'references/case-runtime/errors.md',
  'references/case-runtime/errors/transport.md',
  'references/case-runtime/errors/scene-action.md',
  'references/case-runtime/errors/plan.md',
  'references/case-runtime/errors/flow-result.md',
  'references/case-runtime/errors/knowledge-recovery.md',
  'references/case-runtime/errors/runtime.md',
].sort());
assert.deepStrictEqual(roleEntrypoints('case-executor'), [
  'scripts/case-runtime/agent-facing-client.js',
  'scripts/case-runtime/mcp-server.js',
]);
assert.deepStrictEqual(roleEntrypoints('batch-coordinator'), ['scripts/coordinator-agent.js']);
assert.strictEqual(roleResources('batch-coordinator').includes('prompts/case-agent.md'), false);
assert.strictEqual(roleResources('batch-coordinator')[0], 'SKILL.md');
assert.strictEqual(fs.existsSync(path.join(root, 'prompts/main-agent.md')), false);
assert.strictEqual(COORDINATOR_INTERFACE_KIND, 'AGENT_FACING');
assert.strictEqual(CASE_INTERFACE_KIND, 'AGENT_FACING');
assert.ok(COORDINATOR_CAPABILITIES.includes('read'));
assert.ok(AGENT_FACING_CAPABILITIES.includes('read'));

const casePrompt = read('prompts/case-agent.md');
for (const obsolete of ['UNDERSTAND', 'START_READY', 'allowedDecisions', 'checkpointId', 'turnId']) {
  assert.strictEqual(casePrompt.includes(obsolete), false, `Case Prompt must not expose ${obsolete}`);
}
assert.match(casePrompt, /独立负责 Handoff Loader 返回的.*一个 execution/);
assert.match(casePrompt, /本次用例理解与计划/);
assert.match(casePrompt, /case\.source/);
assert.match(casePrompt, /Case Flow/);
assert.match(casePrompt, /checkNodeRef/);
assert.match(casePrompt, /view_image/);
assert.match(casePrompt, /统一 `read`/);
assert.match(casePrompt, /observe.*inspect.*plan.*recordResult.*act.*runPlan.*knowledge.*recover.*finish/);
assert.match(casePrompt, /动态值只取自当前 Brief、Scene 或响应/);
assert.doesNotMatch(casePrompt, /retryWith|nextCall|technicalContext/);
assert.match(casePrompt, /控件树为空.*不得.*页面空白/);
assert.match(casePrompt, /权限弹窗/);
assert.match(casePrompt, /长按过程/);
assert.match(casePrompt, /inspect\(mode="action"\)/);
assert.match(casePrompt, /previousAction/);
assert.match(casePrompt, /有效技术事实.*BLOCKED.*证据不足.*INCONCLUSIVE/);
assert.match(casePrompt, /首选能力.*不是排他的工具边界/);
assert.strictEqual(casePrompt.includes('Frozen CaseSpec'), false);
assert.strictEqual(casePrompt.includes('"operation": "prepare"'), false);
for (const internalField of ['basedOnSceneId', 'capabilityId', 'inspectVisual', 'inspectScene', 'knowledgeReview', 'contractDefinitions', 'allowedOperations']) {
  assert.strictEqual(casePrompt.includes(internalField), false, `Case Prompt must not expose internal field ${internalField}`);
}
assert.deepStrictEqual(AGENT_OPERATIONS, ['observe', 'act', 'runPlan', 'inspectVisual', 'inspectScene', 'knowledge', 'recover', 'finish', 'status']);
assert.deepStrictEqual(AGENT_OPERATIONS, Object.entries(OPERATION_CONTRACT)
  .filter(([, definition]) => definition.agentAccessible).map(([operation]) => operation));
for (const [operation, definition] of Object.entries(OPERATION_CONTRACT)) {
  assert.deepStrictEqual([...REQUEST_FIELDS[operation]], definition.requestFields);
}
assert.strictEqual(isSupportedBroker({ allowedOperations: AGENT_OPERATIONS }), true);
assert.strictEqual(isSupportedBroker({ allowedOperations: ['observe', 'act', 'knowledge', 'recover', 'finish', 'status'] }), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(runtimeOperationContract, 'BROKER_OPERATION_SETS'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(runtimeBroker, 'LEGACY_AGENT_OPERATIONS'), false);
assert.strictEqual(read('scripts/case-runtime/runtime-operation-contract.js').includes('BROKER_OPERATION_SETS'), false);
assert.strictEqual(read('scripts/coordinator/agent-facing-service.js').includes('COORDINATOR_SCHEMA_VERSION'), false);
assert.match(read('scripts/case-runtime/agent-facing-client.js'), /schemaVersion !== 13/);
assert.strictEqual(read('scripts/report/execution-trace.js').includes('legacyCoordinateAudit'), false);
assert.strictEqual(read('scripts/report/execution-trace.js').includes('event.coordinateAudit'), false);
assert.strictEqual(read('scripts/lib/execution-timing.js').includes('EXECUTION_LEGACY'), false);
for (const hidden of ['CLEAR_APP_DATA', 'REINSTALL_APP', 'artifactPath', 'appiumSessionId']) {
  assert.strictEqual(casePrompt.includes(hidden), false, `Case Prompt must not expose ${hidden}`);
}
const promptRequests = [...casePrompt.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
assert.strictEqual(promptRequests.length, 0, 'Runtime request schemas belong in runtime.capabilities, not the prompt');
assert.match(casePrompt, /stdin.*一次提交.*operation,input/);
for (const request of promptRequests) assert.doesNotThrow(() => validateRuntimeRequest(request));
for (const request of promptRequests) if (request.decision) assert.doesNotThrow(() => validateDecision(request.decision));
assert.doesNotThrow(() => validateDecision({ purpose: '检查结果', expectationRefs: ['E1'] }));
assert.throws(() => validateDecision({ expectationRefs: ['E1'] }),
  (error) => error?.code === 'CASE_NARRATIVE_INVALID' && error.fieldPath === 'decision.purpose');

const mainPrompt = read('SKILL.md');
assert.match(mainPrompt, /你是 Authoring Agent/);
assert.match(mainPrompt, /你是执行协调 Agent/);
assert.strictEqual(mainPrompt.includes('主 Agent'), false);
assert.match(mainPrompt, /NEED_CASE_AGENT/);
assert.match(mainPrompt, /一个用例只保留一个有效写入者/);
assert.strictEqual(mainPrompt.includes('Case Definition Compiler'), false);
assert.match(mainPrompt, /执行协调 Agent 不执行 Case Agent Loader/);
assert.strictEqual(/读取 `prompts\/case-agent\.md`/.test(mainPrompt), false);
assert.match(mainPrompt, /不读取.*Handoff 正文/);
assert.match(mainPrompt, /不继承执行协调 Agent.*上下文/);
assert.match(mainPrompt, /loaderCommand/);
assert.strictEqual(mainPrompt.includes('根据原文整理并审核'), false);
assert.strictEqual(mainPrompt.includes('caseNo + definitionRef'), false);
assert.match(mainPrompt, /prepareRun.*confirmRun.*advanceRun.*cancelRun/);
assert.match(mainPrompt, /仍在运行的会话句柄.*继续等待.*不得重复执行/);
assert.strictEqual(mainPrompt.includes('可重试的报告发布'), false, 'report publication must not keep a run WAITING');
assert.strictEqual(mainPrompt.includes('coordinatorCapabilities'), false);
assert.strictEqual(mainPrompt.includes('batch bootstrap'), false);
assert.strictEqual(mainPrompt.includes('batch start'), false);
assert.match(mainPrompt, /执行协调 Agent.*不执行 Case Agent Loader.*不读取.*Handoff 正文/);
assert.match(mainPrompt, /documentationRef/);
assert.doesNotMatch(mainPrompt, /confirmChoices|confirmTemplate|retryWith|technicalContext\.resume/);
assert.match(mainPrompt, /首选入口.*不是.*排他能力边界/);
assert.strictEqual(fs.existsSync(path.join(root, 'prompts/case-definition-compiler.md')), false);
assert.strictEqual(mainPrompt.includes('allowedDecisions'), false);

const currentReportSource = read('scripts/report/current-report.js');
assert.strictEqual(currentReportSource.includes('report.events'), false, 'Renderer must consume projected ViewModels');
for (const obsolete of ['execution-story', 'checkpoint-accordion', 'process-workspace', 'case-plan-workspace']) {
  assert.strictEqual(currentReportSource.includes(obsolete), false, `Renderer must not retain obsolete ${obsolete} UI`);
}
for (const artifact of ['binding.snapshot.json', 'case.snapshot.json', 'source.snapshot.md', 'logs/', 'action-spatial-evidence/']) {
  assert.ok(read('docs/architecture.md').includes(artifact), `architecture must list ${artifact}`);
}

for (const name of fs.readdirSync(path.join(root, 'scripts/case-runtime')).filter((item) => item.endsWith('.js'))) {
  assert.strictEqual(read(`scripts/case-runtime/${name}`).includes("require('../batch/"), false, `${name} must not depend on Batch`);
}

const lifecycle = require('../case-runtime/lifecycle');
const batchCore = require('../batch/core');
assert.deepStrictEqual(Object.keys(lifecycle).sort(), ['EXECUTION_SCHEMA_VERSION', 'buildContinuationBrief', 'cancelExecution', 'commitExecution', 'createExecution', 'establishInitialState', 'readCompletion', 'reconcileExecution', 'recordAgentContinuation', 'recordTimingAnchor', 'resumeExecution']);
assert.strictEqual(batchCore.BATCH_SCHEMA_VERSION, 8);
assert.strictEqual(Object.prototype.hasOwnProperty.call(lifecycle, 'act'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(batchCore, 'recoverApp'), false);

const batchCoreSource = read('scripts/batch/core.js');
assert.ok(batchCoreSource.split(/\r?\n/).length < 100, 'Batch core must be a small phase facade');
for (const service of [
  'initialization-service.js',
  'dispatch-service.js',
  'completion-service.js',
  'finalization-service.js',
  'reconcile-service.js',
]) {
  assert.strictEqual(fs.existsSync(path.join(root, 'scripts/batch', service)), true, `${service} must own its Batch phase`);
  assert.match(batchCoreSource, new RegExp(service.replace(/\.js$/, '').replace('.', '\\.')));
}
for (const obsolete of ["require('../agent/", "require('../execution/core')", 'recoveryDraft', 'RESUME_RECOVERY']) {
  assert.strictEqual(batchCoreSource.includes(obsolete), false, `Batch must not retain replaced recovery path: ${obsolete}`);
}
assert.strictEqual(read('scripts/case-runtime/lifecycle.js').includes("require('./runtime-broker')"), false,
  'Lifecycle must depend on the pure Runtime operation contract, not Broker');
for (const relative of fs.readdirSync(path.join(root, 'scripts/batch')).filter((name) => name.endsWith('.js'))) {
  const source = read(`scripts/batch/${relative}`);
  assert.strictEqual(/require\(['"]\.\.\/case-runtime\/(?!lifecycle)/.test(source), false, `${relative} must use the Case Runtime lifecycle facade`);
}

const caseContract = buildContract({ skillRoot: root, role: 'case-executor', platform: 'harmony' });
assert.strictEqual(Object.prototype.hasOwnProperty.call(caseContract, 'schemaVersion'), false);
assert.strictEqual(caseContract.implementationFiles.some((file) => file.startsWith('scripts/agent/')), false);
assert.strictEqual(caseContract.implementationFiles.some((file) => file.startsWith('scripts/batch/')), false);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/case-runtime/lifecycle.js'), false);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/platform/prepare-app.sh'), true);
const iosContract = buildContract({ skillRoot: root, role: 'case-executor', platform: 'ios' });
assert.strictEqual(iosContract.implementationFiles.includes('scripts/platform/adapters/ios/lib/input-service.js'), true);
assert.strictEqual(iosContract.implementationFiles.includes('scripts/platform/adapters/ios/lib/pointer-actions.js'), true);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/lib/app-provisioning.js'), true);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/case-runtime/case-model-service.js'), false);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/execution/contracts/case-spec-contract.js'), false);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/execution/contracts/validation-profile-contract.js'), true);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/case-runtime/runtime-operation-contract.js'), true);
assert.strictEqual(caseContract.implementationFiles.includes('scripts/lib/dispatch-lease.js'), true);

const coordinatorContract = buildContract({ skillRoot: root, role: 'batch-coordinator', platform: 'harmony' });
assert.strictEqual(Object.prototype.hasOwnProperty.call(coordinatorContract, 'schemaVersion'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(coordinatorContract.coordinatorFacade, 'schemaVersion'), false);
assert.strictEqual(coordinatorContract.coordinatorFacade.interfaceKind, 'AGENT_FACING');
assert.strictEqual(coordinatorContract.implementationFiles.includes('prompts/case-definition-compiler.md'), false);
assert.strictEqual(coordinatorContract.allowedEntrypoints.includes('scripts/app-artifact.js'), false);
assert.strictEqual(coordinatorContract.implementationFiles.includes('scripts/app-artifact.js'), true);
assert.strictEqual(coordinatorContract.requiredResources.includes('references/knowledge.md'), false);
assert.deepStrictEqual([...coordinatorContract.requiredResources].sort(), [
  'SKILL.md',
  'references/coordinator.md',
  'references/coordinator/resources.md',
  'references/coordinator/methods/read.md',
  'references/coordinator/methods/prepare-run.md',
  'references/coordinator/methods/confirm-run.md',
  'references/coordinator/methods/advance-run.md',
  'references/coordinator/methods/cancel-run.md',
  'references/coordinator/errors.md',
  'references/coordinator/errors/input-state.md',
  'references/coordinator/errors/environment.md',
  'references/coordinator/errors/batch.md',
  'references/coordinator/errors/resources.md',
].sort());
assert.strictEqual(read('references/interfaces.md').includes('## Case Runtime'), false);
for (const retired of ['function caseFlowRanks', 'function renderCaseFlow(', 'function flowViewer(', '.case-flow-', '.flow-viewer']) {
  assert.strictEqual(read('scripts/report/current-report-html.js').includes(retired), false, `retired flow renderer remains: ${retired}`);
}
assert.strictEqual(read('references/interfaces.md').includes('runtime.requestPath'), false);
assert.match(read('references/interfaces.md'), /scripts\/coordinator-agent\.js/);
assert.match(read('references/interfaces.md'), /Authoring 接口/);
assert.match(read('references/interfaces.md'), /scripts\/import-cases\.js/);
assert.match(read('SKILL.md'), /references\/case-authoring\.md/);
assert.match(read('references/case-authoring.md'), /文件(?:名|数量|格式)?.*不是用例边界|文件不是用例边界/);
assert.match(read('references/case-authoring.md'), /完整读取|阅读完整/);
assert.match(read('references/case-authoring.md'), /一条或多条/);
assert.strictEqual(read('SKILL.md').includes('你是本次测试的主 Agent'), false);
assert.strictEqual(read('references/workflow.md').includes('Prompt 和派生 Case Brief 一次性交给'), false);
assert.strictEqual(read('docs/architecture.md').includes('agentRequired=true + derived Case Brief'), false);
assert.strictEqual(read('docs/architecture.md').includes('主 Agent 使用该 Brief'), false);
assert.match(casePrompt, /Handoff Loader/);
assert.match(casePrompt, /checkNodeRefs.*只关联.*直接检查或调查/);
assert.match(casePrompt, /finish.*Runtime 从 ledger 组装完整结果/);
assert.match(casePrompt, /finish.*input\.mode: "complete"/);
assert.match(casePrompt, /input\.mode: "notRun"/);
assert.doesNotMatch(casePrompt, /outcome: "NOT_RUN"|finish` 只提交摘要/);
const implementation = implementationGroups(root, 'harmony');
assert.strictEqual(implementation.coordinator.includes('scripts/knowledge.js'), false);
assert.strictEqual(implementation.report.includes('scripts/execution/contracts/case-definition-contract.js'), false);
assert.strictEqual(implementation.report.includes('scripts/execution/contracts/validation-profile-contract.js'), true);
const platformSpecific = /\b(?:codex|spawn_agent|fork_turns|provider)\b/i;
for (const relative of new Set([...caseContract.requiredResources, ...coordinatorContract.requiredResources])) {
  assert.strictEqual(platformSpecific.test(read(relative)), false, `${relative} must remain Agent-host neutral`);
}
assert.strictEqual(platformSpecific.test(JSON.stringify({ caseContract, coordinatorContract })), false, 'Agent contracts must remain host neutral');

const digestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-digest-boundaries-'));
fs.cpSync(root, digestRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) });
const harmonyBefore = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
const androidBefore = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'android' });
const coordinatorBefore = buildContract({ skillRoot: digestRoot, role: 'batch-coordinator', platform: 'harmony' });

function assertCoordinatorOnlyDigestChange(relative) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-coordinator-digest-boundary-'));
  fs.cpSync(root, fixtureRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) });
  const caseBefore = buildContract({ skillRoot: fixtureRoot, role: 'case-executor', platform: 'harmony' });
  const coordinatorBeforeFixture = buildContract({ skillRoot: fixtureRoot, role: 'batch-coordinator', platform: 'harmony' });
  fs.appendFileSync(path.join(fixtureRoot, relative), '\n// coordinator digest boundary fixture\n');
  const caseAfter = buildContract({ skillRoot: fixtureRoot, role: 'case-executor', platform: 'harmony' });
  const coordinatorAfter = buildContract({ skillRoot: fixtureRoot, role: 'batch-coordinator', platform: 'harmony' });
  assert.notStrictEqual(coordinatorAfter.coordinatorSha, coordinatorBeforeFixture.coordinatorSha, `${relative} must affect coordinatorSha`);
  assert.strictEqual(caseAfter.runtimeSha, caseBefore.runtimeSha, `${relative} must not affect runtimeSha`);
  assert.strictEqual(caseAfter.adapterSha, caseBefore.adapterSha, `${relative} must not affect adapterSha`);
  assert.strictEqual(caseAfter.protocolSha, caseBefore.protocolSha, `${relative} must not affect case protocolSha`);
  assert.strictEqual(coordinatorAfter.protocolSha, coordinatorBeforeFixture.protocolSha, `${relative} must not affect coordinator protocolSha`);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

for (const relative of [
  'scripts/batch/initialization-service.js',
  'scripts/batch/reconcile-service.js',
  'scripts/case-runtime/lifecycle.js',
]) assertCoordinatorOnlyDigestChange(relative);

fs.appendFileSync(path.join(digestRoot, 'references/knowledge.md'), '\nBehavior-bearing knowledge protocol fixture.\n');
const coordinatorAfterKnowledge = buildContract({ skillRoot: digestRoot, role: 'batch-coordinator', platform: 'harmony' });
assert.strictEqual(coordinatorAfterKnowledge.protocolSha, coordinatorBefore.protocolSha);
assert.strictEqual(buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' }).protocolSha, harmonyBefore.protocolSha);
fs.appendFileSync(path.join(digestRoot, 'references/case-runtime/methods/act.md'), '\nActionRef recovery fixture.\n');
const caseAfterDocs = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
assert.notStrictEqual(caseAfterDocs.protocolSha, harmonyBefore.protocolSha);
const coordinatorInterfaceFile = path.join(digestRoot, 'scripts/coordinator/agent-facing-contract.js');
fs.writeFileSync(coordinatorInterfaceFile, fs.readFileSync(coordinatorInterfaceFile, 'utf8')
  .replace('在绑定工作空间中创建一次 run。', '在当前绑定工作空间中创建一次 run。'));
const coordinatorAfterInterface = buildContract({ skillRoot: digestRoot, role: 'batch-coordinator', platform: 'harmony' });
assert.notStrictEqual(coordinatorAfterInterface.protocolSha, coordinatorAfterKnowledge.protocolSha);
assert.strictEqual(buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' }).protocolSha, caseAfterDocs.protocolSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/report/current-report.js'), '\n// renderer digest boundary fixture\n');
const afterReport = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
assert.strictEqual(afterReport.runtimeSha, harmonyBefore.runtimeSha);
assert.strictEqual(afterReport.adapterSha, harmonyBefore.adapterSha);
assert.strictEqual(afterReport.coordinatorSha, coordinatorAfterInterface.coordinatorSha);
assert.notStrictEqual(afterReport.reportRendererSha, harmonyBefore.reportRendererSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/lib/technical-facts.js'), '\n// technical fact digest boundary fixture\n');
const afterTechnicalFacts = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
assert.notStrictEqual(afterTechnicalFacts.runtimeSha, afterReport.runtimeSha);
assert.notStrictEqual(afterTechnicalFacts.reportRendererSha, afterReport.reportRendererSha);
assert.strictEqual(afterTechnicalFacts.adapterSha, afterReport.adapterSha);
fs.appendFileSync(path.join(digestRoot, 'scripts/platform/adapters/harmony/probe.sh'), '\n# adapter digest boundary fixture\n');
const harmonyAfterAdapter = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'harmony' });
const androidAfterAdapter = buildContract({ skillRoot: digestRoot, role: 'case-executor', platform: 'android' });
assert.notStrictEqual(harmonyAfterAdapter.adapterSha, afterTechnicalFacts.adapterSha);
assert.strictEqual(harmonyAfterAdapter.runtimeSha, afterTechnicalFacts.runtimeSha);
assert.strictEqual(harmonyAfterAdapter.coordinatorSha, afterTechnicalFacts.coordinatorSha);
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

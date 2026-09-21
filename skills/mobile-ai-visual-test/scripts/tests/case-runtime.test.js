#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrapBatch, commitCurrentCase, initializeBatch, reconcileBatch, recordFinalizationStep, startCurrentCase } = require('../batch/core');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { buildContract } = require('../build-agent-contract');
const { executeFacadeRequest: run } = require('../case-runtime/runtime-broker');
const { buildContinuationBrief, resumeExecution } = require('../case-runtime/lifecycle');
const { loadAgentHandoff } = require('../batch/agent-handoff');
const { readExecutionReport } = require('../lib/execution-reader');
const { buildExecutionNarrative } = require('../report/execution-narrative');
const { refreshCommittedCaseReports } = require('../report/report-service');
const { acquireFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { claimTokenFor } = require('../lib/dispatch-lease');
const { createTestExecutionRequest, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const T0 = '2026-09-03T10:00:00.000Z';
const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-runtime-')), 'workspace with spaces $literal');
createTestWorkspace(root);
const handoffClaimToken = (handoff) => claimTokenFor(JSON.parse(fs.readFileSync(handoff.path, 'utf8')));
const transientLock = path.join(root, 'runs', 'transient-write.lock');
fs.mkdirSync(path.dirname(transientLock), { recursive: true });
fs.writeFileSync(transientLock, '');
assert.throws(() => acquireFileLock(transientLock), (error) => error?.code === 'EXECUTION_LOCKED');
fs.unlinkSync(transientLock);
fs.mkdirSync(path.join(root, 'knowledge'));
const runtimeKnowledgePath = path.join(root, 'knowledge', 'K-runtime-001.md');
fs.writeFileSync(runtimeKnowledgePath, `# K-runtime-001 页面稳定等待规则

## 适用范围
- App: com.example.runtime
- Platform: harmony
- Page: target

## 可观察现象
当前页面显示异常或仍在加载，但目标 App 保持前台。

## 结论与处理建议
短暂等待后重新观察；目标内容稳定显示时可以继续验证。

## 追溯信息
Runtime 自动化测试夹具。
`);

const sourceText = '进入目标页面，等待页面稳定后确认内容正常显示。';
const caseKey = `ck-${crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 12)}`;
const caseJson = createCaseContract({ caseKey, title: 'Case Runtime 闭环', sourceText, importPath: '/fixture/case.txt' });
const caseDir = path.join(root, 'cases', `runtime__${caseKey}`);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);

const batchId = 'batch-case-runtime';
const binding = {
  platform: 'harmony', deviceId: 'runtime-device', appId: 'com.example.runtime',
  appName: 'Runtime Display Name', entry: 'EntryAbility',
};
const frozenCaseSpec = {
  summary: '等待目标页面稳定并确认目标内容正常显示',
  preconditions: ['目标 App 已启动'],
  expectations: [
    { text: '目标内容正常显示', sourceEvidence: [{ quote: sourceText }] },
    { text: '页面保持在目标 App', sourceEvidence: [{ quote: sourceText }] },
  ],
  ambiguities: [],
};
function caseFlowRevision(baseRevision, actionText, reason) {
  const actionRef = baseRevision === null ? 'N1' : 'N5';
  return {
    baseRevision,
    summary: frozenCaseSpec.summary,
    entryNodeRef: actionRef,
    nodes: [
      { ref: actionRef, type: 'ACTION', text: actionText },
      {
        ref: 'N2', type: 'CHECK', text: frozenCaseSpec.expectations[0].text,
        verificationKind: 'DIRECT_OBSERVATION', sourceBasis: sourceText, requirement: 'REQUIRED',
      },
      {
        ref: 'N3', type: 'CHECK', text: frozenCaseSpec.expectations[1].text,
        verificationKind: 'DIRECT_OBSERVATION', sourceBasis: sourceText, requirement: 'REQUIRED',
      },
      { ref: 'N4', type: 'END', text: '用例完成' },
    ],
    edges: [
      { ref: baseRevision === null ? 'L1' : 'L4', from: actionRef, to: 'N2' },
      { ref: 'L2', from: 'N2', to: 'N3' },
      { ref: 'L3', from: 'N3', to: 'N4' },
    ],
    uncertainties: frozenCaseSpec.ambiguities,
    ...(reason ? { reason } : {}),
  };
}
const contract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }], { now: T0 });
initializeBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, now: T0 });
const adapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 });

const startedResponse = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, executionId: 'execution-runtime-001', now: T0 });
assert.deepStrictEqual(Object.keys(startedResponse).sort(), ['action', 'agentRequired', 'batchId', 'caseKey', 'executionId', 'handoff']);
assert.strictEqual(startedResponse.action, 'DELEGATE_CASE_AGENT');
assert.strictEqual(startedResponse.agentRequired, true);
const startedExecDir = fs.realpathSync(path.join(caseDir, 'platforms', binding.platform, 'executions', startedResponse.executionId));
const started = {
  execDir: startedExecDir,
  execution: JSON.parse(fs.readFileSync(path.join(startedExecDir, 'execution.json'), 'utf8')),
  runtime: JSON.parse(fs.readFileSync(path.join(startedExecDir, 'runtime.json'), 'utf8')),
  brief: loadAgentHandoff({
    workspaceRoot: root,
    handoffPath: startedResponse.handoff.path,
    sha256: startedResponse.handoff.sha256,
    executionId: startedResponse.executionId,
    caseProtocolSha: contract.protocolSha,
    claimToken: handoffClaimToken(startedResponse.handoff),
  }).brief,
};
require('../case-runtime/case-flow-service').revise(started.execDir,
  caseFlowRevision(null, '观察当前页面并等待稳定'), { now: T0 });
assert.strictEqual(started.execution.schemaVersion, 13);
assert.strictEqual(Object.prototype.hasOwnProperty.call(started.brief, 'schemaVersion'), false);
const validationProfile = JSON.parse(fs.readFileSync(path.join(started.execDir, 'validation-profile.snapshot.json'), 'utf8'));
assert.strictEqual(started.execution.validationProfileSha, validationProfile.profileSha);
assert.strictEqual(started.brief.caseFlow, null);
assert.strictEqual(started.brief.caseModel, undefined);
assert.strictEqual(started.brief.case.spec, undefined);
assert.strictEqual(started.request, undefined);
assert.strictEqual(started.brief.case.source, sourceText);
assert.strictEqual(started.brief.scene, null);
assert.strictEqual(path.dirname(started.runtime.entry), started.execDir);
assert.strictEqual(started.brief.runtime.entry, undefined);
assert.deepStrictEqual(Object.keys(started.brief.runtime).sort(), ['command', 'documentation', 'interfaceKind', 'protocol']);
assert.strictEqual(started.brief.runtime.protocol, 'agent-facing');
assert.strictEqual(started.brief.runtime.documentation, 'references/case-runtime.md');
assert.match(started.brief.runtime.command, /--dispatch-sequence 1$/);
assert.strictEqual(started.brief.runtime.commands, undefined);
assert.strictEqual(started.brief.runtime.allowedOperations, undefined);
assert.strictEqual(started.brief.runtime.interfaceKind, 'AGENT_FACING');
assert.strictEqual(started.brief.runtime.capabilities, undefined);
assert.strictEqual(started.brief.runtime.requestPath, undefined);
assert.deepStrictEqual(started.brief.initialState, {
  automaticPreparation: 'NONE',
  currentAppState: 'UNVERIFIED',
  availablePreparation: [
    {
      targetState: 'APP_LOCAL_STATE_EMPTY',
      meaning: '目标 App 本地状态为空',
      authorized: true,
      platformEffect: '清除目标 App 数据并冷启动',
    },
    {
      targetState: 'FRESH_INSTALL',
      meaning: '目标 App 处于首次安装状态',
      authorized: true,
      platformEffect: '清除目标 App 数据并冷启动',
    },
  ],
});
assert.strictEqual(JSON.stringify(started.brief.initialState).includes('KEEP_EXISTING'), false);
assert.strictEqual(started.brief.runtime.contractDefinitions, undefined);
assert.strictEqual(started.brief.investigationCapabilities, undefined);
for (const hidden of ['basedOnSceneId', 'capabilityId', 'contractDefinitions', 'allowedOperations', 'decision.knowledgeReview']) {
  assert.strictEqual(JSON.stringify(started.brief).includes(hidden), false, `Case Brief must not expose ${hidden}`);
}
assert.strictEqual(fs.statSync(started.runtime.entry).mode & 0o111, 0o111);
assert.deepStrictEqual(started.runtime.status, 'READY');
assert.strictEqual(Object.prototype.hasOwnProperty.call(started.runtime.broker, 'schemaVersion'), false);
assert.deepStrictEqual(started.runtime.broker.allowedOperations, ['observe', 'act', 'runPlan', 'inspectVisual', 'inspectScene', 'knowledge', 'recover', 'finish', 'status']);
assert.strictEqual(started.execution.caseProcessingStartedAt, T0);
assert.strictEqual(started.execution.handoffReadyAt, T0);
assert.strictEqual(started.execution.handoffConsumedAt, undefined, 'loader reads the handoff without consuming it');
assert.deepStrictEqual(run(started.execDir, { operation: 'status' }).knowledgeInvestigation, {
  available: true,
  requiredBeforeNegativeConclusion: true,
  pendingReviews: [],
  reviewedExpectationRefs: [],
});
const handoffConsumedAt = JSON.parse(fs.readFileSync(path.join(startedExecDir, 'execution.json'), 'utf8')).handoffConsumedAt;
assert.ok(handoffConsumedAt, 'first Agent Runtime invocation records handoff consumption');
run(started.execDir, { operation: 'status' });
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(startedExecDir, 'execution.json'), 'utf8')).handoffConsumedAt, handoffConsumedAt,
  'handoff consumption anchor is idempotent');
assert.strictEqual(Object.prototype.hasOwnProperty.call(startedResponse, 'item'), false);
writeJsonAtomic(path.join(started.execDir, 'runtime.json'), {
  ...started.runtime,
  broker: { allowedOperations: started.runtime.broker.allowedOperations.slice(0, -1) },
});
assert.throws(
  () => resumeExecution({ executionDir: started.execDir }),
  (error) => error?.code === 'CASE_RUNTIME_BINDING_INVALID',
);
writeJsonAtomic(path.join(started.execDir, 'runtime.json'), started.runtime);
writeJsonAtomic(path.join(started.execDir, 'runtime.json'), started.runtime);
writeJsonAtomic(path.join(started.execDir, 'case-brief.json'), {
  schemaVersion: 2,
  case: { source: 'tampered', spec: { summary: 'tampered' } },
});
const continuationCount = () => fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line)).filter((event) => event.type === 'agentContinuation').length;
const originalLinkSync = fs.linkSync;
fs.linkSync = (source, destination) => {
  if (String(destination).includes(`${path.sep}handoffs${path.sep}`)) {
    throw new Error('simulated immutable handoff write failure');
  }
  return originalLinkSync(source, destination);
};
try {
  assert.throws(() => startCurrentCase({
    workspaceRoot: root,
    batchId,
    implementationSha: contract.implementationSha,
    continuationReason: 'simulated handoff write failure',
    now: T0,
  }), /simulated immutable handoff write failure/);
} finally {
  fs.linkSync = originalLinkSync;
}
assert.strictEqual(continuationCount(), 0);
const continuation = startCurrentCase({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  continuationReason: 'simulated native handle loss',
  now: T0,
});
assert.deepStrictEqual(Object.keys(continuation).sort(), ['action', 'agentRequired', 'batchId', 'caseKey', 'executionId', 'handoff']);
assert.strictEqual(continuation.executionId, started.execution.executionId);
assert.strictEqual(continuation.handoff.path.includes('/2-'), true);
assert.strictEqual(fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line)).at(-1).type, 'agentContinuation');
const resumedPreparedContinuation = startCurrentCase({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  now: T0,
});
assert.deepStrictEqual(resumedPreparedContinuation.handoff, continuation.handoff,
  'retry after a lost response must return the active prepared continuation');
const continuationBrief = loadAgentHandoff({
  workspaceRoot: root,
  handoffPath: continuation.handoff.path,
  sha256: continuation.handoff.sha256,
  executionId: continuation.executionId,
  caseProtocolSha: started.execution.caseProtocolSha,
  claimToken: handoffClaimToken(continuation.handoff),
}).brief;
assert.strictEqual(continuationBrief.mode, 'CONTINUATION');
assert.strictEqual(continuationBrief.continuation.sequence, 2);
assert.strictEqual(continuationBrief.scene, null);
assert.strictEqual(continuationBrief.resumeState.executionStatus, 'RUNNING');
assert.strictEqual(continuationBrief.case.source, sourceText);
assert.strictEqual(continuationBrief.caseFlow.summary, frozenCaseSpec.summary);
assert.strictEqual(continuationBrief.resumeState.caseFlow.revision, 1);
assert.strictEqual(continuationBrief.resumeState.caseModel, undefined);
assert.deepStrictEqual(Object.keys(continuationBrief.runtime).sort(), ['command', 'documentation', 'interfaceKind', 'protocol']);
const replacedWriter = JSON.parse(childProcess.execSync(started.brief.runtime.command, {
  encoding: 'utf8', input: JSON.stringify({ capability: 'observe' }),
}));
assert.strictEqual(replacedWriter.status, 'TECHNICAL');
assert.strictEqual(replacedWriter.code, 'BINDING_INVALID');
assert.match(replacedWriter.documentationRef, /error-binding-invalid$/);
assert.strictEqual(JSON.parse(childProcess.execSync(continuationBrief.runtime.command, {
  encoding: 'utf8', input: JSON.stringify({ capability: 'unknown' }),
})).status, 'INPUT_INVALID');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const continuationWorker = [
  `const { startCurrentCase } = require(${JSON.stringify(path.resolve(__dirname, '../batch/core'))});`,
  `const response = startCurrentCase({ workspaceRoot: ${JSON.stringify(root)}, batchId: ${JSON.stringify(batchId)}, continuationReason: 'simultaneous continuation' });`,
  'process.stdout.write(JSON.stringify(response));',
].join(' ');
const concurrentOutputA = path.join(root, 'continuation-a.json');
const concurrentOutputB = path.join(root, 'continuation-b.json');
const concurrent = childProcess.spawnSync('/bin/sh', ['-c', [
  `${shellQuote(process.execPath)} -e ${shellQuote(continuationWorker)} > ${shellQuote(concurrentOutputA)} & mavt_pid_a=$!`,
  `${shellQuote(process.execPath)} -e ${shellQuote(continuationWorker)} > ${shellQuote(concurrentOutputB)} & mavt_pid_b=$!`,
  'wait "$mavt_pid_a"; mavt_status_a=$?',
  'wait "$mavt_pid_b"; mavt_status_b=$?',
  '[ "$mavt_status_a" -eq 0 ] && [ "$mavt_status_b" -eq 0 ]',
].join('; ')], { encoding: 'utf8' });
assert.strictEqual(concurrent.status, 0, concurrent.stderr);
const concurrentHandoffs = [concurrentOutputA, concurrentOutputB].map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).handoff);
assert.deepStrictEqual(concurrentHandoffs.map((handoff) => Number(path.basename(handoff.path).split('-')[0])).sort((a, b) => a - b), [3, 4]);
assert.strictEqual(continuationCount(), 3);
const activeHandoff = concurrentHandoffs.find((handoff) => path.basename(handoff.path).startsWith('4-'));
const activeBrief = loadAgentHandoff({
  workspaceRoot: root,
  handoffPath: activeHandoff.path,
  sha256: activeHandoff.sha256,
  executionId: started.execution.executionId,
  caseProtocolSha: started.execution.caseProtocolSha,
  claimToken: handoffClaimToken(activeHandoff),
}).brief;
const clientStatus = JSON.parse(childProcess.execSync(activeBrief.runtime.command, {
  cwd: os.tmpdir(), encoding: 'utf8', input: JSON.stringify({ capability: 'observe', unsupported: true }),
}));
assert.strictEqual(clientStatus.status, 'INPUT_INVALID');
assert.strictEqual(JSON.parse(childProcess.execSync(activeBrief.runtime.command, {
  encoding: 'utf8', input: JSON.stringify({ capability: 'unknown' }),
})).status, 'INPUT_INVALID');
const malformedRequest = childProcess.spawnSync(started.runtime.entry, ['--dispatch-sequence', '4'], { encoding: 'utf8', input: '{ malformed json' });
assert.strictEqual(malformedRequest.status, 0);
assert.strictEqual(JSON.parse(malformedRequest.stdout).status, 'INPUT_INVALID');
assert.strictEqual(JSON.parse(childProcess.execSync(activeBrief.runtime.command, {
  encoding: 'utf8', input: JSON.stringify({ capability: 'recover', reason: '' }),
})).status, 'INPUT_INVALID');
const invalidClientCall = childProcess.spawnSync(started.runtime.entry, ['--dispatch-sequence', '4', 'act'], { encoding: 'utf8' });
assert.strictEqual(invalidClientCall.status, 0);
assert.strictEqual(JSON.parse(invalidClientCall.stdout).status, 'INPUT_INVALID');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'WAIT_EXECUTION_RESULT');

let observationCount = 0;
let actionInvocationCount = 0;
function runner(command, args, options) {
  if (options.kind === 'OBSERVE') {
    observationCount += 1;
    const out = args[args.indexOf('--out') + 1];
    const label = args[args.indexOf('--label') + 1];
    const ref = `screenshots/${label}.png`;
    fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(out, ref), PNG);
    return { status: 0, stdout: JSON.stringify({
      schemaVersion: 1,
      type: 'observation',
      platform: binding.platform,
      time: T0,
      device: { id: binding.deviceId },
      app: { appId: binding.appId, inTargetApp: true },
      artifacts: { screenshot: ref, layout: null, logs: [] },
    }), stderr: '' };
  }
  actionInvocationCount += 1;
  const type = args[args.indexOf('--type') + 1];
  const xIndex = args.indexOf('--x');
  const yIndex = args.indexOf('--y');
  const dispatchedPoint = xIndex >= 0 && yIndex >= 0
    ? { x: Number(args[xIndex + 1]), y: Number(args[yIndex + 1]) }
    : null;
  return { status: 0, stdout: JSON.stringify({
    schemaVersion: 2,
    type: 'actionResult',
    platform: binding.platform,
    time: T0,
    device: { id: binding.deviceId },
    app: { appId: binding.appId, inTargetApp: true },
    action: type,
    command: { status: 'ACCEPTED', transport: 'TEST_RUNNER', elapsedMs: 0 },
    deviceExecution: {
      status: 'UNVERIFIED', verification: dispatchedPoint ? 'REQUEST_ECHO' : 'NONE',
      ...(dispatchedPoint ? { dispatchedPoint } : {}), actualTouchPoint: null,
    },
  }), stderr: '' };
}

const caseContext = {
  summary: '等待目标页面稳定并确认目标内容正常显示',
  preconditions: ['目标 App 已启动'],
  expectations: ['目标内容正常显示', '页面保持在目标 App'],
  initialPlan: ['观察当前页面', '等待页面稳定', '验证页面内容和 App 状态'],
  uncertainties: [],
};
const first = run(started.execDir, {
  operation: 'observe',
  decision: {
    purpose: '建立当前页面基线',
    expectationRefs: [],
  },
}, { runner, now: T0 });
assert.strictEqual(first.status, 'SCENE');
assert.strictEqual(first.scene.sceneId, 'scene-0001');
assert.strictEqual(first.scene.evidenceChannels.visual.available, true);
assert.strictEqual(first.scene.evidenceChannels.visual.attachment.mediaType, 'image/png');
assert.strictEqual(first.scene.evidenceChannels.visual.attachment.path, first.scene.screenshot.path);
assert.strictEqual(first.scene.evidenceChannels.layout.available, false);
assert.strictEqual(first.scene.evidenceChannels.layout.inline, false);
assert.strictEqual(first.scene.evidenceChannels.policy, 'COMBINE_VISUAL_AND_LAYOUT');
assert.strictEqual(first.scene.elements, undefined);
assert.strictEqual(first.scene.capabilities, undefined);
assert.deepStrictEqual(first.scene.inspectScene, { operation: 'inspectScene' });
assert.strictEqual(first.scene.inspectScene.views, undefined);
const observationsBeforeInspection = observationCount;
const wait = require('../case-runtime/store').readCurrentScene(started.execDir).capabilities
  .find((capability) => capability.kind === 'wait');
assert.ok(wait);
assert.strictEqual(observationCount, observationsBeforeInspection);
assert.deepStrictEqual(first.narrative.caseContext.expectations.map((item) => item.id), ['N2', 'N3']);
const firstScenePath = path.join(started.execDir, 'scenes', `${first.scene.sceneId}.json`);
const frozenFirstScene = JSON.parse(fs.readFileSync(firstScenePath, 'utf8'));
writeJsonAtomic(firstScenePath, {
  ...frozenFirstScene,
  evidenceChannels: {
    ...first.scene.evidenceChannels,
    visual: {
      ...first.scene.evidenceChannels.visual,
      attachment: { ...first.scene.evidenceChannels.visual.attachment, path: path.join(started.execDir, 'wrong.png') },
    },
  },
});
const mismatchedVisualAttachment = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: first.scene.sceneId,
  decision: {
    purpose: '拒绝不匹配的视觉附件',
    expectationRefs: ['N2'],
    observation: '不应登记错误路径的截图',
  },
}, { now: T0 });
assert.strictEqual(mismatchedVisualAttachment.status, 'TECHNICAL');
assert.strictEqual(mismatchedVisualAttachment.code, 'VISUAL_EVIDENCE_INVALID');
writeJsonAtomic(firstScenePath, frozenFirstScene);
const firstInspection = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: first.scene.sceneId,
  decision: {
    purpose: '记录首屏截图视觉检查',
    expectationRefs: ['N2'],
    observation: '截图显示目标 App 页面',
  },
}, { now: T0 });
assert.strictEqual(firstInspection.status, 'VISUAL_INSPECTED');
assert.strictEqual(firstInspection.scene.sceneId, first.scene.sceneId);
assert.strictEqual(firstInspection.visualInspection.sceneId, first.scene.sceneId);
const firstInspectionDecision = require('../case-runtime/store').events(started.execDir)
  .find((event) => event.type === 'agentDecisionRecorded' && event.decision?.purpose === '记录首屏截图视觉检查');
assert.deepStrictEqual(firstInspectionDecision.decisionFieldSources, {
  assessment: 'NOT_PROVIDED',
  observation: 'AGENT_AUTHORED',
  conclusion: 'NOT_PROVIDED',
  purpose: 'AGENT_AUTHORED',
  expectedOutcome: 'NOT_PROVIDED',
  expectationRefs: 'AGENT_AUTHORED',
  knowledgeReview: 'NOT_PROVIDED',
  uncertainties: 'NOT_PROVIDED',
});
const duplicateInspection = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: first.scene.sceneId,
  decision: {
    purpose: '重复确认首屏截图',
    expectationRefs: ['N2'],
    observation: '截图仍显示目标 App 页面',
  },
}, { now: T0 });
assert.strictEqual(duplicateInspection.status, 'VISUAL_INSPECTED');
assert.strictEqual(duplicateInspection.idempotent, undefined);
assert.notStrictEqual(duplicateInspection.visualInspection.inspectionId, firstInspection.visualInspection.inspectionId);
assert.deepStrictEqual(
  require('../case-runtime/narrative-service').latestCaseContext(started.execDir).expectations.map((item) => item.id),
  ['N2', 'N3'],
);
const currentSceneId = () => JSON.parse(fs.readFileSync(path.join(started.execDir, 'current-scene.json'), 'utf8')).sceneId;
const eventsBeforeInvalidNarrative = require('../case-runtime/store').events(started.execDir).length;
const invalidVisualNarrative = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: currentSceneId(),
  decision: {
    purpose: '拒绝未知验证点的视觉登记',
    expectationRefs: ['N999'],
    observation: '该视觉登记不应落盘',
  },
}, { now: T0 });
assert.strictEqual(invalidVisualNarrative.status, 'REQUEST_INVALID');
assert.strictEqual(invalidVisualNarrative.code, 'CASE_NARRATIVE_INVALID');
assert.strictEqual(require('../case-runtime/store').events(started.execDir).length, eventsBeforeInvalidNarrative);

const invalidKnowledgeNarrative = run(started.execDir, {
  operation: 'knowledge',
  basedOnSceneId: currentSceneId(),
  query: '该查询不应执行',
  decision: {
    purpose: '拒绝未知验证点的知识查询',
    expectationRefs: ['N999'],
  },
}, { now: T0 });
assert.strictEqual(invalidKnowledgeNarrative.status, 'REQUEST_INVALID');
assert.strictEqual(invalidKnowledgeNarrative.code, 'CASE_NARRATIVE_INVALID');
assert.strictEqual(require('../case-runtime/store').events(started.execDir).length, eventsBeforeInvalidNarrative);
const knowledge = run(started.execDir, {
  operation: 'knowledge',
  basedOnSceneId: currentSceneId(),
  query: '当前页面显示异常',
  decision: {
    observation: '当前页面信息不足以解释显示状态',
    conclusion: '查询本地经验以辅助判断',
    purpose: '调查可能的页面显示异常',
    expectedOutcome: '获得与当前现象相关的本地经验',
    expectationRefs: ['N2'],
  },
}, { now: T0 });
assert.strictEqual(knowledge.status, 'KNOWLEDGE');
assert.ok(Array.isArray(knowledge.candidates));
assert.strictEqual(knowledge.candidates[0].entryId, 'K-runtime-001');
assert.strictEqual(knowledge.context.app, 'com.example.runtime');
assert.strictEqual(knowledge.filterDiagnostics, null);
assert.strictEqual(knowledge.requiredReview.fieldPath, 'decision.knowledgeReview');
assert.strictEqual(knowledge.requiredReview.required, true);
assert.strictEqual(knowledge.requiredReview.template.queryId, knowledge.queryId);
assert.strictEqual(knowledge.requiredReview.template.conclusion, 'NO_APPLICABLE');
assert.deepStrictEqual(knowledge.requiredReview.template.assessments, [{
  entryId: 'K-runtime-001',
  status: 'NOT_APPLICABLE',
  reason: '<explain why this candidate is or is not applicable>',
}]);
const pendingReviewBrief = buildContinuationBrief({
  executionDir: started.execDir,
  reason: 'verify pending knowledge review contract',
});
assert.strictEqual(pendingReviewBrief.resumeState.pendingKnowledgeReviews[0].queryId, knowledge.queryId);
assert.strictEqual(pendingReviewBrief.resumeState.pendingKnowledgeReviews[0].query, '当前页面显示异常');
assert.deepStrictEqual(pendingReviewBrief.resumeState.pendingKnowledgeReviews[0].checkNodeRefs, ['N2']);
assert.strictEqual(pendingReviewBrief.resumeState.pendingKnowledgeReviews[0].expectationRefs, undefined);
assert.strictEqual(pendingReviewBrief.resumeState.pendingKnowledgeReviews[0].candidates[0].entryId, 'K-runtime-001');
assert.strictEqual(pendingReviewBrief.resumeState.pendingKnowledgeReviews[0].nextCall, undefined);
assert.strictEqual(JSON.stringify(pendingReviewBrief).includes('decision.knowledgeReview'), false);
assert.strictEqual(knowledge.knowledgeInvestigation.pendingReviews[0].queryId, knowledge.queryId);
assert.strictEqual(knowledge.knowledgeInvestigation.pendingReviews[0].candidates[0].entryId, 'K-runtime-001');
assert.deepStrictEqual(knowledge.knowledgeInvestigation.pendingReviews[0].requiredReview, knowledge.requiredReview);
fs.unlinkSync(runtimeKnowledgePath);
fs.writeFileSync(path.join(root, 'knowledge', 'K-other-app-001.md'), `# K-other-app-001 其他应用页面规则

## 适用范围
- App: com.example.other
- Platform: harmony

## 可观察现象
目标内容未显示。

## 结论与处理建议
重新观察其他应用页面。

## 追溯信息
Runtime 自动化测试夹具。
`);
const knowledgeMiss = run(started.execDir, {
  operation: 'knowledge',
  basedOnSceneId: currentSceneId(),
  query: '目标内容未显示',
  decision: {
    observation: '当前目标内容仍未显示',
    conclusion: '需要确认是否存在已知应用规则',
    purpose: '验证知识过滤诊断',
    expectedOutcome: '记录未命中的具体原因',
    expectationRefs: ['N3'],
  },
}, { now: T0 });
assert.strictEqual(knowledgeMiss.candidates.length, 0);
assert.strictEqual(knowledgeMiss.requiredReview, null);
assert.strictEqual(knowledgeMiss.filterDiagnostics.excludedBy.app, 1);
const knowledgeMissEvent = fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map(JSON.parse)
  .find((event) => event.type === 'knowledgeQueried' && event.queryId === knowledgeMiss.queryId);
assert.strictEqual(knowledgeMissEvent.context.app, 'com.example.runtime');
assert.strictEqual(knowledgeMissEvent.filterDiagnostics.rejected[0].entryId, 'K-other-app-001');
const eventsBeforeInvalidKnowledgeReview = require('../case-runtime/store').events(started.execDir).length;
const actionsBeforeInvalidKnowledgeReview = actionInvocationCount;
const invalidKnowledgeReview = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: wait.id,
  decision: {
    purpose: '拒绝引用不存在查询的知识复核',
    expectationRefs: ['N2'],
    knowledgeReview: {
      queryId: 'query-9999',
      conclusion: 'NO_APPLICABLE',
      assessments: [],
    },
  },
}, { runner, now: '2026-09-03T10:00:00.450Z' });
assert.strictEqual(invalidKnowledgeReview.status, 'REQUEST_INVALID');
assert.strictEqual(invalidKnowledgeReview.code, 'CASE_NARRATIVE_INVALID');
assert.strictEqual(actionInvocationCount, actionsBeforeInvalidKnowledgeReview);
assert.strictEqual(require('../case-runtime/store').events(started.execDir).length, eventsBeforeInvalidKnowledgeReview);

const actionInvocationsBeforeSceneGuard = actionInvocationCount;
const missingSceneBasis = run(started.execDir, {
  operation: 'act',
  capabilityId: wait.id,
}, { runner, now: '2026-09-03T10:00:00.500Z' });
assert.strictEqual(missingSceneBasis.status, 'REQUEST_INVALID');
assert.strictEqual(missingSceneBasis.code, 'CASE_RUNTIME_REQUEST_INVALID');
assert.strictEqual(actionInvocationCount, actionInvocationsBeforeSceneGuard);

const invalidRecover = run(started.execDir, {
  operation: 'recover', basedOnSceneId: '', reason: 42, unexpected: true,
}, { now: '2026-09-03T10:00:00.550Z' });
assert.strictEqual(invalidRecover.status, 'REQUEST_INVALID');
assert.deepStrictEqual(invalidRecover.issues.map((issue) => issue.fieldPath).sort(), [
  'basedOnSceneId', 'reason', 'unexpected',
]);
assert.deepStrictEqual(invalidRecover.allowedFields,
  ['operation', 'basedOnSceneId', 'reason', 'decision', 'externalAction', 'flowContext']);
assert.deepStrictEqual(invalidRecover.requiredFields,
  ['operation', 'reason']);
assert.strictEqual(invalidRecover.example.operation, 'recover');

const ambiguousTarget = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: wait.id,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
}, { runner, now: '2026-09-03T10:00:00.600Z' });
assert.strictEqual(ambiguousTarget.status, 'REQUEST_INVALID');
assert.strictEqual(ambiguousTarget.issues.some((issue) => issue.code === 'EXACTLY_ONE_REQUIRED'), true);
assert.strictEqual(ambiguousTarget.issues.some((issue) => issue.fieldPath === 'decision' && issue.code === 'REQUIRED'), true);
assert.strictEqual(actionInvocationCount, actionInvocationsBeforeSceneGuard);

require('../case-runtime/case-flow-service').revise(started.execDir,
  caseFlowRevision(1, '等待页面稳定', '当前页面已是目标页，无需导航'),
  { now: '2026-09-03T10:00:00.900Z' });

const second = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: wait.id,
  decision: {
    observation: '页面已经打开但仍需等待稳定',
    conclusion: '可以执行短暂等待后验证最终状态',
    purpose: '等待页面稳定',
    expectedOutcome: '目标内容保持可见且 App 状态正常',
    expectationRefs: ['N2', 'N3'],
    knowledgeReview: {
      queryId: knowledge.queryId,
      conclusion: 'APPLICABLE_FOUND',
      assessments: [{
        entryId: 'K-runtime-001', status: 'APPLICABLE',
        reason: '当前为 HarmonyOS 目标 App，等待稳定后复核符合条目建议',
      }],
    },
  },
}, { runner, now: '2026-09-03T10:00:01.000Z' });
assert.strictEqual(second.status, 'SCENE');
assert.strictEqual(second.action.lifecycle.status, 'COMPLETED');
assert.strictEqual(second.action.command.status, 'ACCEPTED');
assert.strictEqual(second.action.deviceExecution.status, 'UNVERIFIED');
assert.strictEqual(second.action.observedEffect, undefined);
assert.deepStrictEqual(second.action.evidence.sceneRefs, { before: 'scene-0001', after: 'scene-0002' });
assert.deepStrictEqual(second.action.evidence.screenshotRefs, [
  'screenshots/observation-0001.png',
  'screenshots/observation-0002.png',
]);
assert.strictEqual(second.scene.sceneId, 'scene-0002');
assert.strictEqual(observationCount, 2);
const narrativeStatus = run(started.execDir, { operation: 'status' });
assert.strictEqual(narrativeStatus.narrative.contextVersion, 2);
assert.strictEqual(narrativeStatus.narrative.latestPlan.version, 2);
assert.strictEqual(narrativeStatus.narrative.lastDecision.decision.purpose, '等待页面稳定');
assert.deepStrictEqual(narrativeStatus.knowledgeInvestigation.pendingReviews, []);
assert.deepStrictEqual(narrativeStatus.knowledgeInvestigation.reviewedExpectationRefs, ['N2', 'N3']);
const actionInvocationsBeforePartialNarrative = actionInvocationCount;
const secondWait = require('../case-runtime/store').readCurrentScene(started.execDir).capabilities
  .find((capability) => capability.kind === 'wait');
const partialNarrative = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: secondWait.id,
  decision: {
    observation: '页面仍在目标 App 内',
    conclusion: '继续短暂等待以确认稳定性',
    purpose: '继续观察页面稳定性',
    expectationRefs: ['N2'],
  },
}, { runner, now: '2026-09-03T10:00:01.050Z' });
assert.strictEqual(partialNarrative.status, 'SCENE');
assert.strictEqual(actionInvocationCount, actionInvocationsBeforePartialNarrative + 1);
assert.strictEqual(partialNarrative.narrative.warnings.length, 0);
const historicalInspection = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: first.scene.sceneId,
  decision: {
    purpose: '补查历史 Scene 截图',
    expectationRefs: ['N2'],
    observation: '历史截图显示目标 App 页面',
  },
}, { now: '2026-09-03T10:00:01.050Z' });
assert.strictEqual(historicalInspection.status, 'VISUAL_INSPECTED');
assert.strictEqual(historicalInspection.idempotent, undefined);
assert.strictEqual(historicalInspection.visualInspection.sceneId, first.scene.sceneId);
assert.strictEqual(historicalInspection.scene.sceneId, partialNarrative.scene.sceneId);
const stale = run(started.execDir, {
  operation: 'act', basedOnSceneId: currentSceneId(), capabilityId: wait.id,
  decision: { purpose: '验证过期能力会被拒绝', expectationRefs: ['N2'] },
}, { runner, now: '2026-09-03T10:00:01.100Z' });
assert.strictEqual(stale.status, 'SCENE_CHANGED');
assert.strictEqual(stale.scene.sceneId, partialNarrative.scene.sceneId);

let restartCount = 0;
const recovered = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '用例要求重新建立 App 起点' }, {
  runner,
  now: '2026-09-03T10:00:01.500Z',
  restartApp: () => {
    restartCount += 1;
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
});
assert.strictEqual(recovered.status, 'SCENE');
assert.strictEqual(recovered.recovery.generation, 2);
const recoveredInspection = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: recovered.scene.sceneId,
  decision: {
    purpose: '检查恢复后的截图',
    expectationRefs: ['N2', 'N3'],
    observation: '恢复后页面显示目标内容且目标 App 保持前台',
  },
}, { now: '2026-09-03T10:00:01.510Z' });
assert.strictEqual(recoveredInspection.status, 'VISUAL_INSPECTED');
assert.strictEqual(require('../case-runtime/store').events(started.execDir)
  .find((event) => event.sceneId === recovered.scene.sceneId).relatedOperationId, recovered.recovery.operationId);
assert.strictEqual(recovered.narrative.warnings.length, 0);
assert.strictEqual(restartCount, 1);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'runs', batchId, 'batch.json'), 'utf8')).warmSession.generation, 2);

const interruptedRecovery = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '验证恢复事务可续写' }, {
  runner,
  now: '2026-09-03T10:00:01.600Z',
  interruptAfter: 'generation',
  restartApp: () => {
    restartCount += 1;
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
});
assert.strictEqual(interruptedRecovery.status, 'TECHNICAL');
assert.match(interruptedRecovery.message, /MAVT_CASE_RECOVERY_INTERRUPTED/);
assert.match(interruptedRecovery.technicalFactRef, /^technical-fact-\d{4}$/);
const resumedRecovery = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '验证恢复事务可续写' }, {
  runner,
  now: '2026-09-03T10:00:01.700Z',
  restartApp: () => {
    restartCount += 1;
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
});
assert.strictEqual(resumedRecovery.status, 'RECOVERY_APPLIED');
assert.strictEqual(resumedRecovery.requiresReassessment, true);
assert.strictEqual(resumedRecovery.recoveredTransactions[0].status, 'SUCCEEDED');
assert.strictEqual(restartCount, 2);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'runs', batchId, 'batch.json'), 'utf8')).warmSession.generation, 3);

let unknownRestartCount = 0;
const unknownRecovery = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '模拟重启结果未知' }, {
  runner,
  now: '2026-09-03T10:00:01.750Z',
  restartApp: () => {
    unknownRestartCount += 1;
    throw new Error('simulated transport interruption');
  },
});
assert.strictEqual(unknownRecovery.status, 'TECHNICAL');
const observedUnknownRecovery = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '模拟重启结果未知' }, {
  runner,
  now: '2026-09-03T10:00:01.800Z',
  restartApp: () => {
    unknownRestartCount += 1;
    throw new Error('must not replay restart');
  },
});
assert.strictEqual(observedUnknownRecovery.status, 'RECOVERY_APPLIED');
assert.strictEqual(observedUnknownRecovery.recoveredTransactions[0].status, 'UNKNOWN');
assert.strictEqual(unknownRestartCount, 1);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'recovery.draft.json')), false);

const failedRecovery = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '模拟明确恢复失败' }, {
  runner,
  now: '2026-09-03T10:00:01.850Z',
  restartApp: () => ({
    ok: false,
    coldStartVerified: false,
    startupDisplayVerified: false,
    reason: 'simulated restart failure',
  }),
});
assert.strictEqual(failedRecovery.status, 'TECHNICAL');
assert.strictEqual(failedRecovery.code, 'APP_RECOVERY_FAILED');
assert.match(failedRecovery.technicalFactRef, /^technical-fact-\d{4}$/);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'recovery.draft.json')), false);

let resumedDeviceResultCount = 0;
const interruptedDeviceResult = run(started.execDir, { operation: 'recover', basedOnSceneId: currentSceneId(), reason: '验证下一次调用自动续写恢复' }, {
  runner,
  now: '2026-09-03T10:00:01.875Z',
  interruptAfter: 'device-result',
  restartApp: () => {
    resumedDeviceResultCount += 1;
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
});
assert.strictEqual(interruptedDeviceResult.status, 'TECHNICAL');
const afterAutomaticRecovery = run(started.execDir, {
  operation: 'observe',
  decision: {
    purpose: '确认自动恢复后的页面状态',
    expectationRefs: ['N2', 'N3'],
  },
}, {
  runner,
  now: '2026-09-03T10:00:01.900Z',
  restartApp: () => {
    resumedDeviceResultCount += 1;
    throw new Error('must not replay restart');
  },
});
assert.strictEqual(afterAutomaticRecovery.status, 'RECOVERY_APPLIED');
assert.strictEqual(afterAutomaticRecovery.requiresReassessment, true);
require('../case-runtime/case-flow-service').revise(started.execDir,
  caseFlowRevision(2, '确认恢复后的页面状态', '恢复后按当前现场收敛执行路径'),
  { now: '2026-09-03T10:00:01.910Z' });
const afterRecoveryObserve = run(started.execDir, {
  operation: 'observe',
  decision: {
    purpose: '观察恢复后的页面',
    expectationRefs: ['N2', 'N3'],
  },
}, { runner, now: '2026-09-03T10:00:01.925Z' });
assert.strictEqual(afterRecoveryObserve.status, 'SCENE');
assert.strictEqual(afterRecoveryObserve.narrative.contextVersion, 3);
assert.strictEqual(afterRecoveryObserve.narrative.latestPlan.version, 3);
assert.deepStrictEqual(afterRecoveryObserve.narrative.latestPlan.nodes.map((item) => item.ref), ['N5', 'N2', 'N3', 'N4']);
assert.deepStrictEqual(afterRecoveryObserve.narrative.caseContext.expectations.map((item) => item.id), ['N2', 'N3']);
assert.strictEqual(afterRecoveryObserve.narrative.warnings.length, 0);
assert.strictEqual(resumedDeviceResultCount, 1);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'runs', batchId, 'batch.json'), 'utf8')).warmSession.generation, 4);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'recovery.draft.json')), false);

const spatialAction = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  visual: { gesture: 'tap', point: [0, 0] },
  decision: {
    observation: '当前现场左上角可作为无副作用测试位置',
    conclusion: '执行一次视觉点击以检查 Runtime 返回证据',
    purpose: '验证动作空间证据闭环',
    expectedOutcome: '返回请求点、投递点和带底图的标注附件',
    expectationRefs: [],
  },
}, { runner, now: '2026-09-03T10:00:01.950Z' });
assert.strictEqual(spatialAction.status, 'SCENE');
assert.strictEqual(spatialAction.action.spatialEvidence.certainty, 'DISPATCH_ONLY');
assert.deepStrictEqual(spatialAction.action.spatialEvidence.requested.point, { x: 0, y: 0 });
assert.deepStrictEqual(spatialAction.action.spatialEvidence.dispatched.point, { x: 0, y: 0 });
assert.strictEqual(spatialAction.action.spatialEvidence.deviceActual, null);
assert.strictEqual(spatialAction.action.spatialEvidence.annotatedScreenshot.attachment.mediaType, 'image/png');
assert.strictEqual(spatialAction.action.spatialEvidence.annotatedScreenshot.tool, 'view_image');
assert.strictEqual(fs.existsSync(spatialAction.action.spatialEvidence.annotatedScreenshot.path), true);
const spatialOperationId = spatialAction.action.operationId;
const spatialEvent = require('../case-runtime/store').events(started.execDir)
  .find((event) => event.type === 'actionCompleted' && event.operationId === spatialOperationId);
assert.strictEqual(spatialEvent.spatialEvidenceRef, `action-spatial-evidence/${spatialOperationId}.json`);
assert.strictEqual(spatialEvent.spatialEvidence, undefined);
assert.strictEqual(spatialEvent.coordinateAudit, undefined);
const spatialOperation = JSON.parse(fs.readFileSync(path.join(started.execDir, 'operations', `${spatialOperationId}.json`), 'utf8'));
assert.strictEqual(spatialOperation.spatialEvidenceRef, spatialEvent.spatialEvidenceRef);
assert.strictEqual(spatialOperation.actionResult.spatialEvidenceRef, spatialEvent.spatialEvidenceRef);
assert.strictEqual(spatialOperation.actionResult.spatialEvidence, undefined);
const spatialInspection = run(started.execDir, {
  operation: 'inspectScene',
  basedOnSceneId: currentSceneId(),
  view: 'ACTION',
  observation: '标注落点位于目标区域左上方，需要调整后续操作位置',
  expectationRefs: ['N2'],
}, { now: '2026-09-03T10:00:01.960Z' });
assert.strictEqual(spatialInspection.status, 'ACTION_SPATIAL_INSPECTED');
const spatialInspectionEvent = require('../case-runtime/store').events(started.execDir)
  .find((event) => event.type === 'actionSpatialInspected' && event.operationId === spatialOperationId);
assert.strictEqual(spatialInspectionEvent.caseFlowRevision, 3);
const revisedAfterSpatialInspection = require('../case-runtime/case-flow-service').revise(started.execDir,
  caseFlowRevision(3, '根据落点标注修正操作位置', '上一动作标注图显示落点偏离目标区域'),
  { now: '2026-09-03T10:00:01.970Z' });
assert.strictEqual(revisedAfterSpatialInspection.caseFlow.revision, 4);

const timedOut = run(started.execDir, { operation: 'observe' }, { runner, now: '2026-09-03T10:30:00.000Z' });
assert.strictEqual(timedOut.status, 'TIME_LIMIT');
assert.strictEqual(timedOut.scene.sceneId, spatialAction.scene.sceneId);
assert.match(timedOut.technicalFactRef, /^technical-fact-\d{4}$/);

const eventCount = fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8').trim().split('\n').length;
const malformed = run(started.execDir, { operation: 'act' });
assert.strictEqual(malformed.status, 'REQUEST_INVALID');
assert.strictEqual(fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8').trim().split('\n').length, eventCount);
const result = {
  verdict: 'PASS',
  summary: '页面在等待后保持正常显示',
  checks: [
    { checkNodeRef: 'N2', status: 'PASS', actual: '目标内容在稳定后的页面中正常显示', sceneRefs: [recovered.scene.sceneId], knowledgeRefs: ['K-runtime-001'] },
    { checkNodeRef: 'N3', status: 'PASS', actual: '页面保持在目标 App 且截图可用', sceneRefs: [recovered.scene.sceneId] },
  ],
  uncertainties: [],
};
const uninspectedResult = {
  ...result,
  checks: result.checks.map((check) => ({
    ...check,
    sceneRefs: [spatialAction.scene.sceneId],
    knowledgeRefs: check.checkNodeRef === 'N2' ? ['K-runtime-001'] : [],
  })),
};
const finishWithoutVisualInspection = run(started.execDir, {
  operation: 'finish', basedOnSceneId: currentSceneId(), result: uninspectedResult,
}, { now: '2026-09-03T10:00:02.000Z' });
assert.strictEqual(finishWithoutVisualInspection.status, 'RESULT_INCOMPLETE');
assert.ok(finishWithoutVisualInspection.missing.some((item) => item.field === `scenes.${spatialAction.scene.sceneId}.visualInspection`));
const timedOutInspection = run(started.execDir, {
  operation: 'inspectVisual',
  basedOnSceneId: currentSceneId(),
  decision: {
    purpose: '在设备动作超时后补充截图检查',
    expectationRefs: ['N2', 'N3'],
    observation: '截图仍可用于已有 Scene 的业务判断',
  },
}, { now: '2026-09-03T10:30:00.100Z' });
assert.strictEqual(timedOutInspection.status, 'VISUAL_INSPECTED');
const emptyPass = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), result: { ...result, checks: [] } }, { now: '2026-09-03T10:00:01.900Z' });
assert.strictEqual(emptyPass.code, 'CASE_RESULT_CHECKS_REQUIRED');
const passWithFail = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), result: {
  ...result,
  checks: [{ ...result.checks[0], status: 'FAIL' }, result.checks[1]],
} }, { now: '2026-09-03T10:00:01.900Z' });
assert.strictEqual(passWithFail.code, 'CASE_RESULT_VERDICT_MISMATCH');
const passWithoutEvidence = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), result: {
  ...result,
  checks: [{ ...result.checks[0], sceneRefs: [] }, result.checks[1]],
} }, { now: '2026-09-03T10:00:01.900Z' });
assert.strictEqual(passWithoutEvidence.code, 'CASE_RESULT_EVIDENCE_REQUIRED');
const unknownScene = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), result: {
  ...result,
  checks: [{ ...result.checks[0], sceneRefs: ['scene-9999'] }, result.checks[1]],
} }, { now: '2026-09-03T10:00:01.900Z' });
assert.strictEqual(unknownScene.status, 'TECHNICAL');
assert.strictEqual(unknownScene.code, 'CASE_RESULT_SCENE_UNKNOWN');
const uncoveredExpectation = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), result: {
  ...result,
  checks: [result.checks[0]],
} }, { now: '2026-09-03T10:00:01.900Z' });
assert.strictEqual(uncoveredExpectation.status, 'RESULT_INCOMPLETE');
assert.strictEqual(uncoveredExpectation.code, 'CASE_RESULT_INCOMPLETE');
assert.ok(uncoveredExpectation.missing.some((item) => item.field === 'checks.N3'));
const actionsBeforePendingRecovery = actionInvocationCount;
writeJsonAtomic(path.join(started.execDir, 'transactions', 'action-9000.draft.json'), {
  schemaVersion: 1,
  operationId: 'action-9000',
  status: 'DISPATCHED',
  sceneId: recovered.scene.sceneId,
  action: { type: 'wait', ms: 100 },
});
const finishDecision = {
  observation: '等待后目标内容仍然显示，App 保持前台',
  conclusion: 'E1 和 E2 均有当前 Scene 支持，可以判定通过',
  purpose: '完成用例并提交结论',
  expectedOutcome: '全部验证点都有明确结果和现场证据',
  expectationRefs: ['N2', 'N3'],
};
const recoveryBeforeFinish = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), decision: finishDecision, result }, {
  now: '2026-09-03T10:00:01.950Z', runner,
});
assert.strictEqual(recoveryBeforeFinish.status, 'RECOVERY_APPLIED');
assert.strictEqual(actionInvocationCount, actionsBeforePendingRecovery);
const interruptedFinish = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), decision: finishDecision, result }, {
  now: '2026-09-03T10:00:02.000Z',
  runner,
  interruptAfter: 'execution',
});
assert.strictEqual(interruptedFinish.status, 'TECHNICAL');
assert.match(interruptedFinish.message, /MAVT_CASE_FINISH_INTERRUPTED/);
assert.match(interruptedFinish.technicalFactRef, /^technical-fact-\d{4}$/);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'execution.json'), 'utf8')).finalized, true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'runtime.json'), 'utf8')).status, 'READY');
assert.strictEqual(actionInvocationCount, actionsBeforePendingRecovery);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'action-9000.draft.json')), false);
const finalizedRetry = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, now: T0 });
assert.deepStrictEqual(finalizedRetry, {
  action: 'CASE_ALREADY_FINISHED',
  agentRequired: false,
  batchId,
  caseKey,
  executionId: started.execution.executionId,
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'COMMIT_CASE');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'runtime.json'), 'utf8')).status, 'COMPLETED');
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'finish.draft.json')), false);
const finished = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), decision: finishDecision, result }, { now: '2026-09-03T10:00:02.500Z' });
assert.strictEqual(finished.status, 'COMPLETED');
assert.strictEqual(finished.idempotent, true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'result.json'), 'utf8')).caseFlowRevision, 4);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'metrics.json'), 'utf8')).elapsedMs, 2000);
assert.strictEqual(run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), decision: finishDecision, result }).idempotent, true);
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'COMMIT_CASE');

const runtimeMetrics = JSON.parse(fs.readFileSync(path.join(started.execDir, 'metrics.json'), 'utf8'));
for (const field of ['totalElapsedMs', 'runtimeActiveMs', 'adapterActiveMs', 'actionDeviceMs', 'observationCaptureMs', 'postActionSettleMs', 'explicitWaitMs', 'knowledgeQueryMs', 'recoveryMs', 'agentAndSchedulingGapMs', 'invocationCount', 'invocationErrorCount']) {
  assert.strictEqual(Number.isFinite(runtimeMetrics[field]), true, `metrics.${field} must be numeric`);
}
assert.ok(runtimeMetrics.invocationCount > 0);
assert.ok(runtimeMetrics.invocationErrorCount > 0);
assert.ok(runtimeMetrics.knowledgeUsage.queryIds.includes(knowledge.queryId));
assert.ok(runtimeMetrics.knowledgeUsage.reviewedQueryIds.includes(knowledge.queryId));
assert.ok(runtimeMetrics.knowledgeUsage.applicableEntryIds.includes('K-runtime-001'));
assert.strictEqual(runtimeMetrics.counts.caseContextRevisions, 4);
assert.ok(runtimeMetrics.counts.agentDecisions >= 3);
assert.strictEqual(runtimeMetrics.totalElapsedMs, runtimeMetrics.runtimeActiveMs + runtimeMetrics.agentAndSchedulingGapMs);
assert.strictEqual(runtimeMetrics.agentAndSchedulingGapMs,
  runtimeMetrics.agentTiming.firstPreparationMs + runtimeMetrics.agentTiming.stepDecisionMs
  + runtimeMetrics.agentTiming.conclusionPreparationMs + runtimeMetrics.agentTiming.unclassifiedGapMs);
assert.strictEqual(runtimeMetrics.runtimeActiveMs,
  runtimeMetrics.actionDeviceMs + runtimeMetrics.observationCaptureMs + runtimeMetrics.postActionSettleMs
  + runtimeMetrics.explicitWaitMs + runtimeMetrics.knowledgeQueryMs + runtimeMetrics.recoveryControlMs
  + runtimeMetrics.runtimeOverheadMs);

const knowledgeSnapshotPath = path.join(started.execDir, knowledge.candidates[0].snapshotRef);
const frozenKnowledge = fs.readFileSync(knowledgeSnapshotPath, 'utf8');
fs.appendFileSync(knowledgeSnapshotPath, '\nchanged after review\n');
assert.throws(() => commitCurrentCase({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  now: '2026-09-03T10:00:02.900Z',
}), (error) => error.code === 'KNOWLEDGE_SNAPSHOT_CHANGED');
fs.writeFileSync(knowledgeSnapshotPath, frozenKnowledge);

const hashCounts = new Map();
const committed = commitCurrentCase({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  now: '2026-09-03T10:00:03.000Z',
  hashFile: (file) => {
    const absolute = path.resolve(file);
    hashCounts.set(absolute, (hashCounts.get(absolute) || 0) + 1);
    return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  },
});
for (const [file, count] of hashCounts) {
  if (/\/(screenshots|layouts|logs|knowledge|scenes|operations)\//.test(file)) {
    assert.strictEqual(count, 1, `${path.relative(started.execDir, file)} must be hashed once per commit`);
  }
}
assert.strictEqual(Object.prototype.hasOwnProperty.call(committed.completion, 'schemaVersion'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(committed.completion, 'metricsSchemaVersion'), false);
assert.strictEqual(committed.completion.validationProfileSha, validationProfile.profileSha);
const committedManifest = JSON.parse(fs.readFileSync(path.join(started.execDir, 'artifact-manifest.json'), 'utf8'));
assert.ok(committedManifest.files.some((entry) => entry.path === 'validation-profile.snapshot.json'));
assert.strictEqual(committed.completion.verdict, 'PASS');
assert.strictEqual(committed.state.status, 'FINALIZING');
assert.deepStrictEqual(committed.state.finalization, { cause: 'COMPLETED', executionsSettled: false, casesCommitted: true, platformReleased: false });
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'SETTLE_EXECUTIONS');
recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  step: 'executionsSettled',
  result: { ok: true },
  now: '2026-09-03T10:00:03.050Z',
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'RELEASE_PLATFORM');
const finalizedBatch = recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  step: 'platformReleased',
  result: { ok: true, status: 'RELEASED' },
  now: '2026-09-03T10:00:03.100Z',
});
assert.strictEqual(finalizedBatch.state.status, 'COMPLETED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'BATCH_COMPLETE');
const report = readExecutionReport(started.execDir);
assert.strictEqual(report.display.verdict, 'PASS');
assert.ok(report.events.some((event) => event.type === 'caseFlowRevised'));
assert.ok(report.events.some((event) => event.type === 'actionSpatialInspected'));
assert.ok(report.events.some((event) => event.type === 'agentDecisionRecorded'));
const reportNarrative = buildExecutionNarrative(report);
assert.strictEqual(reportNarrative.contextVersion, 4);
assert.strictEqual(reportNarrative.modelKind, 'CASE_FLOW');
assert.strictEqual(reportNarrative.caseFlowHistory.length, 4);
assert.strictEqual(reportNarrative.caseFlow.reason, '上一动作标注图显示落点偏离目标区域');
assert.ok(reportNarrative.steps.some((step) => step.action?.spatialInspection?.observation === '标注落点位于目标区域左上方，需要调整后续操作位置'));
const rendered = refreshCommittedCaseReports(caseDir, 'harmony');
assert.strictEqual(rendered.status, 'UPDATED');
const contextHtml = fs.readFileSync(path.join(caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
assert.match(contextHtml, /目标内容正常显示/);
assert.match(contextHtml, /页面保持在目标 App/);
assert.match(contextHtml, /Runtime 请求错误/);
for (const text of ['结果概览', '用例流程', 'Baseline Flow', '执行轨迹', '检查点', '为什么做', '预期效果', '实际效果', '2\/2', '详细日志']) {
  assert.ok(contextHtml.includes(text), text);
}
const validationProfilePath = path.join(started.execDir, 'validation-profile.snapshot.json');
const frozenValidationProfile = fs.readFileSync(validationProfilePath, 'utf8');
fs.writeFileSync(validationProfilePath, frozenValidationProfile.replace('"knowledgeClosurePolicy": "OPTIONAL"', '"knowledgeClosurePolicy": "DISABLED"'));
const changedProfileReport = readExecutionReport(started.execDir);
assert.strictEqual(changedProfileReport.completionError !== null, true);
assert.strictEqual(changedProfileReport.display.failureCode, 'EXECUTION_COMPLETION_INVALID');
fs.writeFileSync(validationProfilePath, frozenValidationProfile);

function createExecutionLockFixture(workspaceRoot, fixtureBatchId, suffix, platform = 'harmony') {
  const fixtureSource = `验证 execution 创建锁隔离 ${suffix}`;
  const fixtureCaseKey = `ck-${crypto.createHash('sha256').update(fixtureSource).digest('hex').slice(0, 12)}`;
  const fixtureCaseDir = path.join(workspaceRoot, 'cases', `${suffix}__${fixtureCaseKey}`);
  fs.mkdirSync(fixtureCaseDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureCaseDir, 'source.md'), fixtureSource);
  writeJsonAtomic(path.join(fixtureCaseDir, 'case.json'), createCaseContract({
    caseKey: fixtureCaseKey,
    title: `execution 创建锁 ${suffix}`,
    sourceText: fixtureSource,
    importPath: `/fixture/${suffix}.md`,
  }));
  const fixtureBinding = {
    platform,
    deviceId: `${suffix}-device`,
    appId: `com.example.${suffix}`,
    entry: platform === 'android' ? '.MainActivity' : 'EntryAbility',
  };
  createTestExecutionRequest(workspaceRoot, fixtureBatchId, fixtureBinding, [{
    caseKey: fixtureCaseKey,
    caseDir: fixtureCaseDir,
  }]);
  initializeBatch({ workspaceRoot, batchId: fixtureBatchId });
  const fixtureAdapter = {
    restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
    probeSession: () => ({ ok: true, binding: fixtureBinding }),
  };
  bootstrapBatch({ workspaceRoot, batchId: fixtureBatchId, adapter: fixtureAdapter });
  return {
    batchId: fixtureBatchId,
    runtimeDir: path.join(fixtureCaseDir, 'platforms', platform),
  };
}

const scopedCreationLockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-scoped-execution-create-lock-'));
createTestWorkspace(scopedCreationLockRoot);
const scopedCreationLock = createExecutionLockFixture(
  scopedCreationLockRoot,
  'batch-scoped-execution-create-lock',
  'scoped-execution-create-lock',
);
const runtimeCreationLock = path.join(scopedCreationLock.runtimeDir, 'executions', '.create.lock');
writeJsonAtomic(runtimeCreationLock, { pid: process.pid, acquiredAt: '2026-09-17T10:00:00.000Z' });
assert.throws(
  () => startCurrentCase({
    workspaceRoot: scopedCreationLockRoot,
    batchId: scopedCreationLock.batchId,
  }),
  (error) => error.code === 'EXECUTION_LOCKED',
);
const otherPlatformCreation = createExecutionLockFixture(
  scopedCreationLockRoot,
  'batch-other-platform-execution-create-lock',
  'other-platform-execution-create-lock',
  'android',
);
assert.strictEqual(startCurrentCase({
  workspaceRoot: scopedCreationLockRoot,
  batchId: otherPlatformCreation.batchId,
}).action, 'DELEGATE_CASE_AGENT');
fs.rmSync(scopedCreationLockRoot, { recursive: true, force: true });

const legacyCreationLockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-legacy-execution-create-lock-'));
createTestWorkspace(legacyCreationLockRoot);
const legacyCreationLock = createExecutionLockFixture(
  legacyCreationLockRoot,
  'batch-legacy-execution-create-lock',
  'legacy-execution-create-lock',
);
const legacyRootLock = path.join(legacyCreationLockRoot, '.execution-create.lock');
writeJsonAtomic(legacyRootLock, { pid: process.pid, acquiredAt: '2026-09-17T10:00:00.000Z' });
const startedWithLegacyRootLock = startCurrentCase({
  workspaceRoot: legacyCreationLockRoot,
  batchId: legacyCreationLock.batchId,
});
assert.strictEqual(startedWithLegacyRootLock.action, 'DELEGATE_CASE_AGENT');
assert.strictEqual(fs.existsSync(legacyRootLock), true);
fs.rmSync(legacyCreationLockRoot, { recursive: true, force: true });

console.log('case runtime tests passed');

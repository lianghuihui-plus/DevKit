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
const { run, parseRequest } = require('../case-runtime/runtime-client');
const { readExecutionReport } = require('../lib/execution-reader');
const { refreshCommittedCaseReports } = require('../report/report-service');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const T0 = '2026-09-03T10:00:00.000Z';
const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-runtime-')), 'workspace with spaces $literal');
createTestWorkspace(root);
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
const contract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }], { now: T0 });
initializeBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, now: T0 });
const adapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 });

const started = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, executionId: 'execution-runtime-001', now: T0 });
assert.strictEqual(started.execution.schemaVersion, 7);
assert.strictEqual(started.request, undefined);
assert.strictEqual(started.brief.case.source, sourceText);
assert.strictEqual(started.brief.scene, null);
assert.strictEqual(path.dirname(started.runtime.entry), started.execDir);
assert.strictEqual(started.brief.runtime.entry, undefined);
assert.strictEqual(started.brief.runtime.requestPath, path.join(started.execDir, 'runtime-request.json'));
assert.strictEqual(started.brief.runtime.commands, undefined);
assert.strictEqual(fs.statSync(started.runtime.entry).mode & 0o111, 0o111);
assert.deepStrictEqual(started.runtime.status, 'READY');
assert.strictEqual(started.item.sessionId, undefined);
const continuation = startCurrentCase({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  continuationReason: 'simulated native handle loss',
  now: T0,
});
assert.strictEqual(continuation.execution.executionId, started.execution.executionId);
assert.strictEqual(continuation.agentContinuation.event.type, 'agentContinuation');
assert.strictEqual(continuation.brief.mode, 'CONTINUATION');
assert.strictEqual(continuation.brief.scene, null);
assert.strictEqual(continuation.brief.resumeState.executionStatus, 'RUNNING');
writeJsonAtomic(started.brief.runtime.requestPath, { operation: 'status' });
const clientStatus = JSON.parse(childProcess.execSync(started.brief.runtime.command, { cwd: os.tmpdir(), encoding: 'utf8' }));
assert.strictEqual(clientStatus.status, 'READY');
writeJsonAtomic(started.brief.runtime.requestPath, { operation: 'status' });
assert.strictEqual(JSON.parse(childProcess.execSync(started.brief.runtime.command, { encoding: 'utf8' })).status, 'READY');
fs.writeFileSync(started.brief.runtime.requestPath, '{ malformed json');
const malformedRequest = childProcess.spawnSync(started.runtime.entry, [], { encoding: 'utf8' });
assert.strictEqual(malformedRequest.status, 0);
assert.strictEqual(JSON.parse(malformedRequest.stdout).status, 'REQUEST_INVALID');
assert.strictEqual(fs.existsSync(started.brief.runtime.requestPath), false);
writeJsonAtomic(started.brief.runtime.requestPath, { operation: 'status' });
assert.strictEqual(JSON.parse(childProcess.execSync(started.brief.runtime.command, { encoding: 'utf8' })).status, 'READY');
const invalidClientCall = childProcess.spawnSync(started.runtime.entry, ['act'], { encoding: 'utf8' });
assert.strictEqual(invalidClientCall.status, 0);
assert.strictEqual(JSON.parse(invalidClientCall.stdout).status, 'REQUEST_INVALID');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'WAIT_CASE_AGENT');

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
const first = run(started.execDir, { operation: 'observe', caseContext }, { runner, now: T0 });
assert.strictEqual(first.status, 'SCENE');
assert.strictEqual(first.scene.sceneId, 'scene-0001');
assert.deepStrictEqual(first.narrative.caseContext.expectations.map((item) => item.id), ['E1', 'E2']);
const currentSceneId = () => JSON.parse(fs.readFileSync(path.join(started.execDir, 'current-scene.json'), 'utf8')).sceneId;
const knowledge = run(started.execDir, {
  operation: 'knowledge',
  basedOnSceneId: currentSceneId(),
  query: '当前页面显示异常',
  decision: {
    observation: '当前页面信息不足以解释显示状态',
    conclusion: '查询本地经验以辅助判断',
    purpose: '调查可能的页面显示异常',
    expectedOutcome: '获得与当前现象相关的本地经验',
    expectationRefs: ['E1'],
  },
}, { now: T0 });
assert.strictEqual(knowledge.status, 'KNOWLEDGE');
assert.ok(Array.isArray(knowledge.candidates));
assert.strictEqual(knowledge.candidates[0].entryId, 'K-runtime-001');
assert.strictEqual(knowledge.context.app, 'com.example.runtime');
assert.strictEqual(knowledge.filterDiagnostics, null);
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
    expectationRefs: ['E2'],
  },
}, { now: T0 });
assert.strictEqual(knowledgeMiss.candidates.length, 0);
assert.strictEqual(knowledgeMiss.filterDiagnostics.excludedBy.app, 1);
const knowledgeMissEvent = fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map(JSON.parse)
  .find((event) => event.type === 'knowledgeQueried' && event.queryId === knowledgeMiss.queryId);
assert.strictEqual(knowledgeMissEvent.context.app, 'com.example.runtime');
assert.strictEqual(knowledgeMissEvent.filterDiagnostics.rejected[0].entryId, 'K-other-app-001');
const wait = first.scene.capabilities.find((item) => item.kind === 'wait');
assert.ok(wait);

const actionInvocationsBeforeSceneGuard = actionInvocationCount;
const missingSceneBasis = run(started.execDir, {
  operation: 'act',
  capabilityId: wait.id,
}, { runner, now: '2026-09-03T10:00:00.500Z' });
assert.strictEqual(missingSceneBasis.status, 'REQUEST_INVALID');
assert.strictEqual(missingSceneBasis.code, 'CASE_RUNTIME_REQUEST_INVALID');
assert.strictEqual(actionInvocationCount, actionInvocationsBeforeSceneGuard);

const ambiguousTarget = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: wait.id,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
}, { runner, now: '2026-09-03T10:00:00.600Z' });
assert.strictEqual(ambiguousTarget.status, 'REQUEST_INVALID');
assert.match(ambiguousTarget.message, /mutually exclusive/);
assert.strictEqual(actionInvocationCount, actionInvocationsBeforeSceneGuard);

const second = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: wait.id,
  decision: {
    observation: '页面已经打开但仍需等待稳定',
    conclusion: '可以执行短暂等待后验证最终状态',
    purpose: '等待页面稳定',
    expectedOutcome: '目标内容保持可见且 App 状态正常',
    expectationRefs: ['E1', 'E2'],
    knowledgeReview: {
      queryId: knowledge.queryId,
      conclusion: 'APPLICABLE_FOUND',
      assessments: [{
        entryId: 'K-runtime-001', status: 'APPLICABLE',
        reason: '当前为 HarmonyOS 目标 App，等待稳定后复核符合条目建议',
      }],
    },
    planUpdate: { reason: '当前页面已是目标页，无需导航', next: ['等待稳定', '完成两个验证点'] },
  },
}, { runner, now: '2026-09-03T10:00:01.000Z' });
assert.strictEqual(second.status, 'SCENE');
assert.strictEqual(second.action.lifecycle.status, 'COMPLETED');
assert.strictEqual(second.action.command.status, 'ACCEPTED');
assert.strictEqual(second.action.deviceExecution.status, 'UNVERIFIED');
assert.strictEqual(second.action.observedEffect.status, 'UNCHANGED');
assert.strictEqual(second.scene.sceneId, 'scene-0002');
assert.strictEqual(observationCount, 2);
const narrativeStatus = run(started.execDir, { operation: 'status' });
assert.strictEqual(narrativeStatus.narrative.contextVersion, 1);
assert.strictEqual(narrativeStatus.narrative.latestPlan.version, 2);
assert.strictEqual(narrativeStatus.narrative.lastDecision.decision.purpose, '等待页面稳定');
const actionInvocationsBeforePartialNarrative = actionInvocationCount;
const partialNarrative = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  capabilityId: second.scene.capabilities.find((item) => item.kind === 'wait').id,
  decision: {
    observation: '页面仍在目标 App 内',
    conclusion: '继续短暂等待以确认稳定性',
    purpose: '继续观察页面稳定性',
    expectationRefs: ['E1'],
  },
}, { runner, now: '2026-09-03T10:00:01.050Z' });
assert.strictEqual(partialNarrative.status, 'SCENE');
assert.strictEqual(actionInvocationCount, actionInvocationsBeforePartialNarrative + 1);
assert.ok(partialNarrative.narrative.warnings.some((item) => item.fields.includes('decision.expectedOutcome')));
const stale = run(started.execDir, { operation: 'act', basedOnSceneId: currentSceneId(), capabilityId: wait.id }, { runner, now: '2026-09-03T10:00:01.100Z' });
assert.strictEqual(stale.status, 'SCENE_CHANGED');
assert.strictEqual(stale.scene.sceneId, partialNarrative.scene.sceneId);
assert.ok(stale.narrative.warnings.some((item) => item.fields.includes('decision')));

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
assert.strictEqual(require('../case-runtime/store').events(started.execDir)
  .find((event) => event.sceneId === recovered.scene.sceneId).relatedOperationId, recovered.recovery.operationId);
assert.ok(recovered.narrative.warnings.some((item) => item.fields.includes('decision')));
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
  caseContext: {
    ...caseContext,
    revisionReason: '恢复后按当前现场收敛执行计划',
    initialPlan: ['确认恢复后的页面状态', '完成两个验证点'],
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
const afterRecoveryObserve = run(started.execDir, {
  operation: 'observe',
  caseContext: {
    ...caseContext,
    revisionReason: '恢复后按当前现场收敛执行计划',
    initialPlan: ['确认恢复后的页面状态', '完成两个验证点'],
  },
}, { runner, now: '2026-09-03T10:00:01.925Z' });
assert.strictEqual(afterRecoveryObserve.status, 'SCENE');
assert.strictEqual(afterRecoveryObserve.narrative.contextVersion, 2);
assert.strictEqual(afterRecoveryObserve.narrative.latestPlan.version, 2);
assert.deepStrictEqual(afterRecoveryObserve.narrative.latestPlan.items, ['等待稳定', '完成两个验证点']);
assert.deepStrictEqual(afterRecoveryObserve.narrative.caseContext.expectations.map((item) => item.id), ['E1', 'E2']);
assert.ok(afterRecoveryObserve.narrative.warnings.some((item) => item.fields.includes('decision')));
assert.strictEqual(resumedDeviceResultCount, 1);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'runs', batchId, 'batch.json'), 'utf8')).warmSession.generation, 4);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'recovery.draft.json')), false);

const spatialAction = run(started.execDir, {
  operation: 'act',
  basedOnSceneId: currentSceneId(),
  visual: { gesture: 'tap', point: [0, 0] },
  intent: '验证动作空间证据闭环',
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
assert.strictEqual(spatialAction.action.spatialEvidence.actual, null);
assert.strictEqual(spatialAction.action.spatialEvidence.annotatedScreenshot.attachment.mediaType, 'image/png');
assert.strictEqual(fs.existsSync(spatialAction.action.spatialEvidence.annotatedScreenshot.absolutePath), true);
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

const timedOut = run(started.execDir, { operation: 'observe' }, { runner, now: '2026-09-03T10:30:00.000Z' });
assert.strictEqual(timedOut.status, 'TIME_LIMIT');
assert.strictEqual(timedOut.scene.sceneId, spatialAction.scene.sceneId);
assert.match(timedOut.technicalFactRef, /^technical-fact-\d{4}$/);

const eventCount = fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8').trim().split('\n').length;
const malformed = run(started.execDir, { operation: 'act' });
assert.strictEqual(malformed.status, 'REQUEST_INVALID');
assert.strictEqual(fs.readFileSync(path.join(started.execDir, 'events.jsonl'), 'utf8').trim().split('\n').length, eventCount);
assert.deepStrictEqual(parseRequest([], JSON.stringify({ operation: 'act', capabilityId: wait.id, input: { text: '完整 输入' } })), { operation: 'act', capabilityId: wait.id, input: { text: '完整 输入' } });

const result = {
  verdict: 'PASS',
  summary: '页面在等待后保持正常显示',
  checks: [
    { expectationRef: 'E1', status: 'PASS', actual: '目标内容在稳定后的页面中正常显示', sceneRefs: [recovered.scene.sceneId], knowledgeRefs: ['K-runtime-001'] },
    { expectationRef: 'E2', status: 'PASS', actual: '页面保持在目标 App 且截图可用', sceneRefs: [recovered.scene.sceneId] },
  ],
  uncertainties: [],
};
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
assert.ok(uncoveredExpectation.missing.some((item) => item.field === 'checks.E2'));
const actionsBeforePendingRecovery = actionInvocationCount;
writeJsonAtomic(path.join(started.execDir, 'transactions', 'action-9000.draft.json'), {
  schemaVersion: 1,
  operationId: 'action-9000',
  status: 'DISPATCHED',
  sceneId: recovered.scene.sceneId,
  action: { type: 'wait', ms: 100 },
  intent: '模拟进程在设备调用后退出',
});
const finishDecision = {
  observation: '等待后目标内容仍然显示，App 保持前台',
  conclusion: 'E1 和 E2 均有当前 Scene 支持，可以判定通过',
  purpose: '完成用例并提交结论',
  expectedOutcome: '全部验证点都有明确结果和现场证据',
  expectationRefs: ['E1', 'E2'],
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
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'COMMIT_CASE');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'runtime.json'), 'utf8')).status, 'COMPLETED');
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'transactions', 'finish.draft.json')), false);
const finished = run(started.execDir, { operation: 'finish', basedOnSceneId: currentSceneId(), decision: finishDecision, result }, { now: '2026-09-03T10:00:02.500Z' });
assert.strictEqual(finished.status, 'COMPLETED');
assert.strictEqual(finished.idempotent, true);
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
assert.strictEqual(runtimeMetrics.counts.caseContextRevisions, 2);
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
assert.strictEqual(committed.completion.schemaVersion, 3);
assert.strictEqual(committed.completion.verdict, 'PASS');
assert.strictEqual(committed.state.status, 'FINALIZING');
assert.deepStrictEqual(committed.state.finalization, { casesCommitted: true, platformReleased: false, reportsPublished: false });
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'RELEASE_PLATFORM');
recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  step: 'platformReleased',
  result: { ok: true, status: 'RELEASED' },
  now: '2026-09-03T10:00:03.100Z',
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'PUBLISH_REPORTS');
const finalizedBatch = recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  step: 'reportsPublished',
  result: { status: 'PUBLISHED' },
  now: '2026-09-03T10:00:03.200Z',
});
assert.strictEqual(finalizedBatch.state.status, 'COMPLETED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter, now: T0 }).action, 'BATCH_COMPLETE');
const report = readExecutionReport(started.execDir);
assert.strictEqual(report.schemaFamily, 'current');
assert.strictEqual(report.display.verdict, 'PASS');
assert.ok(report.events.some((event) => event.type === 'caseContextRecorded'));
assert.ok(report.events.some((event) => event.type === 'agentDecisionRecorded'));
const rendered = refreshCommittedCaseReports(caseDir, 'harmony');
assert.strictEqual(rendered.status, 'UPDATED');
const contextHtml = fs.readFileSync(path.join(caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
assert.match(contextHtml, /目标内容正常显示/);
assert.match(contextHtml, /页面保持在目标 App/);
assert.match(contextHtml, /Agent 与调度间隔（估算）/);
assert.match(contextHtml, /Runtime 调用 \/ 格式错误/);
for (const text of ['执行复盘', 'Agent 判断', '用例理解', '初始计划', '操作前观察', '操作后的结论', '覆盖 2/2', '证据', '技术信息']) {
  assert.ok(contextHtml.includes(text), text);
}

console.log('case runtime tests passed');

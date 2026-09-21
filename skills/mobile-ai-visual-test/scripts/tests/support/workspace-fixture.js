'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildContract } = require('../../build-agent-contract');
const { createCaseContract, validateCaseContract } = require('../../execution/contracts/case-contract');
const { completionPaths, sha256File, validatePublishedCompletion } = require('../../lib/completion-contract');
const { buildExecutionArtifactManifest } = require('../../lib/execution-artifact-manifest');
const { confirmEnvironment, createExecutionRequest } = require('../../lib/run-control');
const { appProvisioningSha, defaultAppProvisioning, preparationPolicySha, validatePreparationPolicy } = require('../../lib/app-provisioning');
const { createValidationProfile } = require('../../execution/contracts/validation-profile-contract');

const TEST_WORKSPACE_TYPE = 'mobile-ai-visual-test-test-workspace';
const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertTestRoot(root) {
  if (process.env.MAVT_SELF_TEST !== '1') throw new Error('CURRENT_FIXTURE_TEST_ONLY: MAVT_SELF_TEST=1 is required');
  const markerPath = path.join(root, 'workspace.json');
  const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null;
  if (marker?.type !== TEST_WORKSPACE_TYPE || marker.testOnly !== true) {
    throw new Error('CURRENT_FIXTURE_TEST_ONLY: target must be an explicit test workspace');
  }
}

function createTestWorkspace(root) {
  if (process.env.MAVT_SELF_TEST !== '1') throw new Error('CURRENT_FIXTURE_TEST_ONLY: MAVT_SELF_TEST=1 is required');
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw new Error('CURRENT_FIXTURE_TEST_ONLY: test workspace root must be empty');
  writeJson(path.join(root, 'workspace.json'), { schemaVersion: 1, type: TEST_WORKSPACE_TYPE, testOnly: true });
  fs.mkdirSync(path.join(root, 'cases'));
  return root;
}

function createTestExecutionRequest(root, batchId, binding, targets, options = {}) {
  assertTestRoot(root);
  const now = options.now || '2026-08-13T10:00:00.000Z';
  confirmEnvironment({
    workspaceRoot: root,
    binding,
    probe: { schemaVersion: 1, platform: binding.platform, ready: true, devices: [{ id: binding.deviceId }] },
    appProvisioning: options.appProvisioning,
    userConfirmation: options.environmentConfirmation || `确认测试环境 ${binding.deviceId}`,
    now,
  });
  const frozenTargets = targets.map((target) => {
    let caseDir = target.caseDir;
    if (!caseDir && target.caseNo !== undefined) {
      const { resolveCaseNo } = require('../../lib/case-numbering');
      caseDir = resolveCaseNo(root, target.caseNo)?.caseDir;
    }
    const caseJson = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
    return {
      caseNo: target.caseNo,
      caseKey: target.caseKey || caseJson.identity.caseKey,
      caseDir,
    };
  });
  return createExecutionRequest({
    workspaceRoot: root,
    batchId,
    mode: options.mode || (targets.length === 1 ? 'SINGLE' : 'BATCH'),
    targets: frozenTargets,
    bootstrapPolicy: options.bootstrapPolicy,
    userInstruction: options.userInstruction || `${targets.length === 1 ? '单独' : '批量'}执行测试用例`,
    now,
  });
}

function event(executionId, sequence, time, type, payload = {}) {
  return {
    schemaVersion: 1,
    eventId: `fixture-event-${sequence}`,
    executionId,
    sequence,
    time,
    type,
    ...(!['executionStarted', 'caseFlowRevised'].includes(type) ? { caseFlowRevision: 1 } : {}),
    ...payload,
  };
}

function createCurrentFixture(root, options = {}) {
  assertTestRoot(root);
  const verdict = options.verdict || 'PASS';
  const platform = options.platform || 'harmony';
  const suffix = String(options.suffix || verdict).toLowerCase();
  const executionId = `execution-current-${suffix}`;
  const sourceText = options.sourceText || `验证当前报告 ${verdict}`;
  const caseKey = `ck-${Buffer.from(suffix).toString('hex').padEnd(12, '0').slice(0, 12)}`;
  const caseJson = createCaseContract({
    caseKey,
    title: options.title || `${verdict} 当前用例`,
    sourceText,
    importPath: `/fixtures/${suffix}.txt`,
  });
  validateCaseContract(caseJson);

  const caseDir = path.join(root, 'cases', `${suffix}__${caseKey}`);
  const runtimeDir = path.join(caseDir, 'platforms', platform);
  const execDir = path.join(runtimeDir, 'executions', executionId);
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJson(path.join(caseDir, 'case.json'), caseJson);
  fs.writeFileSync(path.join(execDir, 'source.snapshot.md'), sourceText);
  writeJson(path.join(execDir, 'case.snapshot.json'), caseJson);

  const startedAt = '2026-08-13T10:00:00.000+08:00';
  const endedAt = '2026-08-13T10:00:05.000+08:00';
  const currentContract = buildContract({ skillRoot: path.resolve(__dirname, '../../..'), role: 'case-executor', platform });
  const appProvisioning = defaultAppProvisioning();
  const preparationPolicy = validatePreparationPolicy();
  const context = {
    summary: `理解 ${verdict} 用例`,
    preconditions: options.includePreparation ? ['目标页面可进入'] : [],
    expectations: [{ id: 'E1', text: '验证当前报告结果', verificationKind: 'DIRECT_OBSERVATION' }],
    initialPlan: ['观察当前页面', '执行必要操作', '检查最终结果'],
    uncertainties: [],
  };
  const validationProfile = createValidationProfile();
  writeJson(path.join(execDir, 'validation-profile.snapshot.json'), validationProfile);
  const execution = {
    schemaVersion: 13,
    runtime: 'case-runtime',
    executionId,
    batchId: `batch-${suffix}`,
    platform,
    runtimeSha: currentContract.runtimeSha,
    adapterSha: currentContract.adapterSha,
    caseProtocolSha: currentContract.protocolSha,
    coordinatorProtocolSha: 'agent-protocol-fixture0002',
    contractSha: caseJson.contractSha,
    validationProfileSha: validationProfile.profileSha,
    batchContractSha: `batch-contract-${'a'.repeat(24)}`,
    executionRequestSha: `execution-request-${'a'.repeat(24)}`,
    interactionPolicy: 'UNATTENDED',
    targetBinding: { platform, deviceId: 'fixture-device', appId: 'com.example.fixture', entry: 'EntryAbility' },
    targetBindingSha: 'target-binding-fixture',
    appProvisioning,
    appProvisioningSha: appProvisioningSha(appProvisioning),
    preparationPolicy,
    preparationPolicySha: preparationPolicySha(preparationPolicy),
    warmSessionIdStart: 'warm-0001',
    warmSessionId: 'warm-0001',
    warmSessionEpochStart: 1,
    warmSessionEpoch: 1,
    warmSessionGeneration: 1 + (options.recoveryCount || 0),
    warmSessionGenerationStart: 1,
    warmSessionReused: options.warmSessionReused === true,
    executionRecoveryCount: options.recoveryCount || 0,
    batchRecoveryCountAtStart: 0,
    batchRecoveryCountAtEnd: options.recoveryCount || 0,
    sourceSha: caseJson.identity.sourceSha,
    startedAt,
    endedAt,
    status: 'FINISHED',
    lifecycle: 'FINALIZED',
    finalized: true,
    executionStatus: 'COMPLETED',
  };
  writeJson(path.join(execDir, 'execution.json'), execution);
  writeJson(path.join(execDir, 'binding.snapshot.json'), {
    schemaVersion: 1,
    binding: execution.targetBinding,
    bindingSha: execution.targetBindingSha,
    batchContractSha: execution.batchContractSha,
  });

  for (const name of ['screenshots', 'layouts', 'logs', 'scenes', 'operations', 'action-spatial-evidence', 'knowledge', 'telemetry']) {
    fs.mkdirSync(path.join(execDir, name), { recursive: true });
  }
  const beforeRef = 'screenshots/scene-0001.png';
  const afterRef = 'screenshots/scene-0002.png';
  fs.writeFileSync(path.join(execDir, beforeRef), FIXTURE_PNG);
  fs.writeFileSync(path.join(execDir, afterRef), FIXTURE_PNG);
  const screenshotSha = sha256File(path.join(execDir, beforeRef));
  const beforeLayoutRef = 'layouts/scene-0001.json';
  const afterLayoutRef = options.afterLayoutAvailable === false ? null : 'layouts/scene-0002.json';
  fs.writeFileSync(path.join(execDir, beforeLayoutRef), '{}\n');
  if (afterLayoutRef) fs.writeFileSync(path.join(execDir, afterLayoutRef), '{"screen":"after"}\n');
  fs.writeFileSync(path.join(execDir, 'logs', 'scene-0002-errors.txt'), 'fixture observation diagnostics\n');
  const app = { appId: execution.targetBinding.appId, inTargetApp: true };
  const scene = (sceneId, screenshotRef, layoutRef, previousAction = null) => ({
    schemaVersion: 2,
    sceneId,
    generation: execution.warmSessionGeneration,
    warmSessionRef: { sessionId: execution.warmSessionId, epoch: execution.warmSessionEpoch, generation: execution.warmSessionGeneration },
    capturedAt: sceneId === 'scene-0001' ? '2026-08-13T10:00:01.000+08:00' : '2026-08-13T10:00:03.000+08:00',
    screenshot: { ref: screenshotRef, path: path.join(execDir, screenshotRef), sha256: screenshotSha, width: 1, height: 1 },
    layoutRef,
    layout: null,
    app,
    signals: {}, conflicts: [], elements: [], capabilities: [], scrollContainers: [], scrollContexts: [],
    visual: { gestures: ['tap'], coordinates: 'normalized-0-to-1' },
    previousAction,
  });
  const action = options.action || { type: 'tap', x: 120, y: 240, target: '目标按钮', coordinateSource: 'visual', targetBounds: [80, 210, 160, 270], coordinateEvidence: '操作前截图中的目标按钮' };
  const redactedAction = action.type === 'inputText' ? { ...action, text: '[REDACTED]' } : action;
  const spatialEvidenceData = action.x !== undefined && action.y !== undefined ? {
    schemaVersion: 1,
    type: 'actionSpatialEvidence',
    operationId: 'action-0001',
    actionType: action.type,
    source: action.coordinateSource,
    kind: 'POINT',
    certainty: 'DISPATCH_ONLY',
    requested: { point: { x: Number(action.x), y: Number(action.y) }, bounds: action.targetBounds },
    expectedDispatched: { point: { x: Number(action.x), y: Number(action.y) } },
    dispatched: { point: { x: Number(action.x), y: Number(action.y) } },
    actual: null,
    screenshot: { ref: beforeRef, width: 1, height: 1 },
    viewport: { width: 1, height: 1 },
    consistency: 'MATCHED',
    annotatedScreenshotRef: 'action-spatial-evidence/action-0001.svg',
  } : null;
  const spatialEvidenceRef = spatialEvidenceData ? 'action-spatial-evidence/action-0001.json' : null;
  const spatialEvidence = spatialEvidenceData ? {
    ref: spatialEvidenceRef,
    ...spatialEvidenceData,
    annotatedScreenshot: {
      ref: spatialEvidenceData.annotatedScreenshotRef,
      absolutePath: path.join(execDir, spatialEvidenceData.annotatedScreenshotRef),
      attachment: {
        type: 'image', mediaType: 'image/svg+xml', path: path.join(execDir, spatialEvidenceData.annotatedScreenshotRef),
      },
    },
  } : null;
  if (spatialEvidenceData) {
    writeJson(path.join(execDir, spatialEvidenceRef), spatialEvidenceData);
    fs.writeFileSync(path.join(execDir, spatialEvidenceData.annotatedScreenshotRef), `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="data:image/png;base64,${FIXTURE_PNG.toString('base64')}" width="1" height="1"/></svg>\n`);
  }
  const actionResult = {
    operationId: 'action-0001', lifecycle: { status: 'COMPLETED' }, action: redactedAction,
    command: { status: 'ACCEPTED', transport: 'HDC_UITEST', elapsedMs: 20 },
    deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    observedEffect: { status: 'UNCHANGED', beforeSceneRef: 'scene-0001', afterSceneRef: 'scene-0002' },
    ...(spatialEvidence ? { spatialEvidence } : {}),
  };
  const storedActionResult = { ...actionResult };
  delete storedActionResult.spatialEvidence;
  if (spatialEvidenceRef) storedActionResult.spatialEvidenceRef = spatialEvidenceRef;
  writeJson(path.join(execDir, 'operations', 'action-0001.json'), {
    schemaVersion: 1,
    operationId: 'action-0001',
    status: 'COMPLETED',
    sceneId: 'scene-0001',
    sceneIdAfter: 'scene-0002',
    action: redactedAction,
    intent: action.type === 'inputText' ? '输入测试内容' : '打开目标并验证结果',
    deviceResult: { command: actionResult.command, deviceExecution: actionResult.deviceExecution },
    spatialEvidenceRef,
    actionResult: storedActionResult,
  });
  const beforeScene = scene('scene-0001', beforeRef, beforeLayoutRef);
  const afterScene = scene('scene-0002', afterRef, afterLayoutRef, actionResult);
  writeJson(path.join(execDir, 'scenes', 'scene-0001.json'), beforeScene);
  writeJson(path.join(execDir, 'scenes', 'scene-0002.json'), afterScene);

  const decision = {
    observation: '当前页面显示目标入口', conclusion: '可以执行验证操作',
    purpose: action.type === 'inputText' ? '输入测试内容' : '打开目标并验证结果',
    expectedOutcome: '页面展示目标结果', expectationRefs: ['N2'],
  };
  const finalDecision = {
    observation: '操作后已取得目标页面现场', conclusion: `验证结果为 ${verdict}`,
    purpose: '完成用例并提交结论', expectedOutcome: '最终结果与现场证据关联', expectationRefs: ['N2'],
  };
  const events = [
    event(executionId, 1, startedAt, 'executionStarted', { generation: 1 }),
    event(executionId, 2, startedAt, 'caseFlowRevised', {
      revision: 1,
      reason: 'INITIAL_CASE_FLOW',
      basedOnSceneRef: null,
      summary: context.summary,
      entryNodeRef: 'N1',
      nodes: [
        { ref: 'N1', type: 'ACTION', text: context.initialPlan[0] },
        { ref: 'N2', type: 'CHECK', text: context.expectations[0].text, verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例要求验证当前报告结果', requirement: 'REQUIRED' },
        { ref: 'N3', type: 'END', text: '结束用例并提交结论' },
      ],
      edges: [
        { ref: 'L1', from: 'N1', to: 'N2' },
        { ref: 'L2', from: 'N2', to: 'N3' },
      ],
      uncertainties: context.uncertainties,
      retiredNodeRefs: [],
      retiredEdgeRefs: [],
    }),
    event(executionId, 3, '2026-08-13T10:00:01.000+08:00', 'sceneObserved', {
      sceneId: 'scene-0001', generation: 1, operationId: 'observation-0001', purpose: options.includePreparation ? 'INITIAL_SCENE' : 'CURRENT_SCENE',
      relatedOperationId: null, decisionId: null, screenshotRef: beforeRef, screenshotSha256: screenshotSha, layoutRef: beforeLayoutRef, app,
    }),
    event(executionId, 4, '2026-08-13T10:00:01.500+08:00', 'agentDecisionRecorded', {
      decisionId: 'decision-0001', requestedOperation: 'act', sceneId: 'scene-0001', contextVersion: 1, decision,
    }),
    event(executionId, 5, '2026-08-13T10:00:01.600+08:00', 'actionRequested', {
      operationId: 'action-0001', sceneId: 'scene-0001', action: redactedAction,
      intent: decision.purpose, expectedOutcome: decision.expectedOutcome, decisionId: 'decision-0001',
    }),
    event(executionId, 6, '2026-08-13T10:00:02.000+08:00', 'actionCompleted', {
      operationId: 'action-0001', sceneId: 'scene-0001', sceneIdAfter: 'scene-0002', action: redactedAction,
      lifecycle: actionResult.lifecycle, command: actionResult.command,
      deviceExecution: actionResult.deviceExecution, observedEffect: actionResult.observedEffect,
      spatialEvidenceRef, decisionId: 'decision-0001',
    }),
    event(executionId, 7, '2026-08-13T10:00:03.000+08:00', 'sceneObserved', {
      sceneId: 'scene-0002', generation: execution.warmSessionGeneration, operationId: 'observation-0002', purpose: 'POST_ACTION',
      relatedOperationId: 'action-0001', decisionId: 'decision-0001', screenshotRef: afterRef, screenshotSha256: screenshotSha,
      layoutRef: afterLayoutRef, app, technicalSignals: options.afterTechnicalSignals || null,
    }),
    ...(options.recoveryCount ? [event(executionId, 8, '2026-08-13T10:00:03.200+08:00', 'appRecovered', {
      operationId: 'recovery-0001', reason: '恢复当前 App', decisionId: null,
      generationBefore: 1, generationAfter: execution.warmSessionGeneration,
    })] : []),
  ];
  events.push(event(executionId, events.length + 1, '2026-08-13T10:00:03.300+08:00', 'visualInspected', {
    sceneId: 'scene-0002', screenshotRef: afterRef, screenshotSha256: screenshotSha,
    observation: '已查看操作后截图，页面现场可用于最终验证', expectationRefs: ['N2'],
  }));
  let sequence = events.length + 1;
  if (['FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(verdict)) {
    events.push(event(executionId, sequence++, '2026-08-13T10:00:03.500+08:00', 'knowledgeQueried', {
      queryId: 'knowledge-0001', query: '当前结果异常', candidateRefs: [], candidates: [], candidateCount: 0,
      decisionId: null, sceneId: 'scene-0002', contextVersion: 1, expectationRefs: ['N2'], truncated: false,
    }));
    events.push(event(executionId, sequence++, '2026-08-13T10:00:03.600+08:00', 'knowledgeReviewed', {
      queryId: 'knowledge-0001', conclusion: 'NO_MATCH', assessments: [], automatic: true,
      decisionId: null, sceneId: 'scene-0002', contextVersion: 1, expectationRefs: ['N2'],
    }));
  }
  events.push(event(executionId, sequence++, '2026-08-13T10:00:04.000+08:00', 'agentDecisionRecorded', {
    decisionId: 'decision-0002', requestedOperation: 'finish', sceneId: 'scene-0002', contextVersion: 1, decision: finalDecision,
  }));

  const checkStatus = options.checkStatus || verdict;
  const needsScene = ['PASS', 'FAIL'].includes(checkStatus);
  const checkReason = checkStatus === 'WAIVED' ? (options.checkReason || '测试夹具豁免理由') : null;
  const result = {
    verdict,
    caseFlowRevision: 1,
    summary: options.summary || `${verdict} 当前报告结论`,
    checks: [{
      checkNodeRef: 'N2',
      status: checkStatus,
      actual: options.checkActual || (checkStatus === 'PASS' ? '页面符合预期' : `页面结果为 ${checkStatus}`),
      ...(checkReason ? { reason: checkReason } : {}),
      sceneRefs: needsScene ? ['scene-0002'] : [],
    }],
    uncertainties: options.uncertainties || (verdict === 'INCONCLUSIVE' ? ['目标状态仍不确定'] : []),
  };
  events.push(event(executionId, sequence, endedAt, 'caseFinished', {
    verdict, checkCount: 1, expectationCount: 1, coveredExpectationRefs: ['N2'], unresolvedSceneRefs: [], decisionId: 'decision-0002',
  }));
  fs.writeFileSync(path.join(execDir, 'events.jsonl'), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  writeJson(path.join(execDir, 'result.json'), result);

  const metrics = {
    schemaVersion: 3, executionId, verdict, executionStatus: execution.executionStatus, elapsedMs: 5000,
    totalElapsedMs: 5000, runtimeActiveMs: 3000, adapterActiveMs: 2000, actionDeviceMs: 500,
    observationCaptureMs: 1000, postActionSettleMs: 500, explicitWaitMs: 0, knowledgeQueryMs: 0,
    recoveryControlMs: 0, runtimeOverheadMs: 1000, recoveryMs: 0, agentAndSchedulingGapMs: 2000,
    agentTiming: { firstPreparationMs: 500, stepDecisionMs: 900, conclusionPreparationMs: 500, unclassifiedGapMs: 100, stepDecisionIntervals: [] },
    invocationCount: 4, invocationErrorCount: 0,
    warmSessionGenerationStart: 1, warmSessionGenerationEnd: execution.warmSessionGeneration,
    warmSessionIdStart: execution.warmSessionIdStart, warmSessionIdEnd: execution.warmSessionId,
    warmSessionEpochStart: execution.warmSessionEpochStart, warmSessionEpochEnd: execution.warmSessionEpoch,
    warmSessionReused: execution.warmSessionReused, executionRecoveryCount: execution.executionRecoveryCount,
    batchRecoveryCountAtStart: 0, batchRecoveryCountAtEnd: execution.batchRecoveryCountAtEnd, timeLimitStopped: false,
    counts: { actions: 1, observations: 2, knowledgeQueries: ['FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(verdict) ? 1 : 0, knowledgeReviews: ['FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(verdict) ? 1 : 0, recoveries: options.recoveryCount || 0, agentContinuations: 0, invocationCorrections: 0, caseContextRevisions: 1, agentDecisions: 2, narrativeGaps: 0 },
    knowledgeUsage: { queryIds: ['FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(verdict) ? ['knowledge-0001'] : [], reviewedQueryIds: ['FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(verdict) ? ['knowledge-0001'] : [], candidateRefs: [], applicableEntryIds: [] },
  };
  writeJson(path.join(execDir, 'metrics.json'), metrics);
  const artifactManifest = buildExecutionArtifactManifest(execDir, { now: endedAt });
  const paths = completionPaths(execDir);
  const completion = {
    executionId, batchId: execution.batchId, caseKey, platform,
    completionSource: 'framework', runtimeSha: execution.runtimeSha, adapterSha: execution.adapterSha,
    contractSha: execution.contractSha, batchContractSha: execution.batchContractSha,
    validationProfileSha: execution.validationProfileSha,
    verdict, executionStatus: execution.executionStatus, runtimeCompleted: true,
    resultSha256: sha256File(paths.result), metricsSha256: sha256File(paths.metrics),
    artifactManifestSha256: sha256File(paths.artifactManifest),
  };
  writeJson(paths.completion, completion);
  validatePublishedCompletion(execDir, completion, { execution, result, metrics, snapshot: caseJson });
  return { caseDir, runtimeDir, execDir, execution, result, metrics, completion, caseJson, artifactManifest };
}

module.exports = {
  TEST_WORKSPACE_TYPE,
  createCurrentFixture,
  createTestExecutionRequest,
  createTestWorkspace,
};

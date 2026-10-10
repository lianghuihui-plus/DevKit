'use strict';

const fs = require('fs');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { contractError } = require('../lib/contract-utils');
const {
  appProvisioningSha,
  initialStatePreflightSha,
  initialStateRequirementSha,
  preparationPolicySha,
  validateAppProvisioning,
  validateInitialStatePreflight,
  validateInitialStateRequirement,
  validatePreparationPolicy,
} = require('../lib/app-provisioning');
const { sourceSha, validateCaseContract } = require('../execution/contracts/case-contract');
const { allocateExecutionId, atomicWrite, readJson, writeJsonAtomic, withFileLock } = require('../lib/execution-lifecycle');
const { assertWorkspace } = require('../lib/workspace');
const { signature } = require('../lib/agent-facing-signature');
const runtimeCore = require('./runtime-core');
const store = require('./store');
const { createValidationProfile, PROFILE_FILE } = require('../execution/contracts/validation-profile-contract');
const {
  AGENT_OPERATIONS,
  isSupportedBroker,
} = require('./runtime-operation-contract');

const EXECUTION_SCHEMA_VERSION = 14;

const STARTUP_GUIDE = Object.freeze([
  '直接使用本 Brief 的 case.source、casePrompt、executionPrinciples、scene 和 caseFlow；启动时不要预读本地参考文档。',
  '通读 case.source，用 plan 建立 Baseline Case Flow；已有 caseFlow 时先核对并按需修订。',
  'Baseline 后调用一次 queryCapabilities；首次业务动作前完成。',
  'Brief scene 缺失或可能变化时调用 observe；随后选择 act 或 runSequence。',
  '只有当前方法字段不足或 Runtime 返回 documentationRef 时，才定向读取对应方法或错误文档。',
]);

const EXECUTION_PRINCIPLES = Object.freeze([
  '原始用例是唯一业务目标；完整阅读并保留若、如果、可选、可能、无需、跳过、直到等限定词，Case Flow 不能替代、缩小或改写原意。',
  '同一事实的不同取值都可进入正常路径时建 DECISION，分支内验证建 CONDITIONAL CHECK；不得把条件检查改成 REQUIRED CHECK。',
  'Baseline 冻结原意；每条正常 END 路径必须能处置 REQUIRED CHECK，未进入分支的 CONDITIONAL CHECK 记 NOT_APPLICABLE，不新增原文未要求的检查点。',
  'Working Flow 表达实际路径；Scene、动作效果、环境或原文理解变化时可修订路线，但不得改写 Baseline CHECK。',
  '同一意图可用 act 或 runSequence 时优先 runSequence；瞬态结果在同一 sequence 中按业务时序使用两次 SCREENSHOT_ONLY，最终完整 Scene 不能替代。',
  '动作结果必须用新 Scene、previousAction 或 sequence result 核验；技术成功不证明业务成功，业务结论通过 recordResult 保存。',
  'ACTION_OUTCOME_UNKNOWN 和 CAPABILITY_OUTCOME_UNKNOWN 禁止自动重放，先观察或调查外部状态。',
  'PASS 和 FAIL 必须有直接支持 CHECK 的可靠业务证据；技术异常不能改报产品 FAIL，证据冲突或覆盖不足用 INCONCLUSIVE，有效技术事实可支撑 BLOCKED。',
  '只有覆盖目标可能范围并确认边界后才能判断不存在；否则披露搜索范围或使用 INCONCLUSIVE。',
  '出现预期不符、操作无效果、异常反复、原因不明或无法可靠判断时优先尽早 knowledge；无适用候选仍按现场证据判断。',
  'NOT_RUN 仅在必要条件于 execution 权限、事实和能力内无法建立、无安全合理路径、尚未验证相应业务 CHECK、且已有 Scene 或技术事实说明原因时使用。',
  '正常结束用 finish(mode="complete")；收口前核对条件、分支、范围、CHECK、证据和不确定项。',
]);

function createBoundAgentFacingClient(execDir) {
  const entry = path.join(execDir, 'agent-facing-client.js');
  const client = path.resolve(__dirname, 'agent-facing-client.js');
  const content = `#!/usr/bin/env node\n'use strict';\nrequire(${JSON.stringify(client)}).main(process.argv.slice(2), { execDir: ${JSON.stringify(path.resolve(execDir))} });\n`;
  atomicWrite(entry, content);
  fs.chmodSync(entry, 0o755);
  return entry;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildCaseBrief(executionDir, execution, caseJson, sourceText, runtime, scene = null, dispatchSequence = 1) {
  const preparation = runtimeCore.runtimeStatus(executionDir).preparation;
  const dispatchBound = Boolean(execution.batchId && runtime.sessionRef?.statePath);
  const command = dispatchBound
    ? `${shellQuote(runtime.entry)} --dispatch-sequence ${dispatchSequence}`
    : shellQuote(runtime.entry);
  const fullScene = store.readCurrentScene(executionDir) || scene;
  const agentContract = require('./agent-facing-contract');
  const caseFlow = require('./case-flow-service').current(executionDir);
  const initialState = agentContract.projectInitialState(execution, preparation);
  return {
    case: {
      caseNo: caseJson.identity.caseNo || caseJson.identity.caseKey,
      caseKey: caseJson.identity.caseKey,
      source: sourceText,
    },
    target: {
      platform: execution.platform,
      app: execution.targetBinding.appName || execution.targetBinding.appId,
    },
    initialState,
    runtime: {
      interfaceKind: agentContract.AGENT_FACING_INTERFACE_KIND,
      protocol: agentContract.AGENT_FACING_PROTOCOL,
      command,
      documentation: 'references/case-runtime.md',
      startup: [...STARTUP_GUIDE],
      methodIndex: Object.fromEntries(Object.entries(agentContract.PUBLIC_CONTRACT.methods).map(([name, definition]) => [name, {
        summary: definition.summary,
        signature: signature(definition),
      }])),
      invocation: {
        transport: 'STDIN_JSON',
        requestFormat: '{"operation":"<method>","input":{...}}',
        shellTemplate: `${command} <<'MAVT_REQUEST'\n<REQUEST_JSON>\nMAVT_REQUEST`,
        rules: [
          '原样保留 shellTemplate 第一行的完整 runtime.command，只替换 <REQUEST_JSON>。不得重建客户端路径、删改 --dispatch-sequence 或追加位置参数。',
          'REQUEST_JSON 直接使用 JSON.stringify 等价的单个 JSON 对象；不要使用 Buffer、base64 或 shell 字符串拼接。',
          '单引号、中文、$ 和反引号可直接放入 JSON 字符串；带单引号的 heredoc 分隔符会阻止 shell 展开。',
        ],
      },
    },
    executionPrinciples: [...EXECUTION_PRINCIPLES],
    caseFlow,
    ...(caseFlow ? { caseFlowRef: require('./agent-resource-store').publishEvent(executionDir, 'caseFlow', caseFlow).data.ref } : {}),
    scene: fullScene ? require('./agent-resource-store').publishScene(executionDir, fullScene.sceneId).data.content : null,
  };
}

function deriveCaseBrief(executionDir, dispatchSequence = 1) {
  const resolved = path.resolve(executionDir);
  const execution = store.loadExecution(resolved, { allowFinalized: true });
  const sourceText = fs.readFileSync(path.join(resolved, 'source.snapshot.md'), 'utf8');
  const caseJson = readJson(path.join(resolved, 'case.snapshot.json'), null);
  validateCaseContract(caseJson);
  if (sourceSha(sourceText) !== execution.sourceSha || caseJson.identity.sourceSha !== execution.sourceSha
    || caseJson.contractSha !== execution.contractSha) {
    throw contractError('CASE_BRIEF_SOURCE_INVALID', 'execution snapshots do not match the frozen execution binding');
  }
  const runtime = readJson(path.join(resolved, 'runtime.json'), null);
  const expectedAgentEntry = path.join(resolved, 'agent-facing-client.js');
  if (!runtime || runtime.executionId !== execution.executionId || runtime.entry !== expectedAgentEntry
    || !fs.existsSync(expectedAgentEntry) || !isSupportedBroker(runtime.broker)) {
    throw contractError('CASE_RUNTIME_BINDING_INVALID', 'Case Runtime client does not match the execution');
  }
  return buildCaseBrief(resolved, execution, caseJson, sourceText, runtime, store.readCurrentScene(resolved), dispatchSequence);
}

function createExecution(options) {
  assertWorkspace(options.workspaceRoot, { allowTest: true });
  validateCaseContract(options.caseJson);
  const frozenSourceSha = sourceSha(options.sourceText);
  if (frozenSourceSha !== options.caseJson.identity.sourceSha) throw contractError('EXECUTION_SOURCE_CHANGED', 'source text does not match the case contract');
  const appProvisioning = validateAppProvisioning(options.appProvisioning, {
    workspaceRoot: options.workspaceRoot,
    platform: options.platform,
    appId: options.targetBinding.appId,
    deviceType: options.targetBinding.deviceType,
  });
  const preparationPolicy = validatePreparationPolicy(options.preparationPolicy);
  const initialStateRequirement = validateInitialStateRequirement(options.initialStateRequirement);
  const frozenProvisioningSha = appProvisioningSha(appProvisioning);
  const frozenPolicySha = preparationPolicySha(preparationPolicy);
  const frozenRequirementSha = initialStateRequirementSha(initialStateRequirement);
  if (options.appProvisioningSha && options.appProvisioningSha !== frozenProvisioningSha) throw contractError('APP_PROVISIONING_CHANGED', 'execution App provisioning hash does not match');
  if (options.preparationPolicySha && options.preparationPolicySha !== frozenPolicySha) throw contractError('PREPARATION_POLICY_CHANGED', 'execution preparation policy hash does not match');
  if (options.initialStateRequirementSha && options.initialStateRequirementSha !== frozenRequirementSha) throw contractError('INITIAL_STATE_REQUIREMENT_CHANGED', 'execution initial state requirement hash does not match');
  const initialStatePreflight = validateInitialStatePreflight(options.initialStatePreflight, {
    requirement: initialStateRequirement,
    preparationPolicy,
    appProvisioning,
    platform: options.platform,
    provisioningOptions: {
      workspaceRoot: options.workspaceRoot,
      platform: options.platform,
      appId: options.targetBinding.appId,
      deviceType: options.targetBinding.deviceType,
    },
  });
  if (options.initialStatePreflightSha && options.initialStatePreflightSha !== initialStatePreflightSha(initialStatePreflight)) {
    throw contractError('INITIAL_STATE_PREFLIGHT_CHANGED', 'execution initial state preflight hash does not match');
  }
  const warmSessionId = options.warmSessionId || 'warm-0001';
  const warmSessionEpoch = options.warmSessionEpoch || 1;
  if (!/^warm-[0-9]{4,}$/.test(warmSessionId) || !Number.isInteger(warmSessionEpoch) || warmSessionEpoch < 1) {
    throw contractError('WARM_SESSION_INVALID', 'execution warm session identity is invalid');
  }
  return withFileLock(path.join(options.runtimeDir, 'executions', '.create.lock'), () => {
    const executionId = options.executionId || allocateExecutionId(options.runtimeDir, options);
    const execDir = path.join(options.runtimeDir, 'executions', executionId);
    options.execDir = execDir;
    if (fs.existsSync(execDir)) throw contractError('EXECUTION_ALREADY_EXISTS', `execution already exists: ${executionId}`);
    fs.mkdirSync(path.dirname(execDir), { recursive: true });
    const stagingDir = path.join(path.dirname(execDir), `.${executionId}.creating`);
    fs.mkdirSync(stagingDir, { recursive: false });
    try {
      for (const name of ['screenshots', 'layouts', 'logs', 'scenes', 'operations', 'transactions', 'knowledge', 'telemetry']) {
        fs.mkdirSync(path.join(stagingDir, name));
      }
      atomicWrite(path.join(stagingDir, 'source.snapshot.md'), options.sourceText);
      writeJsonAtomic(path.join(stagingDir, 'case.snapshot.json'), options.caseJson);
      const validationProfile = createValidationProfile();
      writeJsonAtomic(path.join(stagingDir, PROFILE_FILE), validationProfile);
      const startedAt = options.now || new Date().toISOString();
      const execution = {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        runtime: 'case-runtime',
        executionId,
        batchId: options.batchId,
        platform: options.platform,
        runtimeSha: options.runtimeSha,
        adapterSha: options.adapterSha,
        caseProtocolSha: options.caseProtocolSha,
        coordinatorProtocolSha: options.coordinatorProtocolSha,
        contractSha: options.caseJson.contractSha,
        validationProfileSha: validationProfile.profileSha,
        batchContractSha: options.batchContractSha,
        executionRequestSha: options.executionRequestSha,
        interactionPolicy: options.interactionPolicy,
        targetBinding: { ...options.targetBinding },
        targetBindingSha: bindingSha(options.targetBinding),
        appProvisioning,
        appProvisioningSha: frozenProvisioningSha,
        preparationPolicy,
        preparationPolicySha: frozenPolicySha,
        initialStateRequirement,
        initialStateRequirementSha: frozenRequirementSha,
        initialStatePreflight,
        initialStatePreflightSha: initialStatePreflight.preflightSha,
        warmSessionIdStart: warmSessionId,
        warmSessionId,
        warmSessionEpochStart: warmSessionEpoch,
        warmSessionEpoch,
        warmSessionGeneration: options.warmSessionGeneration,
        warmSessionGenerationStart: options.warmSessionGeneration,
        warmSessionReused: options.warmSessionReused === true,
        executionRecoveryCount: 0,
        batchRecoveryCountAtStart: options.batchRecoveryCountAtStart || 0,
        batchRecoveryCountAtEnd: options.batchRecoveryCountAtStart || 0,
        ...(options.caseProcessingStartedAt ? { caseProcessingStartedAt: options.caseProcessingStartedAt } : {}),
        sourceSha: frozenSourceSha,
        startedAt,
        status: 'RUNNING',
        lifecycle: 'RUNNING',
        finalized: false,
      };
      writeJsonAtomic(path.join(stagingDir, 'execution.json'), execution);
      writeJsonAtomic(path.join(stagingDir, 'binding.snapshot.json'), {
        schemaVersion: 1,
        binding: execution.targetBinding,
        bindingSha: execution.targetBindingSha,
        batchContractSha: execution.batchContractSha,
      });
      fs.renameSync(stagingDir, execDir);
      const entry = createBoundAgentFacingClient(execDir);
      writeJsonAtomic(path.join(execDir, 'runtime.json'), {
        schemaVersion: 1,
        executionId,
        status: 'READY',
        entry,
        sessionRef: options.sessionRef || null,
        knowledgeRoots: (options.knowledgeRoots || []).map((root) => path.resolve(root)),
        broker: {
          allowedOperations: AGENT_OPERATIONS,
        },
        boundAt: startedAt,
      });
      store.appendEvent(execDir, 'executionStarted', { generation: execution.warmSessionGeneration }, { now: startedAt });
      const observed = options.initialObserve === false
        ? { status: 'READY', scene: null }
        : runtimeCore.execute(execDir, { operation: 'observe', purpose: 'INITIAL_SCENE' }, options.runtimeOptions || {});
      const brief = buildCaseBrief(execDir, execution, options.caseJson, options.sourceText, readJson(path.join(execDir, 'runtime.json')), observed.scene || null);
      return { executionId, execDir, execution: readJson(path.join(execDir, 'execution.json')), runtime: readJson(path.join(execDir, 'runtime.json')), brief, scene: observed.scene || null, runtimeStatus: observed.status };
    } catch (error) {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }, { now: options.now });
}

function establishInitialState({ executionDir, runtimeOptions = {} }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  const completeInitialState = () => store.updateExecution(executionDir, (current) => (
    current.initialStateCompletedAt ? current : {
      ...current,
      initialStateCompletedAt: runtimeOptions.now || new Date().toISOString(),
    }
  ));
  const requirement = validateInitialStateRequirement(execution.initialStateRequirement);
  if (execution.initialStateRequirementSha !== initialStateRequirementSha(requirement)) {
    throw contractError('INITIAL_STATE_REQUIREMENT_CHANGED', 'execution initial state requirement changed');
  }
  if (execution.finalized || requirement.targetState === 'KEEP_EXISTING') {
    if (!execution.finalized) completeInitialState();
    return { status: execution.finalized ? execution.status : 'READY', agentRequired: execution.finalized !== true };
  }
  const current = runtimeCore.runtimeStatus(executionDir);
  if (current.preparation?.status === 'SATISFIED') {
    completeInitialState();
    return { status: 'READY', agentRequired: true, scene: current.scene };
  }
  const prepared = runtimeCore.execute(executionDir, {
    operation: 'prepare',
    preparation: { targetState: requirement.targetState },
  }, runtimeOptions);
  if (prepared.status === 'SCENE') {
    completeInitialState();
    return { status: 'READY', agentRequired: true, scene: prepared.scene, preparation: prepared.preparation };
  }
  if (prepared.status === 'TECHNICAL' && prepared.code === 'APP_INITIAL_STATE_UNAVAILABLE') {
    const error = contractError('APP_INITIAL_STATE_UNAVAILABLE', prepared.message || `Required initial state ${requirement.targetState} could not be established`);
    error.technicalFactRef = prepared.technicalFactRef || null;
    throw error;
  }
  throw contractError('INITIAL_STATE_PREPARATION_FAILED', prepared.message || `unexpected preparation status: ${prepared.status}`);
}

function resumeExecution({ executionDir }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  const brief = deriveCaseBrief(executionDir);
  return { executionDir: path.resolve(executionDir), execution, brief, status: runtimeCore.runtimeStatus(executionDir) };
}

function buildContinuationBrief({ executionDir, reason }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  const events = store.events(executionDir);
  const sequence = events.filter((event) => event.type === 'agentContinuation').length + 2;
  const initial = deriveCaseBrief(executionDir, sequence);
  const narrative = require('./narrative-service').narrativeStatus(executionDir);
  const reviewed = new Set(events.filter((event) => event.type === 'knowledgeReviewed').map((event) => event.queryId));
  const pendingKnowledgeReviews = events.filter((event) => event.type === 'knowledgeQueried' && !reviewed.has(event.queryId))
    .map((event) => require('./knowledge-review').projectPendingKnowledgeReview(event));
  const lastAction = events.filter((event) => ['actionCompleted', 'actionOutcomeUnknown'].includes(event.type)).at(-1) || null;
  const technical = require('../lib/technical-facts');
  const unresolvedTechnicalFacts = technical.technicalFacts(events)
    .filter((event) => technical.technicalFactState(event, events, execution).state === 'VALID')
    .map((event) => ({ technicalFactRef: require('./agent-resource-store').publishEvent(executionDir, 'technicalFact', event).data.ref,
      code: event.code, checkNodeIds: event.expectationRefs || [] }));
  const status = runtimeCore.runtimeStatus(executionDir);
  const projectedPendingReviews = pendingKnowledgeReviews.map((pending) => {
    const resources = require('./agent-resource-store').provideOperationResources(executionDir,
      { status: 'KNOWLEDGE', queryId: pending.queryId }, { operation: 'knowledge', input: { mode: 'query' } });
    return { queryId: pending.queryId, knowledgeQueryRef: resources.result.knowledgeQueryRef,
      candidateSetRef: resources.result.candidateSetRef, candidateIds: (pending.candidates || []).map((item) => item.entryId),
      reviewRequired: true };
  });
  return {
    ...initial,
    mode: 'CONTINUATION',
    continuation: {
      reason: String(reason || 'native Agent handle is unavailable'),
      sequence,
    },
    scene: initial.scene,
    resumeState: {
      executionStatus: execution.status,
      remainingMs: status.remainingMs,
      ...(status.preparation ? { preparation: status.preparation } : {}),
      caseFlow: narrative.caseFlow,
      lastAction: lastAction ? { operationId: lastAction.operationId, type: lastAction.type } : null,
      unresolvedTechnicalFacts,
      pendingKnowledgeReviews: projectedPendingReviews,
    },
  };
}

function reconcileExecution({ executionDir, runtimeOptions = {} }) {
  store.loadExecution(executionDir, { allowFinalized: true });
  const reconciled = runtimeCore.reconcileExecution(executionDir, runtimeOptions);
  return { execution: store.loadExecution(executionDir, { allowFinalized: true }), ...reconciled };
}

function recordAgentContinuation({ executionDir, reason, now }) {
  const execution = store.loadExecution(executionDir);
  const event = store.appendEvent(executionDir, 'agentContinuation', {
    reason: String(reason || 'native Agent handle is unavailable'),
  }, { now });
  return { executionId: execution.executionId, event };
}

function recordTimingAnchor({ executionDir, field, now, lockHeld = false }) {
  const allowed = new Set(['handoffReadyAt', 'handoffConsumedAt']);
  if (!allowed.has(field)) throw contractError('EXECUTION_TIMING_INVALID', `unsupported timing anchor: ${field}`);
  const update = () => store.updateExecution(executionDir, (execution) => (
    execution[field] ? execution : { ...execution, [field]: now || new Date().toISOString() }
  ));
  return lockHeld ? update() : store.withRuntimeLock(executionDir, update, { now });
}

function readCompletion({ executionDir }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  return {
    ready: execution.finalized === true,
    execution,
    result: readJson(path.join(executionDir, 'result.json'), null),
    metrics: readJson(path.join(executionDir, 'metrics.json'), null),
    completion: readJson(path.join(executionDir, 'completion.json'), null),
  };
}

function commitExecution({ executionDir }) {
  const completion = readCompletion({ executionDir });
  if (!completion.ready || !completion.result || !completion.metrics) throw contractError('EXECUTION_NOT_FINALIZED', 'execution is not ready to commit');
  return completion;
}

function withCompletionPublication({ executionDir, ...options }, publish) {
  // Batch enters through the lifecycle facade. Recovery of a finalized finish's
  // catalog is delegated to the Facade resource publisher, never Runtime Core.
  return store.withRuntimeLock(executionDir, () => {
    const committed = commitExecution({ executionDir });
    require('./agent-resource-store').publishFinalResources(executionDir);
    return publish(committed);
  }, options);
}

function cancelExecution({ executionDir, reason, now }) {
  return store.withRuntimeLock(executionDir, () => {
    const execution = store.loadExecution(executionDir, { allowFinalized: true });
    if (execution.status === 'CANCELLED') return { execution, idempotent: true };
    if (execution.finalized === true) throw contractError('EXECUTION_ALREADY_FINALIZED', 'a completed execution cannot be cancelled');
    const cancelledAt = now || new Date().toISOString();
    const cancellationReason = String(reason || 'execution cancelled by user').trim();
    store.appendEvent(executionDir, 'executionCancelled', {
      reason: cancellationReason,
      pendingTransactions: fs.existsSync(store.paths(executionDir).transactions)
        ? fs.readdirSync(store.paths(executionDir).transactions).filter((name) => name.endsWith('.draft.json')).sort() : [],
    }, { now: cancelledAt });
    const cancelled = store.updateExecution(executionDir, {
      ...execution,
      status: 'CANCELLED',
      lifecycle: 'TERMINATED',
      executionStatus: 'CANCELLED',
      finalized: true,
      endedAt: cancelledAt,
      cancellation: { reason: cancellationReason, cancelledAt },
    });
    const runtime = readJson(path.join(executionDir, 'runtime.json'), null);
    if (runtime) writeJsonAtomic(path.join(executionDir, 'runtime.json'), { ...runtime, status: 'CANCELLED', completedAt: cancelledAt });
    return { execution: cancelled, idempotent: false };
  }, { now });
}

module.exports = { EXECUTION_SCHEMA_VERSION, buildContinuationBrief, cancelExecution, commitExecution, withCompletionPublication, createExecution, establishInitialState, readCompletion, reconcileExecution, recordAgentContinuation, recordTimingAnchor, resumeExecution };

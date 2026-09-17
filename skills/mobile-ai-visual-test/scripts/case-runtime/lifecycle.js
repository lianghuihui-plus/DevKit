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
const runtimeCore = require('./runtime-core');
const store = require('./store');
const { createValidationProfile, PROFILE_FILE } = require('../execution/contracts/validation-profile-contract');
const {
  AGENT_OPERATIONS,
  isSupportedBroker,
} = require('./runtime-operation-contract');

const EXECUTION_SCHEMA_VERSION = 12;

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
    },
    caseFlow,
    scene: agentContract.projectScene(fullScene),
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
    .map((event) => ({ technicalFactRef: event.technicalFactRef, code: event.code, message: event.message, checkNodeRefs: event.expectationRefs || [] }));
  const status = runtimeCore.runtimeStatus(executionDir);
  const projectedPendingReviews = pendingKnowledgeReviews.map((pending) => ({
    queryId: pending.queryId,
    query: pending.query,
    candidateCount: pending.candidateCount,
    checkNodeRefs: pending.expectationRefs || [],
    candidates: pending.candidates || [],
  }));
  return {
    ...initial,
    mode: 'CONTINUATION',
    continuation: {
      reason: String(reason || 'native Agent handle is unavailable'),
      sequence,
    },
    scene: require('./agent-facing-contract').projectScene(store.readCurrentScene(executionDir)),
    resumeState: {
      executionStatus: execution.status,
      remainingMs: status.remainingMs,
      ...(status.preparation ? { preparation: status.preparation } : {}),
      caseFlow: narrative.caseFlow,
      lastAction,
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

function recordTimingAnchor({ executionDir, field, now }) {
  const allowed = new Set(['handoffReadyAt', 'handoffConsumedAt']);
  if (!allowed.has(field)) throw contractError('EXECUTION_TIMING_INVALID', `unsupported timing anchor: ${field}`);
  return store.withRuntimeLock(executionDir, () => store.updateExecution(executionDir, (execution) => (
    execution[field] ? execution : { ...execution, [field]: now || new Date().toISOString() }
  )), { now });
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

module.exports = { EXECUTION_SCHEMA_VERSION, buildContinuationBrief, cancelExecution, commitExecution, createExecution, establishInitialState, readCompletion, reconcileExecution, recordAgentContinuation, recordTimingAnchor, resumeExecution };

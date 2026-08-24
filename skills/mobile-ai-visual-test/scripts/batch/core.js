'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureId, ensureObject } = require('../lib/contract-utils');
const {
  assertBatchImplementation,
  createBatchContract,
} = require('../lib/batch-contract');
const {
  appendJsonl,
  allocateExecutionId,
  findActiveExecutions,
  readJson,
  recoverExecution,
  withFileLock,
  writeJsonAtomic,
} = require('../lib/execution-lifecycle');
const { completionPaths, sha256File, validatePublishedCompletion } = require('../lib/completion-contract');
const { collectEvidence } = require('../lib/execution-evidence');
const { validateResultKnowledgeSnapshots } = require('../lib/knowledge-snapshot');
const {
  loadExecutionRequest,
  resolveExecutionTargets,
} = require('../lib/run-control');
const {
  createWarmSession,
  markBootstrapFailed,
  markBootstrapReady,
  markClosed,
  markDegraded,
  markRecovered,
  validateWarmSession,
} = require('../lib/warm-session-contract');
const {
  bindAgentRuntime,
  createExecution,
  knowledgeQueryDraftIds,
  operationDraftIds,
  recordRuntimeEvent,
  sealTimeLimit,
  stepDraftIds,
  timelineEvents,
  turnDraftIds,
} = require('../execution/core');
const { createAgentRequest, rebindAgentRequestGeneration } = require('../agent/core');
const { clearControlRequest, controlRequestPath } = require('../agent/control-request');
const { recoverInternalTransactions } = require('./internal-recovery');
const { validateAgentRequest, validateAgentResult } = require('../lib/agent-driven-contract');
const { assertWorkspace } = require('../lib/workspace');
const { buildExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');
const { buildContract } = require('../build-agent-contract');

const BATCH_SCHEMA_VERSION = 3;
const RECOVERY_TRIGGERS = new Set([
  'SOURCE_REQUIRED_COLD_START',
  'AGENT_DECIDED_RESTART',
  'APP_CRASH',
  'SYSTEM_KILLED',
  'UNKNOWN_EXIT',
  'APP_UNRESPONSIVE',
  'AUTOMATION_SESSION_LOST',
]);

function isIncidentRecovery(triggerType) {
  return !['SOURCE_REQUIRED_COLD_START', 'AGENT_DECIDED_RESTART'].includes(triggerType);
}

function assertBatchWorkspace(root) {
  try {
    return assertWorkspace(root, { allowTest: true });
  } catch (error) {
    throw contractError(error.code || 'WORKSPACE_INVALID', error.message);
  }
}

function batchPaths(workspaceRoot, batchId) {
  ensureId(batchId, 'batchId', 'BATCH_INVALID');
  const batchDir = path.join(workspaceRoot, 'runs', batchId);
  return {
    batchDir,
    state: path.join(batchDir, 'batch.json'),
    contract: path.join(batchDir, 'contract.json'),
    events: path.join(batchDir, 'events.jsonl'),
    lock: path.join(batchDir, '.write.lock'),
    initDraft: path.join(batchDir, 'batch-init.draft.json'),
    bootstrapDraft: path.join(batchDir, 'bootstrap.draft.json'),
    caseStartDraft: path.join(batchDir, 'case-start.draft.json'),
    caseCommitDraft: path.join(batchDir, 'case-commit.draft.json'),
    recoveryDraft: path.join(batchDir, 'recovery.draft.json'),
  };
}

function caseRuntimeDir(caseDir, platform) {
  return path.join(caseDir, 'platforms', platform);
}

function loadBatch(workspaceRoot, batchId, implementationSha, protocols = {}) {
  assertBatchWorkspace(workspaceRoot);
  const paths = batchPaths(workspaceRoot, batchId);
  const state = readJson(paths.state, null);
  const contract = readJson(paths.contract, null);
  if (!state || !contract) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${batchId}`);
  if (state.schemaVersion !== BATCH_SCHEMA_VERSION) throw contractError('BATCH_SCHEMA_UNSUPPORTED', `unsupported batch schema: ${state.schemaVersion ?? 'missing'}`);
  assertBatchImplementation(contract, implementationSha, protocols);
  if (state.batchId !== contract.batchId || state.contractSha !== contract.contractSha || state.implementationSha !== contract.implementationSha) {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its frozen contract');
  }
  if (state.executionRequestId !== contract.executionRequestId || state.executionRequestSha !== contract.executionRequestSha
    || state.mode !== contract.mode || state.interactionPolicy !== 'UNATTENDED' || contract.interactionPolicy !== 'UNATTENDED') {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its explicit unattended execution request');
  }
  const stateTargets = Array.isArray(state.cases)
    ? state.cases.map((entry) => ({
      order: entry.order,
      caseKey: entry.caseKey,
      caseDir: entry.caseDir,
      snapshotPath: entry.snapshotPath,
      sourceSha: entry.sourceSha,
      caseContractSha: entry.caseContractSha,
    }))
    : null;
  if (!stateTargets || canonicalJson(stateTargets) !== canonicalJson(contract.targets)) {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch cases do not match the frozen targets');
  }
  validateWarmSession(state.warmSession);
  return { paths, state, contract };
}

function saveBatch(paths, state, now) {
  state.updatedAt = now || new Date().toISOString();
  writeJsonAtomic(paths.state, state);
  return state;
}

function hasBatchEvent(eventsPath, predicate) {
  if (!fs.existsSync(eventsPath)) return false;
  return fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line);
      return predicate(event);
    } catch (error) {
      return false;
    }
  });
}

function hasRecoveryEvent(eventsPath, recoveryId) {
  return hasBatchEvent(eventsPath, (event) => event.type === 'appRecovery' && event.recoveryId === recoveryId);
}

function stopBatch(paths, state, action, failureCode, reason, options = {}) {
  const time = options.now || new Date().toISOString();
  if (state.status !== 'BLOCKED') {
    state.status = 'BLOCKED';
    state.failureCode = failureCode;
    state.reason = reason;
    state.stoppedAt = time;
    if (options.stopContext) state.stopContext = options.stopContext;
    if (state.warmSession?.status !== 'CLOSED' && state.warmSession?.status !== 'DEGRADED') {
      state.warmSession = markDegraded(state.warmSession, time, { failureCode, reason });
    }
    saveBatch(paths, state, time);
  }
  const eventId = `batch-stopped-${state.batchId}`;
  if (!hasBatchEvent(paths.events, (event) => event.eventId === eventId)) {
    appendJsonl(paths.events, {
      schemaVersion: 1,
      eventId,
      time,
      type: 'batchStopped',
      action,
      failureCode: state.failureCode || failureCode,
      reason: state.reason || reason,
      ...(state.stopContext ? { stopContext: state.stopContext } : {}),
      ...(options.executions ? { executions: options.executions } : {}),
    });
  }
  return { action, state, reason: state.reason || reason, ...(options.executions ? { executions: options.executions } : {}) };
}

function completeRecoveryCommit(paths, recovery) {
  if (!hasRecoveryEvent(paths.events, recovery.recoveryId)) {
    appendJsonl(paths.events, { schemaVersion: 1, type: 'appRecovery', ...recovery });
  }
  const draft = readJson(paths.recoveryDraft, null);
  if (draft?.request?.recoveryId === recovery.recoveryId) fs.unlinkSync(paths.recoveryDraft);
}

function completeRecoveryTimeline(execDir, recovery, implementationSha, now) {
  if (isIncidentRecovery(recovery.triggerType)) {
    recordRuntimeEvent(execDir, {
      type: 'runtimeIncident',
      incidentId: recovery.incidentId,
      triggerType: recovery.triggerType,
      category: recovery.incidentCategory,
      evidenceRefs: recovery.evidenceRefs,
      reason: recovery.incidentReason,
    }, { implementationSha, now });
  }
  recordRuntimeEvent(execDir, {
    type: 'recoveryStarted', recoveryId: recovery.recoveryId, incidentId: recovery.incidentId || null,
  }, { implementationSha, now });
  recordRuntimeEvent(execDir, {
    type: 'recoveryCompleted', recoveryId: recovery.recoveryId, incidentId: recovery.incidentId || null,
    status: recovery.status, warmSessionGeneration: recovery.warmSessionGeneration,
    triggerType: recovery.triggerType,
    checkpointId: recovery.checkpointId,
    evidenceRefs: recovery.evidenceRefs || [],
    decisionReason: recovery.decisionReason || null,
    reason: recovery.reason || recovery.incidentReason || null,
    failureCode: recovery.failureCode || null,
  }, { implementationSha, now });
}

function recoveryExecutionDir(state, contract, executionId) {
  const item = state.cases.find((entry) => entry.executionId === executionId);
  if (!item) throw contractError('RECOVERY_BINDING_MISMATCH', 'recovery execution does not belong to this batch');
  return {
    item,
    execDir: path.join(caseRuntimeDir(item.caseDir, contract.binding.platform), 'executions', executionId),
  };
}

function recoveryTimelineComplete(execDir, recovery) {
  if (!execDir || !fs.existsSync(path.join(execDir, 'execution.json'))) return false;
  const events = timelineEvents(execDir);
  const started = events.some((entry) => entry.type === 'recoveryStarted' && entry.recoveryId === recovery.recoveryId);
  const completed = events.some((entry) => entry.type === 'recoveryCompleted' && entry.recoveryId === recovery.recoveryId);
  const incident = !isIncidentRecovery(recovery.triggerType)
    || events.some((entry) => entry.type === 'runtimeIncident' && entry.incidentId === recovery.incidentId);
  return started && completed && incident;
}

function assertRecoveriesCommitted(paths, state, execDir, executionId) {
  if (fs.existsSync(paths.recoveryDraft)) throw contractError('BATCH_RECOVERY_COMMIT_INCOMPLETE', 'active recovery draft must be committed before the case');
  const pending = state.recoveries.filter((recovery) => recovery.executionId === executionId)
    .filter((recovery) => !hasRecoveryEvent(paths.events, recovery.recoveryId) || !recoveryTimelineComplete(execDir, recovery));
  if (pending.length) {
    throw contractError('BATCH_RECOVERY_COMMIT_INCOMPLETE', `recovery commit is incomplete: ${pending.map((entry) => entry.recoveryId).join(', ')}`);
  }
}

function protocolBindings(options) {
  return {
    caseExecutorProtocolSha: options.caseExecutorProtocolSha,
    coordinatorProtocolSha: options.coordinatorProtocolSha,
  };
}

function initializeBatch(options) {
  assertBatchWorkspace(options.workspaceRoot);
  if (options.binding !== undefined || options.targets !== undefined) {
    throw contractError('EXECUTION_REQUEST_REQUIRED', 'batch init does not accept direct binding or targets');
  }
  const paths = batchPaths(options.workspaceRoot, options.batchId);
  const executionRequest = loadExecutionRequest(options.workspaceRoot, options.batchId);
  const targets = resolveExecutionTargets(options.workspaceRoot, executionRequest.targets, options.batchId);
  if (executionRequest.implementationSha !== options.implementationSha) {
    throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'execution request belongs to a different implementation');
  }
  if ((options.caseExecutorProtocolSha && executionRequest.caseExecutorProtocolSha !== options.caseExecutorProtocolSha)
    || (options.coordinatorProtocolSha && executionRequest.coordinatorProtocolSha !== options.coordinatorProtocolSha)) {
    throw contractError('BATCH_PROTOCOL_MISMATCH', 'execution request belongs to a different Agent protocol');
  }
  let draft = readJson(paths.initDraft, null);
  const existingState = readJson(paths.state, null);
  const existingContract = readJson(paths.contract, null);
  if (!draft && (existingState || existingContract)) {
    if (!existingState || !existingContract) throw contractError('BATCH_INIT_CORRUPTED', 'partial batch initialization has no recovery draft');
    const loaded = loadBatch(options.workspaceRoot, options.batchId, options.implementationSha, protocolBindings(options));
    if (executionRequest.requestSha !== loaded.contract.executionRequestSha
      || canonicalJson(targets) !== canonicalJson(loaded.contract.targets)) {
      throw contractError('BATCH_BINDING_MISMATCH', 'existing batch cannot be initialized with a different execution request');
    }
    if (!hasBatchEvent(paths.events, (event) => event.type === 'batchInitialized' && event.batchId === options.batchId)) {
      appendJsonl(paths.events, {
        schemaVersion: 1, eventId: `batch-initialized-${options.batchId}`, time: loaded.state.createdAt,
        type: 'batchInitialized', batchId: loaded.state.batchId, contractSha: loaded.state.contractSha,
        implementationSha: loaded.state.implementationSha, executionRequestSha: loaded.state.executionRequestSha,
        interactionPolicy: loaded.state.interactionPolicy,
      });
    }
    return loaded;
  }
  if (!draft) {
    const contract = createBatchContract({
      batchId: options.batchId,
      implementationSha: options.implementationSha,
      executionRequest: { ...executionRequest, targets },
    });
    const now = options.now || new Date().toISOString();
    const state = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId: options.batchId,
      implementationSha: contract.implementationSha,
      caseExecutorProtocolSha: contract.caseExecutorProtocolSha,
      coordinatorProtocolSha: contract.coordinatorProtocolSha,
      contractSha: contract.contractSha,
      executionRequestId: contract.executionRequestId,
      executionRequestSha: contract.executionRequestSha,
      mode: contract.mode,
      interactionPolicy: contract.interactionPolicy,
      status: 'INITIALIZING',
      currentIndex: 0,
      warmSession: createWarmSession(contract.binding, now),
      cases: targets.map((target) => ({ ...target, status: 'PENDING', executionId: null, runtimePath: null })),
      recoveries: [],
      createdAt: now,
      updatedAt: now,
    };
    draft = { schemaVersion: 1, status: 'STARTED', contract, state };
    fs.mkdirSync(paths.batchDir, { recursive: true });
    writeJsonAtomic(paths.initDraft, draft);
  }
  if (draft.schemaVersion !== 1 || draft.status !== 'STARTED'
    || draft.contract?.batchId !== options.batchId || draft.state?.batchId !== options.batchId
    || draft.contract?.executionRequestSha !== executionRequest.requestSha
    || canonicalJson(draft.contract?.targets) !== canonicalJson(targets)) {
    throw contractError('BATCH_INIT_DRAFT_INVALID', 'batch initialization draft does not match the execution request');
  }
  if (options.interruptAfter === 'draft') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: draft');
  writeJsonAtomic(paths.contract, draft.contract);
  if (options.interruptAfter === 'contract') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: contract');
  writeJsonAtomic(paths.state, draft.state);
  if (options.interruptAfter === 'state') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: state');
  if (!hasBatchEvent(paths.events, (event) => event.type === 'batchInitialized' && event.batchId === options.batchId)) appendJsonl(paths.events, {
    schemaVersion: 1,
    eventId: `batch-initialized-${options.batchId}`,
    time: draft.state.createdAt,
    type: 'batchInitialized',
    batchId: draft.state.batchId,
    contractSha: draft.state.contractSha,
    implementationSha: draft.state.implementationSha,
    executionRequestSha: draft.state.executionRequestSha,
    interactionPolicy: draft.state.interactionPolicy,
  });
  if (options.interruptAfter === 'event') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: event');
  fs.unlinkSync(paths.initDraft);
  return { paths, state: draft.state, contract: draft.contract };
}

function currentCase(state) {
  return state.cases[state.currentIndex] || null;
}

function assertAdapterResult(result, kind) {
  if (!result || result.ok !== true || result.coldStartVerified !== true || result.startupDisplayVerified !== true) {
    throw contractError(`${kind}_FAILED`, result?.reason || `${kind} did not verify App restart`);
  }
  return result;
}

function bootstrapBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, options.implementationSha, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const { paths, contract } = loaded;
    const state = readJson(paths.state);
    const requestId = 'batch-bootstrap-001';
    let draft = readJson(paths.bootstrapDraft, null);
    if (!draft && state.warmSession.status === 'READY') return { state, alreadyBootstrapped: true };
    if (!draft && state.warmSession.status !== 'INITIALIZING') throw contractError('BATCH_BOOTSTRAP_INVALID', `cannot bootstrap ${state.warmSession.status} warm session`);
    if (!draft) {
      draft = {
        schemaVersion: 1,
        requestId,
        eventId: `batch-bootstrap-${state.batchId}`,
        status: 'STARTED',
        binding: contract.binding,
        createdAt: options.now || new Date().toISOString(),
      };
      writeJsonAtomic(paths.bootstrapDraft, draft);
    }
    if (draft.schemaVersion !== 1 || draft.requestId !== requestId || draft.eventId !== `batch-bootstrap-${state.batchId}`
      || canonicalJson(draft.binding) !== canonicalJson(contract.binding)) {
      throw contractError('BATCH_BOOTSTRAP_BINDING_MISMATCH', 'bootstrap draft does not match the current batch');
    }
    if (!draft.result) {
      try {
        draft.result = options.adapter.restartApp({ requestId, scope: 'batch-bootstrap', binding: contract.binding });
      } catch (error) {
        draft.result = {
          ok: false,
          coldStartVerified: false,
          startupDisplayVerified: false,
          failureCode: error.code || 'ADAPTER_ERROR',
          reason: error.message,
        };
      }
      draft.status = 'ACTION_RECORDED';
      draft.recordedAt = options.now || new Date().toISOString();
      writeJsonAtomic(paths.bootstrapDraft, draft);
    }
    if (options.interruptAfter === 'action') throw new Error('MAVT_BATCH_BOOTSTRAP_INTERRUPTED: action');
    let failure = null;
    try {
      assertAdapterResult(draft.result, 'BATCH_BOOTSTRAP');
    } catch (error) {
      failure = error;
    }
    const commitTime = draft.recordedAt || options.now || new Date().toISOString();
    if (failure) {
      const failureCode = failure.code || 'BATCH_BOOTSTRAP_FAILED';
      if (state.warmSession.status === 'INITIALIZING') {
        state.warmSession = markBootstrapFailed(state.warmSession, commitTime);
        state.status = 'BLOCKED';
        state.failureCode = failureCode;
        state.reason = failure.message;
        saveBatch(paths, state, options.now);
      } else if (state.warmSession.status !== 'DEGRADED' || state.status !== 'BLOCKED'
        || state.failureCode !== failureCode || state.reason !== failure.message) {
        throw contractError('BATCH_BOOTSTRAP_CORRUPTED', 'failed bootstrap draft does not match batch state');
      }
    } else if (state.warmSession.status === 'INITIALIZING') {
      state.warmSession = markBootstrapReady(state.warmSession, commitTime);
      state.status = 'RUNNING';
      saveBatch(paths, state, options.now);
    } else if (state.warmSession.status !== 'READY' || state.status !== 'RUNNING') {
      throw contractError('BATCH_BOOTSTRAP_CORRUPTED', 'successful bootstrap draft does not match batch state');
    }
    if (options.interruptAfter === 'state') throw new Error('MAVT_BATCH_BOOTSTRAP_INTERRUPTED: state');
    if (!hasBatchEvent(paths.events, (event) => event.eventId === draft.eventId)) {
      appendJsonl(paths.events, {
        schemaVersion: 1,
        eventId: draft.eventId,
        time: commitTime,
        type: 'batchBootstrap',
        requestId,
        generation: failure ? 0 : 1,
        outcome: failure ? 'FAILED' : 'SUCCEEDED',
        result: draft.result,
      });
    }
    if (options.interruptAfter === 'event') throw new Error('MAVT_BATCH_BOOTSTRAP_INTERRUPTED: event');
    if (fs.existsSync(paths.bootstrapDraft)) fs.unlinkSync(paths.bootstrapDraft);
    if (failure) throw failure;
    return { state, bootstrapped: true };
  }, { now: options.now });
}

function startCurrentCase(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, options.implementationSha, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    if (state.status !== 'RUNNING' || state.warmSession.status !== 'READY') throw contractError('WARM_SESSION_NOT_READY', 'batch warm session is not ready');
    const item = currentCase(state);
    if (!item) return { state, complete: true };
    if (item.status === 'RUNNING' && !fs.existsSync(loaded.paths.caseStartDraft)) {
      const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
      return {
        state,
        item,
        alreadyStarted: true,
        execDir,
        execution: readJson(path.join(execDir, 'execution.json')),
        runtime: readJson(path.join(execDir, 'agent', 'runtime.json')),
        request: readJson(path.join(execDir, 'agent', 'request.json')),
      };
    }
    if (!['PENDING', 'RUNNING'].includes(item.status)) throw contractError('BATCH_CASE_INVALID', `current case is ${item.status}`);
    const caseJson = readJson(path.join(item.snapshotPath, 'case.snapshot.json'));
    const sourceText = fs.readFileSync(path.join(item.snapshotPath, 'source.snapshot.md'), 'utf8');
    const runtimeDir = caseRuntimeDir(item.caseDir, loaded.contract.binding.platform);
    let draft = readJson(loaded.paths.caseStartDraft, null);
    if (!draft) {
      const executionId = options.executionId || allocateExecutionId(runtimeDir, options);
      draft = {
        schemaVersion: 1,
        eventId: `case-started-${state.batchId}-${item.order}`,
        batchId: state.batchId,
        caseKey: item.caseKey,
        order: item.order,
        executionId,
        sessionId: `session-${executionId}`,
        warmSessionGeneration: state.warmSession.generation,
        createdAt: options.now || new Date().toISOString(),
      };
      writeJsonAtomic(loaded.paths.caseStartDraft, draft);
    }
    if (draft.batchId !== state.batchId || draft.caseKey !== item.caseKey || draft.order !== item.order) {
      throw contractError('CASE_START_BINDING_MISMATCH', 'case start draft does not match the current case');
    }
    const execDir = path.join(runtimeDir, 'executions', draft.executionId);
    let created;
    if (!fs.existsSync(path.join(execDir, 'execution.json'))) {
      created = createExecution({
        workspaceRoot: options.workspaceRoot,
        runtimeDir,
        caseJson,
        sourceText,
        executionId: draft.executionId,
        batchId: state.batchId,
        platform: loaded.contract.binding.platform,
        implementationSha: state.implementationSha,
        caseExecutorProtocolSha: state.caseExecutorProtocolSha,
        coordinatorProtocolSha: state.coordinatorProtocolSha,
        batchContractSha: state.contractSha,
        executionRequestSha: state.executionRequestSha,
        interactionPolicy: state.interactionPolicy,
        targetBinding: loaded.contract.binding,
        warmSessionGeneration: draft.warmSessionGeneration,
        warmSessionReused: state.currentIndex > 0,
        recoveryCount: state.warmSession.recoveryCount,
        now: options.now,
      });
    } else {
      created = { execDir, execution: readJson(path.join(execDir, 'execution.json')), executionId: draft.executionId };
    }
    if (options.interruptAfter === 'execution') throw new Error('MAVT_CASE_START_INTERRUPTED: execution');
    let runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
    if (!runtime) {
      runtime = bindAgentRuntime(execDir, {
        implementationSha: state.implementationSha,
        batchId: state.batchId,
        warmSessionGeneration: draft.warmSessionGeneration,
        sessionId: draft.sessionId,
        now: options.now,
      });
    }
    if (options.interruptAfter === 'runtime') throw new Error('MAVT_CASE_START_INTERRUPTED: runtime');
    let request = readJson(path.join(execDir, 'agent', 'request.json'), null);
    if (!request) {
      const skillContract = options.skillContract || buildContract({
        skillRoot: path.resolve(__dirname, '..', '..'),
        role: 'case-executor',
        provider: 'codex',
        platform: loaded.contract.binding.platform,
      });
      request = createAgentRequest({ workspaceRoot: options.workspaceRoot, execDir, skillContract });
    }
    if (options.interruptAfter === 'request') throw new Error('MAVT_CASE_START_INTERRUPTED: request');
    Object.assign(item, { status: 'RUNNING', executionId: draft.executionId, runtimePath: path.join(execDir, 'agent', 'runtime.json'), startedAt: created.execution.startedAt });
    saveBatch(loaded.paths, state, options.now);
    if (options.interruptAfter === 'batch') throw new Error('MAVT_CASE_START_INTERRUPTED: batch');
    const eventExists = fs.existsSync(loaded.paths.events) && fs.readFileSync(loaded.paths.events, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
      try { return JSON.parse(line).eventId === draft.eventId; } catch (error) { return false; }
    });
    if (!eventExists) appendJsonl(loaded.paths.events, { schemaVersion: 1, eventId: draft.eventId, time: options.now || new Date().toISOString(), type: 'caseStarted', caseKey: item.caseKey, executionId: item.executionId, warmSessionGeneration: draft.warmSessionGeneration });
    if (options.interruptAfter === 'event') throw new Error('MAVT_CASE_START_INTERRUPTED: event');
    fs.unlinkSync(loaded.paths.caseStartDraft);
    return { state, item, execution: created.execution, execDir, runtime, request };
  }, { now: options.now });
}

function releaseRuntime(execDir, options = {}) {
  const runtimePath = path.join(execDir, 'agent', 'runtime.json');
  const runtime = readJson(runtimePath, null);
  if (!runtime) throw contractError('AGENT_RUNTIME_MISSING', 'Agent Runtime is missing');
  if (runtime.status === 'RELEASED') return runtime;
  const released = { ...runtime, status: 'RELEASED', releasedAt: options.now || new Date().toISOString() };
  writeJsonAtomic(runtimePath, released);
  return released;
}

function prepareCurrentCompletion(execDir, state, item) {
  const execution = readJson(path.join(execDir, 'execution.json'));
  const snapshot = readJson(path.join(execDir, 'case.snapshot.json'));
  const result = readJson(path.join(execDir, 'result.json'));
  const metrics = readJson(path.join(execDir, 'metrics.json'));
  const request = validateAgentRequest(readJson(path.join(execDir, 'agent', 'request.json'), null));
  const agentResult = validateAgentResult(readJson(path.join(execDir, 'agent', 'result.json'), null), { request });
  validateResultKnowledgeSnapshots(execDir, result, timelineEvents(execDir));
  if (agentResult.verdict !== result.verdict || agentResult.executionStatus !== result.executionStatus
    || agentResult.warmSessionGeneration !== execution.warmSessionGeneration) {
    throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'AgentResult does not match finalized execution artifacts');
  }
  const paths = completionPaths(execDir);
  buildExecutionArtifactManifest(execDir);
  const completion = {
    schemaVersion: 2,
    executionId: execution.executionId,
    batchId: state.batchId,
    caseKey: item.caseKey,
    platform: execution.platform,
    completionSource: 'framework',
    implementationSha: execution.implementationSha,
    contractSha: execution.contractSha,
    batchContractSha: state.contractSha,
    resultSchemaVersion: 2,
    metricsSchemaVersion: 2,
    verdict: result.verdict,
    executionStatus: result.executionStatus,
    sessionReleased: true,
    resultSha256: sha256File(paths.result),
    metricsSha256: sha256File(paths.metrics),
    agentResultSha256: sha256File(paths.agentResult),
    artifactManifestSha256: sha256File(paths.artifactManifest),
    validationSha256: null,
  };
  return { completion, execution, snapshot, result, metrics };
}

function publishCurrentCompletion(execDir, prepared) {
  const { completion, execution, snapshot, result, metrics } = prepared;
  const paths = completionPaths(execDir);
  validatePublishedCompletion(execDir, completion, { execution, snapshot, result, metrics });
  const existing = readJson(paths.completion, null);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(completion)) {
      throw contractError('EXECUTION_COMPLETION_MISMATCH', 'completion.json is already bound to different artifacts');
    }
    return existing;
  }
  writeJsonAtomic(paths.completion, completion);
  return completion;
}

function commitCurrentCase(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, options.implementationSha, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    let draft = readJson(loaded.paths.caseCommitDraft, null);
    let item;
    if (draft) {
      if (draft.schemaVersion !== 1 || draft.batchId !== state.batchId || !Number.isInteger(draft.caseIndex)
        || draft.caseIndex < 0 || draft.caseIndex >= state.cases.length
        || !['STARTED', 'VALIDATED', 'RUNTIME_RELEASED', 'COMPLETION_WRITTEN', 'STATE_COMMITTED'].includes(draft.stage)) {
        throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'case commit draft is invalid');
      }
      item = state.cases[draft.caseIndex];
      if (!item || item.caseKey !== draft.caseKey || item.executionId !== draft.executionId) {
        throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'case commit draft does not match batch state');
      }
    } else {
      item = currentCase(state);
      if (!item || item.status !== 'RUNNING') throw contractError('BATCH_CASE_INVALID', 'current case is not running');
      draft = {
        schemaVersion: 1,
        stage: 'STARTED',
        batchId: state.batchId,
        caseIndex: state.currentIndex,
        caseKey: item.caseKey,
        executionId: item.executionId,
        eventId: `case-committed-${state.batchId}-${item.order}`,
      };
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
    const execution = readJson(path.join(execDir, 'execution.json'));
    if (!execution?.finalized) throw contractError('EXECUTION_NOT_FINALIZED', 'current execution must be finalized before commit');
    if (execution.batchContractSha !== state.contractSha || execution.implementationSha !== state.implementationSha) {
      throw contractError('BATCH_BINDING_MISMATCH', 'execution does not match current batch implementation and contract');
    }
    assertRecoveriesCommitted(loaded.paths, state, execDir, item.executionId);
    const prepared = prepareCurrentCompletion(execDir, state, item);
    if (draft.stage === 'STARTED') {
      draft.stage = 'VALIDATED';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'validation') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: validation');
    const runtime = releaseRuntime(execDir, options);
    if (draft.stage === 'VALIDATED') {
      draft.stage = 'RUNTIME_RELEASED';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'runtime') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: runtime');
    const completion = publishCurrentCompletion(execDir, prepared);
    if (draft.stage === 'RUNTIME_RELEASED') {
      draft.stage = 'COMPLETION_WRITTEN';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'completion') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: completion');
    if (item.status === 'RUNNING') {
      if (state.currentIndex !== draft.caseIndex) throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'currentIndex changed before case commit');
      Object.assign(item, { status: 'COMPLETED', verdict: completion.verdict, executionStatus: completion.executionStatus, endedAt: execution.endedAt, sessionId: runtime.sessionId });
      state.currentIndex = draft.caseIndex + 1;
      if (state.currentIndex >= state.cases.length) {
        state.status = 'COMPLETED';
        if (state.warmSession.status !== 'CLOSED') state.warmSession = markClosed(state.warmSession, options.now || new Date().toISOString());
        state.completedAt = options.now || new Date().toISOString();
      }
      saveBatch(loaded.paths, state, options.now);
    } else if (item.status !== 'COMPLETED' || item.verdict !== completion.verdict
      || item.executionStatus !== completion.executionStatus || state.currentIndex < draft.caseIndex + 1) {
      throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'batch state contains a conflicting case commit');
    }
    if (draft.stage === 'COMPLETION_WRITTEN') {
      draft.stage = 'STATE_COMMITTED';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'state') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: state');
    if (!hasBatchEvent(loaded.paths.events, (event) => event.eventId === draft.eventId)) {
      appendJsonl(loaded.paths.events, { schemaVersion: 1, eventId: draft.eventId, time: options.now || new Date().toISOString(), type: 'caseCommitted', caseKey: item.caseKey, executionId: item.executionId, verdict: item.verdict });
    }
    if (options.interruptAfter === 'event') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: event');
    if (fs.existsSync(loaded.paths.caseCommitDraft)) fs.unlinkSync(loaded.paths.caseCommitDraft);
    return { state, item, completion, runtime };
  }, { now: options.now });
}

function validateRecoveryRequest(request, state, item, execDir) {
  ensureObject(request, 'recovery request', 'RECOVERY_INVALID');
  ensureId(request.recoveryId, 'recoveryId', 'RECOVERY_INVALID');
  if (!RECOVERY_TRIGGERS.has(request.triggerType)) throw contractError('RECOVERY_TRIGGER_INVALID', `unsupported recovery trigger: ${request.triggerType || 'missing'}`);
  if (!item || item.status !== 'RUNNING' || request.executionId !== item.executionId) throw contractError('RECOVERY_BINDING_MISMATCH', 'recovery must bind the current running execution');
  const sourceRefs = Array.isArray(request.sourceRefs) ? request.sourceRefs : [];
  const evidenceRefs = Array.isArray(request.evidenceRefs) ? request.evidenceRefs : [];
  const failedOperation = request.generatedBy === 'agent-facade' && request.failedOperationId
    ? timelineEvents(execDir).find((event) => event.type === 'operationCompleted'
      && event.operationId === request.failedOperationId && event.outcome === 'FAILED' && event.failureCode)
    : null;
  if (request.triggerType === 'SOURCE_REQUIRED_COLD_START' && !sourceRefs.length) throw contractError('RECOVERY_EVIDENCE_REQUIRED', 'source-required cold start needs sourceRefs');
  if (request.triggerType !== 'SOURCE_REQUIRED_COLD_START' && !evidenceRefs.length && !failedOperation) {
    throw contractError('RECOVERY_EVIDENCE_REQUIRED', 'recovery needs current execution evidenceRefs or a frozen failed operation');
  }
  if (request.triggerType === 'AGENT_DECIDED_RESTART' && (typeof request.decisionReason !== 'string' || !request.decisionReason.trim())) {
    throw contractError('RECOVERY_INVALID', 'agent-decided restart requires decisionReason');
  }
  if (isIncidentRecovery(request.triggerType)) {
    ensureId(request.incidentId, 'incidentId', 'RECOVERY_INVALID');
    if (!['PRODUCT', 'TECHNICAL'].includes(request.incidentCategory)) throw contractError('RECOVERY_INVALID', 'incidentCategory must be PRODUCT or TECHNICAL');
    if (typeof request.incidentReason !== 'string' || !request.incidentReason.trim()) throw contractError('RECOVERY_INVALID', 'incidentReason is required');
  }
  if (!request.checkpointId) throw contractError('RECOVERY_INVALID', 'checkpointId is required');
  if (state.status !== 'RUNNING' || state.warmSession.status !== 'READY') {
    throw contractError('RECOVERY_STATE_INVALID', 'recovery requires a running batch and ready warm session');
  }
  const plan = readJson(path.join(execDir, 'plan.json'), null);
  if (!plan?.checkpoints?.some((entry) => entry.id === request.checkpointId)) {
    throw contractError('RECOVERY_REFERENCE_INVALID', 'checkpointId must belong to the current plan');
  }
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
  if (!execution || !runtime || runtime.status !== 'BOUND' || runtime.executionId !== execution.executionId) {
    throw contractError('AGENT_RUNTIME_NOT_BOUND', 'App recovery requires the current bound Agent Runtime');
  }
  if (request.triggerType === 'SOURCE_REQUIRED_COLD_START') {
    const knownRefs = new Set((readJson(path.join(execDir, 'understanding.json'), null)?.sourceRefs || []).map((entry) => entry.id));
    if (!sourceRefs.every((ref) => knownRefs.has(ref))) {
      throw contractError('RECOVERY_REFERENCE_INVALID', 'sourceRefs must belong to the current understanding');
    }
  } else if (evidenceRefs.length) {
    const execution = readJson(path.join(execDir, 'execution.json'));
    const knownRefs = new Set(collectEvidence(timelineEvents(execDir), {
      execDir,
      executionId: execution.executionId,
    }).filter((entry) => entry.warmSessionGeneration === execution.warmSessionGeneration)
      .map((entry) => entry.ref));
    if (!evidenceRefs.every((ref) => knownRefs.has(ref))) {
      throw contractError('RECOVERY_REFERENCE_INVALID', 'evidenceRefs must be current execution observations');
    }
  }
}

function recoverApp(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, options.implementationSha, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    const item = currentCase(state);
    const request = options.request;
    ensureObject(request, 'recovery request', 'RECOVERY_INVALID');
    ensureId(request.recoveryId, 'recoveryId', 'RECOVERY_INVALID');
    const existing = state.recoveries.find((entry) => entry.recoveryId === request.recoveryId);
    if (existing) {
      const requestedBinding = {
        recoveryId: request.recoveryId,
        executionId: request.executionId,
        checkpointId: request.checkpointId,
        triggerType: request.triggerType,
        sourceRefs: request.sourceRefs || [],
        evidenceRefs: request.evidenceRefs || [],
        incidentId: request.incidentId || null,
        incidentCategory: request.incidentCategory || null,
        incidentReason: request.incidentReason || null,
        decisionReason: request.decisionReason || null,
      };
      const existingBinding = {
        recoveryId: existing.recoveryId,
        executionId: existing.executionId,
        checkpointId: existing.checkpointId,
        triggerType: existing.triggerType,
        sourceRefs: existing.sourceRefs,
        evidenceRefs: existing.evidenceRefs,
        incidentId: existing.incidentId || null,
        incidentCategory: existing.incidentCategory || null,
        incidentReason: existing.incidentReason || null,
        decisionReason: existing.decisionReason || null,
      };
      if (canonicalJson(requestedBinding) !== canonicalJson(existingBinding)) {
        throw contractError('RECOVERY_BINDING_MISMATCH', 'recoveryId is already bound to another request');
      }
      const resolved = recoveryExecutionDir(state, loaded.contract, existing.executionId);
      const originalExecution = readJson(path.join(resolved.execDir, 'execution.json'), null);
      if (!originalExecution || originalExecution.batchId !== state.batchId || originalExecution.executionId !== existing.executionId) {
        throw contractError('RECOVERY_BINDING_MISMATCH', 'recovery execution binding is invalid');
      }
      if (!recoveryTimelineComplete(resolved.execDir, existing)) {
        if (originalExecution.finalized === true) {
          throw contractError('BATCH_RECOVERY_COMMIT_INCOMPLETE', 'finalized execution has an incomplete recovery timeline');
        }
        completeRecoveryTimeline(resolved.execDir, existing, state.implementationSha, options.now);
      }
      completeRecoveryCommit(loaded.paths, existing);
      clearControlRequest(resolved.execDir, existing.recoveryId);
      return { state, recovery: existing, idempotent: true };
    }
    const execDir = item?.executionId
      ? path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId)
      : null;
    validateRecoveryRequest(request, state, item, execDir);
    if (isIncidentRecovery(request.triggerType)) {
      recordRuntimeEvent(execDir, {
        type: 'runtimeIncident',
        incidentId: request.incidentId,
        triggerType: request.triggerType,
        category: request.incidentCategory,
        evidenceRefs: request.evidenceRefs || [],
        reason: request.incidentReason,
      }, { implementationSha: state.implementationSha, now: options.now });
    }
    let draft = readJson(loaded.paths.recoveryDraft, null);
    if (draft && draft.request?.recoveryId !== request.recoveryId) {
      throw contractError('RECOVERY_IN_PROGRESS', `recovery ${draft.request?.recoveryId || 'unknown'} is still active`);
    }
    if (draft && canonicalJson(draft.request) !== canonicalJson(request)) {
      throw contractError('RECOVERY_BINDING_MISMATCH', 'active recovery request cannot be changed');
    }
    if (!draft) {
      draft = {
        schemaVersion: 1,
        request,
        requestId: `batch-recovery-${request.recoveryId}`,
        status: 'STARTED',
      };
      writeJsonAtomic(loaded.paths.recoveryDraft, draft);
    }
    recordRuntimeEvent(execDir, {
      type: 'recoveryStarted', recoveryId: request.recoveryId, incidentId: request.incidentId || null,
    }, { implementationSha: state.implementationSha, now: options.now });
    if (!draft.result) {
      try {
        draft.result = options.adapter.restartApp({ requestId: draft.requestId, scope: 'batch-recovery', binding: loaded.contract.binding, triggerType: request.triggerType });
      } catch (error) {
        draft.result = {
          ok: false,
          coldStartVerified: false,
          startupDisplayVerified: false,
          failureCode: error.code || 'ADAPTER_ERROR',
          reason: error.message,
        };
      }
      draft.status = 'ACTION_RECORDED';
      writeJsonAtomic(loaded.paths.recoveryDraft, draft);
    }
    if (options.interruptAfter === 'action') throw new Error('MAVT_BATCH_RECOVERY_INTERRUPTED: action');
    const recovery = {
      recoveryId: request.recoveryId,
      executionId: request.executionId,
      checkpointId: request.checkpointId,
      triggerType: request.triggerType,
      sourceRefs: request.sourceRefs || [],
      evidenceRefs: request.evidenceRefs || [],
      incidentId: request.incidentId || null,
      incidentCategory: request.incidentCategory || null,
      incidentReason: request.incidentReason || null,
      decisionReason: request.decisionReason || null,
      requestId: draft.requestId,
      noAutomaticReplay: true,
      time: options.now || new Date().toISOString(),
    };
    try {
      assertAdapterResult(draft.result, 'APP_RECOVERY');
      recovery.status = 'SUCCEEDED';
      state.warmSession = markRecovered(state.warmSession, recovery.time);
      const execution = readJson(path.join(execDir, 'execution.json'));
      const runtimePath = path.join(execDir, 'agent', 'runtime.json');
      const runtime = readJson(runtimePath);
      writeJsonAtomic(path.join(execDir, 'execution.json'), {
        ...execution,
        warmSessionGeneration: state.warmSession.generation,
        recoveryCount: state.warmSession.recoveryCount,
      });
      writeJsonAtomic(runtimePath, { ...runtime, warmSessionGeneration: state.warmSession.generation });
      rebindAgentRequestGeneration(execDir, state.warmSession.generation);
    } catch (error) {
      recovery.status = 'FAILED';
      recovery.failureCode = error.code || 'APP_RECOVERY_FAILED';
      recovery.reason = error.message;
      state.warmSession = markDegraded(state.warmSession, recovery.time);
      state.status = 'BLOCKED';
    }
    state.recoveries.push(recovery);
    recovery.warmSessionGeneration = state.warmSession.generation;
    saveBatch(loaded.paths, state, options.now);
    if (options.interruptAfter === 'state') throw new Error('MAVT_BATCH_RECOVERY_INTERRUPTED: state');
    completeRecoveryTimeline(execDir, recovery, state.implementationSha, options.now);
    completeRecoveryCommit(loaded.paths, recovery);
    clearControlRequest(execDir, recovery.recoveryId);
    return { state, recovery };
  }, { now: options.now });
}

function probeWarmSession(state, contract, adapter, now) {
  const probe = adapter.probeSession({ binding: contract.binding });
  if (probe?.ok === true && canonicalJson(probe.binding) === canonicalJson(contract.binding)) return { state, probe };
  const failureCode = probe?.failureCode || (probe?.ok === true ? 'WARM_SESSION_BINDING_MISMATCH' : 'WARM_SESSION_PROBE_FAILED');
  const reason = probe?.reason || (probe?.ok === true
    ? 'warm App session no longer matches the frozen execution binding'
    : 'warm App session probe failed');
  state.warmSession = markDegraded(state.warmSession, now || new Date().toISOString(), { failureCode, reason });
  return { state, probe, failureCode, reason };
}

function caseDeadlineReached(execDir, execution, now = new Date().toISOString()) {
  const request = readJson(path.join(execDir, 'agent', 'request.json'), null);
  const deadlineAt = request?.deadlineAt || new Date(Date.parse(execution.startedAt) + (30 * 60 * 1000)).toISOString();
  return Number.isFinite(Date.parse(deadlineAt)) && Date.parse(now) >= Date.parse(deadlineAt);
}

function reconcileBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, options.implementationSha, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    if (fs.existsSync(loaded.paths.bootstrapDraft)) return { action: 'BOOTSTRAP', state, draft: readJson(loaded.paths.bootstrapDraft) };
    if (state.warmSession.status === 'INITIALIZING') return { action: 'BOOTSTRAP', state };
    if (fs.existsSync(loaded.paths.caseStartDraft)) return { action: 'RESUME_CASE_START', state, draft: readJson(loaded.paths.caseStartDraft) };
    if (fs.existsSync(loaded.paths.recoveryDraft)) return { action: 'RESUME_RECOVERY', state, draft: readJson(loaded.paths.recoveryDraft) };
    if (fs.existsSync(loaded.paths.caseCommitDraft)) return { action: 'COMMIT_CASE', state, draft: readJson(loaded.paths.caseCommitDraft) };
    if (state.warmSession.status === 'CLOSED') return { action: 'BATCH_COMPLETE', state };
    if (state.status === 'BLOCKED') return { action: 'BATCH_BLOCKED', state };
    const requireDeviceSession = () => {
      const probed = probeWarmSession(state, loaded.contract, options.adapter, options.now);
      if (probed.state.warmSession.status !== 'DEGRADED') return null;
      const activeItem = currentCase(state);
      return {
        ...stopBatch(loaded.paths, state, 'DEGRADED', probed.failureCode, probed.reason, {
          now: options.now,
          stopContext: {
            source: 'warm-session-probe',
            caseKey: activeItem?.caseKey || null,
            executionId: activeItem?.executionId || null,
            warmSessionGeneration: state.warmSession.generation,
            probe: probed.probe || null,
          },
        }),
        probe: probed.probe,
      };
    };
    const allActive = findActiveExecutions(options.workspaceRoot);
    const active = allActive.filter((entry) => entry.execution.batchId === state.batchId);
    if (allActive.length !== active.length) {
      const executions = allActive.map((entry) => entry.execution.executionId);
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_ACTIVE_EXECUTION_CONFLICT', 'another batch owns an active execution', { now: options.now, executions });
    }
    if (active.length > 1) {
      const executions = active.map((entry) => entry.execution.executionId);
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_ACTIVE_EXECUTION_CONFLICT', 'batch has more than one active execution', { now: options.now, executions });
    }
    const item = currentCase(state);
    if (!item) return { action: 'BATCH_COMPLETE', state };
    if (item.status === 'PENDING') {
      if (active.length) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'pending case conflicts with an active execution', { now: options.now });
      return requireDeviceSession() || { action: 'START_CASE', state };
    }
    if (item.status !== 'RUNNING' || !item.executionId) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'current case state is invalid', { now: options.now });
    const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    if (!execution || (active.length && active[0].execution.executionId !== item.executionId)) {
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'current execution is missing or conflicts with batch state', { now: options.now });
    }
    const entry = { execDir, execution };
    if (entry.execution.implementationSha !== state.implementationSha || entry.execution.batchContractSha !== state.contractSha) {
      throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'active execution belongs to another batch implementation');
    }
    const recovery = recoverExecution(entry.execDir);
    const runtime = readJson(path.join(entry.execDir, 'agent', 'runtime.json'), null);
    if (recovery.status === 'RESUME_PHASE') return { action: 'RESUME_PHASE', state, execDir: entry.execDir, draft: recovery.draft };
    if (recovery.status === 'RESUME_FINALIZE') return { action: 'RESUME_FINALIZE', state, execDir: entry.execDir };
    if (entry.execution.finalized) {
      if (!runtime) return stopBatch(loaded.paths, state, 'CORRUPTED', 'AGENT_RUNTIME_MISSING', 'finalized execution has no Agent Runtime', { now: options.now });
      const agentResult = readJson(path.join(entry.execDir, 'agent', 'result.json'), null);
      if (!agentResult && runtime.status === 'BOUND') return { action: 'CREATE_AGENT_RESULT', state, execDir: entry.execDir };
      if (!agentResult && runtime.status === 'RELEASED') {
        return stopBatch(loaded.paths, state, 'BLOCKED', 'AGENT_RESULT_MISSING_AFTER_RELEASE', 'finalized execution released its Agent Runtime before AgentResult was created', { now: options.now });
      }
      if (['BOUND', 'RELEASED'].includes(runtime.status)) return { action: 'COMMIT_CASE', state, execDir: entry.execDir };
      return stopBatch(loaded.paths, state, 'BLOCKED', 'AGENT_RUNTIME_STATE_INVALID', `unsupported finalized Agent Runtime status: ${runtime.status}`, { now: options.now });
    }
    if (!runtime) return stopBatch(loaded.paths, state, 'CORRUPTED', 'AGENT_RUNTIME_MISSING', 'active execution has no Agent Runtime or case-start draft', { now: options.now });
    const internalRecovery = runtime.status === 'BOUND'
      ? recoverInternalTransactions(entry.execDir, { now: options.now, runner: options.runner })
      : { recovered: [] };
    entry.execution = readJson(path.join(entry.execDir, 'execution.json'), entry.execution);
    if (runtime.status === 'BOUND' && caseDeadlineReached(entry.execDir, entry.execution, options.now)) {
      const pendingAgentRecovery = operationDraftIds(entry.execDir).length > 0
        || knowledgeQueryDraftIds(entry.execDir).length > 0
        || turnDraftIds(entry.execDir).length > 0
        || stepDraftIds(entry.execDir).length > 0;
      if (!pendingAgentRecovery) sealTimeLimit(entry.execDir, { implementationSha: state.implementationSha, now: options.now });
      return { action: 'CONCLUDE_TIME_LIMIT', state, execDir: entry.execDir, sessionId: runtime.sessionId, internalRecovery: internalRecovery.recovered };
    }
    const controlRequest = readJson(controlRequestPath(entry.execDir), null);
    if (runtime.status === 'BOUND' && controlRequest) {
      return { action: 'RECOVER_APP', state, execDir: entry.execDir, sessionId: runtime.sessionId, recoveryRequest: controlRequest, internalRecovery: internalRecovery.recovered };
    }
    if (runtime.status === 'BOUND') return requireDeviceSession() || {
      action: 'RESUME_EXECUTION', state, execDir: entry.execDir, sessionId: runtime.sessionId, internalRecovery: internalRecovery.recovered,
    };
    if (runtime.status === 'RELEASED') return stopBatch(loaded.paths, state, 'BLOCKED', 'AGENT_RUNTIME_RELEASED_EARLY', 'unfinalized execution has a released Agent session', { now: options.now });
    return stopBatch(loaded.paths, state, 'BLOCKED', 'AGENT_RUNTIME_STATE_INVALID', `unsupported Agent Runtime status: ${runtime.status}`, { now: options.now });
  }, { now: options.now });
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  RECOVERY_TRIGGERS,
  batchPaths,
  bootstrapBatch,
  caseDeadlineReached,
  commitCurrentCase,
  currentCase,
  initializeBatch,
  loadBatch,
  reconcileBatch,
  recoverApp,
  releaseRuntime,
  startCurrentCase,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureId } = require('../lib/contract-utils');
const {
  assertBatchImplementation,
  createBatchContract,
} = require('../lib/batch-contract');
const {
  appendJsonl,
  allocateExecutionId,
  findActiveExecutions,
  readJson,
  withFileLock,
  writeJsonAtomic,
} = require('../lib/execution-lifecycle');
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
  validateWarmSession,
} = require('../lib/warm-session-contract');
const { assertWorkspace } = require('../lib/workspace');
const { closeStaleExecutions } = require('../lib/execution-closure');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');
const {
  buildCurrentCompletion,
  prepareCurrentCompletion,
  publishCurrentCompletion,
  releaseRuntime,
} = require('./completion');

const BATCH_SCHEMA_VERSION = 5;

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
  };
}

function caseRuntimeDir(caseDir, platform) {
  return path.join(caseDir, 'platforms', platform);
}

function loadBatch(workspaceRoot, batchId, versions = {}) {
  assertBatchWorkspace(workspaceRoot);
  const paths = batchPaths(workspaceRoot, batchId);
  const state = readJson(paths.state, null);
  const contract = readJson(paths.contract, null);
  if (!state || !contract) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${batchId}`);
  if (state.schemaVersion !== BATCH_SCHEMA_VERSION) throw contractError('BATCH_SCHEMA_UNSUPPORTED', `unsupported batch schema: ${state.schemaVersion ?? 'missing'}`);
  assertBatchImplementation(contract, versions);
  if (state.batchId !== contract.batchId || state.contractSha !== contract.contractSha
    || state.runtimeSha !== contract.runtimeSha || state.adapterSha !== contract.adapterSha
    || state.coordinatorSha !== contract.coordinatorSha) {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its frozen contract');
  }
  if (state.executionRequestId !== contract.executionRequestId || state.executionRequestSha !== contract.executionRequestSha
    || state.mode !== contract.mode || state.interactionPolicy !== 'UNATTENDED' || contract.interactionPolicy !== 'UNATTENDED') {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its explicit unattended execution request');
  }
  const stateTargets = Array.isArray(state.cases)
    ? state.cases.map((entry) => ({
      order: entry.order,
      ...(entry.caseNo ? { caseNo: entry.caseNo } : {}),
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

function protocolBindings(options) {
  return {
    caseProtocolSha: options.caseProtocolSha,
    coordinatorProtocolSha: options.coordinatorProtocolSha,
    runtimeSha: options.runtimeSha,
    adapterSha: options.adapterSha,
    coordinatorSha: options.coordinatorSha,
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
  if ((options.runtimeSha && executionRequest.runtimeSha !== options.runtimeSha)
    || (options.adapterSha && executionRequest.adapterSha !== options.adapterSha)
    || (options.coordinatorSha && executionRequest.coordinatorSha !== options.coordinatorSha)) {
    throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'execution request belongs to different runtime components');
  }
  if ((options.caseProtocolSha && executionRequest.caseProtocolSha !== options.caseProtocolSha)
    || (options.coordinatorProtocolSha && executionRequest.coordinatorProtocolSha !== options.coordinatorProtocolSha)) {
    throw contractError('BATCH_PROTOCOL_MISMATCH', 'execution request belongs to a different Agent protocol');
  }
  const closedExecutions = closeStaleExecutions(options.workspaceRoot, {
    runtimeSha: executionRequest.runtimeSha,
    adapterSha: executionRequest.adapterSha,
  }, {
    replacementBatchId: options.batchId,
    reason: '新批次使用当前实现，其他实现的未完成 execution 不再续写',
    now: options.now,
  });
  let draft = readJson(paths.initDraft, null);
  const existingState = readJson(paths.state, null);
  const existingContract = readJson(paths.contract, null);
  if (!draft && (existingState || existingContract)) {
    if (!existingState || !existingContract) throw contractError('BATCH_INIT_CORRUPTED', 'partial batch initialization has no recovery draft');
    const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
    if (executionRequest.requestSha !== loaded.contract.executionRequestSha
      || canonicalJson(targets) !== canonicalJson(loaded.contract.targets)) {
      throw contractError('BATCH_BINDING_MISMATCH', 'existing batch cannot be initialized with a different execution request');
    }
    if (!hasBatchEvent(paths.events, (event) => event.type === 'batchInitialized' && event.batchId === options.batchId)) {
      appendJsonl(paths.events, {
        schemaVersion: 1, eventId: `batch-initialized-${options.batchId}`, time: loaded.state.createdAt,
        type: 'batchInitialized', batchId: loaded.state.batchId, contractSha: loaded.state.contractSha,
        runtimeSha: loaded.state.runtimeSha, adapterSha: loaded.state.adapterSha,
        coordinatorSha: loaded.state.coordinatorSha, executionRequestSha: loaded.state.executionRequestSha,
        interactionPolicy: loaded.state.interactionPolicy,
      });
    }
    return { ...loaded, closedExecutions };
  }
  if (!draft) {
    const contract = createBatchContract({
      batchId: options.batchId,
      executionRequest: { ...executionRequest, targets },
    });
    const now = options.now || new Date().toISOString();
    const state = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId: options.batchId,
      runtimeSha: contract.runtimeSha,
      adapterSha: contract.adapterSha,
      coordinatorSha: contract.coordinatorSha,
      caseProtocolSha: contract.caseProtocolSha,
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
      finalization: { casesCommitted: false, platformReleased: false, reportsPublished: false },
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
    runtimeSha: draft.state.runtimeSha,
    adapterSha: draft.state.adapterSha,
    coordinatorSha: draft.state.coordinatorSha,
    executionRequestSha: draft.state.executionRequestSha,
    interactionPolicy: draft.state.interactionPolicy,
  });
  if (options.interruptAfter === 'event') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: event');
  fs.unlinkSync(paths.initDraft);
  return { paths, state: draft.state, contract: draft.contract, closedExecutions };
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

function platformRuntimeAcquisition(value) {
  if (value === undefined) return { ok: true, status: 'NOT_REQUIRED', ownership: 'NONE' };
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') {
    throw contractError('PLATFORM_RUNTIME_RESULT_INVALID', 'platform runtime acquisition is invalid');
  }
  return JSON.parse(JSON.stringify(value));
}

function bootstrapBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const { paths, contract } = loaded;
    const state = readJson(paths.state);
    const requestId = 'batch-bootstrap-001';
    const runtimeAcquisition = platformRuntimeAcquisition(options.platformRuntime);
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
        platformRuntime: runtimeAcquisition,
        createdAt: options.now || new Date().toISOString(),
      };
      writeJsonAtomic(paths.bootstrapDraft, draft);
    }
    if (draft.schemaVersion !== 1 || draft.requestId !== requestId || draft.eventId !== `batch-bootstrap-${state.batchId}`
      || canonicalJson(draft.binding) !== canonicalJson(contract.binding)
      || canonicalJson(draft.platformRuntime) !== canonicalJson(runtimeAcquisition)) {
      throw contractError('BATCH_BOOTSTRAP_BINDING_MISMATCH', 'bootstrap draft does not match the current batch');
    }
    if (!draft.result) {
      if (draft.platformRuntime.ok !== true) {
        draft.result = {
          ok: false,
          coldStartVerified: false,
          startupDisplayVerified: false,
          failureCode: draft.platformRuntime.failureCode || 'PLATFORM_RUNTIME_ACQUIRE_FAILED',
          reason: draft.platformRuntime.reason || 'platform runtime acquisition failed',
        };
      } else {
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
        platformRuntime: {
          status: draft.platformRuntime.status,
          ownership: draft.platformRuntime.ownership,
          ...(draft.platformRuntime.failureCode ? { failureCode: draft.platformRuntime.failureCode } : {}),
        },
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
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    if (state.status !== 'RUNNING' || state.warmSession.status !== 'READY') throw contractError('WARM_SESSION_NOT_READY', 'batch warm session is not ready');
    const item = currentCase(state);
    if (!item) return { state, complete: true };
    if (item.status === 'RUNNING' && !fs.existsSync(loaded.paths.caseStartDraft)) {
      const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
      const execution = readJson(path.join(execDir, 'execution.json'));
      if (execution?.schemaVersion !== 6) throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
      const agentContinuation = options.continuationReason
        ? caseRuntimeLifecycle.recordAgentContinuation({ executionDir: execDir, reason: options.continuationReason, now: options.now })
        : null;
      return {
        state,
        item,
        alreadyStarted: true,
        execDir,
        execution,
        runtime: readJson(path.join(execDir, 'runtime.json')),
        brief: readJson(path.join(execDir, 'case-brief.json')),
        ...(agentContinuation ? { agentContinuation } : {}),
      };
    }
    if (!['PENDING', 'RUNNING'].includes(item.status)) throw contractError('BATCH_CASE_INVALID', `current case is ${item.status}`);
    const caseJson = readJson(path.join(item.snapshotPath, 'case.snapshot.json'));
    const sourceText = fs.readFileSync(path.join(item.snapshotPath, 'source.snapshot.md'), 'utf8');
    const runtimeDir = caseRuntimeDir(item.caseDir, loaded.contract.binding.platform);
    const platformRuntime = readJson(path.join(loaded.paths.batchDir, 'platform-runtime.json'), null);
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
      created = caseRuntimeLifecycle.createExecution({
        workspaceRoot: options.workspaceRoot,
        runtimeDir,
        caseJson,
        sourceText,
        executionId: draft.executionId,
        batchId: state.batchId,
        platform: loaded.contract.binding.platform,
        runtimeSha: state.runtimeSha,
        adapterSha: state.adapterSha,
        caseProtocolSha: state.caseProtocolSha,
        coordinatorProtocolSha: state.coordinatorProtocolSha,
        batchContractSha: state.contractSha,
        executionRequestSha: state.executionRequestSha,
        interactionPolicy: state.interactionPolicy,
        targetBinding: loaded.contract.binding,
        warmSessionGeneration: draft.warmSessionGeneration,
        warmSessionReused: state.currentIndex > 0,
        batchRecoveryCountAtStart: state.warmSession.recoveryCount,
        sessionRef: {
          schemaVersion: 1,
          batchId: state.batchId,
          statePath: loaded.paths.state,
          lockPath: loaded.paths.lock,
          platformResource: platformRuntime?.resource || null,
        },
        knowledgeRoots: [
          path.resolve(__dirname, '../..', 'knowledge'),
          path.join(options.workspaceRoot, 'knowledge'),
        ],
        now: options.now,
        initialObserve: false,
      });
    } else {
      created = { execDir, execution: readJson(path.join(execDir, 'execution.json')), executionId: draft.executionId };
    }
    if (options.interruptAfter === 'execution') throw new Error('MAVT_CASE_START_INTERRUPTED: execution');
    const runtime = readJson(path.join(execDir, 'runtime.json'), null);
    if (!runtime) throw contractError('CASE_RUNTIME_MISSING', 'Case Runtime binding is missing');
    if (options.interruptAfter === 'runtime') throw new Error('MAVT_CASE_START_INTERRUPTED: runtime');
    const brief = readJson(path.join(execDir, 'case-brief.json'), null);
    if (!brief) throw contractError('CASE_BRIEF_MISSING', 'Case Brief is missing');
    if (options.interruptAfter === 'request') throw new Error('MAVT_CASE_START_INTERRUPTED: request');
    Object.assign(item, { status: 'RUNNING', executionId: draft.executionId, runtimePath: path.join(execDir, 'runtime.json'), startedAt: created.execution.startedAt });
    saveBatch(loaded.paths, state, options.now);
    if (options.interruptAfter === 'batch') throw new Error('MAVT_CASE_START_INTERRUPTED: batch');
    const eventExists = fs.existsSync(loaded.paths.events) && fs.readFileSync(loaded.paths.events, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
      try { return JSON.parse(line).eventId === draft.eventId; } catch (error) { return false; }
    });
    if (!eventExists) appendJsonl(loaded.paths.events, { schemaVersion: 1, eventId: draft.eventId, time: options.now || new Date().toISOString(), type: 'caseStarted', caseKey: item.caseKey, executionId: item.executionId, warmSessionGeneration: draft.warmSessionGeneration });
    if (options.interruptAfter === 'event') throw new Error('MAVT_CASE_START_INTERRUPTED: event');
    fs.unlinkSync(loaded.paths.caseStartDraft);
    return { state, item, execution: created.execution, execDir, runtime, brief };
  }, { now: options.now });
}

function commitCurrentCase(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
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
    if (execution?.schemaVersion !== 6) throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
    if (!execution?.finalized) throw contractError('EXECUTION_NOT_FINALIZED', 'current execution must be finalized before commit');
    if (execution.batchContractSha !== state.contractSha || execution.runtimeSha !== state.runtimeSha
      || execution.adapterSha !== state.adapterSha) {
      throw contractError('BATCH_BINDING_MISMATCH', 'execution does not match current batch implementation and contract');
    }
    const prepared = prepareCurrentCompletion(execDir, options);
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
    const completion = publishCurrentCompletion(execDir, buildCurrentCompletion(execDir, state, item, prepared, runtime));
    if (draft.stage === 'RUNTIME_RELEASED') {
      draft.stage = 'COMPLETION_WRITTEN';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'completion') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: completion');
    if (item.status === 'RUNNING') {
      if (state.currentIndex !== draft.caseIndex) throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'currentIndex changed before case commit');
      Object.assign(item, { status: 'COMPLETED', verdict: completion.verdict, executionStatus: completion.executionStatus, endedAt: execution.endedAt });
      state.currentIndex = draft.caseIndex + 1;
      if (state.currentIndex >= state.cases.length) {
        state.status = 'FINALIZING';
        state.finalization = { casesCommitted: true, platformReleased: false, reportsPublished: false };
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

function recordFinalizationStep(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    if (state.status === 'COMPLETED') return { state, idempotent: true };
    if (state.status !== 'FINALIZING' || state.finalization?.casesCommitted !== true) {
      throw contractError('BATCH_FINALIZATION_INVALID', 'batch is not ready for finalization');
    }
    if (options.step === 'platformReleased') {
      if (options.result?.ok !== true) throw contractError('PLATFORM_RUNTIME_RELEASE_FAILED', options.result?.reason || 'platform runtime release failed');
      state.finalization.platformReleased = true;
      if (state.warmSession.status !== 'CLOSED') state.warmSession = markClosed(state.warmSession, options.now || new Date().toISOString());
    } else if (options.step === 'reportsPublished') {
      if (options.result?.status !== 'PUBLISHED') throw contractError('REPORT_PUBLICATION_FAILED', options.result?.reason || 'report publication failed');
      state.finalization.reportsPublished = true;
    } else {
      throw contractError('BATCH_FINALIZATION_INVALID', `unknown finalization step: ${options.step}`);
    }
    if (state.finalization.platformReleased && state.finalization.reportsPublished) {
      state.status = 'COMPLETED';
      state.completedAt = options.now || new Date().toISOString();
    }
    saveBatch(loaded.paths, state, options.now);
    return { state, finalization: state.finalization };
  }, { now: options.now });
}

function reconcileBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readJson(loaded.paths.state);
    if (fs.existsSync(loaded.paths.bootstrapDraft)) return { action: 'BOOTSTRAP', state, draft: readJson(loaded.paths.bootstrapDraft) };
    if (state.warmSession.status === 'INITIALIZING') return { action: 'BOOTSTRAP', state };
    if (fs.existsSync(loaded.paths.caseStartDraft)) return { action: 'RESUME_CASE_START', state, draft: readJson(loaded.paths.caseStartDraft) };
    if (fs.existsSync(loaded.paths.caseCommitDraft)) return { action: 'COMMIT_CASE', state, draft: readJson(loaded.paths.caseCommitDraft) };
    if (state.status === 'BLOCKED') return { action: 'BATCH_BLOCKED', state };
    if (state.status === 'FINALIZING') {
      if (state.finalization?.casesCommitted !== true) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'finalizing batch has uncommitted cases', { now: options.now });
      if (state.finalization.platformReleased !== true) return { action: 'RELEASE_PLATFORM', state };
      if (state.finalization.reportsPublished !== true) return { action: 'PUBLISH_REPORTS', state };
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'completed finalization checklist was not committed', { now: options.now });
    }
    if (state.status === 'COMPLETED' && state.warmSession.status === 'CLOSED') return { action: 'BATCH_COMPLETE', state };
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
    if (!item) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'batch has no current case before finalization', { now: options.now });
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
    if (entry.execution.runtimeSha !== state.runtimeSha || entry.execution.adapterSha !== state.adapterSha
      || entry.execution.batchContractSha !== state.contractSha) {
      throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'active execution belongs to another batch implementation');
    }
    if (entry.execution.schemaVersion === 6) {
      try {
        caseRuntimeLifecycle.reconcileExecution({ executionDir: entry.execDir, runtimeOptions: options.runtimeOptions || {} });
      } catch (error) {
        return { action: 'WAIT_CASE_AGENT', state, execDir: entry.execDir, executionId: item.executionId, technical: { code: error.code || 'CASE_RUNTIME_RECONCILE_FAILED', reason: error.message || String(error) } };
      }
      entry.execution = readJson(path.join(entry.execDir, 'execution.json'), null);
      const runtime = readJson(path.join(entry.execDir, 'runtime.json'), null);
      if (!runtime || runtime.executionId !== entry.execution.executionId) {
        return stopBatch(loaded.paths, state, 'CORRUPTED', 'CASE_RUNTIME_MISSING', 'active execution has no valid Case Runtime binding', { now: options.now });
      }
      if (entry.execution.finalized === true) return { action: 'COMMIT_CASE', state, execDir: entry.execDir };
      return {
        action: 'WAIT_CASE_AGENT',
        state,
        execDir: entry.execDir,
        executionId: item.executionId,
        brief: readJson(path.join(entry.execDir, 'case-brief.json'), null),
      };
    }
    return stopBatch(loaded.paths, state, 'CORRUPTED', 'EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again', { now: options.now });
  }, { now: options.now });
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  batchPaths,
  bootstrapBatch,
  commitCurrentCase,
  currentCase,
  initializeBatch,
  loadBatch,
  reconcileBatch,
  recordFinalizationStep,
  releaseRuntime,
  startCurrentCase,
};

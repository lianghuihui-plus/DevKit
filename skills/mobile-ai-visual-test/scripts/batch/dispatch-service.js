'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { validateAppProvisioning, validateBootstrapPolicy, validateInstalledAppIdentity } = require('../lib/app-provisioning');
const { appendJsonl, allocateExecutionId, readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { markBootstrapFailed, markBootstrapReady } = require('../lib/warm-session-contract');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');
const { createAgentHandoff, loadPreparedAgentHandoff } = require('./agent-handoff');
const { loadBatch, readBatchState, saveBatch } = require('./state-repository');
const {
  caseAgentPrompt,
  caseAgentResponse,
  caseRuntimeDir,
  currentCase,
  hasBatchEvent,
  protocolBindings,
  stopBatch,
  withRetriedBatchLock,
} = require('./service-support');

function assertAdapterResult(result, kind) {
  if (!result || result.ok !== true || result.coldStartVerified !== true || result.startupDisplayVerified !== true) {
    const error = contractError(result?.failureCode || `${kind}_FAILED`, result?.reason || `${kind} did not verify App restart`);
    if (result?.diagnostic) error.diagnostic = result.diagnostic;
    throw error;
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

function refreshBootstrapPlatformSession(paths, draft, result, now) {
  if (!result?.platformSession) return;
  const runtimePath = path.join(paths.batchDir, 'platform-runtime.json');
  const runtime = readJson(runtimePath, null);
  const previous = runtime?.resource?.session;
  if (!previous?.sessionId) throw contractError('IOS_APPIUM_SESSION_UNAVAILABLE', 'artifact bootstrap cannot update the missing Appium session');
  if (previous.sessionId !== result.platformSession.sessionId) {
    runtime.resource.session = {
      ...previous,
      ...result.platformSession,
      generation: Number(previous.generation || 1) + 1,
      refreshedAt: now,
      refreshOperationId: 'batch-artifact-bootstrap',
    };
    runtime.updatedAt = now;
    writeJsonAtomic(runtimePath, runtime);
  }
  draft.platformRuntime = { ...draft.platformRuntime, resource: runtime.resource };
}

function bootstrapBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  validateAppProvisioning(loaded.contract.appProvisioning, {
    workspaceRoot: options.workspaceRoot,
    platform: loaded.contract.binding.platform,
    appId: loaded.contract.binding.appId,
    deviceType: loaded.contract.binding.deviceType,
  });
  return withFileLock(loaded.paths.lock, () => {
    const { paths, contract } = loaded;
    const state = readBatchState(paths, contract);
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
    const platformRuntimeMatches = canonicalJson(draft.platformRuntime) === canonicalJson(runtimeAcquisition);
    const canRefreshPendingRuntime = draft.platformRuntime?.ok !== true
      && draft.platformRuntime?.retryable === true;
    if (draft.schemaVersion !== 1 || draft.requestId !== requestId || draft.eventId !== `batch-bootstrap-${state.batchId}`
      || canonicalJson(draft.binding) !== canonicalJson(contract.binding)
      || (!platformRuntimeMatches && !canRefreshPendingRuntime)) {
      throw contractError('BATCH_BOOTSTRAP_BINDING_MISMATCH', 'bootstrap draft does not match the current batch');
    }
    if (!platformRuntimeMatches && canRefreshPendingRuntime) {
      draft.platformRuntime = runtimeAcquisition;
      writeJsonAtomic(paths.bootstrapDraft, draft);
    }
    if (draft.platformRuntime?.ok !== true && draft.platformRuntime?.retryable === true) {
      return {
        action: 'WAIT_PLATFORM_RUNTIME',
        state,
        waitFor: draft.platformRuntime.waitFor || 'PLATFORM_RUNTIME',
        technical: draft.platformRuntime.diagnostic || {
          code: draft.platformRuntime.failureCode || 'PLATFORM_RUNTIME_ACQUIRE_FAILED',
          stage: 'PLATFORM_RUNTIME_ACQUIRE',
          summary: draft.platformRuntime.reason || 'platform runtime acquisition is still in progress',
          retryable: true,
        },
      };
    }
    if (contract.bootstrapPolicy.mode === 'REINSTALL_FROZEN' && !draft.result) {
      let dispatchNow = false;
      if (!draft.artifactPreparation) {
        draft.artifactPreparation = {
          status: 'DISPATCHED',
          artifactRef: contract.appProvisioning.artifactRef,
          dispatchedAt: options.now || new Date().toISOString(),
        };
        writeJsonAtomic(paths.bootstrapDraft, draft);
        dispatchNow = true;
      }
      if (options.interruptAfter === 'artifact-dispatched') throw new Error('MAVT_BATCH_BOOTSTRAP_INTERRUPTED: artifact-dispatched');
      if (draft.artifactPreparation.status === 'DISPATCHED' && dispatchNow) {
        let result;
        try {
          const policy = validateBootstrapPolicy(contract.bootstrapPolicy);
          if (policy.mode !== 'REINSTALL_FROZEN'
            || !policy.allowedEffects.includes('UNINSTALL_TARGET_APP')
            || !policy.allowedEffects.includes('INSTALL_FROZEN_ARTIFACT')) {
            throw contractError('BOOTSTRAP_NOT_AUTHORIZED', 'frozen bootstrap authorization does not permit reinstall');
          }
          result = options.adapter.prepareApp({
            binding: contract.binding,
            platformRuntime: draft.platformRuntime,
            provisioning: contract.appProvisioning,
            bootstrapPolicy: policy,
          });
          validateInstalledAppIdentity(result, contract.appProvisioning);
        } catch (error) {
          result = {
            ok: false,
            status: 'FAILED',
            failureCode: error.code || 'APP_ARTIFACT_BOOTSTRAP_FAILED',
            reason: error.message || String(error),
          };
        }
        draft.artifactPreparation = {
          ...draft.artifactPreparation,
          status: 'RECORDED',
          result,
          recordedAt: options.now || new Date().toISOString(),
        };
        writeJsonAtomic(paths.bootstrapDraft, draft);
      } else if (draft.artifactPreparation.status === 'DISPATCHED') {
        draft.artifactPreparation = {
          ...draft.artifactPreparation,
          status: 'OUTCOME_UNKNOWN',
          result: {
            ok: false,
            status: 'FAILED',
            failureCode: 'APP_PREPARATION_OUTCOME_UNKNOWN',
            reason: 'artifact installation was dispatched before interruption and will not be replayed',
          },
          recordedAt: options.now || new Date().toISOString(),
        };
        writeJsonAtomic(paths.bootstrapDraft, draft);
      }
      if (!['RECORDED', 'OUTCOME_UNKNOWN'].includes(draft.artifactPreparation.status)) {
        throw contractError('BATCH_BOOTSTRAP_CORRUPTED', 'artifact preparation state is invalid');
      }
      if (draft.artifactPreparation.result?.ok === true) {
        refreshBootstrapPlatformSession(paths, draft, draft.artifactPreparation.result, draft.artifactPreparation.recordedAt);
        writeJsonAtomic(paths.bootstrapDraft, draft);
      }
      if (options.interruptAfter === 'artifact-preparation') throw new Error('MAVT_BATCH_BOOTSTRAP_INTERRUPTED: artifact-preparation');
    }
    if (!draft.result) {
      if (draft.artifactPreparation?.result?.ok === false) {
        draft.result = {
          ok: false,
          coldStartVerified: false,
          startupDisplayVerified: false,
          failureCode: draft.artifactPreparation.result.failureCode || 'APP_ARTIFACT_BOOTSTRAP_FAILED',
          reason: draft.artifactPreparation.result.reason || 'artifact-managed bootstrap failed',
          ...(draft.artifactPreparation.result.diagnostic ? { diagnostic: draft.artifactPreparation.result.diagnostic } : {}),
        };
      } else if (draft.platformRuntime.ok !== true) {
        draft.result = {
          ok: false,
          coldStartVerified: false,
          startupDisplayVerified: false,
          failureCode: draft.platformRuntime.failureCode || 'PLATFORM_RUNTIME_ACQUIRE_FAILED',
          reason: draft.platformRuntime.reason || 'platform runtime acquisition failed',
          ...(draft.platformRuntime.diagnostic ? { diagnostic: draft.platformRuntime.diagnostic } : {}),
        };
      } else {
        try {
          draft.result = options.adapter.restartApp({
            requestId,
            scope: 'batch-bootstrap',
            binding: contract.binding,
            platformRuntime: draft.platformRuntime,
          });
        } catch (error) {
          draft.result = {
            ok: false,
            coldStartVerified: false,
            startupDisplayVerified: false,
            failureCode: error.code || 'ADAPTER_ERROR',
            reason: error.message,
            ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
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
      const failureCode = failure.code === 'DEVICE_ADAPTER_TIMEOUT'
        ? 'BATCH_BOOTSTRAP_TIMEOUT' : (failure.code || 'BATCH_BOOTSTRAP_FAILED');
      const diagnostic = failure.diagnostic
        ? {
          ...failure.diagnostic,
          code: failureCode,
          ...(failure.diagnostic.code && failure.diagnostic.code !== failureCode
            ? { causeCode: failure.diagnostic.code } : {}),
        }
        : undefined;
      if (state.warmSession.status === 'INITIALIZING') {
        state.warmSession = markBootstrapFailed(state.warmSession, commitTime);
        stopBatch(paths, state, 'BOOTSTRAP_FAILED', failureCode, failure.message, {
          now: commitTime,
          platform: contract.binding.platform,
          diagnostic: diagnostic || draft.result?.diagnostic,
        });
      } else if (state.warmSession.status !== 'DEGRADED' || !['BLOCKING', 'BLOCKED'].includes(state.status)
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
        appProvisioning: {
          mode: contract.appProvisioning.mode,
          bootstrapMode: contract.bootstrapPolicy.mode,
          ...(contract.bootstrapPolicy.mode === 'REINSTALL_FROZEN'
            ? {
              artifactRef: contract.appProvisioning.artifactRef,
              installationOutcome: draft.artifactPreparation?.result?.ok === true ? 'SUCCEEDED' : 'FAILED',
            }
            : {}),
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
  const started = withRetriedBatchLock(loaded.paths.lock, () => {
    const state = readBatchState(loaded.paths, loaded.contract);
    if (state.status !== 'RUNNING' || state.warmSession.status !== 'READY') throw contractError('WARM_SESSION_NOT_READY', 'batch warm session is not ready');
    const item = currentCase(state);
    if (!item) return { state, complete: true };
    if (item.status === 'RUNNING' && !fs.existsSync(loaded.paths.caseStartDraft)) {
      const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
      const execution = readJson(path.join(execDir, 'execution.json'));
      if (execution?.schemaVersion !== 12) throw contractError('FORMAT_UNSUPPORTED', `unsupported execution schema: ${execution?.schemaVersion ?? 'missing'}`);
      return {
        state,
        item,
        alreadyStarted: true,
        execDir,
        execution,
        runtime: readJson(path.join(execDir, 'runtime.json')),
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
        warmSessionId: state.warmSession.sessionId,
        warmSessionEpoch: state.warmSession.epoch,
        warmSessionGeneration: state.warmSession.generation,
        createdAt: options.now || new Date().toISOString(),
      };
      writeJsonAtomic(loaded.paths.caseStartDraft, draft);
    }
    if (draft.batchId !== state.batchId || draft.caseKey !== item.caseKey || draft.order !== item.order
      || draft.warmSessionId !== state.warmSession.sessionId || draft.warmSessionEpoch !== state.warmSession.epoch
      || draft.warmSessionGeneration !== state.warmSession.generation) {
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
        appProvisioning: loaded.contract.appProvisioning,
        appProvisioningSha: loaded.contract.appProvisioningSha,
        preparationPolicy: item.preparationPolicy,
        preparationPolicySha: item.preparationPolicySha,
        initialStateRequirement: item.initialStateRequirement,
        initialStateRequirementSha: item.initialStateRequirementSha,
        initialStatePreflight: item.initialStatePreflight,
        initialStatePreflightSha: item.initialStatePreflightSha,
        warmSessionId: draft.warmSessionId,
        warmSessionEpoch: draft.warmSessionEpoch,
        warmSessionGeneration: draft.warmSessionGeneration,
        warmSessionReused: state.currentIndex > 0,
        batchRecoveryCountAtStart: state.warmSession.recoveryCount,
        caseProcessingStartedAt: draft.createdAt,
        sessionRef: {
          schemaVersion: 2,
          batchId: state.batchId,
          statePath: loaded.paths.state,
          lockPath: loaded.paths.lock,
          eventsPath: loaded.paths.events,
          platformRuntimePath: path.join(loaded.paths.batchDir, 'platform-runtime.json'),
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
    if (options.interruptAfter === 'request') throw new Error('MAVT_CASE_START_INTERRUPTED: request');
    Object.assign(item, { status: 'RUNNING', executionId: draft.executionId, runtimePath: path.join(execDir, 'runtime.json'), startedAt: created.execution.startedAt });
    saveBatch(loaded.paths, state, options.now);
    if (options.interruptAfter === 'batch') throw new Error('MAVT_CASE_START_INTERRUPTED: batch');
    const eventExists = fs.existsSync(loaded.paths.events) && fs.readFileSync(loaded.paths.events, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
      try { return JSON.parse(line).eventId === draft.eventId; } catch (error) { return false; }
    });
    if (!eventExists) appendJsonl(loaded.paths.events, {
      schemaVersion: 1,
      eventId: draft.eventId,
      time: options.now || new Date().toISOString(),
      type: 'caseStarted',
      caseKey: item.caseKey,
      executionId: item.executionId,
      warmSessionId: draft.warmSessionId,
      warmSessionEpoch: draft.warmSessionEpoch,
      warmSessionGeneration: draft.warmSessionGeneration,
    });
    if (options.interruptAfter === 'event') throw new Error('MAVT_CASE_START_INTERRUPTED: event');
    fs.unlinkSync(loaded.paths.caseStartDraft);
    return { state, item, execution: readJson(path.join(execDir, 'execution.json')), execDir, runtime };
  }, { now: options.now });
  if (!started.execDir) {
    return caseAgentResponse({
      action: 'BATCH_COMPLETE',
      agentRequired: false,
      batchId: options.batchId,
      caseKey: null,
      executionId: null,
    });
  }
  const initialState = caseRuntimeLifecycle.establishInitialState({
    executionDir: started.execDir,
    runtimeOptions: { now: options.now, ...(options.runtimeOptions || {}) },
  });
  const response = {
    batchId: options.batchId,
    caseKey: started.item.caseKey,
    executionId: started.item.executionId,
  };
  if (!initialState.agentRequired) {
    return caseAgentResponse({
      action: initialState.status === 'BLOCKED' ? 'CASE_AUTO_BLOCKED' : 'CASE_ALREADY_FINISHED',
      agentRequired: false,
      ...response,
    });
  }
  if (!options.continuationReason) {
    const preparedHandoff = loadPreparedAgentHandoff({
      workspaceRoot: options.workspaceRoot,
      batchId: response.batchId,
      executionId: response.executionId,
      caseProtocolSha: loaded.contract.caseProtocolSha,
    });
    if (preparedHandoff) {
      return caseAgentResponse({ action: 'DELEGATE_CASE_AGENT', agentRequired: true, ...response, handoff: preparedHandoff });
    }
  }
  const delegate = () => {
    let brief;
    let mode = 'INITIAL';
    let sequence = 1;
    if (options.continuationReason) {
      caseRuntimeLifecycle.reconcileExecution({ executionDir: started.execDir, runtimeOptions: { now: options.now, ...(options.runtimeOptions || {}) } });
      const execution = readJson(path.join(started.execDir, 'execution.json'), null);
      if (execution?.finalized === true) {
        return caseAgentResponse({ action: 'CASE_ALREADY_FINISHED', agentRequired: false, ...response });
      }
      brief = caseRuntimeLifecycle.buildContinuationBrief({ executionDir: started.execDir, reason: options.continuationReason });
      mode = 'CONTINUATION';
      sequence = brief.continuation.sequence;
    } else {
      brief = caseRuntimeLifecycle.resumeExecution({ executionDir: started.execDir }).brief;
    }
    const handoff = createAgentHandoff({
      workspaceRoot: options.workspaceRoot,
      batchId: response.batchId,
      executionId: response.executionId,
      caseProtocolSha: loaded.contract.caseProtocolSha,
      casePrompt: caseAgentPrompt(),
      brief,
      mode,
      sequence,
      continuationReason: options.continuationReason,
      now: options.now,
    });
    caseRuntimeLifecycle.recordTimingAnchor({
      executionDir: started.execDir,
      field: 'handoffReadyAt',
      now: options.now,
    });
    if (mode === 'CONTINUATION') {
      caseRuntimeLifecycle.recordAgentContinuation({ executionDir: started.execDir, reason: options.continuationReason, now: options.now });
    }
    return caseAgentResponse({ action: 'DELEGATE_CASE_AGENT', agentRequired: true, ...response, handoff });
  };
  return options.continuationReason
    ? withRetriedBatchLock(loaded.paths.lock, delegate, { now: options.now })
    : delegate();
}

module.exports = { bootstrapBatch, startCurrentCase };

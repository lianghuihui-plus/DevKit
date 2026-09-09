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
const { validateCaseSpec } = require('../execution/contracts/case-spec-contract');
const { allocateExecutionId, atomicWrite, readJson, writeJsonAtomic, withFileLock } = require('../lib/execution-lifecycle');
const { assertWorkspace } = require('../lib/workspace');
const runtimeCore = require('./runtime-core');
const store = require('./store');

const EXECUTION_SCHEMA_VERSION = 10;

function createBoundClient(execDir) {
  const entry = path.join(execDir, 'runtime-client.js');
  const runtimeClient = path.resolve(__dirname, 'runtime-client.js');
  const content = `#!/usr/bin/env node\n'use strict';\nrequire(${JSON.stringify(runtimeClient)}).main(process.argv.slice(2), { execDir: ${JSON.stringify(path.resolve(execDir))} });\n`;
  atomicWrite(entry, content);
  fs.chmodSync(entry, 0o755);
  return entry;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildCaseBrief(executionDir, execution, caseJson, caseSpec, sourceText, runtime, scene = null) {
  const preparation = runtimeCore.runtimeStatus(executionDir).preparation;
  return {
    schemaVersion: 2,
    case: {
      caseNo: caseJson.identity.caseNo || caseJson.identity.caseKey,
      caseKey: caseJson.identity.caseKey,
      source: sourceText,
      spec: caseSpec,
    },
    target: {
      platform: execution.platform,
      app: execution.targetBinding.appName || execution.targetBinding.appId,
    },
    initialState: {
      targetState: execution.initialStateRequirement.targetState,
      status: execution.initialStateRequirement.targetState === 'KEEP_EXISTING'
        ? 'SATISFIED' : preparation?.status || 'PENDING',
    },
    runtime: {
      command: shellQuote(runtime.entry),
      requestPath: runtime.requestPath,
      input: 'Write one RuntimeRequest JSON object to requestPath, then run command without arguments.',
    },
    scene,
  };
}

function deriveCaseBrief(executionDir) {
  const resolved = path.resolve(executionDir);
  const execution = store.loadExecution(resolved, { allowFinalized: true });
  const sourceText = fs.readFileSync(path.join(resolved, 'source.snapshot.md'), 'utf8');
  const caseJson = readJson(path.join(resolved, 'case.snapshot.json'), null);
  const caseSpec = readJson(path.join(resolved, 'case-spec.snapshot.json'), null);
  validateCaseContract(caseJson);
  if (sourceSha(sourceText) !== execution.sourceSha || caseJson.identity.sourceSha !== execution.sourceSha
    || caseJson.contractSha !== execution.contractSha) {
    throw contractError('CASE_BRIEF_SOURCE_INVALID', 'execution snapshots do not match the frozen execution binding');
  }
  validateCaseSpec(caseSpec, { sourceText, sourceSha: execution.sourceSha });
  if (caseSpec.specSha !== execution.caseSpecSha) {
    throw contractError('CASE_BRIEF_SOURCE_INVALID', 'CaseSpec snapshot does not match the frozen execution binding');
  }
  const runtime = readJson(path.join(resolved, 'runtime.json'), null);
  const expectedEntry = path.join(resolved, 'runtime-client.js');
  const expectedRequestPath = path.join(resolved, 'runtime-request.json');
  if (!runtime || runtime.executionId !== execution.executionId || runtime.entry !== expectedEntry
    || runtime.requestPath !== expectedRequestPath || !fs.existsSync(expectedEntry)
    || runtime.broker?.schemaVersion !== 1
    || JSON.stringify(runtime.broker?.allowedOperations) !== JSON.stringify(require('./runtime-broker').AGENT_OPERATIONS)) {
    throw contractError('CASE_RUNTIME_BINDING_INVALID', 'Case Runtime client does not match the execution');
  }
  return buildCaseBrief(resolved, execution, caseJson, caseSpec, sourceText, runtime, store.readCurrentScene(resolved));
}

function createExecution(options) {
  assertWorkspace(options.workspaceRoot, { allowTest: true });
  validateCaseContract(options.caseJson);
  const frozenSourceSha = sourceSha(options.sourceText);
  if (frozenSourceSha !== options.caseJson.identity.sourceSha) throw contractError('EXECUTION_SOURCE_CHANGED', 'source text does not match the case contract');
  const caseSpec = validateCaseSpec(options.caseSpec, { sourceText: options.sourceText, sourceSha: frozenSourceSha });
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
  const executionId = options.executionId || allocateExecutionId(options.runtimeDir, options);
  const execDir = path.join(options.runtimeDir, 'executions', executionId);
  options.execDir = execDir;
  return withFileLock(path.join(options.workspaceRoot, '.execution-create.lock'), () => {
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
      writeJsonAtomic(path.join(stagingDir, 'case-spec.snapshot.json'), caseSpec);
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
        caseSpecSha: caseSpec.specSha,
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
      const entry = createBoundClient(execDir);
      writeJsonAtomic(path.join(execDir, 'runtime.json'), {
        schemaVersion: 1,
        executionId,
        status: 'READY',
        entry,
        requestPath: path.join(execDir, 'runtime-request.json'),
        sessionRef: options.sessionRef || null,
        knowledgeRoots: (options.knowledgeRoots || []).map((root) => path.resolve(root)),
        broker: {
          schemaVersion: 1,
          allowedOperations: require('./runtime-broker').AGENT_OPERATIONS,
        },
        boundAt: startedAt,
      });
      store.appendEvent(execDir, 'executionStarted', { generation: execution.warmSessionGeneration }, { now: startedAt });
      store.appendEvent(execDir, 'caseContextRecorded', {
        contextVersion: 1,
        reason: 'FROZEN_CASE_SPEC',
        caseContext: {
          summary: caseSpec.summary,
          preconditions: caseSpec.preconditions,
          expectations: caseSpec.expectations.map(({ id, text, verificationKind }) => ({ id, text, verificationKind })),
          initialPlan: [],
          uncertainties: caseSpec.ambiguities,
        },
      }, { now: startedAt });
      const observed = options.initialObserve === false
        ? { status: 'READY', scene: null }
        : runtimeCore.execute(execDir, { operation: 'observe', purpose: 'INITIAL_SCENE' }, options.runtimeOptions || {});
      const brief = buildCaseBrief(execDir, execution, options.caseJson, caseSpec, options.sourceText, readJson(path.join(execDir, 'runtime.json')), observed.scene || null);
      return { executionId, execDir, execution: readJson(path.join(execDir, 'execution.json')), runtime: readJson(path.join(execDir, 'runtime.json')), brief, scene: observed.scene || null, runtimeStatus: observed.status };
    } catch (error) {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }, { now: options.now });
}

function establishInitialState({ executionDir, runtimeOptions = {} }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  const requirement = validateInitialStateRequirement(execution.initialStateRequirement);
  if (execution.initialStateRequirementSha !== initialStateRequirementSha(requirement)) {
    throw contractError('INITIAL_STATE_REQUIREMENT_CHANGED', 'execution initial state requirement changed');
  }
  if (execution.finalized || requirement.targetState === 'KEEP_EXISTING') {
    return { status: execution.finalized ? execution.status : 'READY', agentRequired: execution.finalized !== true };
  }
  const current = runtimeCore.runtimeStatus(executionDir);
  if (current.preparation?.status === 'SATISFIED') return { status: 'READY', agentRequired: true, scene: current.scene };
  const prepared = runtimeCore.execute(executionDir, {
    operation: 'prepare',
    preparation: { targetState: requirement.targetState },
  }, runtimeOptions);
  if (prepared.status === 'SCENE') return { status: 'READY', agentRequired: true, scene: prepared.scene, preparation: prepared.preparation };
  if (prepared.status === 'TECHNICAL' && prepared.code === 'APP_INITIAL_STATE_UNAVAILABLE') {
    const caseSpec = readJson(path.join(executionDir, 'case-spec.snapshot.json'));
    const actual = `Required initial state ${requirement.targetState} could not be established`;
    const result = {
      verdict: 'BLOCKED',
      summary: actual,
      checks: caseSpec.expectations.map((expectation) => ({
        expectationRef: expectation.id,
        status: 'BLOCKED',
        actual,
        sceneRefs: [],
        knowledgeRefs: [],
        technicalRefs: prepared.technicalFactRef ? [prepared.technicalFactRef] : [],
      })),
      uncertainties: [prepared.message || actual],
    };
    const finished = runtimeCore.execute(executionDir, { operation: 'finish', result }, runtimeOptions);
    if (finished.status !== 'COMPLETED') throw contractError('INITIAL_STATE_BLOCKED_RESULT_INVALID', finished.message || 'failed to finalize blocked initial state');
    return { status: 'BLOCKED', agentRequired: false, technicalFactRef: prepared.technicalFactRef || null, result };
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
  const initial = deriveCaseBrief(executionDir);
  const events = store.events(executionDir);
  const narrative = require('./narrative-service').narrativeStatus(executionDir);
  const reviewed = new Set(events.filter((event) => event.type === 'knowledgeReviewed').map((event) => event.queryId));
  const pendingKnowledgeReviews = events.filter((event) => event.type === 'knowledgeQueried' && !reviewed.has(event.queryId))
    .map((event) => ({ queryId: event.queryId, candidateCount: event.candidateCount, expectationRefs: event.expectationRefs || [] }));
  const lastAction = events.filter((event) => ['actionCompleted', 'actionOutcomeUnknown'].includes(event.type)).at(-1) || null;
  const technical = require('../lib/technical-facts');
  const unresolvedTechnicalFacts = technical.technicalFacts(events)
    .filter((event) => technical.technicalFactState(event, events, execution).state === 'VALID')
    .map((event) => ({ technicalFactRef: event.technicalFactRef, code: event.code, message: event.message, expectationRefs: event.expectationRefs || [] }));
  const status = runtimeCore.runtimeStatus(executionDir);
  return {
    ...initial,
    schemaVersion: 2,
    mode: 'CONTINUATION',
    continuation: {
      reason: String(reason || 'native Agent handle is unavailable'),
      sequence: events.filter((event) => event.type === 'agentContinuation').length + 1,
    },
    scene: store.readCurrentScene(executionDir),
    resumeState: {
      executionStatus: execution.status,
      remainingMs: status.remainingMs,
      ...(status.preparation ? { preparation: status.preparation } : {}),
      caseContext: narrative.caseContext,
      contextVersion: narrative.contextVersion,
      latestPlan: narrative.latestPlan,
      lastAction,
      unresolvedTechnicalFacts,
      pendingKnowledgeReviews,
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

module.exports = { EXECUTION_SCHEMA_VERSION, buildContinuationBrief, cancelExecution, commitExecution, createExecution, establishInitialState, readCompletion, reconcileExecution, recordAgentContinuation, resumeExecution };

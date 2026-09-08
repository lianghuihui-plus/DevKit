'use strict';

const fs = require('fs');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { contractError } = require('../lib/contract-utils');
const { sourceSha, validateCaseContract } = require('../execution/contracts/case-contract');
const { allocateExecutionId, atomicWrite, readJson, writeJsonAtomic, withFileLock } = require('../lib/execution-lifecycle');
const { assertWorkspace } = require('../lib/workspace');
const runtimeCore = require('./runtime-core');
const store = require('./store');

const EXECUTION_SCHEMA_VERSION = 7;

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

function buildCaseBrief(options, execution, entry, scene = null) {
  const requestPath = path.join(path.resolve(options.execDir), 'runtime-request.json');
  return {
    schemaVersion: 1,
    case: {
      caseNo: options.caseJson.identity.caseNo || options.caseJson.identity.caseKey,
      caseKey: options.caseJson.identity.caseKey,
      source: options.sourceText,
    },
    target: {
      platform: execution.platform,
      app: execution.targetBinding.appName || execution.targetBinding.appId,
    },
    runtime: {
      command: shellQuote(entry),
      requestPath,
      input: 'Write one RuntimeRequest JSON object to requestPath, then run command without arguments.',
    },
    scene,
  };
}

function createExecution(options) {
  assertWorkspace(options.workspaceRoot, { allowTest: true });
  validateCaseContract(options.caseJson);
  const frozenSourceSha = sourceSha(options.sourceText);
  if (frozenSourceSha !== options.caseJson.identity.sourceSha) throw contractError('EXECUTION_SOURCE_CHANGED', 'source text does not match the case contract');
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
        batchContractSha: options.batchContractSha,
        executionRequestSha: options.executionRequestSha,
        interactionPolicy: options.interactionPolicy,
        targetBinding: { ...options.targetBinding },
        targetBindingSha: bindingSha(options.targetBinding),
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
        boundAt: startedAt,
      });
      store.appendEvent(execDir, 'executionStarted', { generation: execution.warmSessionGeneration }, { now: startedAt });
      const observed = options.initialObserve === false
        ? { status: 'READY', scene: null }
        : runtimeCore.execute(execDir, { operation: 'observe', purpose: 'INITIAL_SCENE' }, options.runtimeOptions || {});
      const brief = buildCaseBrief({ ...options, execDir }, execution, entry, observed.scene || null);
      writeJsonAtomic(path.join(execDir, 'case-brief.json'), brief);
      return { executionId, execDir, execution: readJson(path.join(execDir, 'execution.json')), runtime: readJson(path.join(execDir, 'runtime.json')), brief, scene: observed.scene || null, runtimeStatus: observed.status };
    } catch (error) {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }, { now: options.now });
}

function resumeExecution({ executionDir }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  const brief = readJson(path.join(executionDir, 'case-brief.json'), null);
  if (!brief) throw contractError('CASE_BRIEF_MISSING', 'case-brief.json is missing');
  return { executionDir: path.resolve(executionDir), execution, brief, status: runtimeCore.runtimeStatus(executionDir) };
}

function buildContinuationBrief({ executionDir, reason }) {
  const execution = store.loadExecution(executionDir, { allowFinalized: true });
  const initial = readJson(path.join(executionDir, 'case-brief.json'), null);
  if (!initial) throw contractError('CASE_BRIEF_MISSING', 'case-brief.json is missing');
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
      remainingMs: runtimeCore.runtimeStatus(executionDir).remainingMs,
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

module.exports = { EXECUTION_SCHEMA_VERSION, buildContinuationBrief, cancelExecution, commitExecution, createExecution, readCompletion, reconcileExecution, recordAgentContinuation, resumeExecution };

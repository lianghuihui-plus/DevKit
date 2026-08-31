'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const {
  sourceSha,
  validateCaseContract,
} = require('../execution/contracts/case-contract');
const { bindingSha, validateBinding } = require('./batch-contract');

const EXECUTION_SCHEMA_VERSION = 3;
const EXECUTION_PHASES = new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE', 'FINALIZED']);

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function writeJsonAtomic(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function executionIdFromDate(date = new Date(), random = Math.random) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
    '-',
    String(date.getMilliseconds()).padStart(3, '0'),
  ].join('');
  return `${stamp}-${random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

function allocateExecutionId(runtimeDir, options = {}) {
  for (let index = 0; index < 20; index += 1) {
    const executionId = executionIdFromDate(options.date ? new Date(options.date) : new Date(), options.random || Math.random);
    if (!fs.existsSync(path.join(runtimeDir, 'executions', executionId))) return executionId;
  }
  throw contractError('EXECUTION_ID_EXHAUSTED', 'failed to allocate a unique execution id');
}

function executionPaths(runtimeDir, executionId) {
  const execDir = path.join(runtimeDir, 'executions', executionId);
  return {
    execDir,
    execution: path.join(execDir, 'execution.json'),
    caseSnapshot: path.join(execDir, 'case.snapshot.json'),
    sourceSnapshot: path.join(execDir, 'source.snapshot.md'),
    timeline: path.join(execDir, 'timeline.jsonl'),
    understanding: path.join(execDir, 'understanding.json'),
    plan: path.join(execDir, 'plan.json'),
    result: path.join(execDir, 'result.json'),
    metrics: path.join(execDir, 'metrics.json'),
    phaseDraft: path.join(execDir, 'phase.draft.json'),
    finalizationDraft: path.join(execDir, 'finalization.draft.json'),
    lock: path.join(execDir, '.write.lock'),
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireFileLock(file, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { pid: process.pid, acquiredAt: options.now || new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
      fs.closeSync(fd);
      return { file, owner: payload };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(file, {});
      if (processIsAlive(owner.pid)) throw contractError('EXECUTION_LOCKED', `execution is locked by process ${owner.pid}`);
      fs.unlinkSync(file);
    }
  }
  throw contractError('EXECUTION_LOCKED', 'execution lock could not be acquired');
}

function releaseFileLock(lock) {
  if (!lock?.file || !fs.existsSync(lock.file)) return;
  const owner = readJson(lock.file, {});
  if (owner.pid !== lock.owner.pid || owner.acquiredAt !== lock.owner.acquiredAt) {
    throw contractError('EXECUTION_LOCK_OWNERSHIP_LOST', 'execution lock owner changed before release');
  }
  fs.unlinkSync(lock.file);
}

function withFileLock(file, callback, options = {}) {
  const lock = acquireFileLock(file, options);
  try {
    return callback();
  } finally {
    releaseFileLock(lock);
  }
}

function listExecutionDirs(workspaceRoot) {
  const casesRoot = path.join(workspaceRoot, 'cases');
  if (!fs.existsSync(casesRoot)) return [];
  const dirs = [];
  for (const caseName of fs.readdirSync(casesRoot).sort()) {
    const platformsRoot = path.join(casesRoot, caseName, 'platforms');
    if (!fs.existsSync(platformsRoot)) continue;
    for (const platform of fs.readdirSync(platformsRoot).sort()) {
      const executionsRoot = path.join(platformsRoot, platform, 'executions');
      if (!fs.existsSync(executionsRoot)) continue;
      for (const executionId of fs.readdirSync(executionsRoot).filter((name) => !name.startsWith('.')).sort()) {
        const execDir = path.join(executionsRoot, executionId);
        if (fs.statSync(execDir).isDirectory()) dirs.push(execDir);
      }
    }
  }
  return dirs;
}

function findActiveExecutions(workspaceRoot) {
  return listExecutionDirs(workspaceRoot).flatMap((execDir) => {
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    const closure = execution && execution.finalized !== true
      ? require('./execution-closure').readExecutionClosure(workspaceRoot, execDir, execution)
      : null;
    return execution && execution.finalized !== true && !closure ? [{ execDir, execution }] : [];
  });
}

function createExecution(options) {
  const {
    workspaceRoot,
    runtimeDir,
    caseJson,
    sourceText,
    batchId,
    platform,
    implementationSha,
    contractSha = caseJson?.contractSha,
  } = options;
  validateCaseContract(caseJson);
  if (!String(options.executionRequestSha || '').startsWith('execution-request-') || options.interactionPolicy !== 'UNATTENDED') {
    throw contractError('EXECUTION_REQUEST_BINDING_INVALID', 'execution requires an unattended execution request');
  }
  const frozenSourceSha = sourceSha(sourceText);
  if (frozenSourceSha !== caseJson.identity.sourceSha) {
    throw contractError('EXECUTION_SOURCE_CHANGED', 'source text does not match the current case contract');
  }
  const createLock = path.join(workspaceRoot, '.execution-create.lock');
  return withFileLock(createLock, () => {
    const active = findActiveExecutions(workspaceRoot);
    if (active.length) throw contractError('EXECUTION_ACTIVE_CONFLICT', `unfinalized execution exists: ${active[0].execution.executionId}`);
    const executionId = options.executionId || allocateExecutionId(runtimeDir, options);
    const paths = executionPaths(runtimeDir, executionId);
    fs.mkdirSync(path.dirname(paths.execDir), { recursive: true });
    const stagingDir = path.join(path.dirname(paths.execDir), `.${executionId}.creating`);
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    try {
      fs.mkdirSync(stagingDir);
    } catch (error) {
      if (error.code === 'EEXIST' || fs.existsSync(paths.execDir)) throw contractError('EXECUTION_ALREADY_EXISTS', `execution already exists: ${executionId}`);
      throw error;
    }
    if (fs.existsSync(paths.execDir)) throw contractError('EXECUTION_ALREADY_EXISTS', `execution already exists: ${executionId}`);
    const stagingPaths = {
      sourceSnapshot: path.join(stagingDir, 'source.snapshot.md'),
      caseSnapshot: path.join(stagingDir, 'case.snapshot.json'),
      execution: path.join(stagingDir, 'execution.json'),
    };
    if (options.interruptAfter === 'directory') throw new Error('MAVT_EXECUTION_CREATE_INTERRUPTED: directory');
    for (const name of ['screenshots', 'layouts', 'logs', 'agent']) fs.mkdirSync(path.join(stagingDir, name));
    atomicWrite(stagingPaths.sourceSnapshot, sourceText);
    writeJsonAtomic(stagingPaths.caseSnapshot, caseJson);
    if (options.interruptAfter === 'snapshots') throw new Error('MAVT_EXECUTION_CREATE_INTERRUPTED: snapshots');
    const startedAt = options.now || new Date().toISOString();
    const execution = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      executionId,
      batchId,
      platform,
      implementationSha,
      caseExecutorProtocolSha: options.caseExecutorProtocolSha,
      coordinatorProtocolSha: options.coordinatorProtocolSha,
      contractSha,
      batchContractSha: options.batchContractSha,
      executionRequestSha: options.executionRequestSha,
      interactionPolicy: options.interactionPolicy,
      targetBinding: options.targetBinding ? { ...options.targetBinding } : undefined,
      targetBindingSha: options.targetBinding ? bindingSha(options.targetBinding) : undefined,
      warmSessionGeneration: options.warmSessionGeneration,
      warmSessionReused: options.warmSessionReused === true,
      recoveryCount: options.recoveryCount || 0,
      sourceSha: frozenSourceSha,
      startedAt,
      phase: 'UNDERSTAND',
      lifecycle: 'RUNNING',
      finalized: false,
    };
    writeJsonAtomic(stagingPaths.execution, execution);
    if (options.interruptAfter === 'state') throw new Error('MAVT_EXECUTION_CREATE_INTERRUPTED: state');
    fs.renameSync(stagingDir, paths.execDir);
    return { executionId, ...paths, execution };
  }, { now: options.now });
}

function readExecution(execDir, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (!execution) throw contractError('EXECUTION_ORPHANED', 'execution.json is missing');
  if (execution.schemaVersion !== EXECUTION_SCHEMA_VERSION) throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', `unsupported execution schema: ${execution.schemaVersion ?? 'missing'}`);
  if (!EXECUTION_PHASES.has(execution.phase)) throw contractError('EXECUTION_CORRUPTED', `invalid execution phase: ${execution.phase}`);
  const sourcePath = path.join(execDir, 'source.snapshot.md');
  const snapshot = readJson(path.join(execDir, 'case.snapshot.json'), null);
  if (!fs.existsSync(sourcePath) || !snapshot) throw contractError('EXECUTION_CORRUPTED', 'execution snapshots are incomplete');
  validateCaseContract(snapshot);
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const actualSourceSha = sourceSha(sourceText);
  if (actualSourceSha !== execution.sourceSha || snapshot.identity.sourceSha !== execution.sourceSha) {
    throw contractError('EXECUTION_SNAPSHOT_CHANGED', 'execution source or case snapshot digest changed');
  }
  if (snapshot.contractSha !== execution.contractSha) throw contractError('EXECUTION_SNAPSHOT_CHANGED', 'case snapshot contract binding changed');
  if (!String(execution.executionRequestSha || '').startsWith('execution-request-') || execution.interactionPolicy !== 'UNATTENDED') {
    throw contractError('EXECUTION_CORRUPTED', 'execution is not bound to an unattended execution request');
  }
  if (execution.targetBinding !== undefined || execution.targetBindingSha !== undefined) {
    validateBinding(execution.targetBinding);
    if (bindingSha(execution.targetBinding) !== execution.targetBindingSha) {
      throw contractError('EXECUTION_TARGET_BINDING_CHANGED', 'target binding hash mismatch');
    }
  }
  const liveSourceChanged = options.liveSourceText !== undefined && sourceSha(options.liveSourceText) !== execution.sourceSha;
  return { execution, snapshot, sourceText, liveSourceChanged };
}

function recoverExecution(execDir) {
  const executionPath = path.join(execDir, 'execution.json');
  if (!fs.existsSync(executionPath)) return { status: 'ORPHANED', execDir };
  const execution = readJson(executionPath);
  if (execution.finalized === true) {
    const complete = fs.existsSync(path.join(execDir, 'result.json')) && fs.existsSync(path.join(execDir, 'metrics.json'));
    return { status: complete ? 'FINALIZED' : 'CORRUPTED', execDir, execution };
  }
  if (fs.existsSync(path.join(execDir, 'phase.draft.json'))) {
    return { status: 'RESUME_PHASE', execDir, execution, draft: readJson(path.join(execDir, 'phase.draft.json')) };
  }
  if (execution.lifecycle === 'FINALIZING' && fs.existsSync(path.join(execDir, 'finalization.draft.json'))) {
    return { status: 'RESUME_FINALIZE', execDir, execution };
  }
  return { status: 'RESUME', execDir, execution };
}

module.exports = {
  EXECUTION_PHASES,
  EXECUTION_SCHEMA_VERSION,
  acquireFileLock,
  allocateExecutionId,
  appendJsonl,
  atomicWrite,
  createExecution,
  executionIdFromDate,
  executionPaths,
  findActiveExecutions,
  readExecution,
  readJson,
  recoverExecution,
  releaseFileLock,
  withFileLock,
  writeJsonAtomic,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('./contract-utils');

const CLOSURE_SCHEMA_VERSION = 1;
const CLOSURE_DIR = 'execution-closures';

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function findWorkspaceRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'workspace.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function closurePath(workspaceRoot, executionId) {
  return path.join(workspaceRoot, CLOSURE_DIR, `${executionId}.json`);
}

function closureDigest(value) {
  const unsigned = { ...value };
  delete unsigned.closureSha;
  return sha256(canonicalJson(unsigned), 'execution-closure', 24);
}

function validateExecutionClosure(workspaceRoot, value, execDir = null) {
  const componentBound = String(value?.runtimeSha || '').trim() && String(value?.adapterSha || '').trim()
    && String(value?.closedByRuntimeSha || '').trim() && String(value?.closedByAdapterSha || '').trim();
  if (value?.schemaVersion !== CLOSURE_SCHEMA_VERSION || !String(value.executionId || '').trim()
    || !String(value.executionPath || '').trim() || !componentBound
    || value.reasonCode !== 'IMPLEMENTATION_REPLACED'
    || !String(value.reason || '').trim() || Number.isNaN(Date.parse(value.closedAt))) {
    throw contractError('EXECUTION_CLOSURE_INVALID', 'execution closure is incomplete');
  }
  if (path.isAbsolute(value.executionPath) || value.executionPath.split(/[\\/]+/).includes('..')) {
    throw contractError('EXECUTION_CLOSURE_INVALID', 'execution closure path is unsafe');
  }
  const expectedDir = path.resolve(workspaceRoot, value.executionPath);
  if (!expectedDir.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)
    || (execDir && expectedDir !== path.resolve(execDir))) {
    throw contractError('EXECUTION_CLOSURE_BINDING_MISMATCH', 'execution closure does not match its execution directory');
  }
  if (value.closureSha !== closureDigest(value)) throw contractError('EXECUTION_CLOSURE_INVALID', 'execution closure digest is invalid');
  return value;
}

function readExecutionClosure(workspaceRoot, execDir, execution = null) {
  const identity = execution || readJson(path.join(execDir, 'execution.json'), null);
  if (!identity?.executionId) return null;
  const value = readJson(closurePath(workspaceRoot, identity.executionId), null);
  if (!value) return null;
  const identityMatches = value.runtimeSha === identity.runtimeSha && value.adapterSha === identity.adapterSha;
  if (value.executionId !== identity.executionId || !identityMatches) {
    throw contractError('EXECUTION_CLOSURE_BINDING_MISMATCH', 'execution closure identity does not match execution.json');
  }
  return validateExecutionClosure(workspaceRoot, value, execDir);
}

function executionClosureForDir(execDir) {
  const workspaceRoot = findWorkspaceRoot(execDir);
  return workspaceRoot ? readExecutionClosure(workspaceRoot, execDir) : null;
}

function createExecutionClosure(workspaceRoot, execDir, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (!execution?.executionId || execution.finalized === true) {
    throw contractError('EXECUTION_CLOSURE_INVALID', 'only an unfinalized execution can be closed');
  }
  if (!execution.runtimeSha || !execution.adapterSha) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'execution does not use the current component binding and must be run again');
  }
  if (execution.runtimeSha === options.closedByRuntimeSha && execution.adapterSha === options.closedByAdapterSha) {
    throw contractError('EXECUTION_CLOSURE_INVALID', 'an execution cannot be replaced by compatible runtime components');
  }
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(execDir)).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError('EXECUTION_CLOSURE_INVALID', 'execution must belong to the current workspace');
  }
  const value = {
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    executionId: execution.executionId,
    executionPath: relative,
    batchId: execution.batchId || null,
    runtimeSha: execution.runtimeSha,
    adapterSha: execution.adapterSha,
    closedByRuntimeSha: options.closedByRuntimeSha,
    closedByAdapterSha: options.closedByAdapterSha,
    replacementBatchId: options.replacementBatchId || null,
    reasonCode: 'IMPLEMENTATION_REPLACED',
    reason: options.reason || '未完成执行属于其他实现，当前协议不再续写',
    closedAt: options.now || new Date().toISOString(),
  };
  value.closureSha = closureDigest(value);
  const file = closurePath(workspaceRoot, execution.executionId);
  const existing = readJson(file, null);
  if (existing) {
    validateExecutionClosure(workspaceRoot, existing, execDir);
    if (existing.executionId !== value.executionId || existing.executionPath !== value.executionPath
      || existing.runtimeSha !== value.runtimeSha || existing.adapterSha !== value.adapterSha) {
      throw contractError('EXECUTION_CLOSURE_BINDING_MISMATCH', 'existing execution closure belongs to another execution');
    }
    return { closure: existing, idempotent: true };
  }
  writeJsonAtomic(file, value);
  return { closure: value, idempotent: false };
}

function executionDirs(workspaceRoot) {
  const casesRoot = path.join(workspaceRoot, 'cases');
  if (!fs.existsSync(casesRoot)) return [];
  const values = [];
  for (const caseName of fs.readdirSync(casesRoot).sort()) {
    const platformsRoot = path.join(casesRoot, caseName, 'platforms');
    if (!fs.existsSync(platformsRoot)) continue;
    for (const platform of fs.readdirSync(platformsRoot).sort()) {
      const root = path.join(platformsRoot, platform, 'executions');
      if (!fs.existsSync(root)) continue;
      for (const executionId of fs.readdirSync(root).filter((name) => !name.startsWith('.')).sort()) {
        const execDir = path.join(root, executionId);
        if (fs.statSync(execDir).isDirectory()) values.push(execDir);
      }
    }
  }
  return values;
}

function closeStaleExecutions(workspaceRoot, components, options = {}) {
  const closed = [];
  for (const execDir of executionDirs(workspaceRoot)) {
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    if (!execution || execution.schemaVersion !== 13 || execution.runtime !== 'case-runtime'
      || execution.finalized === true
      || (execution.runtimeSha === components.runtimeSha && execution.adapterSha === components.adapterSha)
      || readExecutionClosure(workspaceRoot, execDir, execution)) continue;
    closed.push(createExecutionClosure(workspaceRoot, execDir, {
      closedByRuntimeSha: components.runtimeSha,
      closedByAdapterSha: components.adapterSha,
      replacementBatchId: options.replacementBatchId,
      reason: options.reason,
      now: options.now,
    }).closure);
  }
  return closed;
}

module.exports = {
  CLOSURE_DIR,
  CLOSURE_SCHEMA_VERSION,
  closeStaleExecutions,
  closurePath,
  createExecutionClosure,
  executionClosureForDir,
  findWorkspaceRoot,
  readExecutionClosure,
  validateExecutionClosure,
};

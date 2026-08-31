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
  if (value?.schemaVersion !== CLOSURE_SCHEMA_VERSION || !String(value.executionId || '').trim()
    || !String(value.executionPath || '').trim() || !String(value.implementationSha || '').trim()
    || !String(value.closedByImplementationSha || '').trim() || value.reasonCode !== 'IMPLEMENTATION_REPLACED'
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
  if (value.executionId !== identity.executionId || value.implementationSha !== identity.implementationSha) {
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
  if (execution.implementationSha === options.closedByImplementationSha) {
    throw contractError('EXECUTION_CLOSURE_INVALID', 'an execution cannot be closed as an implementation replacement by the same implementation');
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
    implementationSha: execution.implementationSha,
    closedByImplementationSha: options.closedByImplementationSha,
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
      || existing.implementationSha !== value.implementationSha) {
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

function closeIncompatibleExecutions(workspaceRoot, implementationSha, options = {}) {
  const closed = [];
  for (const execDir of executionDirs(workspaceRoot)) {
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    if (!execution || execution.finalized === true || execution.implementationSha === implementationSha
      || readExecutionClosure(workspaceRoot, execDir, execution)) continue;
    closed.push(createExecutionClosure(workspaceRoot, execDir, {
      closedByImplementationSha: implementationSha,
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
  closeIncompatibleExecutions,
  closurePath,
  createExecutionClosure,
  executionClosureForDir,
  findWorkspaceRoot,
  readExecutionClosure,
  validateExecutionClosure,
};

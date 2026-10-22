'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const {
  sourceSha,
  validateCaseContract,
} = require('../execution/contracts/case-contract');
const { bindingSha, validateBinding } = require('./batch-contract');

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

function readJsonl(file, options = {}) {
  if (!fs.existsSync(file)) return [];
  let content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      const isIncompleteTail = index === lines.length - 1 && !content.endsWith('\n');
      if (options.repairIncompleteTail === true && isIncompleteTail) {
        const lastNewline = content.lastIndexOf('\n');
        content = lastNewline >= 0 ? content.slice(0, lastNewline + 1) : '';
        atomicWrite(file, content);
        return events;
      }
      throw contractError('EXECUTION_EVENT_LOG_CORRUPTED', `invalid JSONL event at line ${index + 1}: ${path.basename(file)}`);
    }
  }
  if (options.repairIncompleteTail === true && content && !content.endsWith('\n')) {
    atomicWrite(file, `${content}\n`);
  }
  return events;
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
      let owner;
      try {
        owner = readJson(file, {});
      } catch {
        throw contractError('EXECUTION_LOCKED', 'execution lock owner is still being written');
      }
      if (processIsAlive(owner.pid)) throw contractError('EXECUTION_LOCKED', `execution is locked by process ${owner.pid}`);
      try {
        fs.unlinkSync(file);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
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
    if (execution?.schemaVersion !== 14 || execution.runtime !== 'case-runtime') return [];
    const closure = execution && execution.finalized !== true
      ? require('./execution-closure').readExecutionClosure(workspaceRoot, execDir, execution)
      : null;
    return execution && execution.finalized !== true && !closure ? [{ execDir, execution }] : [];
  });
}

module.exports = {
  acquireFileLock,
  allocateExecutionId,
  appendJsonl,
  atomicWrite,
  executionIdFromDate,
  findActiveExecutions,
  listExecutionDirs,
  readJson,
  readJsonl,
  releaseFileLock,
  withFileLock,
  writeJsonAtomic,
};

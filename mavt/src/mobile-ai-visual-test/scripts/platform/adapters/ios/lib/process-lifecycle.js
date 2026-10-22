'use strict';

const childProcess = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processCommand(pid) {
  const result = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function processStartedAt(pid) {
  const result = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return result.status === 0 ? String(result.stdout || '').trim().replace(/\s+/g, ' ') : '';
}

function parseProcessList(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      command: match[4],
    };
  }).filter(Boolean);
}

function listProcesses() {
  const result = childProcess.spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.status === 0 ? parseProcessList(result.stdout) : [];
}

function signalProcessGroup(record, signal) {
  try {
    process.kill(-record.processGroupId, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    try {
      process.kill(record.pid, signal);
    } catch (fallbackError) {
      if (fallbackError.code !== 'ESRCH') throw fallbackError;
    }
  }
}

async function stopProcessGroup(record, options = {}) {
  const alive = options.processAlive || processAlive;
  const signal = options.signalProcessGroup || signalProcessGroup;
  const wait = options.sleep || sleep;
  const label = options.label || 'managed process';
  if (!alive(record.pid)) return { ok: true, alreadyStopped: true };
  signal(record, 'SIGTERM');
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 3000;
  const deadline = Date.now() + graceMs;
  while (alive(record.pid) && Date.now() < deadline) await wait(100);
  if (alive(record.pid)) {
    signal(record, 'SIGKILL');
    const forceDeadline = Date.now() + 1000;
    while (alive(record.pid) && Date.now() < forceDeadline) await wait(50);
  }
  return alive(record.pid)
    ? { ok: false, reason: `${label} ${record.pid} did not stop` }
    : { ok: true, alreadyStopped: false };
}

module.exports = {
  listProcesses,
  parseProcessList,
  processAlive,
  processCommand,
  processStartedAt,
  signalProcessGroup,
  sleep,
  stopProcessGroup,
};

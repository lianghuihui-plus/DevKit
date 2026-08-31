'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonl, readJson } = require('./execution-lifecycle');

const CURRENT_ATTEMPT_FILE = 'attempt.current.json';

function durationMs(start, end) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readAttempts(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function settleCurrentAttempt(execDir, options = {}) {
  const agentDir = path.join(path.resolve(execDir), 'agent');
  const currentFile = path.join(agentDir, CURRENT_ATTEMPT_FILE);
  const current = readJson(currentFile, null);
  if (!current) return null;
  const attemptsFile = path.join(agentDir, 'attempts.jsonl');
  const existing = readAttempts(attemptsFile).find((attempt) => attempt.attemptId === current.attemptId);
  if (existing) {
    fs.unlinkSync(currentFile);
    return { ...existing, idempotent: true };
  }
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const executionCompleted = execution?.finalized === true;
  const endedAt = executionCompleted && execution.endedAt
    ? execution.endedAt
    : options.endedAt || options.now || new Date().toISOString();
  const error = executionCompleted
    ? {
      code: 'AGENT_ENTRYPOINT_OUTPUT_INTERRUPTED',
      message: 'Agent entrypoint completed the execution but ended before recording its response',
    }
    : {
      code: 'AGENT_ENTRYPOINT_INTERRUPTED',
      message: options.reason || 'Agent entrypoint ended without a recorded response',
    };
  const settled = {
    ...current,
    endedAt,
    durationMs: durationMs(current.startedAt, endedAt),
    ok: false,
    executionCompleted,
    error,
  };
  appendJsonl(attemptsFile, settled);
  fs.unlinkSync(currentFile);
  return settled;
}

module.exports = {
  CURRENT_ATTEMPT_FILE,
  settleCurrentAttempt,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonl, readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

const CURRENT_ATTEMPT_FILE = 'attempt.current.json';

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

function errorCode(error) {
  if (error?.code) return error.code;
  const match = String(error?.message || error || '').match(/^([A-Z][A-Z0-9_]+):/);
  return match?.[1] || 'AGENT_ENTRYPOINT_FAILED';
}

function errorPayload(error, entrypoint) {
  const code = errorCode(error);
  return {
    ok: false,
    code,
    entrypoint,
    message: String(error?.message || error || code).replace(new RegExp(`^${code}:\\s*`), ''),
    ...(error?.fieldPath || error?.field ? { fieldPath: error.fieldPath || error.field } : {}),
    ...(error?.expected ? { expected: error.expected } : {}),
    ...(error?.allowed ? { allowed: error.allowed } : {}),
    retryable: error?.retryable !== false,
  };
}

function appendAttempt(argv, value) {
  const execDir = optionValue(argv, '--exec-dir');
  if (!execDir || !fs.existsSync(execDir)) return;
  const resolved = path.resolve(execDir);
  const currentFile = path.join(resolved, 'agent', CURRENT_ATTEMPT_FILE);
  if (fs.existsSync(path.join(resolved, 'completion.json')) || fs.existsSync(path.join(resolved, 'artifact-manifest.json'))) {
    if (fs.existsSync(currentFile)) fs.unlinkSync(currentFile);
    return;
  }
  appendJsonl(path.join(resolved, 'agent', 'attempts.jsonl'), value);
  const current = readJson(currentFile, null);
  if (current?.attemptId === value.attemptId && fs.existsSync(currentFile)) fs.unlinkSync(currentFile);
}

function beginAttempt(argv, value) {
  const execDir = optionValue(argv, '--exec-dir');
  if (!execDir || !fs.existsSync(execDir)) return;
  const resolved = path.resolve(execDir);
  const currentFile = path.join(resolved, 'agent', CURRENT_ATTEMPT_FILE);
  const previous = readJson(currentFile, null);
  if (previous) {
    appendJsonl(path.join(resolved, 'agent', 'attempts.jsonl'), {
      ...previous,
      endedAt: value.startedAt,
      durationMs: Math.max(Date.parse(value.startedAt) - Date.parse(previous.startedAt), 0),
      ok: false,
      error: { code: 'AGENT_ENTRYPOINT_INTERRUPTED', message: 'previous Agent entrypoint ended without a recorded response' },
    });
  }
  writeJsonAtomic(currentFile, value);
}

function runtimeState(execDir) {
  if (!execDir) return null;
  try { return require('./status').readAgentStatus(path.resolve(execDir)); } catch { return null; }
}

function withRuntimeState(argv, value) {
  if (value?.runtimeState) return value;
  const state = runtimeState(optionValue(argv, '--exec-dir'));
  if (!state || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.phase && value.signals && value.executionId) return value;
  return { ...value, runtimeState: state };
}

function printHelp(usage) {
  process.stdout.write(`${JSON.stringify({ ok: true, usage }, null, 2)}\n`);
}

function runAgentCli(entrypoint, argv, usage, handler) {
  if (argv.includes('--help')) {
    printHelp(usage);
    return;
  }
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const attemptId = `${entrypoint}-${process.pid}-${startMs}`;
  beginAttempt(argv, { schemaVersion: 1, attemptId, entrypoint, startedAt });
  try {
    const value = withRuntimeState(argv, handler(argv));
    const endedAt = new Date().toISOString();
    appendAttempt(argv, { schemaVersion: 1, attemptId, entrypoint, startedAt, endedAt, durationMs: Date.now() - startMs, ok: true });
    if (value !== undefined) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return value;
  } catch (error) {
    const payload = errorPayload(error, entrypoint);
    const endedAt = new Date().toISOString();
    appendAttempt(argv, { schemaVersion: 1, attemptId, entrypoint, startedAt, endedAt, durationMs: Date.now() - startMs, ok: false, error: payload });
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = error.exitCode || 2;
    return null;
  }
}

module.exports = {
  CURRENT_ATTEMPT_FILE,
  appendAttempt,
  beginAttempt,
  errorPayload,
  runAgentCli,
  withRuntimeState,
};

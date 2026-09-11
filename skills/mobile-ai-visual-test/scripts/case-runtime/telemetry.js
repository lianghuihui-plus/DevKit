'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonl, readJson, readJsonl } = require('../lib/execution-lifecycle');

function telemetryDir(execDir) {
  return path.join(execDir, 'telemetry');
}

function invocationFile(execDir) {
  return path.join(telemetryDir(execDir), 'invocations.jsonl');
}

function spanFile(execDir) {
  return path.join(telemetryDir(execDir), 'spans.jsonl');
}

function clock(options = {}) {
  return typeof options.telemetryClock === 'function' ? options.telemetryClock() : Date.now();
}

function redactRequest(request) {
  if (!request || typeof request !== 'object') return null;
  const value = JSON.parse(JSON.stringify(request));
  if (value.input?.text !== undefined) value.input.text = '[REDACTED]';
  if (value.result) value.result = { verdict: value.result.verdict };
  return value;
}

function beginInvocation(execDir, operation, request, options = {}) {
  if (readJson(path.join(execDir, 'execution.json'), null)?.finalized === true
    || fs.existsSync(path.join(execDir, 'artifact-manifest.json'))) return null;
  fs.mkdirSync(telemetryDir(execDir), { recursive: true });
  const starts = readJsonl(invocationFile(execDir), { repairIncompleteTail: true }).filter((entry) => entry.phase === 'START');
  const invocationId = `invocation-${String(starts.length + 1).padStart(4, '0')}`;
  const startedMs = clock(options);
  appendJsonl(invocationFile(execDir), {
    schemaVersion: 1,
    invocationId,
    phase: 'START',
    operation,
    at: options.now || new Date().toISOString(),
    request: redactRequest(request),
  });
  return { invocationId, operation, startedMs, startedAt: options.now || new Date().toISOString() };
}

function endInvocation(execDir, invocation, response, options = {}) {
  if (!invocation) return;
  const endedMs = clock(options);
  appendJsonl(invocationFile(execDir), {
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    phase: 'END',
    operation: invocation.operation,
    at: options.now || new Date().toISOString(),
    durationMs: Math.max(0, endedMs - invocation.startedMs),
    status: response?.status || 'TECHNICAL',
    error: ['TECHNICAL', 'REQUEST_INVALID'].includes(response?.status),
    ...(response?.code ? { code: response.code } : {}),
    ...(Array.isArray(response?.issues) ? {
      issueCodes: [...new Set(response.issues.map((item) => item.code).filter(Boolean))],
      fieldPaths: [...new Set(response.issues.map((item) => item.fieldPath).filter(Boolean))],
    } : {}),
  });
}

function recordSpan(execDir, name, durationMs, details = {}, options = {}) {
  fs.mkdirSync(telemetryDir(execDir), { recursive: true });
  appendJsonl(spanFile(execDir), {
    schemaVersion: 1,
    name,
    durationMs: Math.max(0, Number(durationMs) || 0),
    at: options.now || new Date().toISOString(),
    ...details,
  });
}

function summarize(execDir, totalElapsedMs, openInvocation = null, options = {}) {
  const invocations = readJsonl(invocationFile(execDir), { repairIncompleteTail: true });
  const starts = invocations.filter((entry) => entry.phase === 'START');
  const ends = invocations.filter((entry) => entry.phase === 'END');
  let runtimeActiveMs = ends.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0);
  if (openInvocation) runtimeActiveMs += Math.max(0, clock(options) - openInvocation.startedMs);
  runtimeActiveMs = Math.min(totalElapsedMs, runtimeActiveMs);
  const spans = readJsonl(spanFile(execDir), { repairIncompleteTail: true });
  const operationMs = (operation) => ends.filter((entry) => entry.operation === operation)
    .reduce((total, entry) => total + (Number(entry.durationMs) || 0), 0);
  const raw = {
    actionDeviceMs: 0,
    observationCaptureMs: 0,
    postActionSettleMs: 0,
    explicitWaitMs: 0,
  };
  let recoveryAdapterMs = 0;
  for (const span of spans.filter((entry) => entry.name === 'adapter')) {
    const duration = Math.max(0, Number(span.durationMs) || 0);
    const settle = Math.min(duration, Math.max(0, Number(span.postActionSettleMs) || 0));
    const afterSettle = duration - settle;
    const explicitWait = Math.min(afterSettle, Math.max(0, Number(span.explicitWaitMs) || 0));
    const device = afterSettle - explicitWait;
    raw.postActionSettleMs += settle;
    raw.explicitWaitMs += explicitWait;
    if (span.kind === 'ACTION') raw.actionDeviceMs += device;
    if (span.kind === 'OBSERVE') raw.observationCaptureMs += device;
    if (span.runtimeOperation === 'recover') recoveryAdapterMs += duration;
  }
  raw.knowledgeQueryMs = operationMs('knowledge');
  raw.recoveryControlMs = Math.max(0, operationMs('recover') - recoveryAdapterMs);
  const allocated = {};
  let remaining = runtimeActiveMs;
  for (const field of ['actionDeviceMs', 'observationCaptureMs', 'postActionSettleMs', 'explicitWaitMs', 'knowledgeQueryMs', 'recoveryControlMs']) {
    allocated[field] = Math.min(remaining, raw[field]);
    remaining -= allocated[field];
  }
  allocated.runtimeOverheadMs = remaining;
  const adapterActiveMs = allocated.actionDeviceMs + allocated.observationCaptureMs
    + allocated.postActionSettleMs + allocated.explicitWaitMs;
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const invocationEnd = new Map(ends.map((entry) => [entry.invocationId, entry]));
  const gapBetween = (before, after) => {
    const end = invocationEnd.get(before?.invocationId)?.at;
    const start = after?.at;
    return end && start ? Math.max(0, Date.parse(start) - Date.parse(end)) : 0;
  };
  const finishIndex = starts.findIndex((entry) => entry.operation === 'finish');
  const firstPreparationMs = starts[0] && execution?.startedAt
    ? Math.max(0, Date.parse(starts[0].at) - Date.parse(execution.startedAt)) : 0;
  const conclusionPreparationMs = finishIndex > 0 ? gapBetween(starts[finishIndex - 1], starts[finishIndex]) : 0;
  const stepDecisionIntervals = [];
  const decisionEnd = finishIndex >= 0 ? finishIndex : starts.length;
  for (let index = 1; index < decisionEnd; index += 1) {
    stepDecisionIntervals.push({
      afterInvocationId: starts[index - 1].invocationId,
      beforeInvocationId: starts[index].invocationId,
      durationMs: gapBetween(starts[index - 1], starts[index]),
    });
  }
  const agentAndSchedulingGapMs = Math.max(0, totalElapsedMs - runtimeActiveMs);
  const rawAgentTiming = {
    firstPreparationMs,
    stepDecisionMs: stepDecisionIntervals.reduce((sum, item) => sum + item.durationMs, 0),
    conclusionPreparationMs,
  };
  let remainingAgentGapMs = agentAndSchedulingGapMs;
  const allocateGap = (value) => {
    const allocated = Math.min(remainingAgentGapMs, value);
    remainingAgentGapMs -= allocated;
    return allocated;
  };
  const agentTiming = {
    firstPreparationMs: allocateGap(rawAgentTiming.firstPreparationMs),
    stepDecisionMs: allocateGap(rawAgentTiming.stepDecisionMs),
    conclusionPreparationMs: allocateGap(rawAgentTiming.conclusionPreparationMs),
    unclassifiedGapMs: remainingAgentGapMs,
    stepDecisionIntervals,
  };
  return {
    totalElapsedMs,
    runtimeActiveMs,
    adapterActiveMs,
    ...allocated,
    recoveryMs: allocated.recoveryControlMs,
    agentAndSchedulingGapMs,
    agentTiming,
    invocationCount: starts.length,
    invocationErrorCount: ends.filter((entry) => entry.error === true).length,
  };
}

module.exports = {
  beginInvocation,
  endInvocation,
  invocationFile,
  recordSpan,
  redactRequest,
  spanFile,
  summarize,
};

'use strict';

const path = require('path');
const { contextDir, loadGraph, loadFrontier, readJson } = require('./common');
const { runContextIds } = require('./run-protocol');
const { nextWork } = require('./work-scheduler');

const CONTINUABLE_DECISIONS = new Set([
  'DISCOVER',
  'VERIFY',
  'SUGGEST_FRONTIER',
  'BACKFILL_FRONTIER_SUGGESTIONS',
  'REVIEW_FRONTIER_CANDIDATES'
]);

const PARTIAL_STOP_REASONS = new Set([
  'WORK_EMPTY',
  'MAX_ACTIVE_MINUTES',
  'MAX_DEVICE_ACTIONS',
  'MAX_COLD_STARTS',
  'MAX_STATES',
  'REQUIRED_VERIFICATION_FAILED',
  'FRONTIER_SUGGESTIONS_NOT_APPLICABLE',
  'WORK_BLOCKED_BY_FAILED_DEPENDENCIES'
]);

function reasonFrom(decision = {}) {
  return decision.reasonCode || decision.decision || 'UNKNOWN';
}

function contextAssessment({ scanDir, scan, contextId, metricsOverridesByContext = {} }) {
  const graph = loadGraph(scanDir, contextId);
  const frontier = loadFrontier(scanDir, contextId);
  const metrics = metricsOverridesByContext[contextId] || readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {});
  const decision = nextWork({ scanDir, scan, contextId, graph, frontier, metrics });
  return {
    contextId,
    nextWork: {
      decision: decision.decision,
      reasonCode: decision.reasonCode || null,
      suggestedTerminalStatus: decision.suggestedTerminalStatus || null,
      recommendedAction: decision.recommendedAction || null
    },
    openWorkSummary: decision.openWorkSummary || null,
    executionProgress: decision.executionProgress || null,
    continuable: CONTINUABLE_DECISIONS.has(decision.decision)
  };
}

function reject(assessment, reasonCode, message) {
  return { ...assessment, canFinalize: false, reasonCode, message };
}

function assessFinalization({ scanDir, scan, requestedStatus, reasonCode = null, confirmUserStop = false, userStopNote = null, metricsOverridesByContext = {} }) {
  const status = String(requestedStatus || '').toUpperCase();
  const contexts = runContextIds(scan).map(contextId => contextAssessment({ scanDir, scan, contextId, metricsOverridesByContext }));
  const base = {
    schemaVersion: 1,
    requestedStatus: status,
    requestedReasonCode: reasonCode || null,
    userStopConfirmed: confirmUserStop === true,
    userStopNote: userStopNote || null,
    contexts
  };

  if (reasonCode === 'USER_STOPPED' && !confirmUserStop) {
    return reject(base, 'FINALIZATION_REQUIRES_USER_STOP_CONFIRMATION', 'USER_STOPPED finalization requires --confirm-user-stop true.');
  }

  if (status === 'COMPLETED') {
    const notEmpty = contexts.find(item => item.nextWork.decision !== 'STOP' || item.nextWork.reasonCode !== 'WORK_EMPTY');
    if (notEmpty) return reject(base, 'FINALIZATION_REQUIRES_WORK_EMPTY', `COMPLETED requires nextWork STOP/WORK_EMPTY; ${notEmpty.contextId} is ${notEmpty.nextWork.decision}/${reasonFrom(notEmpty.nextWork)}.`);
    return { ...base, canFinalize: true, reasonCode: 'FINALIZATION_ALLOWED_WORK_EMPTY', message: 'Run can complete because all contexts are work-empty.' };
  }

  if (status === 'PARTIAL') {
    if (reasonCode === 'USER_STOPPED') {
      return { ...base, canFinalize: true, reasonCode: 'FINALIZATION_ALLOWED_USER_STOPPED', message: 'Run can finalize PARTIAL because user stop was explicitly confirmed.' };
    }
    const continuable = contexts.find(item => item.continuable);
    if (continuable) return reject(base, 'FINALIZATION_REQUIRES_CONTINUATION_OR_USER_STOP', `PARTIAL finalization would interrupt continuable work; ${continuable.contextId} is ${continuable.nextWork.decision}/${reasonFrom(continuable.nextWork)}.`);
    const disallowedStop = contexts.find(item => item.nextWork.decision !== 'STOP' || !PARTIAL_STOP_REASONS.has(reasonFrom(item.nextWork)));
    if (disallowedStop) return reject(base, 'FINALIZATION_STOP_REASON_UNSUPPORTED', `PARTIAL finalization requires budget exhaustion, blocked work, user stop, or empty work; ${disallowedStop.contextId} is ${disallowedStop.nextWork.decision}/${reasonFrom(disallowedStop.nextWork)}.`);
    return { ...base, canFinalize: true, reasonCode: 'FINALIZATION_ALLOWED_PARTIAL_STOP', message: 'Run can finalize PARTIAL because nextWork reached an allowed STOP condition.' };
  }

  if (['BLOCKED', 'FAILED'].includes(status)) {
    if (!reasonCode) return reject(base, 'FINALIZATION_REASON_REQUIRED', `${status} finalization requires --reason-code.`);
    return { ...base, canFinalize: true, reasonCode: `FINALIZATION_ALLOWED_${status}`, message: `Run can finalize ${status} with explicit reasonCode.` };
  }

  return reject(base, 'STATUS_INVALID', `Unsupported finalization status: ${status}`);
}

module.exports = { assessFinalization, CONTINUABLE_DECISIONS, PARTIAL_STOP_REASONS };

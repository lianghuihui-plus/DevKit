'use strict';

const path = require('path');
const { contextDir, readJson, writeJsonAtomic, now, commitEvent, fail } = require('./common');

function cursorFile(scanDir, contextId) { return path.join(contextDir(scanDir, contextId), 'live-cursor.json'); }
function metricsFile(scanDir, contextId) { return path.join(contextDir(scanDir, contextId), 'metrics.json'); }

function loadCursor(scanDir, contextId) {
  return readJson(cursorFile(scanDir, contextId), { schemaVersion: 1, contextId, reachableStateId: null, observationId: null, status: 'UNKNOWN', epoch: 0, mutationSeq: 0, establishedBy: null, lastValidatedAt: null, updatedAt: null, invalidatedReason: 'NOT_ESTABLISHED' });
}

function currentMutationSeq(scanDir, contextId) { return Number(readJson(metricsFile(scanDir, contextId), {}).deviceMutationSeq || 0); }

function projectedCursor(scanDir, contextId, { reachableStateId, observationId, status = 'EXACT', establishedBy, incrementEpoch = false, equivalence = null }) {
  const current = loadCursor(scanDir, contextId); const at = now();
  return { schemaVersion: 1, contextId, reachableStateId, observationId, status, equivalence, epoch: Number(current.epoch || 0) + (incrementEpoch ? 1 : 0), mutationSeq: currentMutationSeq(scanDir, contextId), establishedBy, lastValidatedAt: at, updatedAt: at, invalidatedReason: null };
}

function establishCursor(scanDir, contextId, input, { emitEvent = true, incrementEpoch = false } = {}) {
  const cursor = projectedCursor(scanDir, contextId, { ...input, incrementEpoch });
  if (emitEvent) commitEvent(scanDir, 'cursorEstablished', { contextId, cursor }, [{ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: cursor }]); else writeJsonAtomic(cursorFile(scanDir, contextId), cursor);
  return cursor;
}

function invalidateCursor(scanDir, contextId, reason, { emitEvent = true } = {}) {
  const current = loadCursor(scanDir, contextId); const cursor = { ...current, status: 'UNKNOWN', equivalence: null, epoch: Number(current.epoch || 0) + 1, reachableStateId: null, observationId: null, updatedAt: now(), invalidatedReason: reason || 'UNKNOWN' };
  const metricPath = metricsFile(scanDir, contextId); const metrics = readJson(metricPath, {}); metrics.cursorInvalidations = Number(metrics.cursorInvalidations || 0) + 1;
  if (emitEvent) commitEvent(scanDir, 'cursorInvalidated', { contextId, reasonCode: cursor.invalidatedReason, cursor }, [{ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: cursor }, { path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]); else { writeJsonAtomic(cursorFile(scanDir, contextId), cursor); writeJsonAtomic(metricPath, metrics); }
  return cursor;
}

function usableCursorStatus(status) { return ['EXACT', 'SOURCE_CONFIRMED', 'REVIEW_CONFIRMED'].includes(status); }

function cursorLease(scanDir, contextId, scan, expectedReachableStateId = null) {
  const cursor = loadCursor(scanDir, contextId); const ageMs = cursor.lastValidatedAt ? Math.max(0, Date.now() - Date.parse(cursor.lastValidatedAt)) : Number.MAX_SAFE_INTEGER; const freshnessMs = Number(scan.budget?.cursorFreshnessMs || 15000);
  const mutationMatches = Number(cursor.mutationSeq || 0) === currentMutationSeq(scanDir, contextId);
  const stateMatches = !expectedReachableStateId || cursor.reachableStateId === expectedReachableStateId;
  const usable = usableCursorStatus(cursor.status);
  return { cursor, usable, valid: usable && mutationMatches && stateMatches, mutationMatches, stateMatches, ageMs, freshnessMs, requiresRecheck: !usable || !mutationMatches || !stateMatches || ageMs > freshnessMs };
}

function assertCursorEpoch(scanDir, contextId, epoch) {
  const cursor = loadCursor(scanDir, contextId);
  if (Number(cursor.epoch) !== Number(epoch)) fail('Cursor epoch changed after Frontier claim', 'CURSOR_EPOCH_STALE');
  return cursor;
}

module.exports = { cursorFile, loadCursor, currentMutationSeq, projectedCursor, establishCursor, invalidateCursor, cursorLease, assertCursorEpoch, usableCursorStatus };

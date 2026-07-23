'use strict';

const path = require('path');
const fs = require('fs');
const { readJson, nextId, now, hashObject } = require('./common');
const { extractCandidates } = require('./frontier-candidate-extractor');
const { loadFrontierSuggestions, suggestionUpsertOp, pendingSuggestionsForState } = require('./frontier-suggestions-store');
const { assessAction } = require('./safety');
const { runBudget, maxCandidatesPerState, maxDepth, maxScrollsPerState } = require('./run-protocol');

function existingKeys(frontier = {}, suggestions = {}) {
  return new Set([
    ...(frontier.items || []).map(item => item.candidateGroupKey).filter(Boolean),
    ...(suggestions.items || []).map(item => item.candidateGroupKey).filter(Boolean)
  ]);
}

function appRootFromScanDir(scanDir) {
  return path.dirname(path.dirname(scanDir));
}

function observationFiles(baseScanDir, observationId) {
  const dir = path.join(baseScanDir, 'evidence', 'observations', observationId);
  return {
    dir,
    observationFile: path.join(dir, 'observation.json'),
    layoutFile: path.join(dir, 'layout.json'),
    screenshotFile: path.join(dir, 'screenshot.png')
  };
}

function observationExists(baseScanDir, observationId) {
  const files = observationFiles(baseScanDir, observationId);
  return fs.existsSync(files.observationFile) && fs.existsSync(files.layoutFile) && fs.existsSync(files.screenshotFile);
}

function loadObservationLayout(scanDir, observationId) {
  return loadObservationLayoutFromSource({ baseScanDir: scanDir, observationId });
}

function loadObservationLayoutFromSource({ baseScanDir, observationId }) {
  const observation = readJson(path.join(baseScanDir, 'evidence', 'observations', observationId, 'observation.json'));
  const layout = readJson(path.join(baseScanDir, observation.layoutPath || path.join('evidence', 'observations', observationId, 'layout.json')));
  return { observation, layout };
}

function localObservationRef(scan, visualState, observationId) {
  if (observationId && !(visualState.evidenceObservationIds || []).includes(observationId)) return null;
  const sourceObservationId = observationId || (visualState.evidenceObservationIds || []).at(-1);
  if (!sourceObservationId) return null;
  return {
    evidenceSource: 'LOCAL_RUN',
    baseScanDir: null,
    runId: scan.scanId,
    observationId: sourceObservationId,
    observationRef: { runId: scan.scanId, observationId: sourceObservationId }
  };
}

function historicalObservationRef(scanDir, visualState) {
  const appRoot = appRootFromScanDir(scanDir);
  const refs = [...(visualState.evidenceObservationRefs || [])].reverse();
  for (const ref of refs) {
    if (!ref?.runId || !ref?.observationId) continue;
    const baseScanDir = path.join(appRoot, 'runs', String(ref.runId));
    if (!observationExists(baseScanDir, String(ref.observationId))) continue;
    return {
      evidenceSource: 'CANONICAL_REF',
      baseScanDir,
      runId: String(ref.runId),
      observationId: String(ref.observationId),
      observationRef: { runId: String(ref.runId), observationId: String(ref.observationId) }
    };
  }
  return null;
}

function resolveObservationForSuggestion({ scanDir, scan, visualState, observationId = null, allowHistorical = true }) {
  if (observationId && !(visualState.evidenceObservationIds || []).includes(observationId)) {
    return { ok: false, reasonCode: 'OBSERVATION_NOT_BOUND_TO_VISUAL_STATE' };
  }
  const local = localObservationRef(scan, visualState, observationId);
  if (local && observationExists(scanDir, local.observationId)) return { ok: true, ...local, baseScanDir: scanDir };
  if (local && observationId) return { ok: false, reasonCode: 'OBSERVATION_MISSING', evidenceSource: 'LOCAL_RUN' };
  if (allowHistorical) {
    const historical = historicalObservationRef(scanDir, visualState);
    if (historical) return { ok: true, ...historical };
    if ((visualState.evidenceObservationRefs || []).length) return { ok: false, reasonCode: 'HISTORICAL_OBSERVATION_MISSING', evidenceSource: 'HISTORICAL_REF_MISSING' };
  }
  return { ok: false, reasonCode: 'OBSERVATION_MISSING' };
}

function buildSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId, allowHistorical = true }) {
  const reachableState = (graph.reachableStates || []).find(item => item.id === reachableStateId);
  const visualState = reachableState && (graph.visualStates || []).find(item => item.id === reachableState.visualStateId);
  if (!reachableState || !visualState) return { created: [], skipped: [], ops: [], reasonCode: 'REACHABLE_STATE_NOT_FOUND' };
  const resolved = resolveObservationForSuggestion({ scanDir, scan, visualState, observationId, allowHistorical });
  if (!resolved.ok) return { created: [], skipped: [], ops: [], reasonCode: resolved.reasonCode, evidenceSource: resolved.evidenceSource || null };
  const suggestions = loadFrontierSuggestions(scanDir, contextId);
  const { layout } = loadObservationLayoutFromSource({ baseScanDir: resolved.baseScanDir, observationId: resolved.observationId });
  const budget = runBudget(scan, contextId);
  const limit = Math.max(0, maxCandidatesPerState(budget) - (frontier.items || []).filter(item => item.fromReachableStateId === reachableStateId).length);
  const knownKeys = existingKeys(frontier, suggestions);
  const extracted = extractCandidates({ reachableState, visualState, observationId: resolved.observationId, layout, existingKeys: knownKeys, limit: Math.max(0, limit) });
  const created = [];
  const skipped = [];
  const ops = [];
  for (const suggestion of extracted) {
    const safety = assessAction(suggestion.candidate, scan.target);
    const item = {
      schemaVersion: 1,
      suggestionId: nextId(scanDir, 'suggestion', 'suggest'),
      ...suggestion,
      candidateHash: hashObject(suggestion.candidate),
      risk: safety.risk || null,
      safety,
      status: safety.allowed === false ? 'BLOCKED' : 'PENDING',
      evidenceSource: resolved.evidenceSource,
      observationRef: resolved.observationRef,
      createdAt: now(),
      updatedAt: now(),
      reasonCode: safety.allowed === false ? safety.reasonCode : null,
      frontierId: null
    };
    created.push(item);
    ops.push(suggestionUpsertOp(contextId, item));
  }
  const noCandidateKey = `${reachableState.id}/no-candidates`;
  if (!created.length && limit > 0 && !knownKeys.has(noCandidateKey)) {
    const item = {
      schemaVersion: 1,
      suggestionId: nextId(scanDir, 'suggestion', 'suggest'),
      reachableStateId: reachableState.id,
      visualStateId: visualState.id,
      observationId: resolved.observationId,
      candidateGroupKey: noCandidateKey,
      candidate: null,
      source: 'NO_CANDIDATES',
      confidence: 0,
      candidateHash: null,
      risk: null,
      safety: { allowed: true, reasonCode: null },
      status: 'SKIPPED',
      evidenceSource: resolved.evidenceSource,
      observationRef: resolved.observationRef,
      createdAt: now(),
      updatedAt: now(),
      reasonCode: 'NO_CANDIDATES_EXTRACTED',
      frontierId: null
    };
    skipped.push({ reasonCode: item.reasonCode });
    ops.push(suggestionUpsertOp(contextId, item));
  }
  if (!created.length && limit <= 0) skipped.push({ reasonCode: 'MAX_CANDIDATES_PER_STATE' });
  return { created, skipped, ops, reachableState, visualState, observationId: resolved.observationId, observationRef: resolved.observationRef, evidenceSource: resolved.evidenceSource };
}

function suggestionApplicability({ scan, contextId, graph, frontier, suggestion, dependencyBlocking = null, acceptSafe = true }) {
  if (!suggestion || suggestion.status !== 'PENDING') return { applicable: false, reasonCode: 'SUGGESTION_NOT_PENDING' };
  const fromState = (graph.reachableStates || []).find(item => item.id === suggestion.reachableStateId);
  if (!fromState) return { applicable: false, reasonCode: 'SOURCE_STATE_MISSING' };
  if (dependencyBlocking?.isFrontierBlocked({ fromReachableStateId: suggestion.reachableStateId })) return { applicable: false, reasonCode: 'SOURCE_BLOCKED_BY_FAILED_DEPENDENCY' };
  const safety = suggestion.safety || assessAction(suggestion.candidate, scan.target);
  if (safety.allowed === false) return { applicable: false, reasonCode: safety.reasonCode || 'SAFETY_BLOCKED' };
  if (acceptSafe && (safety.risk || suggestion.risk || 'SAFE') !== 'SAFE') return { applicable: false, reasonCode: 'ACCEPT_SAFE_ONLY' };
  const budget = runBudget(scan, contextId);
  const fromItems = (frontier.items || []).filter(item => item.fromReachableStateId === suggestion.reachableStateId);
  if (fromItems.some(item => item.candidateGroupKey === suggestion.candidateGroupKey)) return { applicable: false, reasonCode: 'DUPLICATE_FRONTIER' };
  if (fromItems.length >= maxCandidatesPerState(budget)) return { applicable: false, reasonCode: 'MAX_CANDIDATES_PER_STATE' };
  if ((fromState.depth?.pathDepth || 0) + 1 > maxDepth(budget)) return { applicable: false, reasonCode: 'MAX_DEPTH' };
  if (suggestion.candidate?.type === 'swipe') {
    const scrollGroups = new Set(fromItems.filter(item => item.candidate?.type === 'swipe').map(item => item.candidateGroupKey));
    if (!scrollGroups.has(suggestion.candidateGroupKey) && scrollGroups.size >= maxScrollsPerState(budget)) return { applicable: false, reasonCode: 'MAX_SCROLLS_PER_STATE' };
  }
  return { applicable: true, safety };
}

function applicableSuggestions({ scanDir, scan, contextId, graph, frontier, reachableStateId = null, dependencyBlocking = null, acceptSafe = true }) {
  const store = loadFrontierSuggestions(scanDir, contextId);
  const items = pendingSuggestionsForState(store, reachableStateId);
  const applicable = [];
  const skipped = [];
  for (const suggestion of items) {
    const result = suggestionApplicability({ scan, contextId, graph, frontier, suggestion, dependencyBlocking, acceptSafe });
    if (result.applicable) applicable.push(suggestion);
    else skipped.push({ suggestionId: suggestion.suggestionId, reachableStateId: suggestion.reachableStateId, reasonCode: result.reasonCode });
  }
  return { items: applicable, skipped, totalPending: items.length };
}

module.exports = { buildSuggestionItems, loadObservationLayout, resolveObservationForSuggestion, existingKeys, suggestionApplicability, applicableSuggestions };

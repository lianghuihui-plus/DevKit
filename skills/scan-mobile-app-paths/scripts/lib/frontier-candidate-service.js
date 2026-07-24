'use strict';

const path = require('path');
const fs = require('fs');
const { readJson, nextId, now, hashObject } = require('./common');
const { extractCandidates } = require('./frontier-candidate-extractor');
const { isAutoApplyCandidate } = require('./candidate-classifier');
const { candidateRulesForScan } = require('./candidate-rules');
const { normalizeBounds, normalizeText, boundsOverlap } = require('./semantic-fingerprint');
const { loadFrontierSuggestions, suggestionUpsertOp, pendingSuggestionsForState } = require('./frontier-suggestions-store');
const { assessAction } = require('./safety');
const { runBudget, maxCandidatesPerState, maxTotalCandidatesPerState, maxDepth, maxScrollsPerState } = require('./run-protocol');
const { candidateCoverageBasis } = require('./candidate-coverage');

const DATA_SKIP_CLASSES = new Set(['DYNAMIC_DATA_ITEM', 'BUSINESS_DATA_ITEM']);

function isDynamicDataCandidate(suggestion = {}) {
  return DATA_SKIP_CLASSES.has(suggestion.candidateClass || suggestion.classification?.candidateClass);
}

function existingKeys(frontier = {}, suggestions = {}) {
  return new Set([
    ...(frontier.items || []).map(item => item.candidateGroupKey).filter(Boolean),
    ...(suggestions.items || []).map(item => item.candidateGroupKey).filter(Boolean)
  ]);
}

function existingCandidateHashes(frontier = {}, suggestions = {}, reachableStateId = null) {
  const hashes = [];
  for (const item of frontier.items || []) {
    if (reachableStateId && item.fromReachableStateId !== reachableStateId) continue;
    if (!countedCandidateItem(item)) continue;
    hashes.push(item.candidateHash || hashObject(item.candidate));
  }
  for (const item of suggestions.items || []) {
    if (reachableStateId && item.reachableStateId !== reachableStateId) continue;
    if (!countedCandidateItem(item)) continue;
    hashes.push(item.candidateHash || hashObject(item.candidate));
  }
  return new Set(hashes.filter(Boolean));
}

function countedCandidateItem(item = {}) {
  if (!item?.candidate || item.source === 'NO_CANDIDATES') return false;
  return !isDynamicDataCandidate(item);
}

function knownCandidateCountForState({ frontier = {}, suggestions = {}, reachableStateId, includeExistingSuggestions = false }) {
  const keys = new Set();
  for (const item of frontier.items || []) {
    if (item.fromReachableStateId !== reachableStateId || !countedCandidateItem(item)) continue;
    keys.add(item.candidateGroupKey || hashObject(item.candidate));
  }
  if (!includeExistingSuggestions) {
    for (const item of suggestions.items || []) {
      if (item.reachableStateId !== reachableStateId || !countedCandidateItem(item)) continue;
      keys.add(item.candidateGroupKey || item.candidateHash || hashObject(item.candidate));
    }
  }
  return keys.size;
}

function candidateBatchLimit({ budget, frontier = {}, suggestions = {}, reachableStateId, includeExistingSuggestions = false }) {
  const batchLimit = Math.max(0, maxCandidatesPerState(budget));
  const totalLimit = Math.max(0, maxTotalCandidatesPerState(budget));
  if (!batchLimit) return { limit: 0, batchLimit, totalLimit, knownCandidateCount: 0, reasonCode: 'MAX_CANDIDATES_PER_STATE' };
  const knownCandidateCount = knownCandidateCountForState({ frontier, suggestions, reachableStateId, includeExistingSuggestions });
  const remainingTotal = Math.max(0, totalLimit - knownCandidateCount);
  return {
    limit: Math.min(batchLimit, remainingTotal),
    batchLimit,
    totalLimit,
    knownCandidateCount,
    reasonCode: remainingTotal <= 0 ? 'MAX_TOTAL_CANDIDATES_PER_STATE' : null
  };
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

function boolish(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function nodeValue(value = {}) {
  return { ...(value.attributes || {}), ...value };
}

function rawNodes(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(item => rawNodes(item, out));
    return out;
  }
  if (typeof value !== 'object') return out;
  const node = nodeValue(value);
  out.push(node);
  for (const key of ['children', 'nodes', 'components']) rawNodes(value[key], out);
  return out;
}

function textOf(node = {}) {
  return normalizeText(node.text || node.content || node.label || node.accessibilityLabel || node.description || node.originalText);
}

function roleOf(node = {}) {
  return String(node.type || node.role || node.className || '');
}

function visualReviewSignals({ layout, pendingSuggestions = [] }) {
  const nodes = rawNodes(layout).map(node => ({ node, role: roleOf(node), text: textOf(node), bounds: normalizeBounds(node.bounds || node.rect || node.origBounds) })).filter(item => item.bounds);
  const largeTextlessClickables = nodes.filter(({ node, text, bounds }) => {
    const area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
    return !text && (boolish(node.clickable) || boolish(node.longClickable)) && area >= 80000;
  });
  const horizontalScroll = nodes.filter(({ node, role, bounds }) => {
    const width = bounds[2] - bounds[0]; const height = bounds[3] - bounds[1];
    return (boolish(node.scrollable) || /swiper|carousel|pager|horizontal/i.test(role)) && width > height * 1.4;
  });
  const textCoveredByContainer = pendingSuggestions.filter(suggestion => suggestion.candidate?.type === 'tap' && suggestion.candidate.fallbackBounds && !suggestion.source?.startsWith('VISUAL_')).filter(suggestion => largeTextlessClickables.some(item => boundsOverlap(item.bounds, suggestion.candidate.fallbackBounds) >= 0.85));
  const reasonCodes = [];
  if (largeTextlessClickables.length) reasonCodes.push('CLICKABLE_CONTAINER_WITHOUT_TEXT');
  if (horizontalScroll.length) reasonCodes.push('HORIZONTAL_SCROLL_CONTAINER');
  if (textCoveredByContainer.length) reasonCodes.push('SCRIPT_TEXT_WITH_CONTAINER');
  return {
    required: reasonCodes.length > 0,
    reasonCodes,
    containerCount: largeTextlessClickables.length,
    horizontalScrollCount: horizontalScroll.length,
    coveredTextSuggestionIds: textCoveredByContainer.map(item => item.suggestionId).filter(Boolean)
  };
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

function draftSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId, allowHistorical = true, includeExistingSuggestions = false }) {
  const reachableState = (graph.reachableStates || []).find(item => item.id === reachableStateId);
  const visualState = reachableState && (graph.visualStates || []).find(item => item.id === reachableState.visualStateId);
  if (!reachableState || !visualState) return { drafts: [], skipped: [], reasonCode: 'REACHABLE_STATE_NOT_FOUND' };
  const resolved = resolveObservationForSuggestion({ scanDir, scan, visualState, observationId, allowHistorical });
  if (!resolved.ok) return { drafts: [], skipped: [], reasonCode: resolved.reasonCode, evidenceSource: resolved.evidenceSource || null };
  const suggestions = loadFrontierSuggestions(scanDir, contextId);
  const { observation, layout } = loadObservationLayoutFromSource({ baseScanDir: resolved.baseScanDir, observationId: resolved.observationId });
  const budget = runBudget(scan, contextId);
  const batch = candidateBatchLimit({ budget, frontier, suggestions, reachableStateId, includeExistingSuggestions });
  const limit = batch.limit;
  const knownKeys = includeExistingSuggestions ? existingKeys(frontier, { items: [] }) : existingKeys(frontier, suggestions);
  const knownCandidateHashes = includeExistingSuggestions ? existingCandidateHashes(frontier, { items: [] }, reachableStateId) : existingCandidateHashes(frontier, suggestions, reachableStateId);
  const candidateRules = candidateRulesForScan(scanDir, scan);
  const coverageBasis = candidateCoverageBasis({ state: reachableState, visualState, scan, budget, candidateRules });
  const extracted = extractCandidates({ reachableState, visualState, observationId: resolved.observationId, layout, existingKeys: knownKeys, existingCandidateHashes: knownCandidateHashes, limit: Math.max(0, limit), candidateRules });
  const dynamicAudit = extracted.dynamicAudit || { reasonCode: 'DYNAMIC_DATA_ITEMS_SUPPRESSED', totalCount: 0, emittedCount: 0, suppressedCount: 0, sampleCandidateGroupKeys: [] };
  const drafts = extracted.map((item, index) => ({ draftId: `draft-${String(index + 1).padStart(2, '0')}`, ...item }));
  const skipped = [];
  if (!drafts.length && limit > 0) skipped.push({ reasonCode: 'NO_CANDIDATES_EXTRACTED' });
  if (!drafts.length && limit <= 0) skipped.push({ reasonCode: batch.reasonCode || 'MAX_CANDIDATES_PER_STATE' });
  return { drafts, skipped, dynamicAudit, reachableState, visualState, observationId: resolved.observationId, observation, layout, observationRef: resolved.observationRef, evidenceSource: resolved.evidenceSource, baseScanDir: resolved.baseScanDir, limit, knownKeys, candidateBudget: batch, candidateCoverageBasis: coverageBasis };
}

function buildSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId, allowHistorical = true }) {
  const drafted = draftSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId, allowHistorical });
  if (drafted.reasonCode) return { created: [], skipped: [], ops: [], reasonCode: drafted.reasonCode, evidenceSource: drafted.evidenceSource || null };
  const { drafts, skipped: draftSkipped, dynamicAudit, reachableState, visualState, observationRef, evidenceSource, limit, knownKeys } = drafted;
  const created = [];
  const skipped = [];
  const ops = [];
  const hasActionableDraft = drafts.some(item => !isDynamicDataCandidate(item));
  for (const draft of drafts) {
    const { draftId, ...suggestion } = draft;
    const safety = assessAction(suggestion.candidate, scan.target);
    const defaultStatus = suggestion.defaultStatus || (isDynamicDataCandidate(suggestion) ? 'SKIPPED' : null);
    const status = safety.allowed === false ? 'BLOCKED' : defaultStatus || 'PENDING';
    const reasonCode = safety.allowed === false ? safety.reasonCode : suggestion.reasonCode || (isDynamicDataCandidate(suggestion) ? 'DYNAMIC_DATA_ITEM' : null);
    const item = {
      schemaVersion: 1,
      suggestionId: nextId(scanDir, 'suggestion', 'suggest'),
      ...suggestion,
      candidateHash: hashObject(suggestion.candidate),
      risk: safety.risk || null,
      safety,
      status,
      evidenceSource,
      observationRef,
      createdAt: now(),
      updatedAt: now(),
      reasonCode,
      frontierId: null
    };
    delete item.defaultStatus;
    if (item.status === 'SKIPPED') skipped.push({ suggestionId: item.suggestionId, candidateGroupKey: item.candidateGroupKey, reasonCode: item.reasonCode || 'SUGGESTION_SKIPPED', candidateClass: item.candidateClass || null, candidate: item.candidate });
    else created.push(item);
    ops.push(suggestionUpsertOp(contextId, item));
  }
  const noCandidateKey = `${reachableState.id}/no-candidates`;
  if (!created.length && !hasActionableDraft && limit > 0 && !knownKeys.has(noCandidateKey)) {
    const item = {
      schemaVersion: 1,
      suggestionId: nextId(scanDir, 'suggestion', 'suggest'),
      reachableStateId: reachableState.id,
      visualStateId: visualState.id,
      observationId: drafted.observationId,
      candidateGroupKey: noCandidateKey,
      candidate: null,
      source: 'NO_CANDIDATES',
      confidence: 0,
      candidateHash: null,
      candidateCoverageBasis: drafted.candidateCoverageBasis,
      dynamicAudit,
      risk: null,
      safety: { allowed: true, reasonCode: null },
      status: 'SKIPPED',
      evidenceSource,
      observationRef,
      createdAt: now(),
      updatedAt: now(),
      reasonCode: 'NO_CANDIDATES_EXTRACTED',
      frontierId: null
    };
    skipped.push({ reasonCode: item.reasonCode });
    if (dynamicAudit?.suppressedCount) skipped.push({ reasonCode: dynamicAudit.reasonCode, suppressedCount: dynamicAudit.suppressedCount, sampleCandidateGroupKeys: dynamicAudit.sampleCandidateGroupKeys || [] });
    ops.push(suggestionUpsertOp(contextId, item));
  }
  if (!created.length && limit <= 0) skipped.push({ reasonCode: drafted.candidateBudget?.reasonCode || 'MAX_CANDIDATES_PER_STATE' });
  if (!created.length && draftSkipped.length && !skipped.length) skipped.push(...draftSkipped);
  return { created, skipped, dynamicAudit, ops, reachableState, visualState, observationId: drafted.observationId, observationRef, evidenceSource };
}

function suggestionApplicability({ scan, contextId, graph, frontier, suggestion, dependencyBlocking = null, acceptSafe = true }) {
  if (!suggestion || suggestion.status !== 'PENDING') return { applicable: false, reasonCode: 'SUGGESTION_NOT_PENDING' };
  if (isDynamicDataCandidate(suggestion)) return { applicable: false, reasonCode: 'DYNAMIC_DATA_ITEM' };
  if (suggestion.candidateClass === 'UNKNOWN_REVIEW_REQUIRED' && !suggestion.visualCandidateReviewId) return { applicable: false, reasonCode: 'UNKNOWN_REVIEW_REQUIRED' };
  const fromState = (graph.reachableStates || []).find(item => item.id === suggestion.reachableStateId);
  if (!fromState) return { applicable: false, reasonCode: 'SOURCE_STATE_MISSING' };
  if (dependencyBlocking?.isFrontierBlocked({ fromReachableStateId: suggestion.reachableStateId })) return { applicable: false, reasonCode: 'SOURCE_BLOCKED_BY_FAILED_DEPENDENCY' };
  const safety = suggestion.safety || assessAction(suggestion.candidate, scan.target);
  if (safety.allowed === false) return { applicable: false, reasonCode: safety.reasonCode || 'SAFETY_BLOCKED' };
  if (acceptSafe && (safety.risk || suggestion.risk || 'SAFE') !== 'SAFE') return { applicable: false, reasonCode: 'ACCEPT_SAFE_ONLY' };
  const budget = runBudget(scan, contextId);
  const fromItems = (frontier.items || []).filter(item => item.fromReachableStateId === suggestion.reachableStateId);
  if (fromItems.some(item => item.candidateGroupKey === suggestion.candidateGroupKey)) return { applicable: false, reasonCode: 'DUPLICATE_FRONTIER' };
  if (fromItems.filter(countedCandidateItem).length >= maxTotalCandidatesPerState(budget)) return { applicable: false, reasonCode: 'MAX_TOTAL_CANDIDATES_PER_STATE' };
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

function candidateReviewNeed({ scanDir, scan, contextId, graph, frontier, reachableStateId, pendingSuggestions = [] }) {
  const reviewCandidates = pendingSuggestions.filter(item => !item.visualCandidateReviewId && !item.source?.startsWith('VISUAL_') && !isAutoApplyCandidate(item));
  if (!reviewCandidates.length) return null;
  const drafted = draftSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId });
  if (drafted.reasonCode) return null;
  const signals = visualReviewSignals({ layout: drafted.layout, pendingSuggestions: reviewCandidates });
  const unknownReviewCandidates = reviewCandidates.filter(item => item.candidateClass === 'UNKNOWN_REVIEW_REQUIRED');
  if (!unknownReviewCandidates.length && !signals.required) return null;
  return {
    reachableStateId: drafted.reachableState.id,
    visualStateId: drafted.visualState.id,
    observationId: drafted.observationId,
    evidenceSource: drafted.evidenceSource,
    observationRef: drafted.observationRef,
    reasonCodes: signals.reasonCodes,
    containerCount: signals.containerCount,
    horizontalScrollCount: signals.horizontalScrollCount,
    coveredTextSuggestionIds: signals.coveredTextSuggestionIds
  };
}

module.exports = { buildSuggestionItems, draftSuggestionItems, loadObservationLayout, loadObservationLayoutFromSource, resolveObservationForSuggestion, existingKeys, suggestionApplicability, applicableSuggestions, visualReviewSignals, candidateReviewNeed, knownCandidateCountForState };

#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, contextDir, bool, jsonArg, now, commitEvent, nextId, hashObject, slug, safeSegment, output, main, fail } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { buildSuggestionItems, draftSuggestionItems, suggestionApplicability, candidateReviewNeed } = require('./lib/frontier-candidate-service');
const { loadFrontierSuggestions, suggestionUpsertOp, pendingSuggestionsForState } = require('./lib/frontier-suggestions-store');
const { makeFrontierItem, frontierUpsertOp } = require('./lib/frontier-store');
const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./lib/verification-store');
const { deriveBlockedDependencies } = require('./lib/dependency-blocking');
const { assessAction } = require('./lib/safety');
const { flattenLayout, normalizeBounds, normalizeText, boundsOverlap } = require('./lib/semantic-fingerprint');
const { priorityFor } = require('./lib/frontier-candidate-extractor');
const { isAutoApplyCandidate } = require('./lib/candidate-classifier');

const DATA_SKIP_CLASSES = new Set(['DYNAMIC_DATA_ITEM', 'BUSINESS_DATA_ITEM']);

function isDynamicDataCandidate(suggestion = {}) {
  return DATA_SKIP_CLASSES.has(suggestion.candidateClass || suggestion.classification?.candidateClass);
}

function stateIdsFromArgs(args, store) {
  if (args.suggestionId) {
    const wanted = new Set(String(args.suggestionId).split(',').map(x => x.trim()).filter(Boolean));
    return item => wanted.has(item.suggestionId);
  }
  if (args.reachableStateId) return item => item.reachableStateId === String(args.reachableStateId);
  return () => true;
}

function requestedBackfillStateIds(args, graph) {
  const allReachable = bool(args.allReachable, false);
  const requested = [];
  if (args.reachableStateId) requested.push(String(args.reachableStateId));
  if (args.reachableStateIds) {
    const values = Array.isArray(args.reachableStateIds) ? args.reachableStateIds : [args.reachableStateIds];
    for (const value of values) requested.push(...String(value).split(',').map(item => item.trim()).filter(Boolean));
  }
  const unique = [...new Set(requested)];
  if (allReachable && unique.length) fail('Backfill accepts either --all-reachable true or explicit reachable state ids, not both', 'BACKFILL_TARGET_CONFLICT');
  if (!allReachable && !unique.length) fail('Backfill requires --all-reachable true, --reachable-state-id or --reachable-state-ids', 'BACKFILL_TARGET_REQUIRED');
  const known = new Set((graph.reachableStates || []).map(item => item.id));
  const missing = unique.filter(id => !known.has(id));
  if (missing.length) fail(`Backfill target ReachableState is missing: ${missing.join(',')}`, 'GRAPH_REFERENCE_MISSING');
  return { allReachable, ids: unique };
}

function statusForApplicability(reasonCode) {
  return ['SAFETY_BLOCKED', 'SAFETY_HARD_BLOCK', 'TEST_ENV_REQUIRED', 'ACCEPT_SAFE_ONLY', 'SOURCE_BLOCKED_BY_FAILED_DEPENDENCY'].includes(reasonCode) || String(reasonCode || '').startsWith('RISK_') ? 'BLOCKED' : 'SKIPPED';
}

function boolish(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function nodeValue(value = {}) {
  return { ...(value.attributes || {}), ...value };
}

function rawNodes(value, out = [], depth = 0, indexPath = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rawNodes(item, out, depth, [...indexPath, index]));
    return out;
  }
  if (typeof value !== 'object') return out;
  const node = nodeValue(value);
  out.push({ node, depth, indexPath: indexPath.join('.') });
  for (const key of ['children', 'nodes', 'components']) rawNodes(value[key], out, depth + 1, [...indexPath, key]);
  return out;
}

function textOf(node = {}) {
  return normalizeText(node.text || node.content || node.label || node.accessibilityLabel || node.description || node.originalText) || null;
}

function roleOf(node = {}) {
  return String(node.type || node.role || node.className || 'node');
}

function clickableSummary(layout, limit = 120) {
  return rawNodes(layout).map(({ node, depth, indexPath }) => {
    const role = roleOf(node);
    const clickable = boolish(node.clickable) || boolish(node.longClickable) || /button|btn|tab|imagebutton|listitem|menuitem|checkbox|radio/i.test(role);
    const scrollable = boolish(node.scrollable);
    if (!clickable && !scrollable) return null;
    return {
      indexPath,
      depth,
      role,
      text: textOf(node),
      rawText: String(node.text || node.content || node.label || node.accessibilityLabel || node.description || node.originalText || '').trim() || null,
      clickable,
      scrollable,
      selected: boolish(node.selected) || boolish(node.checked) || String(node.state || '').toLowerCase() === 'selected',
      bounds: normalizeBounds(node.bounds || node.rect || node.origBounds || null)
    };
  }).filter(item => item?.bounds).slice(0, limit);
}

function observationPath(baseScanDir, observation, observationId, field, filename) {
  const relative = observation?.[field] || path.join('evidence', 'observations', observationId, filename).split(path.sep).join('/');
  return {
    relative,
    absolute: path.join(baseScanDir, relative)
  };
}

function rootBounds(layout, observation = {}) {
  const first = rawNodes(layout)[0]?.node || {};
  const root = normalizeBounds(first.bounds || first.rect || first.origBounds);
  if (root) return root;
  const width = Number(observation.display?.width || observation.screen?.width || observation.viewport?.width);
  const height = Number(observation.display?.height || observation.screen?.height || observation.viewport?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return [0, 0, width, height];
  const bounds = flattenLayout(layout).map(item => item.bounds).filter(Boolean);
  if (!bounds.length) return [0, 0, 1260, 2720];
  return [Math.min(...bounds.map(item => item[0])), Math.min(...bounds.map(item => item[1])), Math.max(...bounds.map(item => item[2])), Math.max(...bounds.map(item => item[3]))];
}

function usefulBounds(bounds) {
  if (!bounds) return false;
  return bounds[2] - bounds[0] >= 24 && bounds[3] - bounds[1] >= 24;
}

function withinBounds(bounds, outer, tolerance = 4) {
  return bounds[0] >= outer[0] - tolerance && bounds[1] >= outer[1] - tolerance && bounds[2] <= outer[2] + tolerance && bounds[3] <= outer[3] + tolerance;
}

function visualCandidateGroupKey(reachableState, candidate, source) {
  const target = candidate.target || candidate.type || 'candidate';
  const bounds = candidate.fallbackBounds || [candidate.fromX, candidate.fromY, candidate.toX, candidate.toY];
  return `${slug(reachableState.visualStateId || reachableState.id, 'state')}/${slug(target, 'visual-candidate')}-${hashObject({ type: candidate.type, target, bounds, source }).slice(-8)}`;
}

function swipeFromBounds(bounds, direction) {
  const [left, top, right, bottom] = bounds;
  const width = right - left;
  const height = bottom - top;
  const cx = Math.round(left + width / 2);
  const cy = Math.round(top + height / 2);
  const x1 = Math.round(left + width * 0.82);
  const x2 = Math.round(left + width * 0.18);
  const y1 = Math.round(top + height * 0.82);
  const y2 = Math.round(top + height * 0.28);
  if (direction === 'right') return { fromX: x2, fromY: cy, toX: x1, toY: cy, target: '向右滑动' };
  if (direction === 'up') return { fromX: cx, fromY: y1, toX: cx, toY: y2, target: '向上滑动' };
  if (direction === 'down') return { fromX: cx, fromY: y2, toX: cx, toY: y1, target: '向下滑动' };
  return { fromX: x1, fromY: cy, toX: x2, toY: cy, target: '向左滑动' };
}

function normalizeSupplementedCandidate(entry, screenBounds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Visual candidate review supplement must be an object', 'VISUAL_CANDIDATE_INVALID');
  const source = String(entry.source || (String(entry.direction || '').match(/left|right|左|右/i) ? 'VISUAL_HORIZONTAL_SCROLL' : 'VISUAL_CARD_GROUP'));
  const allowedSources = new Set(['VISUAL_CARD_GROUP', 'VISUAL_BANNER', 'VISUAL_ICON_BUTTON', 'VISUAL_HORIZONTAL_SCROLL']);
  if (!allowedSources.has(source)) fail(`Invalid visual candidate source: ${source}`, 'VISUAL_CANDIDATE_SOURCE_INVALID');
  const type = String(entry.type || (entry.direction ? 'swipe' : 'tap'));
  const bounds = normalizeBounds(entry.bounds || entry.fallbackBounds || entry.rect);
  if (!bounds || !usefulBounds(bounds)) fail('Visual candidate review supplement requires useful bounds', 'VISUAL_CANDIDATE_BOUNDS_INVALID');
  if (!withinBounds(bounds, screenBounds)) fail('Visual candidate review supplement bounds must be inside the observation screen', 'VISUAL_CANDIDATE_BOUNDS_OUTSIDE_SCREEN');
  const confidence = Number(entry.confidence ?? (type === 'swipe' ? 0.78 : 0.82));
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail('Visual candidate review supplement confidence must be between 0 and 1', 'VISUAL_CANDIDATE_CONFIDENCE_INVALID');
  if (type === 'swipe') {
    const rawDirection = String(entry.direction || 'left').toLowerCase();
    const direction = rawDirection.includes('右') ? 'right' : rawDirection.includes('上') ? 'up' : rawDirection.includes('下') ? 'down' : rawDirection.includes('right') ? 'right' : rawDirection.includes('up') ? 'up' : rawDirection.includes('down') ? 'down' : 'left';
    const swipe = swipeFromBounds(bounds, direction);
    return {
      candidate: { type: 'swipe', target: entry.target || swipe.target, fromX: swipe.fromX, fromY: swipe.fromY, toX: swipe.toX, toY: swipe.toY },
      source,
      confidence,
      rationale: entry.rationale || null,
      bounds
    };
  }
  const target = normalizeText(entry.target || entry.text || entry.label) || String(entry.target || entry.text || entry.label || '').trim();
  if (!target) fail('Visual candidate review tap supplement requires target text', 'VISUAL_CANDIDATE_TARGET_REQUIRED');
  return {
    candidate: { type: 'tap', target, fallbackBounds: bounds },
    source,
    confidence,
    rationale: entry.rationale || null,
    bounds
  };
}

function acceptedDraftIds(review) {
  return (Array.isArray(review.accepted) ? review.accepted : []).map(item => typeof item === 'string' ? item : item?.draftId).filter(Boolean);
}

function visualCandidateReviewRef(reviewId) {
  return `evidence/visual-candidate-reviews/${safeSegment(reviewId, 'visualCandidateReviewId')}.json`;
}

function materializeReviewSuggestions({ scanDir, scan, contextId, reachableState, visualState, observationId, observationRef, evidenceSource, suggestionsStore, reviewId, acceptedDrafts, supplemented }) {
  const candidates = [
    ...acceptedDrafts.map(item => ({ ...item, reviewOrigin: 'ACCEPTED_DRAFT' })),
    ...supplemented.map(item => {
      const candidateGroupKey = visualCandidateGroupKey(reachableState, item.candidate, item.source);
      return {
        reachableStateId: reachableState.id,
        visualStateId: visualState.id,
        observationId,
        candidateGroupKey,
        candidate: item.candidate,
        source: item.source,
        confidence: item.confidence,
        priority: priorityFor(item.source),
        candidateClass: item.candidateClass || 'UNKNOWN_REVIEW_REQUIRED',
        classification: item.classification || { candidateClass: item.candidateClass || 'UNKNOWN_REVIEW_REQUIRED', reasonCodes: ['SUPPLEMENTED_VISUAL'], confidence: item.confidence },
        rationale: item.rationale || null,
        reviewOrigin: 'SUPPLEMENTED_VISUAL'
      };
    })
  ];
  const skipped = [];
  const updated = [];
  const existingItems = suggestionsStore?.items || [];
  const existingByGroup = new Map(existingItems.map(item => [item.candidateGroupKey, item]));
  const seen = new Set(existingItems.map(item => item.candidateGroupKey).filter(Boolean));
  const visualTapCandidates = candidates.filter(item => item.source?.startsWith('VISUAL_') && item.candidate?.type === 'tap' && item.candidate.fallbackBounds);
  for (const existing of existingItems) {
    if (existing.reachableStateId !== reachableState.id || existing.status !== 'PENDING' || existing.source?.startsWith('VISUAL_') || existing.candidate?.type !== 'tap' || !existing.candidate.fallbackBounds) continue;
    const covered = visualTapCandidates.some(visual => boundsOverlap(visual.candidate.fallbackBounds, existing.candidate.fallbackBounds) >= 0.85);
    if (!covered) continue;
    existing.status = 'SKIPPED';
    existing.updatedAt = now();
    existing.reasonCode = 'COVERED_BY_VISUAL_CONTAINER';
    existing.visualCandidateReviewId = reviewId;
    existing.reviewOrigin = existing.reviewOrigin || 'COVERED_EXISTING_SUGGESTION';
    skipped.push({ suggestionId: existing.suggestionId, candidateGroupKey: existing.candidateGroupKey, reasonCode: existing.reasonCode });
    updated.push(existing);
  }
  const filtered = candidates.filter(item => {
    if (!item.candidate) return false;
    const existing = existingByGroup.get(item.candidateGroupKey);
    if (existing) {
      if (existing.status === 'PENDING' && !skipped.some(skippedItem => skippedItem.suggestionId === existing.suggestionId)) {
        existing.visualCandidateReviewId = reviewId;
        existing.reviewOrigin = item.reviewOrigin || existing.reviewOrigin || 'ACCEPTED_EXISTING_SUGGESTION';
        existing.rationale = item.rationale || existing.rationale || null;
        existing.updatedAt = now();
        updated.push(existing);
        skipped.push({ suggestionId: existing.suggestionId, candidateGroupKey: item.candidateGroupKey, reasonCode: 'EXISTING_SUGGESTION_BOUND_TO_REVIEW' });
      } else {
        skipped.push({ suggestionId: existing.suggestionId, candidateGroupKey: item.candidateGroupKey, reasonCode: 'DUPLICATE_CANDIDATE_GROUP' });
      }
      return false;
    }
    if (!item.source?.startsWith('VISUAL_') && item.candidate?.type === 'tap' && item.candidate.fallbackBounds) {
      const covered = visualTapCandidates.some(visual => visual !== item && boundsOverlap(visual.candidate.fallbackBounds, item.candidate.fallbackBounds) >= 0.85);
      if (covered) {
        skipped.push({ candidateGroupKey: item.candidateGroupKey, reasonCode: 'COVERED_BY_VISUAL_CONTAINER' });
        return false;
      }
    }
    seen.add(item.candidateGroupKey);
    return true;
  });
  const created = [];
  const ops = updated.map(item => suggestionUpsertOp(contextId, item));
  for (const suggestion of filtered) {
    const safety = assessAction(suggestion.candidate, scan.target);
    const item = {
      schemaVersion: 1,
      suggestionId: nextId(scanDir, 'suggestion', 'suggest'),
      reachableStateId: suggestion.reachableStateId,
      visualStateId: suggestion.visualStateId,
      observationId: suggestion.observationId,
      candidateGroupKey: suggestion.candidateGroupKey,
      candidate: suggestion.candidate,
      source: suggestion.source,
      confidence: suggestion.confidence,
      priority: suggestion.priority || priorityFor(suggestion.source),
      candidateClass: suggestion.candidateClass || null,
      classification: suggestion.classification || null,
      candidateHash: hashObject(suggestion.candidate),
      risk: safety.risk || null,
      safety,
      status: safety.allowed === false ? 'BLOCKED' : 'PENDING',
      evidenceSource,
      observationRef,
      visualCandidateReviewId: reviewId,
      reviewOrigin: suggestion.reviewOrigin,
      rationale: suggestion.rationale || null,
      createdAt: now(),
      updatedAt: now(),
      reasonCode: safety.allowed === false ? safety.reasonCode : null,
      frontierId: null
    };
    created.push(item);
    ops.push(suggestionUpsertOp(contextId, item));
  }
  return { created, updated, skipped, ops };
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'list'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: ['suggest', 'prepare-review', 'record-visual-review', 'apply', 'backfill', 'dismiss'].includes(command) }); const contextId = args.context || runContextId(scan);
  if (command === 'list') return output(loadFrontierSuggestions(scanDir, contextId));
  if (command === 'suggest') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion generation requires SCANNING', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const reachableStateId = required(args, 'reachableStateId'); const observationId = args.observationId ? String(args.observationId) : null;
    const result = buildSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId });
    if (result.reasonCode) return output({ schemaVersion: 1, ok: false, created: 0, reasonCode: result.reasonCode });
    if (result.ops.length) commitEvent(scanDir, 'frontierSuggestionsGenerated', { contextId, reachableStateId, observationId: result.observationId, suggestionIds: result.created.map(item => item.suggestionId), created: result.created, skipped: result.skipped }, result.ops);
    return output({ schemaVersion: 1, ok: true, created: result.created.length, suggestions: result.created, skipped: result.skipped });
  }
  if (command === 'prepare-review') {
    if (scan.status !== 'SCANNING') fail('Frontier visual candidate review preparation requires SCANNING', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const reachableStateId = required(args, 'reachableStateId'); const observationId = args.observationId ? String(args.observationId) : null;
    const result = draftSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId, includeExistingSuggestions: true });
    if (result.reasonCode) return output({ schemaVersion: 1, ok: false, reasonCode: result.reasonCode, evidenceSource: result.evidenceSource || null });
    const screenshot = observationPath(result.baseScanDir, result.observation, result.observationId, 'screenshotPath', 'screenshot.png');
    const layout = observationPath(result.baseScanDir, result.observation, result.observationId, 'layoutPath', 'layout.json');
    const autoCandidates = result.drafts.filter(item => isAutoApplyCandidate(item));
    const reviewCandidates = result.drafts.filter(item => item.candidateClass === 'UNKNOWN_REVIEW_REQUIRED');
    const suppressedCandidates = result.drafts.filter(item => isDynamicDataCandidate(item) || item.defaultStatus === 'SKIPPED');
    return output({
      schemaVersion: 1,
      ok: true,
      reviewRequest: {
        contextId,
        reachableStateId: result.reachableState.id,
        visualStateId: result.visualState.id,
        observationId: result.observationId,
        evidenceSource: result.evidenceSource,
        observationRef: result.observationRef,
        screenBounds: rootBounds(result.layout, result.observation),
        screenshotPath: screenshot.relative,
        screenshotAbsolutePath: screenshot.absolute,
        layoutPath: layout.relative,
        layoutAbsolutePath: layout.absolute,
        autoCandidates,
        reviewCandidates,
        suppressedCandidates,
        draftCandidates: result.drafts,
        pendingSuggestions: (loadFrontierSuggestions(scanDir, contextId).items || []).filter(item => item.reachableStateId === result.reachableState.id && item.status === 'PENDING'),
        clickableSummary: clickableSummary(result.layout),
        instructions: {
          accepted: 'Return accepted draftIds for script candidates that should become frontier suggestions.',
          supplemented: 'Add visually inferred tap or swipe candidates with bounds from this same screenshot/layout.',
          rejected: 'Optionally record skipped draftIds or regions with reason.'
        }
      },
      skipped: result.skipped
    });
  }
  if (command === 'record-visual-review') {
    if (scan.status !== 'SCANNING') fail('Frontier visual candidate review recording requires SCANNING', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const reachableStateId = required(args, 'reachableStateId'); const observationId = args.observationId ? String(args.observationId) : null; const review = jsonArg(args.review ?? args.reviewJson, {}, '--review');
    const result = draftSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId, includeExistingSuggestions: true });
    if (result.reasonCode) return output({ schemaVersion: 1, ok: false, reasonCode: result.reasonCode, evidenceSource: result.evidenceSource || null });
    const draftById = new Map(result.drafts.map(item => [item.draftId, item]));
    const acceptedDrafts = acceptedDraftIds(review).map(draftId => {
      const draft = draftById.get(draftId);
      if (!draft) fail(`Unknown accepted draftId: ${draftId}`, 'VISUAL_REVIEW_DRAFT_INVALID');
      const { draftId: ignoredDraftId, ...item } = draft;
      return item;
    });
    const screen = rootBounds(result.layout, result.observation);
    const supplemented = (Array.isArray(review.supplemented) ? review.supplemented : []).map(item => normalizeSupplementedCandidate(item, screen));
    const reviewId = nextId(scanDir, 'visualCandidateReview', 'vcandidate');
    const suggestionsStore = loadFrontierSuggestions(scanDir, contextId);
    const materialized = materializeReviewSuggestions({ scanDir, scan, contextId, reachableState: result.reachableState, visualState: result.visualState, observationId: result.observationId, observationRef: result.observationRef, evidenceSource: result.evidenceSource, suggestionsStore, reviewId, acceptedDrafts, supplemented });
    const screenshot = observationPath(result.baseScanDir, result.observation, result.observationId, 'screenshotPath', 'screenshot.png');
    const layout = observationPath(result.baseScanDir, result.observation, result.observationId, 'layoutPath', 'layout.json');
    const reviewValue = {
      schemaVersion: 1,
      visualCandidateReviewId: reviewId,
      contextId,
      reachableStateId: result.reachableState.id,
      visualStateId: result.visualState.id,
      observationId: result.observationId,
      evidenceSource: result.evidenceSource,
      observationRef: result.observationRef,
      screenshotPath: screenshot.relative,
      layoutPath: layout.relative,
      screenBounds: screen,
      review: {
        accepted: Array.isArray(review.accepted) ? review.accepted : [],
        rejected: Array.isArray(review.rejected) ? review.rejected : [],
        supplemented: Array.isArray(review.supplemented) ? review.supplemented : [],
        notes: review.notes || null
      },
      createdSuggestionIds: materialized.created.map(item => item.suggestionId),
      affectedSuggestionIds: [...materialized.created, ...materialized.updated].map(item => item.suggestionId),
      skipped: materialized.skipped,
      createdAt: now()
    };
    const ops = [{ path: visualCandidateReviewRef(reviewId), op: 'REPLACE', value: reviewValue }, ...materialized.ops];
    commitEvent(scanDir, 'visualCandidateReviewRecorded', { contextId, reachableStateId: result.reachableState.id, visualStateId: result.visualState.id, observationId: result.observationId, visualCandidateReviewId: reviewId, createdSuggestionIds: reviewValue.createdSuggestionIds, affectedSuggestionIds: reviewValue.affectedSuggestionIds, skipped: materialized.skipped }, ops);
    return output({ schemaVersion: 1, ok: true, visualCandidateReviewId: reviewId, created: materialized.created.length, updated: materialized.updated.length, suggestions: materialized.created, updatedSuggestions: materialized.updated, skipped: materialized.skipped, review: reviewValue });
  }
  if (command === 'backfill') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion backfill requires SCANNING', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const requestedTargets = requestedBackfillStateIds(args, graph); const wanted = new Set(requestedTargets.ids);
    const states = (graph.reachableStates || []).filter(state => requestedTargets.allReachable || wanted.has(state.id)).sort((a, b) => Number(a.depth?.pathDepth || 0) - Number(b.depth?.pathDepth || 0) || String(a.id).localeCompare(String(b.id)));
    const created = []; const skipped = []; const dynamicAudits = [];
    for (const state of states) {
      const observationId = args.observationId && !requestedTargets.allReachable && states.length === 1 ? String(args.observationId) : null;
      const result = buildSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId: state.id, observationId });
      if (result.reasonCode) { skipped.push({ reachableStateId: state.id, reasonCode: result.reasonCode, evidenceSource: result.evidenceSource || null }); continue; }
      if (result.dynamicAudit?.totalCount) dynamicAudits.push({ reachableStateId: state.id, ...result.dynamicAudit });
      if (result.ops.length) commitEvent(scanDir, 'frontierSuggestionsBackfilled', { contextId, reachableStateId: state.id, observationId: result.observationId, observationRef: result.observationRef || null, evidenceSource: result.evidenceSource || null, suggestionIds: result.created.map(item => item.suggestionId), created: result.created, skipped: result.skipped, dynamicAudit: result.dynamicAudit || null }, result.ops);
      created.push(...result.created); skipped.push(...result.skipped.map(item => ({ reachableStateId: state.id, ...item })));
    }
    return output({ schemaVersion: 1, ok: true, scannedReachableStates: states.length, requestedReachableStateIds: states.map(item => item.id), created: created.length, suggestions: created, skipped, dynamicAudits });
  }
  if (command === 'dismiss') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion dismissal requires SCANNING', 'RUN_STATE_INVALID');
    const store = loadFrontierSuggestions(scanDir, contextId); const predicate = stateIdsFromArgs(args, store); const reasonCode = String(args.reasonCode || 'MANUALLY_DISMISSED');
    const selected = pendingSuggestionsForState(store, args.reachableStateId ? String(args.reachableStateId) : null).filter(predicate);
    const dismissed = []; const ops = [];
    for (const suggestion of selected) {
      suggestion.status = 'DISMISSED';
      suggestion.updatedAt = now();
      suggestion.reasonCode = reasonCode;
      dismissed.push(suggestion);
      ops.push(suggestionUpsertOp(contextId, suggestion));
    }
    if (ops.length) commitEvent(scanDir, 'frontierSuggestionsDismissed', { contextId, suggestionIds: dismissed.map(item => item.suggestionId), reasonCode }, ops);
    return output({ schemaVersion: 1, ok: true, dismissed: dismissed.length, suggestions: dismissed });
  }
  if (command === 'apply') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion apply requires SCANNING', 'RUN_STATE_INVALID');
    const acceptSafe = bool(args.acceptSafe, true); const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const store = loadFrontierSuggestions(scanDir, contextId); const predicate = stateIdsFromArgs(args, store); const queue = loadVerificationQueue(scanDir, contextId); const dependencyBlocking = deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS });
    const selected = pendingSuggestionsForState(store, args.reachableStateId ? String(args.reachableStateId) : null).filter(predicate);
    const applied = []; const skipped = []; const blocked = []; const ops = [];
    const reviewNeedByState = new Map();
    const reviewNeedFor = reachableStateId => {
      if (!reviewNeedByState.has(reachableStateId)) {
        reviewNeedByState.set(reachableStateId, candidateReviewNeed({ scanDir, scan, contextId, graph, frontier, reachableStateId, pendingSuggestions: pendingSuggestionsForState(store, reachableStateId) }));
      }
      return reviewNeedByState.get(reachableStateId);
    };
    for (const suggestion of selected) {
      if (isDynamicDataCandidate(suggestion)) {
        suggestion.status = 'SKIPPED';
        suggestion.updatedAt = now();
        suggestion.reasonCode = 'DYNAMIC_DATA_ITEM';
        skipped.push(suggestion);
        ops.push(suggestionUpsertOp(contextId, suggestion));
        continue;
      }
      if (suggestion.candidateClass === 'UNKNOWN_REVIEW_REQUIRED' && !suggestion.visualCandidateReviewId) {
        suggestion.updatedAt = now();
        suggestion.reasonCode = 'UNKNOWN_REVIEW_REQUIRED';
        suggestion.reviewRequirement = { reasonCode: 'CANDIDATE_VISUAL_REVIEW_REQUIRED', reasonCodes: suggestion.classification?.reasonCodes || [], observationId: suggestion.observationId || null, updatedAt: suggestion.updatedAt };
        skipped.push(suggestion);
        ops.push(suggestionUpsertOp(contextId, suggestion));
        continue;
      }
      const reviewNeed = !isAutoApplyCandidate(suggestion) && !suggestion.visualCandidateReviewId && !suggestion.source?.startsWith('VISUAL_') ? reviewNeedFor(suggestion.reachableStateId) : null;
      if (reviewNeed) {
        suggestion.updatedAt = now();
        suggestion.reasonCode = 'VISUAL_REVIEW_REQUIRED';
        suggestion.reviewRequirement = { reasonCode: 'CANDIDATE_VISUAL_REVIEW_REQUIRED', reasonCodes: reviewNeed.reasonCodes || [], observationId: reviewNeed.observationId || null, updatedAt: suggestion.updatedAt };
        skipped.push(suggestion);
        ops.push(suggestionUpsertOp(contextId, suggestion));
        continue;
      }
      const applicable = suggestionApplicability({ scan, contextId, graph, frontier, suggestion, dependencyBlocking, acceptSafe });
      if (!applicable.applicable) {
        suggestion.status = statusForApplicability(applicable.reasonCode); suggestion.updatedAt = now(); suggestion.reasonCode = applicable.reasonCode || 'SUGGESTION_NOT_APPLICABLE'; if (suggestion.status === 'BLOCKED') blocked.push(suggestion); else skipped.push(suggestion); ops.push(suggestionUpsertOp(contextId, suggestion)); continue;
      }
      const made = makeFrontierItem({ scanDir, scan, contextId, graph, frontier, fromReachableStateId: suggestion.reachableStateId, candidate: suggestion.candidate, candidateGroupKey: suggestion.candidateGroupKey, priority: suggestion.priority || {}, sourceFrontierId: suggestion.suggestionId });
      if (!made.ok || !made.created) {
        suggestion.status = made.blocked ? 'BLOCKED' : 'SKIPPED'; suggestion.updatedAt = now(); suggestion.reasonCode = made.reasonCode || 'FRONTIER_NOT_CREATED'; if (made.blocked) blocked.push(suggestion); else skipped.push(suggestion); ops.push(suggestionUpsertOp(contextId, suggestion)); continue;
      }
      frontier.items.push(made.item);
      suggestion.status = 'APPLIED'; suggestion.frontierId = made.item.id; suggestion.updatedAt = now(); suggestion.reasonCode = null;
      applied.push({ suggestion, frontier: made.item });
      ops.push(suggestionUpsertOp(contextId, suggestion), frontierUpsertOp(contextId, made.item));
    }
    if (ops.length) commitEvent(scanDir, 'frontierSuggestionsApplied', { contextId, suggestionIds: selected.map(item => item.suggestionId), applied: applied.map(item => ({ suggestionId: item.suggestion.suggestionId, frontierId: item.frontier.id })), skipped: skipped.map(item => ({ suggestionId: item.suggestionId, reasonCode: item.reasonCode })), blocked: blocked.map(item => ({ suggestionId: item.suggestionId, reasonCode: item.reasonCode })) }, ops);
    return output({ schemaVersion: 1, ok: true, applied: applied.length, skipped: skipped.length, blocked: blocked.length, frontiers: applied.map(item => item.frontier), suggestions: selected });
  }
  fail(`Unknown frontier-candidates command: ${command}`, 'COMMAND_INVALID');
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, output, main, fail, hashObject, timelineEvents, sha256, contextDir } = require('./lib/common');
const { validateGraph } = require('./lib/graph-store');
const { isCurrentRun, runContextIds, runContextId, runBudget, activeLimitMinutes, maxStates, maxDeviceActions, maxColdStarts, maxDepth } = require('./lib/run-protocol');
const { budgetUsage } = require('./lib/budget');
const { loadCursor } = require('./lib/live-cursor');
const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./lib/verification-store');
const { deriveBlockedDependencies } = require('./lib/dependency-blocking');
const { backfillRequiredFromCoverage } = require('./lib/candidate-coverage');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { loadVisualEquivalence } = require('./lib/visual-equivalence');
const { loadStateEquivalence } = require('./lib/state-equivalence-store');
const { assertAcceptedVisualReview } = require('./lib/visual-review-store');
const { canonicalIntentIdentity, intentFromAction, locatorEvidenceFor } = require('./lib/action-intent');
const { locatorReplayabilityReason } = require('./lib/replayability');

function requireObservation(scanDir, observationId, contextId) {
  const dir = path.join(scanDir, 'evidence', 'observations', observationId); const observation = readJson(path.join(dir, 'observation.json'));
  if (observation.contextId !== contextId || observation.captureStatus !== 'COMPLETE' || !fs.existsSync(path.join(dir, 'screenshot.png')) || !fs.existsSync(path.join(dir, 'layout.json'))) fail(`Observation ${observationId} is incomplete or belongs to another context`, 'EVIDENCE_INCOMPLETE');
  if (Number(observation.schemaVersion || 1) >= 2) {
    const stability = observation.stability; const layout = readJson(path.join(dir, 'layout.json')); const screenshotSha256 = sha256(fs.readFileSync(path.join(dir, 'screenshot.png'))); const layoutHash = buildFingerprint(layout, observation.foreground).layoutHash;
    const policy = stability?.policy; const samples = stability?.samples; const finalSample = Array.isArray(samples) ? samples[samples.length - 1] : null;
    const baseValid = stability?.accepted === true && ['STABLE', 'LAYOUT_STABLE_VISUAL_VARIANCE'].includes(stability.status) && policy && Number.isInteger(policy.requiredStableSamples) && Number.isInteger(policy.layoutFallbackSamples) && stability.sampleCount === samples?.length && stability.sampleCount >= policy.requiredStableSamples && observation.trigger === stability.trigger && stability.trigger === policy.trigger && stability.finalScreenshotSha256 === screenshotSha256 && stability.finalLayoutHash === layoutHash && finalSample?.screenshotSha256 === screenshotSha256 && finalSample?.layoutHash === layoutHash && finalSample?.captureCoherent !== false && (finalSample?.loadingSignals || []).length === 0;
    const statusValid = stability?.status === 'STABLE' ? finalSample?.stableRun >= policy?.requiredStableSamples : finalSample?.layoutRun >= policy?.layoutFallbackSamples && stability?.elapsedMs >= policy?.visualFallbackMs;
    if (!baseValid || !statusValid) fail(`Observation ${observationId} lacks valid stability evidence`, 'OBSERVATION_STABILITY_INVALID');
  }
  return observation;
}

function appRootFromScanDir(scanDir) {
  return path.dirname(path.dirname(scanDir));
}

function requireSuggestionObservation(scanDir, suggestion, contextId) {
  if (!suggestion.observationId) return;
  const ref = suggestion.observationRef || null;
  const baseScanDir = ref?.runId ? path.join(appRootFromScanDir(scanDir), 'runs', String(ref.runId)) : scanDir;
  const observationId = String(ref?.observationId || suggestion.observationId);
  const dir = path.join(baseScanDir, 'evidence', 'observations', observationId);
  const observationFile = path.join(dir, 'observation.json');
  if (!fs.existsSync(observationFile) || !fs.existsSync(path.join(dir, 'layout.json')) || !fs.existsSync(path.join(dir, 'screenshot.png'))) fail(`Frontier suggestion ${suggestion.suggestionId || '<missing>'} references missing observation`, 'FRONTIER_SUGGESTIONS_INVALID');
  const observation = readJson(observationFile);
  if (observation.contextId !== contextId) fail(`Frontier suggestion ${suggestion.suggestionId || '<missing>'} references observation from another context`, 'FRONTIER_SUGGESTIONS_INVALID');
  if (suggestion.evidenceSource === 'CANONICAL_REF' && !ref?.runId) fail(`Frontier suggestion ${suggestion.suggestionId || '<missing>'} lacks historical observationRef`, 'FRONTIER_SUGGESTIONS_INVALID');
}

function requirePopupInterruption(scanDir, interruption, contextId, ownerType, ownerId) {
  requireObservation(scanDir, interruption.beforeObservationId, contextId); const action = readJson(path.join(scanDir, 'evidence', 'actions', `${interruption.dismissalActionResultId}.json`));
  if (action.status !== 'SUCCEEDED' || action.role !== 'POPUP_DISMISSAL' || action.contextId !== contextId || action.owner?.type !== ownerType || action.owner?.id !== ownerId || action.beforeObservationId !== interruption.beforeObservationId) fail('Popup interruption evidence is inconsistent', 'POPUP_EVIDENCE_INVALID');
  if (Number(interruption.schemaVersion || 1) >= 2 && !interruption.afterObservationId) fail('Popup interruption lacks its cleanup observation', 'POPUP_EVIDENCE_INVALID');
  if (Number(interruption.schemaVersion || 1) >= 2 && interruption.phase === 'RESTORE' && !interruption.restoreId) fail('Restore popup interruption lacks its restore checkpoint reference', 'POPUP_EVIDENCE_INVALID');
  if (interruption.afterObservationId) requireObservation(scanDir, interruption.afterObservationId, contextId);
}

function validateRestoreResult(scanDir, restore, attempt) {
  if (Number(restore.schemaVersion || 1) < 2) return;
  const persisted = readJson(path.join(scanDir, 'evidence', 'restores', `${restore.restoreId}.json`));
  if (hashObject(persisted) !== hashObject(restore) || restore.contextId !== attempt.contextId || restore.reachableStateId !== attempt.fromReachableStateId) fail(`Restore ${restore.restoreId} projection is inconsistent`, 'RESTORE_EVIDENCE_INVALID');
  if (attempt.status !== 'FAILED' && restore.status !== 'SUCCEEDED') fail(`Restore ${restore.restoreId} is unfinished`, 'RESTORE_EVIDENCE_INVALID');
  const graph = loadGraph(scanDir, attempt.contextId);
  for (const review of restore.equivalenceReviews || []) {
    const observation = requireObservation(scanDir, review.observationId, attempt.contextId);
    const state = graph.reachableStates.find(item => item.id === review.expectedReachableStateId);
    const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
    const observed = buildFingerprint(readJson(path.join(scanDir, observation.layoutPath)), observation.foreground, observationVisual(observation));
    const reviewable = Number(review.schemaVersion || 1) >= 2 ? ['PROBABLE', 'UNCERTAIN'].includes(review.comparison) : review.comparison === 'PROBABLE' && visual?.fingerprint?.layoutHash === observed.layoutHash;
    if (review.status !== 'EXPECTED_STATE_EQUIVALENT' || !reviewable || !visual || review.layoutHash !== observed.layoutHash || review.observedSha256 !== observed.screenshotSha256 || review.expectedScreenshotSha256 !== visual.fingerprint.screenshotSha256 || !String(review.rationale || '').trim()) fail(`Restore ${restore.restoreId} state equivalence evidence is invalid`, 'RESTORE_EQUIVALENCE_INVALID');
  }
}

function compareObservations(scanDir, beforeId, afterId, contextId) {
  const before = requireObservation(scanDir, beforeId, contextId); const after = requireObservation(scanDir, afterId, contextId);
  const beforeLayout = readJson(path.join(scanDir, before.layoutPath)); const afterLayout = readJson(path.join(scanDir, after.layoutPath));
  return compareFingerprint(buildFingerprint(beforeLayout, before.foreground, observationVisual(before)), buildFingerprint(afterLayout, after.foreground, observationVisual(after)));
}

function validate(scanDir, requestedStatus, options = {}) {
  const scan = loadScan(scanDir); const completed = requestedStatus === 'COMPLETED'; const strictClaim = Number(scan.attemptProtocolVersion || 1) >= 2; const summary = { contexts: {}, observations: new Set(), actions: new Set(), attempts: new Set() }; const executionClosure = isCurrentRun(scan) ? require('./lib/execution-closure').validateExecutionClosure(scanDir, scan, requestedStatus) : null;
  const visualReviewRequired = Number(scan.visualReviewProtocolVersion || 0) >= 1;
  if (['COMPLETED', 'PARTIAL'].includes(requestedStatus)) {
    const confirmed = readJson(path.join(scanDir, 'plan.json')); const { planHash, confirmedAt, ...plan } = confirmed; void confirmedAt;
    if (!planHash || hashObject(plan) !== planHash || !timelineEvents(scanDir).some(item => item.type === 'scanPlanConfirmed' && item.planHash === planHash)) fail('Confirmed execution plan is missing, changed, or not recorded in timeline', 'PLAN_CONFIRMATION_INVALID');
  }
  if (isCurrentRun(scan)) {
    const contextId = runContextId(scan); const dirs = fs.readdirSync(path.join(scanDir, 'contexts'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    if (dirs.length !== 1 || dirs[0] !== contextId) fail('Run must contain exactly its fixed context directory', 'CONTEXT_CARDINALITY_INVALID');
    if (scan.parentScanId) { const parentDir = path.join(path.dirname(scanDir), scan.parentScanId); const parent = loadScan(parentDir); if (parent.status !== 'PARTIAL' || parent.scanMode !== scan.scanMode || runContextIds(parent).length !== 1 || runContextIds(parent)[0] !== contextId || parent.mapRevisionId !== scan.mapRevisionId) fail('Continuation parent relationship is invalid', 'PARENT_RUN_INVALID'); const knownContextFile = path.join(scanDir, 'known', 'contexts', `${contextId}.json`); if (!fs.existsSync(knownContextFile)) fail('Continuation is missing known parent context graph', 'CONTINUATION_KNOWLEDGE_MISSING'); const knownContext = readJson(knownContextFile); if (knownContext.contextId !== contextId) fail('Continuation known context graph has the wrong contextId', 'CONTINUATION_KNOWLEDGE_INVALID'); validateGraph(knownContext); if (scan.scanMode === 'goal-directed') { const goal = readJson(path.join(scanDir, 'goal', 'goal.json')); const parentGoal = readJson(path.join(parentDir, 'goal', 'goal.json')); if (!goal.goalSpecHash || goal.goalSpecHash !== parentGoal.goalSpecHash) fail('Goal Continuation goalSpecHash differs from parent', 'PARENT_GOAL_MISMATCH'); } }
  }
  for (const contextId of runContextIds(scan)) {
    const context = readJson(path.join(scanDir, 'contexts', contextId, 'context.json'));
    if (completed && (context.verification?.status !== 'VERIFIED' || context.verification?.source !== 'PLAN_CONFIRMED' || !context.verification?.observationId)) fail(`Context ${contextId} is not evidence-verified`, 'CONTEXT_NOT_VERIFIED');
    if (context.verification?.observationId) {
      const observation = requireObservation(scanDir, context.verification.observationId, contextId); const preparationId = context.verification.preparationId; const preparation = preparationId ? readJson(path.join(scanDir, 'evidence', 'preparations', `${preparationId}.json`)) : null;
      if (!preparation || observation.contextPreparationId !== preparationId || preparation.contextId !== contextId || preparation.status !== 'EVIDENCE_CAPTURED' || preparation.observationId !== observation.observationId || preparation.restartResult?.coldStartVerified !== true) fail(`Context ${contextId} lacks verified cold-start evidence`, 'CONTEXT_PREPARATION_INVALID');
      for (const interruption of preparation.interruptions || []) requirePopupInterruption(scanDir, interruption, contextId, 'CONTEXT_PREPARATION', preparationId);
      for (const check of preparation.stabilityChecks || []) { requireObservation(scanDir, check.beforeObservationId, contextId); requireObservation(scanDir, check.afterObservationId, contextId); }
    }
    const graph = loadGraph(scanDir, contextId); validateGraph(graph); const frontier = loadFrontier(scanDir, contextId); const graphProtocolVersion = Number(scan.graphProtocolVersion || 1);
    if (graphProtocolVersion >= 4 && graph.edges.some(edge => edge.action !== undefined)) fail(`Context ${contextId} contains legacy Edge action storage under current graph rules`, 'GRAPH_SCHEMA_UNSUPPORTED');
    if (graphProtocolVersion >= 2 && graph.edges.some(edge => edge.intent?.type === 'wait')) fail(`Context ${contextId} contains a wait Edge under current graph rules`, 'NON_GRAPH_ACTION');
    if (graphProtocolVersion >= 2 && frontier.items.some(item => item.candidate?.type === 'wait')) fail(`Context ${contextId} contains a wait frontier under current graph rules`, 'NON_GRAPH_ACTION');
    if (completed && !graph.reachableStates.some(x => (x.depth?.pathDepth || 0) === 0)) fail(`Context ${contextId} has no root ReachableState`, 'RUN_INCOMPLETE');
    if (frontier.items.some(x => x.status === 'CLAIMED')) fail(`Context ${contextId} has an unfinished claimed frontier`, 'RUN_INCOMPLETE');
    if (completed && scan.scanMode === 'exploration' && frontier.items.some(x => ['PENDING', 'RETRYABLE'].includes(x.status))) fail(`Context ${contextId} still has explorable frontier items`, 'RUN_INCOMPLETE');
    for (const visual of graph.visualStates) {
      const localEvidenceIds = visual.evidenceObservationIds || [];
      const inheritedRefs = visual.evidenceObservationRefs || [];
      if (!localEvidenceIds.length && !inheritedRefs.length) fail(`VisualState ${visual.id} has no evidence`, 'GRAPH_INVALID');
      for (const id of localEvidenceIds) { requireObservation(scanDir, id, contextId); summary.observations.add(id); }
      if (visualReviewRequired) {
        if (localEvidenceIds.length && !visual.visualReviewIds?.length) fail(`VisualState ${visual.id} has no accepted visual review`, 'VISUAL_REVIEW_REQUIRED');
        const reviews = visual.visualReviewIds.map(visualReviewId => assertAcceptedVisualReview(scanDir, { visualReviewId, contextId }));
        for (const id of localEvidenceIds) if (!reviews.some(review => review.observationId === id)) fail(`VisualState ${visual.id} evidence ${id} lacks accepted visual review`, 'VISUAL_REVIEW_REQUIRED');
        const isRootVisual = graph.reachableStates.some(state => state.visualStateId === visual.id && Number(state.depth?.pathDepth || 0) === 0);
        if (isRootVisual && localEvidenceIds.length && !reviews.some(review => review.reviewType === 'ROOT_STATE')) fail(`Root VisualState ${visual.id} lacks ROOT_STATE visual review`, 'VISUAL_REVIEW_REQUIRED');
      }
    }
    for (const edge of graph.edges) {
      const { beforeObservationId, afterObservationId, actionResultId, visualReviewId } = edge.evidence || {};
      const inheritedEdge = edge.inheritedFromCanonicalMap === true || edge.evidence?.sourceRunId && edge.evidence.sourceRunId !== scan.scanId;
      if (inheritedEdge) {
        if (!edge.evidence?.sourceRunId && !(edge.provenance || []).length) fail(`Inherited Edge ${edge.id} lacks source provenance`, 'GRAPH_INVALID');
        if (isCurrentRun(scan) && (!edge.verification?.transitionFingerprint || !['UNVERIFIED', 'COLD_REPLAY_VERIFIED', 'REPLAY_UNSTABLE', 'NONREPEATABLE', 'INVALIDATED'].includes(edge.verification.replayStatus))) fail(`Edge ${edge.id} has invalid current verification metadata`, 'GRAPH_INVALID');
        continue;
      }
      if (!beforeObservationId || !afterObservationId || !actionResultId || !edge.attemptId) fail(`Edge ${edge.id} lacks causal evidence`, 'GRAPH_INVALID');
      const beforeObservation = requireObservation(scanDir, beforeObservationId, contextId); requireObservation(scanDir, afterObservationId, contextId);
      if (visualReviewRequired) assertAcceptedVisualReview(scanDir, { visualReviewId, contextId, observationId: afterObservationId, reviewType: 'PAGE_OUTCOME' });
      const action = readJson(path.join(scanDir, 'evidence', 'actions', `${actionResultId}.json`));
      const actionIntent = action.actionIntent || intentFromAction(action.action);
      if (action.status !== 'SUCCEEDED' || action.contextId !== contextId || action.attemptId !== edge.attemptId || action.beforeObservationId !== beforeObservationId || hashObject(canonicalIntentIdentity(actionIntent)) !== hashObject(canonicalIntentIdentity(edge.intent))) fail(`Edge ${edge.id} action intent evidence is inconsistent`, 'GRAPH_INVALID');
      const beforeLayout = readJson(path.join(scanDir, beforeObservation.layoutPath));
      const recomputedLocator = locatorEvidenceFor({ action: action.action, intent: edge.intent, observation: beforeObservation, layout: beforeLayout, deviceProfile: action.deviceProfile || beforeObservation.deviceProfile });
      if (edge.locatorQuality !== recomputedLocator.locatorQuality || edge.locatorResolution !== recomputedLocator.resolution) fail(`Edge ${edge.id} locator evidence is inconsistent with before observation`, 'GRAPH_INVALID');
      const locatorReason = locatorReplayabilityReason({ intent: edge.intent, locatorQuality: recomputedLocator.locatorQuality, locatorResolution: recomputedLocator.resolution, locatorEvidence: recomputedLocator });
      if (['EDGE_LOCATOR_UNRESOLVED', 'EDGE_LOCATOR_NOT_RESOLVED'].includes(locatorReason)) fail(`Edge ${edge.id} has unresolved portable locator evidence`, 'GRAPH_INVALID');
      const attempt = readJson(path.join(scanDir, 'attempts', `${edge.attemptId}.json`));
      const frontierItem = frontier.items.find(item => item.id === attempt.frontierId);
      if (attempt.status !== 'COMMITTED' || attempt.edgeId !== edge.id || attempt.actionResultId !== actionResultId || attempt.afterObservationId !== afterObservationId || visualReviewRequired && attempt.visualReviewId !== visualReviewId || !frontierItem || frontierItem.status !== 'EXPLORED' || frontierItem.attemptId !== attempt.attemptId || strictClaim && (!attempt.claimToken || frontierItem.claimToken != null || frontierItem.claimedAttemptId != null) || hashObject(frontierItem.candidate) !== attempt.candidateHash || hashObject(attempt.candidate) !== attempt.candidateHash) fail(`Edge ${edge.id} Attempt is inconsistent`, 'GRAPH_INVALID');
      const targetState = graph.reachableStates.find(x => x.id === edge.toReachableStateId); const targetVisual = targetState && graph.visualStates.find(x => x.id === targetState.visualStateId); if (!targetVisual || targetVisual.kind !== attempt.outcomeKind) fail(`Edge ${edge.id} popup outcome kind is inconsistent`, 'GRAPH_INVALID');
      if (isCurrentRun(scan) && (!edge.verification?.transitionFingerprint || !['UNVERIFIED', 'COLD_REPLAY_VERIFIED', 'REPLAY_UNSTABLE', 'NONREPEATABLE', 'INVALIDATED'].includes(edge.verification.replayStatus))) fail(`Edge ${edge.id} has invalid current verification metadata`, 'GRAPH_INVALID');
      summary.observations.add(beforeObservationId); summary.observations.add(afterObservationId); summary.actions.add(actionResultId); summary.attempts.add(edge.attemptId);
    }
    summary.contexts[contextId] = { logicalScreens: graph.logicalScreens.length, visualStates: graph.visualStates.length, reachableStates: graph.reachableStates.length, edges: graph.edges.length, frontier: frontier.items.length };
    if (isCurrentRun(scan)) {
      const visualEquivalence = loadVisualEquivalence(scanDir, contextId);
      for (const rule of visualEquivalence.rules || []) {
        const state = graph.reachableStates.find(item => item.id === rule.reachableStateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
        if (rule.contextId !== contextId || !state || !visual || rule.visualStateId !== visual.id || rule.logicalScreenKey !== visual.logicalScreenKey || rule.layoutHash !== visual.fingerprint?.layoutHash || !['screenshotSha256'].every(item => (rule.allowedVariance || []).includes(item))) fail(`Visual equivalence rule ${rule.ruleId || '<missing>'} is invalid`, 'VISUAL_EQUIVALENCE_INVALID');
        if (!(rule.semanticAnchors?.requiredTexts || []).length && !(rule.semanticAnchors?.requiredIds || []).length) fail(`Visual equivalence rule ${rule.ruleId} has no semantic anchors`, 'VISUAL_EQUIVALENCE_INVALID');
      }
      const stateEquivalence = loadStateEquivalence(scanDir, contextId);
      for (const rule of stateEquivalence.rules || []) {
        const state = graph.reachableStates.find(item => item.id === rule.reachableStateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
        if (rule.contextId !== contextId || !state || !visual || rule.visualStateId !== visual.id || rule.logicalScreenKey !== visual.logicalScreenKey || !['screenshotSha256', 'layoutHash'].every(item => (rule.allowedVariance || []).includes(item))) fail(`State equivalence rule ${rule.ruleId || '<missing>'} is invalid`, 'STATE_EQUIVALENCE_INVALID');
        const anchors = rule.semanticAnchors || {};
        if (!(anchors.requiredTexts || []).length && !(anchors.requiredIds || []).length && !(anchors.requiredTitles || []).length && !(anchors.requiredTabs || []).length) fail(`State equivalence rule ${rule.ruleId} has no semantic anchors`, 'STATE_EQUIVALENCE_INVALID');
      }
      const cursor = loadCursor(scanDir, contextId); if (cursor.contextId !== contextId || !['EXACT', 'SOURCE_CONFIRMED', 'REVIEW_CONFIRMED', 'UNKNOWN'].includes(cursor.status)) fail('Live Cursor is invalid', 'CURSOR_INVALID'); if (['EXACT', 'SOURCE_CONFIRMED', 'REVIEW_CONFIRMED'].includes(cursor.status) && (!graph.reachableStates.some(item => item.id === cursor.reachableStateId) || !cursor.observationId)) fail('Cursor references missing state or observation', 'CURSOR_INVALID'); if (cursor.status === 'SOURCE_CONFIRMED' && cursor.equivalence?.type !== 'SOURCE_MATCH') fail('SOURCE_CONFIRMED Cursor lacks source match evidence', 'CURSOR_INVALID'); if (cursor.equivalence?.ruleId && ![...(visualEquivalence.rules || []), ...(stateEquivalence.rules || [])].some(rule => rule.ruleId === cursor.equivalence.ruleId)) fail('Cursor equivalence rule is missing', 'CURSOR_INVALID');
      const queue = loadVerificationQueue(scanDir, contextId); const duplicateKeys = queue.items.map(item => item.taskKey).filter((key, index, all) => all.indexOf(key) !== index); if (duplicateKeys.length) fail('Verification queue contains duplicate task keys', 'VERIFICATION_QUEUE_INVALID');
      const suggestions = readJson(path.join(contextDir(scanDir, contextId), 'frontier-suggestions.json'), { schemaVersion: 1, contextId, items: [] });
      const suggestionIds = suggestions.items.map(item => item.suggestionId).filter(Boolean); if (new Set(suggestionIds).size !== suggestionIds.length) fail('Frontier suggestions contain duplicate ids', 'FRONTIER_SUGGESTIONS_INVALID');
      for (const suggestion of suggestions.items || []) {
        if (suggestion.contextId && suggestion.contextId !== contextId || !['PENDING', 'APPLIED', 'SKIPPED', 'BLOCKED', 'DISMISSED'].includes(suggestion.status)) fail(`Frontier suggestion ${suggestion.suggestionId || '<missing>'} is invalid`, 'FRONTIER_SUGGESTIONS_INVALID');
        if (!graph.reachableStates.some(item => item.id === suggestion.reachableStateId) || !graph.visualStates.some(item => item.id === suggestion.visualStateId)) fail(`Frontier suggestion ${suggestion.suggestionId || '<missing>'} references missing graph state`, 'FRONTIER_SUGGESTIONS_INVALID');
        requireSuggestionObservation(scanDir, suggestion, contextId);
        if (suggestion.status === 'APPLIED' && !frontier.items.some(item => item.id === suggestion.frontierId)) fail(`Applied frontier suggestion ${suggestion.suggestionId || '<missing>'} references missing Frontier`, 'FRONTIER_SUGGESTIONS_INVALID');
      }
      if (completed && suggestions.items.some(item => item.status === 'PENDING')) fail('Run has pending frontier suggestions', 'RUN_INCOMPLETE');
      if (completed) {
        const dependencyBlocking = deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS });
        const pendingBackfillStateIds = backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking });
        if (pendingBackfillStateIds.length) fail(`Run has candidate backfill required: ${pendingBackfillStateIds.join(', ')}`, 'RUN_INCOMPLETE');
      }
      if (completed && queue.items.some(item => ['PENDING', 'RUNNING', 'FAILED'].includes(item.status))) fail('Run has unfinished or failed required verification tasks', 'RUN_INCOMPLETE');
      const metrics = options.metricsOverridesByContext?.[contextId] || readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {}); const categorized = ['explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'interruptionActions'].reduce((sum, key) => sum + Number(metrics[key] || 0), 0); if (categorized !== Number(metrics.actions || 0)) fail('Categorized action metrics do not equal total actions', 'METRICS_INVALID');
      const budget = runBudget(scan, contextId); const usage = budgetUsage(scan, graph, frontier, metrics); const limits = [['MAX_STATES', usage.states, maxStates(budget), { baselineStates: usage.baselineStates, totalStates: usage.totalStates }], ['MAX_DEVICE_ACTIONS', usage.actions, maxDeviceActions(budget)], ['MAX_COLD_STARTS', usage.coldStarts, maxColdStarts(budget)], ['MAX_ACTIVE_MINUTES', usage.durationMinutes, activeLimitMinutes(budget)], ['MAX_DEPTH', Math.max(0, ...graph.reachableStates.map(item => Number(item.depth?.pathDepth || 0))), maxDepth(budget)]]; const exceeded = limits.find(([code, used, limit]) => used > limit && (completed || code !== 'MAX_ACTIVE_MINUTES')); if (exceeded) fail(`${exceeded[0]} exceeded at terminal validation: ${exceeded[1]} > ${exceeded[2]}${exceeded[3] ? ` (baseline=${exceeded[3].baselineStates}, total=${exceeded[3].totalStates})` : ''}`, 'BUDGET_LIMIT_EXCEEDED');
    }
  }
  if (fs.existsSync(path.join(scanDir, 'attempts'))) for (const name of fs.readdirSync(path.join(scanDir, 'attempts')).filter(x => x.endsWith('.json'))) {
    const attempt = readJson(path.join(scanDir, 'attempts', name)); if (Number(scan.graphProtocolVersion || 1) >= 2 && attempt.candidate?.type === 'wait') fail(`Attempt ${attempt.attemptId} contains wait under current graph rules`, 'NON_GRAPH_ACTION'); if (completed && !['COMMITTED', 'COVERED_BY_EXISTING_EDGE', 'DISMISSED_NO_EDGE', 'NO_STATE_CHANGE', 'FAILED'].includes(attempt.status)) fail(`Attempt ${attempt.attemptId} is unfinished`, 'RUN_INCOMPLETE');
    if (attempt.status === 'COVERED_BY_EXISTING_EDGE') {
      const graph = loadGraph(scanDir, attempt.contextId); const edge = graph.edges.find(item => item.id === attempt.coveredEdgeId); const action = readJson(path.join(scanDir, 'evidence', 'actions', `${attempt.actionResultId}.json`)); const frontier = loadFrontier(scanDir, attempt.contextId); const item = frontier.items.find(entry => entry.id === attempt.frontierId); const actionIntent = action.actionIntent || intentFromAction(action.action);
      if (!edge || edge.fromReachableStateId !== attempt.fromReachableStateId || edge.toReachableStateId !== attempt.toReachableStateId || action.status !== 'SUCCEEDED' || action.attemptId !== attempt.attemptId || action.beforeObservationId !== attempt.beforeObservationId || hashObject(canonicalIntentIdentity(actionIntent)) !== hashObject(canonicalIntentIdentity(edge.intent)) || !item || item.status !== 'COVERED_BY_GROUP' || item.reasonCode !== 'DUPLICATE_EDGE' || item.coveredEdgeId !== edge.id || item.attemptId !== attempt.attemptId || strictClaim && (!attempt.claimToken || item.claimToken != null || item.claimedAttemptId != null) || hashObject(item.candidate) !== attempt.candidateHash) fail(`Attempt ${attempt.attemptId} duplicate Edge coverage is inconsistent`, 'ATTEMPT_CAUSALITY_INVALID');
      requireObservation(scanDir, attempt.beforeObservationId, attempt.contextId); requireObservation(scanDir, attempt.afterObservationId, attempt.contextId);
      if (visualReviewRequired) assertAcceptedVisualReview(scanDir, { visualReviewId: attempt.visualReviewId, contextId: attempt.contextId, observationId: attempt.afterObservationId, reviewType: 'PAGE_OUTCOME' });
      summary.observations.add(attempt.beforeObservationId); summary.observations.add(attempt.afterObservationId); summary.actions.add(attempt.actionResultId); summary.attempts.add(attempt.attemptId);
    }
    if (attempt.status === 'NO_STATE_CHANGE') {
      const comparison = compareObservations(scanDir, attempt.beforeObservationId, attempt.afterObservationId, attempt.contextId); const action = readJson(path.join(scanDir, 'evidence', 'actions', `${attempt.actionResultId}.json`)); const frontier = loadFrontier(scanDir, attempt.contextId); const item = frontier.items.find(entry => entry.id === attempt.frontierId);
      if (comparison !== 'EXACT' || attempt.noStateChange?.comparison !== 'EXACT' || attempt.noStateChange?.beforeObservationId !== attempt.beforeObservationId || attempt.noStateChange?.afterObservationId !== attempt.afterObservationId || action.status !== 'SUCCEEDED' || action.attemptId !== attempt.attemptId || action.beforeObservationId !== attempt.beforeObservationId || (action.candidateHash || hashObject(action.action)) !== attempt.candidateHash || !item || item.status !== 'EXPLORED' || item.reasonCode !== 'NO_STATE_CHANGE' || item.attemptId !== attempt.attemptId || strictClaim && (!attempt.claimToken || item.claimToken != null || item.claimedAttemptId != null) || hashObject(item.candidate) !== attempt.candidateHash) fail(`Attempt ${attempt.attemptId} NO_STATE_CHANGE evidence is inconsistent`, 'ATTEMPT_CAUSALITY_INVALID');
      if (visualReviewRequired) assertAcceptedVisualReview(scanDir, { visualReviewId: attempt.visualReviewId, contextId: attempt.contextId, observationId: attempt.afterObservationId, reviewType: 'PAGE_OUTCOME' });
      summary.observations.add(attempt.beforeObservationId); summary.observations.add(attempt.afterObservationId); summary.actions.add(attempt.actionResultId); summary.attempts.add(attempt.attemptId);
    }
    if (attempt.status === 'DISMISSED_NO_EDGE') {
      const action = readJson(path.join(scanDir, 'evidence', 'actions', `${attempt.actionResultId}.json`)); const frontier = loadFrontier(scanDir, attempt.contextId); const item = frontier.items.find(entry => entry.id === attempt.frontierId); const cleanup = (attempt.interruptions || []).at(-1);
      if (!attempt.beforeObservationId || !attempt.afterObservationId || action.status !== 'SUCCEEDED' || action.attemptId !== attempt.attemptId || action.beforeObservationId !== attempt.beforeObservationId || (action.candidateHash || hashObject(action.action)) !== attempt.candidateHash || !cleanup?.afterObservationId || compareObservations(scanDir, attempt.beforeObservationId, cleanup.afterObservationId, attempt.contextId) !== 'EXACT' || !item || item.status !== 'EXPLORED' || item.reasonCode !== 'DISMISSIBLE_POPUP' || item.attemptId !== attempt.attemptId || strictClaim && (!attempt.claimToken || item.claimToken != null || item.claimedAttemptId != null) || hashObject(item.candidate) !== attempt.candidateHash) fail(`Attempt ${attempt.attemptId} DISMISSED_NO_EDGE evidence is inconsistent`, 'ATTEMPT_CAUSALITY_INVALID');
      if (visualReviewRequired) assertAcceptedVisualReview(scanDir, { visualReviewId: attempt.visualReviewId, contextId: attempt.contextId, observationId: cleanup.beforeObservationId, reviewType: 'PAGE_OUTCOME' });
      summary.observations.add(attempt.beforeObservationId); summary.observations.add(attempt.afterObservationId); summary.observations.add(cleanup.afterObservationId); summary.actions.add(attempt.actionResultId); summary.attempts.add(attempt.attemptId);
    }
    if (attempt.status === 'FAILED') { const frontier = loadFrontier(scanDir, attempt.contextId); const item = frontier.items.find(entry => entry.id === attempt.frontierId); if (item?.status === 'CLAIMED' || item?.claimedAttemptId === attempt.attemptId) fail(`Failed Attempt ${attempt.attemptId} still owns its frontier`, 'ATTEMPT_CAUSALITY_INVALID'); }
    for (const restore of attempt.restoreResults || []) validateRestoreResult(scanDir, restore, attempt);
    for (const interruption of attempt.interruptions || []) requirePopupInterruption(scanDir, interruption, attempt.contextId, 'ATTEMPT', attempt.attemptId);
    for (const check of attempt.stabilityChecks || []) { if (check.observationId) requireObservation(scanDir, check.observationId, attempt.contextId); if (check.beforeObservationId) requireObservation(scanDir, check.beforeObservationId, attempt.contextId); if (check.afterObservationId) requireObservation(scanDir, check.afterObservationId, attempt.contextId); }
  }
  if (completed && scan.scanMode === 'goal-directed') {
    const result = readJson(path.join(scanDir, 'goal', 'match-result.json')); const paths = readJson(path.join(scanDir, 'goal', 'verified-paths.json'));
    if (result.status !== 'FOUND_VERIFIED' || !paths.paths.some(x => x.verificationStatus === 'VERIFIED')) fail('Goal Run may complete only with a strongly verified path', 'GOAL_NOT_VERIFIED');
  }
  return { schemaVersion: 1, ok: true, requestedStatus, scanId: scan.scanId, contexts: summary.contexts, evidence: { observations: summary.observations.size, actions: summary.actions.size, attempts: summary.attempts.size }, executionClosure };
}

if (require.main === module) main(() => { const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); output(validate(scanDir, String(args.status || 'COMPLETED').toUpperCase())); });

module.exports = { validate };

'use strict';

const fs = require('fs');
const path = require('path');
const { evaluate } = require('./goal-matcher');
const { readJson, now, nextId, commitEvent, transitionWithOps, hashObject, fail } = require('./common');

const MAX_REVIEW_CANDIDATES = 3;

function appRootFromScanDir(scanDir) {
  return path.dirname(path.dirname(scanDir));
}

function observationFiles(baseScanDir, observationId) {
  const dir = path.join(baseScanDir, 'evidence', 'observations', observationId);
  return {
    observationFile: path.join(dir, 'observation.json'),
    layoutFile: path.join(dir, 'layout.json'),
    screenshotFile: path.join(dir, 'screenshot.png')
  };
}

function observationExists(baseScanDir, observationId) {
  const files = observationFiles(baseScanDir, observationId);
  return fs.existsSync(files.observationFile) && fs.existsSync(files.layoutFile) && fs.existsSync(files.screenshotFile);
}

function loadObservationLayout(baseScanDir, observationId) {
  const observation = readJson(path.join(baseScanDir, 'evidence', 'observations', observationId, 'observation.json'));
  const layout = readJson(path.join(baseScanDir, observation.layoutPath || path.join('evidence', 'observations', observationId, 'layout.json')));
  return { observation, layout };
}

function latestObservationRef({ scanDir, scan, visualState }) {
  const local = [...(visualState.evidenceObservationIds || [])].reverse().find(id => observationExists(scanDir, id));
  if (local) return { evidenceSource: 'LOCAL_RUN', baseScanDir: scanDir, observationId: local, observationRef: { runId: scan.scanId, observationId: local } };
  const appRoot = appRootFromScanDir(scanDir);
  for (const ref of [...(visualState.evidenceObservationRefs || [])].reverse()) {
    if (!ref?.runId || !ref?.observationId) continue;
    const baseScanDir = path.join(appRoot, 'runs', String(ref.runId));
    if (observationExists(baseScanDir, String(ref.observationId))) return { evidenceSource: 'CANONICAL_REF', baseScanDir, observationId: String(ref.observationId), observationRef: { runId: String(ref.runId), observationId: String(ref.observationId) } };
  }
  return null;
}

function hasRunnablePath(state = {}) {
  return (state.depth?.pathDepth || 0) === 0 || (state.runnablePathEdgeIds || state.replayPathEdgeIds || []).length > 0;
}

function assessmentForGoal(goal) {
  return goal.referenceScreenshotSha256 ? { status: 'UNCERTAIN', source: 'KNOWN_MAP_PRECHECK' } : { status: 'STRONG', source: 'KNOWN_MAP_PRECHECK' };
}

function precheckCandidates({ scanDir, scan, graph, goal }) {
  const candidates = [];
  const visuals = new Map((graph.visualStates || []).map(item => [item.id, item]));
  const logical = new Map((graph.logicalScreens || []).map(item => [item.id, item]));
  for (const state of graph.reachableStates || []) {
    if (!hasRunnablePath(state)) continue;
    const visualState = visuals.get(state.visualStateId);
    if (!visualState) continue;
    const ref = latestObservationRef({ scanDir, scan, visualState });
    if (!ref) continue;
    const { layout } = loadObservationLayout(ref.baseScanDir, ref.observationId);
    const match = evaluate(goal, layout, assessmentForGoal(goal));
    if (!['CANDIDATE_STRONG', 'CANDIDATE_UNCERTAIN'].includes(match.status)) continue;
    const logicalScreen = logical.get(visualState.logicalScreenKey) || null;
    const edgeIds = state.runnablePathEdgeIds || state.replayPathEdgeIds || [];
    const transitionFingerprints = edgeIds.map(id => (graph.edges || []).find(edge => edge.id === id)?.verification?.transitionFingerprint || hashObject({ edgeId: id }));
    candidates.push({
      status: match.status,
      candidateStrength: match.status === 'CANDIDATE_STRONG' ? 'STRONG' : 'UNCERTAIN',
      reachableStateId: state.id,
      visualStateId: visualState.id,
      logicalScreenKey: visualState.logicalScreenKey || null,
      logicalScreenName: logicalScreen?.name || visualState.name || visualState.logicalScreenKey || null,
      observationId: ref.observationId,
      observationRef: ref.observationRef,
      evidenceSource: ref.evidenceSource,
      edgeIds,
      transitionFingerprints,
      pathDepth: Number(state.depth?.pathDepth || 0),
      evidence: match.evidence
    });
  }
  return candidates.sort((a, b) => (a.status === 'CANDIDATE_STRONG' ? 0 : 1) - (b.status === 'CANDIDATE_STRONG' ? 0 : 1)
    || a.pathDepth - b.pathDepth
    || String(a.logicalScreenName || '').localeCompare(String(b.logicalScreenName || ''))
    || String(a.reachableStateId).localeCompare(String(b.reachableStateId)));
}

function hasExplicitRoute(goal = {}) {
  return (goal.guideSpec?.routeHints || []).filter(Boolean).length > 0;
}

function missingRequiredCount(candidate = {}) {
  return (candidate.evidence?.missingRequiredTexts || []).length;
}

function candidateReviewPolicy(candidate, goal) {
  if (candidate.status === 'CANDIDATE_STRONG') return { reviewable: true, reasonCode: null };
  if (hasExplicitRoute(goal) && missingRequiredCount(candidate) > 0) return { reviewable: false, reasonCode: 'UNCERTAIN_MISSING_REQUIRED_TEXT_WITH_ROUTE_HINT' };
  return { reviewable: true, reasonCode: null };
}

function splitReviewableCandidates(candidates, goal) {
  const reviewable = [];
  const suppressed = [];
  for (const candidate of candidates) {
    const policy = candidateReviewPolicy(candidate, goal);
    if (!policy.reviewable) suppressed.push({ ...candidate, suppressedReasonCode: policy.reasonCode });
    else reviewable.push(candidate);
  }
  const selected = reviewable.slice(0, MAX_REVIEW_CANDIDATES);
  for (const candidate of reviewable.slice(MAX_REVIEW_CANDIDATES)) suppressed.push({ ...candidate, suppressedReasonCode: 'KNOWN_MAP_PRECHECK_REVIEW_LIMIT' });
  return { reviewable: selected, suppressed };
}

function suppressedSummary(candidates = []) {
  return candidates.map(candidate => ({
    status: candidate.status,
    candidateStrength: candidate.candidateStrength,
    suppressedReasonCode: candidate.suppressedReasonCode,
    reachableStateId: candidate.reachableStateId,
    visualStateId: candidate.visualStateId,
    logicalScreenKey: candidate.logicalScreenKey,
    logicalScreenName: candidate.logicalScreenName,
    observationRef: candidate.observationRef,
    evidenceSource: candidate.evidenceSource,
    evidence: {
      requiredMatches: candidate.evidence?.requiredMatches || [],
      missingRequiredTexts: candidate.evidence?.missingRequiredTexts || [],
      optionalMatches: candidate.evidence?.optionalMatches || [],
      anchorMatches: candidate.evidence?.anchorMatches || []
    }
  }));
}

function loadGoalResult(scanDir) {
  return readJson(path.join(scanDir, 'goal', 'match-result.json'), null);
}

function validatePrecheckScope({ scan, graph, goal, result }) {
  if (graph.contextId !== scan.contextId) fail('Known target precheck graph context must match Run contextId', 'CONTEXT_INVALID');
  if (goal.contextId !== scan.contextId) fail('Known target precheck goal context must match Run contextId', 'CONTEXT_INVALID');
  if (!result || result.status !== 'SEARCHING') fail('Known target precheck requires goal result SEARCHING', 'GOAL_PRECHECK_STATE_INVALID');
}

function shouldRunKnownTargetPrecheck({ scanDir, scan }) {
  if (scan.scanMode !== 'goal-directed' || scan.status !== 'SCANNING') return false;
  const goal = readJson(path.join(scanDir, 'goal', 'goal.json'), null);
  if (!goal?.resultPolicy?.verifyKnownPathFirst) return false;
  const result = loadGoalResult(scanDir);
  if (!result || result.status !== 'SEARCHING') return false;
  if (result.knownMapPrecheck?.status) return false;
  return true;
}

function knownTargetPrecheckWork({ scanDir, scan }) {
  if (!shouldRunKnownTargetPrecheck({ scanDir, scan })) return null;
  return {
    decision: 'GOAL_KNOWN_TARGET_PRECHECK',
    reasonCode: 'VERIFY_KNOWN_PATH_FIRST',
    phaseLabel: '已知地图目标预检',
    explanation: '目标模式会先检查当前 seed map 是否已有疑似目标页；这是预检候选，不是最终目标验证。',
    fallbackAfterRejection: '候选被拒绝或未强命中时，会继续按用户提供的参考路径和页面证据做目标引导探索。',
    suggestedCommand: { command: 'goal-precheck.js', args: ['evaluate', '--scan-dir', scanDir] }
  };
}

function decisionFromCandidate(candidate, decisionId, createdAt) {
  return {
    decisionId,
    source: 'KNOWN_MAP_PRECHECK',
    status: candidate.status,
    candidateStrength: candidate.candidateStrength,
    observationId: candidate.observationId,
    observationRef: candidate.observationRef,
    evidenceSource: candidate.evidenceSource,
    visualStateId: candidate.visualStateId,
    reachableStateId: candidate.reachableStateId,
    logicalScreenKey: candidate.logicalScreenKey,
    logicalScreenName: candidate.logicalScreenName,
    pathId: `known-map-${decisionId}`,
    edgeIds: candidate.edgeIds,
    transitionFingerprints: candidate.transitionFingerprints,
    evidence: candidate.evidence,
    humanDecision: 'PENDING',
    createdAt
  };
}

function selectDecision(result, decision) {
  result.status = 'AWAITING_HUMAN_CONFIRMATION';
  result.matchedVisualStateId = decision.visualStateId;
  result.matchedReachableStateId = decision.reachableStateId;
  result.evidenceObservationId = decision.observationId;
  result.knownMapPrecheck = {
    ...(result.knownMapPrecheck || {}),
    status: 'CANDIDATE_FOUND',
    selectedDecisionId: decision.decisionId,
    exhausted: false
  };
}

function applyKnownTargetPrecheck({ scanDir, scan, graph }) {
  if (scan.scanMode !== 'goal-directed') fail('Known target precheck requires goal-directed Run', 'GOAL_MODE_REQUIRED');
  if (scan.status !== 'SCANNING') fail('Known target precheck requires SCANNING status', 'RUN_STATE_INVALID');
  const goal = readJson(path.join(scanDir, 'goal', 'goal.json'));
  const result = readJson(path.join(scanDir, 'goal', 'match-result.json'));
  validatePrecheckScope({ scan, graph, goal, result });
  if (!goal.resultPolicy?.verifyKnownPathFirst) return { applied: false, reasonCode: 'VERIFY_KNOWN_PATH_FIRST_DISABLED', result };
  if (result.knownMapPrecheck?.status) return { applied: false, reasonCode: 'KNOWN_MAP_PRECHECK_ALREADY_DONE', result };
  const candidates = precheckCandidates({ scanDir, scan, graph, goal });
  const { reviewable, suppressed } = splitReviewableCandidates(candidates, goal);
  const checkedAt = now();
  if (!reviewable.length) {
    result.knownMapPrecheck = { status: 'NO_MATCH', checkedAt, candidateCount: candidates.length, reviewCandidateCount: 0, suppressedCandidateCount: suppressed.length, suppressedCandidates: suppressedSummary(suppressed) };
    commitEvent(scanDir, 'goalKnownMapPrecheckCompleted', { goalId: goal.goalId, status: result.knownMapPrecheck.status, candidateCount: candidates.length, reviewCandidateCount: 0, suppressedCandidateCount: suppressed.length }, [{ path: 'goal/match-result.json', op: 'REPLACE', value: result }]);
    return { applied: true, found: false, candidates: reviewable, suppressedCandidates: suppressed, result };
  }
  const decisions = reviewable.map(candidate => decisionFromCandidate(candidate, nextId(scanDir, 'goalDecision', 'goal-decision'), checkedAt));
  result.candidateDecisionIds = result.candidateDecisionIds || [];
  result.decisions = result.decisions || [];
  for (const decision of decisions) {
    result.candidateDecisionIds.push(decision.decisionId);
    result.decisions.push(decision);
  }
  const decision = decisions[0];
  result.knownMapPrecheck = { status: 'CANDIDATE_FOUND', checkedAt, candidateCount: candidates.length, reviewCandidateCount: reviewable.length, suppressedCandidateCount: suppressed.length, suppressedCandidates: suppressedSummary(suppressed), candidateDecisionIds: decisions.map(item => item.decisionId), selectedDecisionId: decision.decisionId, exhausted: false };
  selectDecision(result, decision);
  transitionWithOps(scanDir, 'PAUSED', 'GOAL_CANDIDATE_REVIEW', 'goalKnownMapCandidateFound', { goalId: goal.goalId, decisionId: decision.decisionId, candidateCount: candidates.length, reviewCandidateCount: reviewable.length, suppressedCandidateCount: suppressed.length, reachableStateId: decision.reachableStateId }, [{ path: 'goal/match-result.json', op: 'REPLACE', value: result }]);
  return { applied: true, found: true, decision, decisions, candidates: reviewable, suppressedCandidates: suppressed, result };
}

function advanceKnownMapPrecheckAfterReject({ result, rejectedDecision, decidedAt = now() }) {
  if (rejectedDecision.source !== 'KNOWN_MAP_PRECHECK') return { advanced: false, exhausted: false, nextDecision: null };
  const nextDecision = (result.decisions || []).find(decision => decision.source === 'KNOWN_MAP_PRECHECK' && decision.humanDecision === 'PENDING');
  if (nextDecision) {
    selectDecision(result, nextDecision);
    return { advanced: true, exhausted: false, nextDecision };
  }
  result.status = 'SEARCHING';
  result.matchedVisualStateId = null;
  result.matchedReachableStateId = null;
  result.evidenceObservationId = null;
  result.knownMapPrecheck = {
    ...(result.knownMapPrecheck || {}),
    status: 'EXHAUSTED',
    exhausted: true,
    exhaustedAt: decidedAt,
    selectedDecisionId: null
  };
  return { advanced: true, exhausted: true, nextDecision: null };
}

module.exports = { precheckCandidates, shouldRunKnownTargetPrecheck, knownTargetPrecheckWork, applyKnownTargetPrecheck, advanceKnownMapPrecheckAfterReject };

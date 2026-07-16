#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, readJson, writeJsonAtomic, nextId, now, event, commitEvent, transition, loadFrontier, output, main, fail, jsonArg, sha256, hashObject } = require('./lib/common');
const { evaluate } = require('./lib/goal-matcher');
const { targetVerificationProjection, queueUpsertOp } = require('./lib/verification-store');

main(() => {
  const args = parseArgs(); const command = args._[0] || 'evaluate'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.scanMode !== 'goal-directed') fail('Not a goal-directed Run', 'GOAL_MODE_REQUIRED'); const goalDir = path.join(scanDir, 'goal'); const goal = readJson(path.join(goalDir, 'goal.json')); const result = readJson(path.join(goalDir, 'match-result.json'));
  if (command === 'evaluate') {
    if (scan.status !== 'SCANNING') fail('Goal evaluation requires SCANNING status', 'RUN_STATE_INVALID'); const observationId = required(args, 'observationId');
    const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json')); const layout = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'layout.json'));
    if (observation.contextId !== goal.contextId || observation.captureStatus !== 'COMPLETE') fail('Goal observation belongs to another context or is incomplete', 'CONTEXT_EVIDENCE_INVALID');
    const graph = require('./lib/common').loadGraph(scanDir, goal.contextId); const reachableStateId = required(args, 'reachableStateId'); const state = graph.reachableStates.find(x => x.id === reachableStateId); if (!state) fail('Goal candidate ReachableState is missing', 'GRAPH_REFERENCE_MISSING');
    const visual = graph.visualStates.find(x => x.id === state.visualStateId); if (!visual?.evidenceObservationIds?.includes(observationId)) fail('Goal candidate observation is not evidence of the ReachableState', 'GOAL_EVIDENCE_INVALID');
    if (observation.foreground.bundleName && observation.foreground.bundleName !== scan.target.bundleName) return output({ schemaVersion: 1, ok: true, status: 'NOT_MATCHED', reasonCode: 'APP_LEFT_FOREGROUND' });
    const assessment = jsonArg(required(args, 'visualAssessment'), null, 'visualAssessment JSON');
    if (!['STRONG', 'UNCERTAIN', 'NO_MATCH'].includes(assessment.status) || assessment.referenceSha256 !== goal.referenceScreenshotSha256 || assessment.observedSha256 !== sha256(require('fs').readFileSync(path.join(scanDir, observation.screenshotPath)))) fail('Visual assessment must bind the reference and observed screenshots by SHA-256', 'GOAL_VISUAL_ASSESSMENT_INVALID');
    const match = evaluate(goal, layout, assessment);
    if (!['CANDIDATE_STRONG', 'CANDIDATE_UNCERTAIN'].includes(match.status)) return output({ schemaVersion: 1, ok: true, ...match });
    const decisionId = nextId(scanDir, 'goalDecision', 'goal-decision'); const decision = { decisionId, status: match.status, candidateStrength: match.status === 'CANDIDATE_STRONG' ? 'STRONG' : 'UNCERTAIN', observationId, visualStateId: state.visualStateId, reachableStateId, pathId: args.pathId || null, evidence: { ...match.evidence, visualAssessment: assessment }, humanDecision: 'PENDING', createdAt: now() };
    result.status = 'AWAITING_HUMAN_CONFIRMATION'; result.matchedVisualStateId = decision.visualStateId; result.matchedReachableStateId = decision.reachableStateId; result.evidenceObservationId = observationId; result.candidateDecisionIds.push(decisionId); result.decisions.push(decision); writeJsonAtomic(path.join(goalDir, 'match-result.json'), result);
    if (args.frontierId) { const frontier = loadFrontier(scanDir, goal.contextId); const item = frontier.items.find(x => x.id === args.frontierId); if (!item || item.status !== 'EXPLORED') fail('Goal candidate frontier must already be committed or otherwise explored', 'GOAL_FRONTIER_INVALID'); decision.frontierId = item.id; writeJsonAtomic(path.join(goalDir, 'match-result.json'), result); }
    event(scanDir, 'goalMatchCandidate', { goalId: goal.goalId, decisionId, status: match.status, observationId }); event(scanDir, 'goalConfirmationRequested', { goalId: goal.goalId, decisionId }); transition(scanDir, 'PAUSED', 'GOAL_CANDIDATE_REVIEW');
    return output({ schemaVersion: 1, ok: true, ...match, decision, runStatus: 'PAUSED' });
  }
  if (command === 'decide') {
    if (scan.status !== 'PAUSED') fail('Human decision requires PAUSED status', 'RUN_STATE_INVALID'); const decisionId = required(args, 'decisionId'); const decision = result.decisions.find(x => x.decisionId === decisionId); if (!decision) fail('Goal decision not found', 'GOAL_DECISION_NOT_FOUND');
    if (decision.humanDecision !== 'PENDING') fail('Goal decision is immutable after it is decided', 'GOAL_DECISION_FINAL');
    const humanDecision = required(args, 'humanDecision').toUpperCase(); if (!['CONFIRMED_TARGET', 'REJECTED', 'DEFERRED'].includes(humanDecision)) fail('Invalid humanDecision', 'GOAL_DECISION_INVALID');
    if (humanDecision === 'REJECTED') { decision.humanDecision = humanDecision; decision.decidedAt = now(); result.status = 'SEARCHING'; event(scanDir, 'goalCandidateRejected', { goalId: goal.goalId, decisionId }); writeJsonAtomic(path.join(goalDir, 'match-result.json'), result); transition(scanDir, 'SCANNING'); }
    else if (humanDecision === 'CONFIRMED_TARGET') { decision.humanDecision = humanDecision; decision.decidedAt = now(); result.status = 'CONFIRMED_PENDING_REPLAY'; const graph = require('./lib/common').loadGraph(scanDir, goal.contextId); const state = graph.reachableStates.find(item => item.id === decision.reachableStateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId); const edgeIds = state?.replayPathEdgeIds || []; const transitionFingerprints = edgeIds.map(id => graph.edges.find(edge => edge.id === id)?.verification?.transitionFingerprint || hashObject({ edgeId: id })); const projection = targetVerificationProjection(scanDir, goal.contextId, { decisionId, logicalScreenKey: visual?.logicalScreenKey || null, terminalReachableStateId: decision.reachableStateId, edgeIds, transitionFingerprints }); const verification = projection.item; decision.verificationId = verification.verificationId; commitEvent(scanDir, 'verificationScheduled', { contextId: goal.contextId, goalId: goal.goalId, decisionId, verification }, [queueUpsertOp(goal.contextId, verification), { path: 'goal/match-result.json', op: 'REPLACE', value: result }]); event(scanDir, 'goalCandidateConfirmed', { goalId: goal.goalId, decisionId, verificationId: verification.verificationId }); }
    else { decision.deferredAt = now(); event(scanDir, 'goalCandidateDeferred', { goalId: goal.goalId, decisionId }); writeJsonAtomic(path.join(goalDir, 'match-result.json'), result); }
    return output({ schemaVersion: 1, ok: true, decision, resultStatus: result.status, runStatus: loadScan(scanDir).status });
  }
  if (command === 'update-policy') {
    if (scan.status !== 'PAUSED') fail('Goal policy can only be updated while PAUSED', 'RUN_STATE_INVALID');
    const next = Number(required(args, 'maxVerifiedPaths')); if (!Number.isInteger(next) || next < goal.resultPolicy.maxVerifiedPaths) fail('maxVerifiedPaths may only be increased', 'GOAL_POLICY_INVALID');
    goal.resultPolicy.maxVerifiedPaths = next; writeJsonAtomic(path.join(goalDir, 'goal.json'), goal); event(scanDir, 'budgetUpdated', { goalId: goal.goalId, maxVerifiedPaths: next });
    return output({ schemaVersion: 1, ok: true, resultPolicy: goal.resultPolicy });
  }
  if (command === 'continue-search') {
    if (scan.status !== 'PAUSED') fail('Continue-search requires PAUSED status', 'RUN_STATE_INVALID'); const verified = readJson(path.join(goalDir, 'verified-paths.json'));
    if (verified.paths.length >= goal.resultPolicy.maxVerifiedPaths) fail('Increase maxVerifiedPaths before continuing', 'GOAL_PATH_LIMIT');
    result.status = 'SEARCHING'; writeJsonAtomic(path.join(goalDir, 'match-result.json'), result); transition(scanDir, 'SCANNING');
    return output({ schemaVersion: 1, ok: true, runStatus: 'SCANNING', verifiedPathCount: verified.paths.length, maxVerifiedPaths: goal.resultPolicy.maxVerifiedPaths });
  }
  fail(`Unknown evaluate-goal command: ${command}`, 'COMMAND_INVALID');
});

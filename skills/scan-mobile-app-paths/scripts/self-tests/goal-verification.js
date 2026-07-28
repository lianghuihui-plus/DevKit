#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyGoalReplay } = require('../lib/goal-verification-result');
const { counterSeedFromCanonical } = require('../lib/canonical-map-store');
const { buildGoalSpecFromArgs, goalPlanFromSpec } = require('../lib/goal-spec');
const { evaluate } = require('../lib/goal-matcher');
const { completedStopReasons } = require('../lib/finalization-guard');
const { modeForScan, scanScopeForMode, verificationRuleForMode, recommendedProfileForMode } = require('../lib/modes');
const { knownTargetPrecheckWork, applyKnownTargetPrecheck } = require('../lib/goal-known-target-precheck');
const { verificationUnresolvedItems } = require('../lib/finalization-unresolved');

let tests = 0;
function check(value, expected) {
  assert.deepEqual(value, expected);
  tests += 1;
}

function runScript(script, args, allowFailure = false) {
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', script), ...args], { encoding: 'utf8' });
  if (!allowFailure && child.status !== 0) throw new Error(`${script} failed: ${child.stderr || child.stdout}`);
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, json: child.stdout ? JSON.parse(child.stdout) : null };
}

function task() {
  return {
    verificationId: 'verify-goal',
    terminalReachableStateId: 'rs-target',
    edgeIds: ['edge-a', 'edge-b'],
    transitionFingerprints: ['fp-a', 'fp-b']
  };
}

function graph({ supersede = false } = {}) {
  return {
    edges: [
      { id: 'edge-a', verification: { transitionFingerprint: supersede ? 'fp-old' : 'fp-a' } },
      { id: 'edge-b', verification: { transitionFingerprint: 'fp-b' } }
    ]
  };
}

const semanticallyVerifiedRestore = {
  status: 'SUCCEEDED',
  reachableStateId: 'rs-target',
  fixedEdgeIds: ['edge-a', 'edge-b'],
  fixedTransitionFingerprints: ['fp-a', 'fp-b'],
  steps: [
    { edgeId: 'edge-a', verificationStatus: 'SAME_PAGE', afterObservationId: 'obs-a' },
    { edgeId: 'edge-b', verificationStatus: 'PROBABLE', afterObservationId: 'obs-b' }
  ],
  equivalenceReviews: [{ status: 'EXPECTED_STATE_EQUIVALENT', observationId: 'obs-b' }]
};

const goalMiss = classifyGoalReplay({ task: task(), graph: graph(), restored: semanticallyVerifiedRestore, childStatus: 0, matchStatus: 'NO_MATCH' });
check(goalMiss.pathReplayVerified, true);
check(goalMiss.goalVerified, false);
check(goalMiss.pathReplayStatus, 'COLD_REPLAY_VERIFIED');
check(goalMiss.reasonCode, 'GOAL_REPLAY_NOT_STRONG');
check(goalMiss.failure, null);

const goalHit = classifyGoalReplay({ task: task(), graph: graph(), restored: semanticallyVerifiedRestore, childStatus: 0, matchStatus: 'CANDIDATE_STRONG' });
check(goalHit.pathReplayVerified, true);
check(goalHit.goalVerified, true);
check(goalHit.reasonCode, null);

const branchFailure = classifyGoalReplay({
  task: task(),
  graph: graph(),
  restored: {
    status: 'FAILED',
    restoreId: 'restore-1',
    reasonCode: 'STEP_MISMATCH',
    actionsReplayed: 1,
    steps: [{ edgeId: 'edge-a', verificationStatus: 'EXACT' }]
  },
  childStatus: 1,
  matchStatus: null
});
check(branchFailure.pathReplayVerified, false);
check(branchFailure.failure.blockingEdgeIds, ['edge-b']);
check(branchFailure.failure.scope, 'BRANCH_EDGE_BLOCKED');

const superseded = classifyGoalReplay({ task: task(), graph: graph({ supersede: true }), restored: semanticallyVerifiedRestore, childStatus: 0, matchStatus: 'CANDIDATE_STRONG' });
check(superseded.pathReplayStatus, 'SUPERSEDED');
check(superseded.failure, null);

check(counterSeedFromCanonical({ contextId: 'guest', backCapabilities: { items: [{ backCapabilityId: 'back-0003' }] } }).backCapability, 3);
check(counterSeedFromCanonical({ contextId: 'guest', backCapabilities: { items: [{ backCapabilityId: 'backcap-0007' }, { backCapabilityId: 'back-0003' }] } }).backCapability, 7);

const semanticGoal = buildGoalSpecFromArgs({
  goalSpec: JSON.stringify({
    description: '账号与安全页面',
    guide: { routeHints: ['首页', '我的', '设置', '账号与安全'], preferredTexts: ['我的', '设置', '账号', '安全'] },
    target: { requiredTexts: ['账号与安全'], optionalTexts: ['修改密码'], forbiddenTexts: ['订单详情'] }
  })
}, 'authenticated').goal;
check(semanticGoal.inputKind, 'guided-semantic');
check(semanticGoal.referenceScreenshotSha256, null);
check(goalPlanFromSpec(semanticGoal).targetSpec.requiredTexts, ['账号与安全']);
check(evaluate(semanticGoal, { children: [{ text: '账号与安全' }, { text: '修改密码' }] }, { status: 'STRONG' }).status, 'CANDIDATE_STRONG');
check(evaluate(semanticGoal, { children: [{ text: '账号' }] }, { status: 'STRONG' }).status, 'CANDIDATE_UNCERTAIN');
check(evaluate(semanticGoal, { children: [{ text: '账号与安全' }, { text: '订单详情' }] }, { status: 'STRONG' }).status, 'NOT_MATCHED');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-goal-spec-'));
const targetPng = path.join(temp, 'target.png');
fs.writeFileSync(targetPng, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
const screenshotGoal = buildGoalSpecFromArgs({ description: '截图目标', screenshot: targetPng, successCriteria: JSON.stringify({ requiredTexts: ['目标页'] }) }, 'guest').goal;
check(screenshotGoal.inputKind, 'guided-screenshot');
check(screenshotGoal.referenceScreenshotSha256.startsWith('sha256:'), true);
check([...completedStopReasons({ scanMode: 'goal-directed' })], ['GOAL_FOUND_VERIFIED']);
check([...completedStopReasons({ scanMode: 'exploration' })], ['WORK_EMPTY']);
check(scanScopeForMode('goal-directed'), 'targeted');
check(verificationRuleForMode('exploration'), 'CANONICAL_SCREEN_PATH');
check(recommendedProfileForMode('goal-directed'), 'goal');
check(modeForScan({ scanMode: 'exploration' }).preNextWork({}), null);

const appRoot = path.join(temp, 'app-map');
const scanDir = path.join(appRoot, 'runs', 'scan-precheck');
const contextId = 'authenticated';
fs.mkdirSync(path.join(scanDir, 'contexts', contextId), { recursive: true });
fs.mkdirSync(path.join(scanDir, 'goal'), { recursive: true });
fs.mkdirSync(path.join(scanDir, 'evidence', 'observations', 'obs-known-a'), { recursive: true });
fs.mkdirSync(path.join(scanDir, 'evidence', 'observations', 'obs-known-b'), { recursive: true });
fs.mkdirSync(path.join(scanDir, 'evidence', 'observations', 'obs-known-c'), { recursive: true });
fs.writeFileSync(path.join(appRoot, 'app.json'), JSON.stringify({ schemaVersion: 1, bundleName: 'com.example.goal', environment: 'test' }));
const precheckScan = {
  schemaVersion: 3,
  scanId: 'scan-precheck',
  parentScanId: null,
  mapRevisionId: 'scan-precheck',
  mapBaseRevisionId: null,
  status: 'SCANNING',
  reasonCode: null,
  scanMode: 'goal-directed',
  scanScope: 'targeted',
  graphProtocolVersion: 4,
  attemptProtocolVersion: 4,
  eventProtocolVersion: 2,
  projectionProtocolVersion: 2,
  navigationProtocolVersion: 2,
  verificationProtocolVersion: 2,
  contextId,
  profile: 'goal',
  strategy: 'goal-directed',
  goalSpecPath: 'goal/goal.json',
  budget: { maxActiveMinutes: 15, maxDepth: 7, maxDeviceActions: 300, maxStates: 50, maxColdStarts: 30, maxCandidatesPerState: 12, maxScrollsPerState: 2, depthSlack: 0, cursorFreshnessMs: 15000 },
  budgetBaseline: { schemaVersion: 1, contextId, source: 'CANONICAL_SEED', baselineReachableStates: 1, baselineVisualStates: 1, baselineEdges: 0 },
  budgetRevision: 1,
  navigationPolicy: 'adaptive',
  verificationRule: 'CONFIRMED_TARGET_PATH',
  createdAt: new Date().toISOString(),
  startedAt: null,
  updatedAt: new Date().toISOString(),
  pausedAt: null,
  pausedDurationMs: 0,
  counters: { event: 0, goalDecision: 0, navigationExecution: 0 }
};
fs.writeFileSync(path.join(scanDir, 'scan.json'), `${JSON.stringify(precheckScan, null, 2)}\n`);
fs.writeFileSync(path.join(scanDir, 'target.json'), `${JSON.stringify({ platform: 'harmony', bundleName: 'com.example.goal', entryAbility: 'EntryAbility', environment: 'test', deviceId: 'fake-device' }, null, 2)}\n`);
fs.writeFileSync(path.join(scanDir, 'contexts', contextId, 'metrics.json'), `${JSON.stringify({ schemaVersion: 3, contextId, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, interruptionActions: 0, activeStartedAt: null, activeDurationMs: 0 }, null, 2)}\n`);
const precheckGoal = buildGoalSpecFromArgs({ goalSpec: JSON.stringify({ description: '账号与安全页面', guide: { routeHints: ['首页', '我的', '设置', '账号与安全'] }, target: { requiredTexts: ['账号与安全'], optionalTexts: ['修改密码'] } }) }, contextId).goal;
fs.writeFileSync(path.join(scanDir, 'goal', 'goal.json'), `${JSON.stringify(precheckGoal, null, 2)}\n`);
fs.writeFileSync(path.join(scanDir, 'goal', 'match-result.json'), `${JSON.stringify({ schemaVersion: 1, goalId: precheckGoal.goalId, status: 'SEARCHING', matchedVisualStateId: null, matchedReachableStateId: null, verifiedPathIds: [], candidateDecisionIds: [], alternativePathCount: 0, actionsUsed: 0, durationSeconds: 0, evidenceObservationId: null, decisions: [] }, null, 2)}\n`);
fs.writeFileSync(path.join(scanDir, 'goal', 'verified-paths.json'), `${JSON.stringify({ schemaVersion: 1, goalId: precheckGoal.goalId, paths: [] }, null, 2)}\n`);
for (const observationId of ['obs-known-a', 'obs-known-b', 'obs-known-c']) {
  fs.writeFileSync(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json'), `${JSON.stringify({ observationId, contextId, captureStatus: 'COMPLETE', layoutPath: `evidence/observations/${observationId}/layout.json`, screenshotPath: `evidence/observations/${observationId}/screenshot.png`, foreground: { bundleName: 'com.example.goal' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(scanDir, 'evidence', 'observations', observationId, 'layout.json'), `${JSON.stringify({ children: observationId === 'obs-known-c' ? [{ text: '修改密码' }] : [{ text: '账号与安全' }, { text: observationId === 'obs-known-a' ? '修改密码' : '安全中心' }] }, null, 2)}\n`);
  fs.writeFileSync(path.join(scanDir, 'evidence', 'observations', observationId, 'screenshot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
const precheckGraph = {
  schemaVersion: 2,
  contextId,
  logicalScreens: [{ id: 'account-security', name: '账号与安全', description: '', visualStateIds: ['vs-account-a', 'vs-account-b', 'vs-account-c'], evidenceRunIds: ['scan-precheck'] }],
  visualStates: [
    { id: 'vs-account-a', logicalScreenKey: 'account-security', name: '账号与安全 A', kind: 'full-screen', availableIn: [contextId], fingerprint: {}, evidenceObservationIds: ['obs-known-a'], visualReviewIds: [] },
    { id: 'vs-account-b', logicalScreenKey: 'account-security', name: '账号与安全 B', kind: 'full-screen', availableIn: [contextId], fingerprint: {}, evidenceObservationIds: ['obs-known-b'], visualReviewIds: [] },
    { id: 'vs-account-c', logicalScreenKey: 'account-security', name: '修改密码', kind: 'full-screen', availableIn: [contextId], fingerprint: {}, evidenceObservationIds: ['obs-known-c'], visualReviewIds: [] }
  ],
  reachableStates: [
    { id: 'rs-account-a', visualStateId: 'vs-account-a', contextId, arrivalSignature: {}, depth: { pathDepth: 0, routeDepth: 0, modalDepth: 0 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'NOT_RUNNABLE' },
    { id: 'rs-account-b', visualStateId: 'vs-account-b', contextId, arrivalSignature: {}, depth: { pathDepth: 1, routeDepth: 1, modalDepth: 0 }, incomingEdgeIds: ['edge-known'], runnablePathEdgeIds: ['edge-known'], replayPathEdgeIds: ['edge-known'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE' },
    { id: 'rs-account-c', visualStateId: 'vs-account-c', contextId, arrivalSignature: {}, depth: { pathDepth: 2, routeDepth: 2, modalDepth: 0 }, incomingEdgeIds: ['edge-known'], runnablePathEdgeIds: ['edge-known'], replayPathEdgeIds: ['edge-known'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE' }
  ],
  edges: [{ id: 'edge-known', verification: { transitionFingerprint: 'fp-known' } }],
  paths: []
};
fs.writeFileSync(path.join(scanDir, 'contexts', contextId, 'graph.json'), `${JSON.stringify(precheckGraph, null, 2)}\n`);
fs.writeFileSync(path.join(scanDir, 'contexts', contextId, 'frontier.json'), `${JSON.stringify({ schemaVersion: 1, contextId, items: [] }, null, 2)}\n`);
require('../lib/event-store').initialize(scanDir, 0);
check(knownTargetPrecheckWork({ scanDir, scan: precheckScan }).decision, 'GOAL_KNOWN_TARGET_PRECHECK');
const claimPrecheck = runScript('frontier.js', ['claim', '--scan-dir', scanDir, '--context', contextId]).json;
check(claimPrecheck.decision, 'GOAL_KNOWN_TARGET_PRECHECK');
check(JSON.parse(fs.readFileSync(path.join(scanDir, 'scan.json'), 'utf8')).counters.navigationExecution, 0);
assert.throws(() => applyKnownTargetPrecheck({ scanDir, scan: precheckScan, graph: { ...precheckGraph, contextId: 'guest' } }), /context/);
tests += 1;
const precheck = applyKnownTargetPrecheck({ scanDir, scan: precheckScan, graph: precheckGraph });
check(precheck.found, true);
check(precheck.decision.source, 'KNOWN_MAP_PRECHECK');
check(precheck.decisions.length, 2);
check(JSON.parse(fs.readFileSync(path.join(scanDir, 'scan.json'), 'utf8')).status, 'PAUSED');
let persistedResult = JSON.parse(fs.readFileSync(path.join(scanDir, 'goal', 'match-result.json'), 'utf8'));
check(persistedResult.knownMapPrecheck.status, 'CANDIDATE_FOUND');
check(persistedResult.knownMapPrecheck.candidateCount, 3);
check(persistedResult.knownMapPrecheck.candidateDecisionIds.length, 2);
check(persistedResult.knownMapPrecheck.suppressedCandidateCount, 1);
assert.throws(() => applyKnownTargetPrecheck({ scanDir, scan: { ...precheckScan, status: 'SCANNING' }, graph: precheckGraph }), /SEARCHING/);
tests += 1;
const firstDecisionId = persistedResult.knownMapPrecheck.selectedDecisionId;
const secondDecisionId = persistedResult.knownMapPrecheck.candidateDecisionIds.find(id => id !== firstDecisionId);
const rejectFirst = runScript('evaluate-goal.js', ['decide', '--scan-dir', scanDir, '--decision-id', firstDecisionId, '--human-decision', 'REJECTED']).json;
check(rejectFirst.runStatus, 'PAUSED');
persistedResult = JSON.parse(fs.readFileSync(path.join(scanDir, 'goal', 'match-result.json'), 'utf8'));
check(persistedResult.knownMapPrecheck.selectedDecisionId, secondDecisionId);
check(persistedResult.status, 'AWAITING_HUMAN_CONFIRMATION');
const rejectSecond = runScript('evaluate-goal.js', ['decide', '--scan-dir', scanDir, '--decision-id', secondDecisionId, '--human-decision', 'REJECTED']).json;
check(rejectSecond.runStatus, 'SCANNING');
persistedResult = JSON.parse(fs.readFileSync(path.join(scanDir, 'goal', 'match-result.json'), 'utf8'));
check(persistedResult.knownMapPrecheck.status, 'EXHAUSTED');
check(persistedResult.status, 'SEARCHING');

const unresolvedQueue = { items: [
  { verificationId: 'verify-non-target', reason: 'CANONICAL_SCREEN_PATH', status: 'PENDING' },
  { verificationId: 'verify-target', reason: 'CONFIRMED_TARGET_PATH', status: 'FAILED', reasonCode: 'GOAL_REPLAY_FAILED' }
] };
check(verificationUnresolvedItems(unresolvedQueue, contextId, true).map(item => item.verificationId), ['verify-target']);
check(verificationUnresolvedItems(unresolvedQueue, contextId, false).map(item => item.verificationId), ['verify-non-target', 'verify-target']);

console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'goal-verification', tests }, null, 2));

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextWork } = require('../lib/work-scheduler');
const scheduler = require('../lib/frontier-scheduler');
const { candidateCoverageBasis } = require('../lib/candidate-coverage');
const { candidateRulesForScan } = require('../lib/candidate-rules');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function edge(id, from, to) {
  return {
    id,
    contextId: 'guest',
    fromReachableStateId: from,
    toReachableStateId: to,
    intent: { type: 'tap', target: id },
    locatorQuality: 'SEMANTIC_PORTABLE',
    locatorResolution: 'SEMANTIC_VERIFIED',
    locatorEvidence: { matchedNode: { text: id } },
    replayPolicy: 'REPEATABLE',
    replayability: 'STABLE',
    sideEffect: 'NONE',
    safety: { allowed: true },
    verification: { replayStatus: 'UNVERIFIED', transitionFingerprint: `fp-${id}`, verificationRefs: [] }
  };
}

function fixture(blockingEdgeIds, { unknown = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-deps-'));
  const scanDir = path.join(temp, 'app-map', 'runs', 'scan-deps');
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: 'scan-deps',
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    graphProtocolVersion: 4,
    budget: { maxActiveMinutes: 30, maxDepth: 5, maxStates: 20, maxDeviceActions: 100, maxColdStarts: 20, depthSlack: 1, cursorFreshnessMs: 60000 }
  };
  const graph = {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [],
    visualStates: [],
    reachableStates: [
      { id: 'a', visualStateId: 'va', contextId: 'guest', depth: { pathDepth: 0 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_VERIFIED' },
      { id: 'b', visualStateId: 'vb', contextId: 'guest', depth: { pathDepth: 1 }, incomingEdgeIds: ['e-ab'], runnablePathEdgeIds: ['e-ab'], replayPathEdgeIds: ['e-ab'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'c', visualStateId: 'vc', contextId: 'guest', depth: { pathDepth: 2 }, incomingEdgeIds: ['e-bc'], runnablePathEdgeIds: ['e-ab', 'e-bc'], replayPathEdgeIds: ['e-ab', 'e-bc'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'd', visualStateId: 'vd', contextId: 'guest', depth: { pathDepth: 2 }, incomingEdgeIds: ['e-bd'], runnablePathEdgeIds: ['e-ab', 'e-bd'], replayPathEdgeIds: ['e-ab', 'e-bd'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' }
    ],
    edges: [edge('e-ab', 'a', 'b'), edge('e-bc', 'b', 'c'), edge('e-bd', 'b', 'd')],
    paths: []
  };
  const frontier = { schemaVersion: 1, contextId: 'guest', items: [{ id: 'frontier-d', contextId: 'guest', fromReachableStateId: 'd', candidate: { type: 'tap', target: 'd-next' }, priority: { riskRank: 0, nextPathDepth: 3 }, status: 'PENDING', attempts: 0 }] };
  const failed = { verificationId: 'verify-c', contextId: 'guest', reason: 'CANONICAL_SCREEN_PATH', logicalScreenKey: 'c', terminalReachableStateId: 'c', edgeIds: ['e-ab', 'e-bc'], transitionFingerprints: ['fp-e-ab', 'fp-e-bc'], status: 'FAILED', attemptCount: 3, executions: [], executionIds: [], reasonCode: 'COLD_REPLAY_FAILED' };
  if (!unknown) failed.failure = { reasonCode: 'COLD_REPLAY_FAILED', blockingEdgeIds, failedEdgeIds: blockingEdgeIds, failedEdgeId: blockingEdgeIds[0], scope: blockingEdgeIds[0] === 'e-ab' ? 'PREFIX_EDGE_BLOCKED' : 'BRANCH_EDGE_BLOCKED' };
  const queue = { schemaVersion: 2, contextId: 'guest', items: [
    failed,
    { verificationId: 'verify-d', contextId: 'guest', reason: 'CANONICAL_SCREEN_PATH', logicalScreenKey: 'd', terminalReachableStateId: 'd', edgeIds: ['e-ab', 'e-bd'], transitionFingerprints: ['fp-e-ab', 'fp-e-bd'], status: 'PENDING', attemptCount: 0, executions: [], executionIds: [] }
  ] };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'verification-queue.json'), queue);
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  writeJson(path.join(contextDir, 'live-cursor.json'), { schemaVersion: 1, contextId: 'guest', reachableStateId: 'a', observationId: 'obs-root', status: 'EXACT', epoch: 1, mutationSeq: 0, lastValidatedAt: new Date().toISOString() });
  writeJson(path.join(contextDir, 'back-capabilities.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

function stateBudgetFixture({ baselineStates, totalStates }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-state-budget-'));
  const scanDir = path.join(temp, 'app-map', 'runs', 'scan-state-budget');
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: 'scan-state-budget',
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    graphProtocolVersion: 4,
    budget: { maxActiveMinutes: 30, maxDepth: 5, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, depthSlack: 1, cursorFreshnessMs: 60000 },
    budgetBaseline: { schemaVersion: 1, contextId: 'guest', source: 'CANONICAL_SEED', baselineReachableStates: baselineStates, baselineVisualStates: baselineStates, baselineEdges: 0 }
  };
  const reachableStates = Array.from({ length: totalStates }, (_, index) => ({
    id: `state-${index + 1}`,
    visualStateId: `visual-${index + 1}`,
    contextId: 'guest',
    depth: { pathDepth: index === 0 ? 0 : 1 },
    incomingEdgeIds: [],
    runnablePathEdgeIds: [],
    replayPathEdgeIds: [],
    verifiedPathEdgeIds: [],
    pathStatus: index === 0 ? 'RUNNABLE_VERIFIED' : 'NOT_RUNNABLE'
  }));
  const graph = { schemaVersion: 2, contextId: 'guest', logicalScreens: [], visualStates: reachableStates.map(state => ({ id: state.visualStateId, logicalScreenKey: state.visualStateId, name: state.visualStateId, kind: 'full-screen', evidenceObservationIds: [], evidenceObservationRefs: [{ runId: 'seed', observationId: 'obs' }], fingerprint: {} })), reachableStates, edges: [], paths: [] };
  const frontier = { schemaVersion: 1, contextId: 'guest', items: [{ id: 'frontier-open', contextId: 'guest', fromReachableStateId: 'state-1', candidate: { type: 'tap', target: 'open' }, priority: { riskRank: 0, nextPathDepth: 1 }, status: 'PENDING', attempts: 0 }] };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

function coverageBackfillFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-coverage-'));
  const scanDir = path.join(temp, 'app-map', 'runs', 'scan-coverage');
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: 'scan-coverage',
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    graphProtocolVersion: 4,
    budget: { maxActiveMinutes: 30, maxDepth: 5, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, depthSlack: 1, cursorFreshnessMs: 60000 },
    budgetBaseline: { schemaVersion: 1, contextId: 'guest', source: 'CANONICAL_SEED', baselineReachableStates: 2, baselineVisualStates: 2, baselineEdges: 0 }
  };
  const graph = {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [],
    visualStates: [{ id: 'visual-1' }, { id: 'visual-2', evidenceObservationRefs: [{ runId: 'seed', observationId: 'obs-2' }] }],
    reachableStates: [
      { id: 'state-1', visualStateId: 'visual-1', contextId: 'guest', depth: { pathDepth: 0 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_VERIFIED' },
      { id: 'state-2', visualStateId: 'visual-2', contextId: 'guest', depth: { pathDepth: 1 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' }
    ],
    edges: [],
    paths: []
  };
  const frontier = { schemaVersion: 1, contextId: 'guest', items: [] };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(contextDir, 'context.json'), { schemaVersion: 1, id: 'guest', inheritedCandidateCoverage: { schemaVersion: 1, contextId: 'guest', backfillRequiredStateIds: ['state-2'] } });
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

function currentRunBackfillFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-current-coverage-'));
  const scanDir = path.join(temp, 'app-map', 'runs', 'scan-current-coverage');
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: 'scan-current-coverage',
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    graphProtocolVersion: 4,
    target: { bundleName: 'com.example.demo', environment: 'test' },
    profile: 'standard',
    budget: { maxActiveMinutes: 30, maxDepth: 5, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, maxCandidatesPerState: 5, depthSlack: 1, cursorFreshnessMs: 60000 }
  };
  const graph = {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [],
    visualStates: [{ id: 'visual-batch', evidenceObservationIds: ['obs-batch'], fingerprint: { layoutHash: 'sha256:batch', semantic: { primaryActions: [] } } }],
    reachableStates: [{ id: 'state-batch', visualStateId: 'visual-batch', contextId: 'guest', depth: { pathDepth: 1 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' }],
    edges: [],
    paths: []
  };
  const frontier = { schemaVersion: 1, contextId: 'guest', items: Array.from({ length: 5 }, (_, index) => ({ id: `frontier-old-${index + 1}`, contextId: 'guest', fromReachableStateId: 'state-batch', candidateGroupKey: `batch/${index + 1}`, candidate: { type: 'tap', target: `入口${index + 1}`, fallbackBounds: [10, index * 10, 100, index * 10 + 8] }, priority: {}, status: 'EXPLORED', attempts: 1 })) };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(contextDir, 'context.json'), { schemaVersion: 1, id: 'guest', inheritedCandidateCoverage: null });
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

function exhaustedBasisFixture({ changed = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-exhausted-basis-'));
  const scanDir = path.join(temp, 'app-map', 'runs', 'scan-exhausted-basis');
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: 'scan-exhausted-basis',
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    graphProtocolVersion: 4,
    target: { bundleName: 'com.example.demo', environment: 'test' },
    profile: 'standard',
    budget: { maxActiveMinutes: 30, maxDepth: 5, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, maxCandidatesPerState: 5, depthSlack: 1, cursorFreshnessMs: 60000 }
  };
  const visualState = { id: 'visual-done', evidenceObservationRefs: [{ runId: 'seed', observationId: 'obs-done' }], fingerprint: { layoutHash: 'sha256:done', semantic: { primaryActions: ['完成'] } } };
  const state = { id: 'state-done', visualStateId: 'visual-done', contextId: 'guest', depth: { pathDepth: 1 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' };
  const graph = { schemaVersion: 2, contextId: 'guest', logicalScreens: [], visualStates: [visualState], reachableStates: [state], edges: [], paths: [] };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  const basis = candidateCoverageBasis({ state, visualState, scan, budget: scan.budget, candidateRules: candidateRulesForScan(scanDir, scan) });
  const inheritedBasis = changed ? { ...basis, basisHash: 'sha256:stale-basis' } : basis;
  writeJson(path.join(contextDir, 'context.json'), { schemaVersion: 1, id: 'guest', inheritedCandidateCoverage: { schemaVersion: 1, contextId: 'guest', backfillRequiredStateIds: [], states: [{ reachableStateId: state.id, candidateCoverageStatus: 'EXHAUSTED', candidateCoverageBasis: inheritedBasis, knownCandidateCount: 5, noCandidateSuggestionCount: 1, backfillRequired: false }] } });
  const frontier = { schemaVersion: 1, contextId: 'guest', items: [] };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

function reviewNeededFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-review-'));
  const scanDir = path.join(temp, 'app-map', 'runs', 'scan-review');
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  for (const obsId of ['obs-simple', 'obs-complex']) fs.mkdirSync(path.join(scanDir, 'evidence', 'observations', obsId), { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: 'scan-review',
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    graphProtocolVersion: 4,
    target: { environment: 'test' },
    budget: { maxActiveMinutes: 30, maxDepth: 5, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, maxCandidatesPerState: 6, depthSlack: 1, cursorFreshnessMs: 60000 }
  };
  const graph = {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [],
    visualStates: [
      { id: 'visual-simple', evidenceObservationIds: ['obs-simple'], fingerprint: {} },
      { id: 'visual-complex', evidenceObservationIds: ['obs-complex'], fingerprint: {} }
    ],
    reachableStates: [
      { id: 'state-simple', visualStateId: 'visual-simple', contextId: 'guest', depth: { pathDepth: 1 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'state-complex', visualStateId: 'visual-complex', contextId: 'guest', depth: { pathDepth: 2 }, incomingEdgeIds: [], runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' }
    ],
    edges: [],
    paths: []
  };
  const simpleLayout = { attributes: { type: 'root', bounds: '[0,0][1260,2720]' }, children: [{ attributes: { type: 'Button', text: '简单入口', clickable: 'true', bounds: '[100,400][380,520]' } }] };
  const complexLayout = { attributes: { type: 'root', bounds: '[0,0][1260,2720]' }, children: [{ attributes: { type: 'ListItem', text: '', clickable: 'true', bounds: '[80,600][1180,820]' }, children: [{ attributes: { type: 'Text', text: '复杂卡片', bounds: '[120,650][430,730]' } }] }] };
  writeJson(path.join(scanDir, 'evidence', 'observations', 'obs-simple', 'layout.json'), simpleLayout);
  writeJson(path.join(scanDir, 'evidence', 'observations', 'obs-simple', 'observation.json'), { schemaVersion: 2, observationId: 'obs-simple', contextId: 'guest', layoutPath: 'evidence/observations/obs-simple/layout.json', screenshotPath: 'evidence/observations/obs-simple/screenshot.png' });
  fs.writeFileSync(path.join(scanDir, 'evidence', 'observations', 'obs-simple', 'screenshot.png'), Buffer.from([137, 80, 78, 71]));
  writeJson(path.join(scanDir, 'evidence', 'observations', 'obs-complex', 'layout.json'), complexLayout);
  writeJson(path.join(scanDir, 'evidence', 'observations', 'obs-complex', 'observation.json'), { schemaVersion: 2, observationId: 'obs-complex', contextId: 'guest', layoutPath: 'evidence/observations/obs-complex/layout.json', screenshotPath: 'evidence/observations/obs-complex/screenshot.png' });
  fs.writeFileSync(path.join(scanDir, 'evidence', 'observations', 'obs-complex', 'screenshot.png'), Buffer.from([137, 80, 78, 71, 2]));
  const frontier = { schemaVersion: 1, contextId: 'guest', items: [] };
  const suggestions = { schemaVersion: 1, contextId: 'guest', items: [
    { schemaVersion: 1, suggestionId: 'suggest-0001', contextId: 'guest', reachableStateId: 'state-simple', visualStateId: 'visual-simple', observationId: 'obs-simple', candidateGroupKey: 'simple', candidate: { type: 'tap', target: '简单入口', fallbackBounds: [100, 400, 380, 520] }, source: 'LAYOUT_CLICKABLE', confidence: 0.8, priority: { entryRank: 0 }, risk: null, safety: { allowed: true }, status: 'PENDING' },
    { schemaVersion: 1, suggestionId: 'suggest-0002', contextId: 'guest', reachableStateId: 'state-complex', visualStateId: 'visual-complex', observationId: 'obs-complex', candidateGroupKey: 'complex', candidate: { type: 'tap', target: '复杂卡片', fallbackBounds: [120, 650, 430, 730] }, source: 'LAYOUT_CLICKABLE', confidence: 0.8, priority: { entryRank: 1 }, risk: null, safety: { allowed: true }, status: 'PENDING' }
  ] };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), suggestions);
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

let tests = 0;
function check(actual, expected) {
  assert.deepEqual(actual, expected);
  tests += 1;
}

try {
  const branch = fixture(['e-bc']);
  const branchWork = nextWork(branch);
  check(branchWork.decision, 'DISCOVER');
  check(scheduler.schedule(branch).frontierId, 'frontier-d');

  const prefix = fixture(['e-ab']);
  const prefixWork = nextWork(prefix);
  check(prefixWork.decision, 'STOP');
  check(prefixWork.reasonCode, 'WORK_BLOCKED_BY_FAILED_DEPENDENCIES');
  check(scheduler.schedule(prefix).reasonCode, 'FRONTIER_BLOCKED_BY_FAILED_DEPENDENCIES');

  const unknown = fixture([], { unknown: true });
  const unknownWork = nextWork(unknown);
  check(unknownWork.decision, 'STOP');
  check(unknownWork.reasonCode, 'REQUIRED_VERIFICATION_FAILED');

  const oneNewState = stateBudgetFixture({ baselineStates: 29, totalStates: 30 });
  const oneNewWork = nextWork(oneNewState);
  check(oneNewWork.decision, 'DISCOVER');

  const maxNewStates = stateBudgetFixture({ baselineStates: 29, totalStates: 59 });
  const maxNewWork = nextWork(maxNewStates);
  check(maxNewWork.decision, 'STOP');
  check(maxNewWork.reasonCode, 'MAX_STATES');
  check(maxNewWork.budgetState.used, 30);
  check(maxNewWork.budgetState.totalStates, 59);

  const coverage = coverageBackfillFixture();
  const coverageWork = nextWork(coverage);
  check(coverageWork.decision, 'BACKFILL_FRONTIER_SUGGESTIONS');
  check(coverageWork.reachableStateIds, ['state-2']);
  check(coverageWork.suggestedCommand.args.includes('--reachable-state-ids'), true);
  check(coverageWork.suggestedCommand.args.includes('state-2'), true);

  const currentCoverage = currentRunBackfillFixture();
  const currentCoverageWork = nextWork(currentCoverage);
  check(currentCoverageWork.decision, 'BACKFILL_FRONTIER_SUGGESTIONS');
  check(currentCoverageWork.coverageSource, 'CURRENT_RUN');
  check(currentCoverageWork.reachableStateIds, ['state-batch']);
  check(currentCoverageWork.suggestedCommand.args.includes('state-batch'), true);

  const exhaustedStable = exhaustedBasisFixture({ changed: false });
  const exhaustedStableWork = nextWork(exhaustedStable);
  check(exhaustedStableWork.decision, 'STOP');
  check(exhaustedStableWork.reasonCode, 'WORK_EMPTY');

  const exhaustedChanged = exhaustedBasisFixture({ changed: true });
  const exhaustedChangedWork = nextWork(exhaustedChanged);
  check(exhaustedChangedWork.decision, 'BACKFILL_FRONTIER_SUGGESTIONS');
  check(exhaustedChangedWork.reachableStateIds, ['state-done']);

  const reviewNeeded = reviewNeededFixture();
  const reviewWork = nextWork(reviewNeeded);
  check(reviewWork.decision, 'REVIEW_FRONTIER_CANDIDATES');
  check(reviewWork.reachableStateId, 'state-complex');

  console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'scheduler', tests }, null, 2));
} finally {
  for (const dir of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('smap-scheduler-deps-') || name.startsWith('smap-scheduler-state-budget-') || name.startsWith('smap-scheduler-coverage-') || name.startsWith('smap-scheduler-current-coverage-') || name.startsWith('smap-scheduler-exhausted-basis-') || name.startsWith('smap-scheduler-review-'))) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
}

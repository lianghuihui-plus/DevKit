#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextWork } = require('./lib/work-scheduler');
const scheduler = require('./lib/frontier-scheduler');

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
    visualStates: [{ id: 'visual-1' }, { id: 'visual-2' }],
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

  console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'scheduler', tests }, null, 2));
} finally {
  for (const dir of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('smap-scheduler-deps-') || name.startsWith('smap-scheduler-state-budget-') || name.startsWith('smap-scheduler-coverage-'))) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
}

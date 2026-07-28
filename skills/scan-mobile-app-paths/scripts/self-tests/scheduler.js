#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextWork } = require('../lib/work-scheduler');
const { assessFinalization } = require('../lib/finalization-guard');
const { modeForScan } = require('../lib/modes');
const scheduler = require('../lib/frontier-scheduler');
const { candidateCoverageBasis } = require('../lib/candidate-coverage');
const { candidateRulesForScan } = require('../lib/candidate-rules');
const { initialStartProjection, evaluateKnownStartCandidates } = require('../lib/exploration-start');

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

function goalCorridorFixture({ mode = 'frontier' } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-goal-corridor-'));
  const scanDir = path.join(temp, 'app-map', 'runs', `scan-goal-corridor-${mode}`);
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(path.join(scanDir, 'goal'), { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: `scan-goal-corridor-${mode}`,
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'goal-directed',
    scanScope: 'targeted',
    graphProtocolVersion: 4,
    target: { bundleName: 'com.example.demo', environment: 'test' },
    profile: 'goal',
    strategy: 'goal-directed',
    budget: { maxActiveMinutes: 30, maxDepth: 7, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, maxCandidatesPerState: 5, maxScrollsPerState: 1, depthSlack: 0, cursorFreshnessMs: 60000 },
    verificationRule: 'CONFIRMED_TARGET_PATH'
  };
  const goal = { schemaVersion: 2, goalId: 'goal-corridor', contextId: 'guest', resultPolicy: { verifyKnownPathFirst: false }, guideSpec: { routeHints: ['学习', '我的', '设置', '设备管理'], preferredTexts: ['我的', '设置', '设备管理'] }, targetSpec: { requiredTexts: ['设备管理'] } };
  const graph = {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [
      { id: 'settings', name: '设置' },
      { id: 'creative', name: '创作' }
    ],
    visualStates: [
      { id: 'visual-root', logicalScreenKey: 'home', name: '学习', fingerprint: {} },
      { id: 'visual-settings', logicalScreenKey: 'settings', name: '设置', evidenceObservationRefs: [{ runId: 'seed', observationId: 'obs-settings' }], fingerprint: { semantic: { stableTexts: ['设置'], primaryActions: ['设备管理'] } } },
      { id: 'visual-creative', logicalScreenKey: 'creative', name: '创作', evidenceObservationRefs: [{ runId: 'seed', observationId: 'obs-creative' }], fingerprint: { semantic: { stableTexts: ['创作'], primaryActions: ['赛考专区'] } } }
    ],
    reachableStates: [
      { id: 'state-root', visualStateId: 'visual-root', contextId: 'guest', depth: { pathDepth: 0 }, runnablePathEdgeIds: [], replayPathEdgeIds: [], pathStatus: 'RUNNABLE_VERIFIED' },
      { id: 'state-settings', visualStateId: 'visual-settings', contextId: 'guest', depth: { pathDepth: 1 }, runnablePathEdgeIds: [], replayPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'state-creative', visualStateId: 'visual-creative', contextId: 'guest', depth: { pathDepth: 1 }, runnablePathEdgeIds: [], replayPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' }
    ],
    edges: [],
    paths: []
  };
  const frontier = { schemaVersion: 1, contextId: 'guest', items: mode === 'backfill' ? [] : mode === 'suggestion' ? [
    { id: 'frontier-creative', contextId: 'guest', fromReachableStateId: 'state-creative', candidateGroupKey: 'creative/zone', candidate: { type: 'tap', target: '赛考专区' }, priority: { riskRank: 0, nextPathDepth: 2 }, status: 'PENDING', attempts: 0 }
  ] : [
    { id: 'frontier-creative', contextId: 'guest', fromReachableStateId: 'state-creative', candidateGroupKey: 'creative/zone', candidate: { type: 'tap', target: '赛考专区' }, priority: { riskRank: 0, nextPathDepth: 2 }, status: 'PENDING', attempts: 0 },
    { id: 'frontier-device', contextId: 'guest', fromReachableStateId: 'state-settings', candidateGroupKey: 'settings/device', candidate: { type: 'tap', target: '设备管理' }, priority: { riskRank: 0, nextPathDepth: 2, goalRelevance: 7, routeHintStep: 3 }, status: 'PENDING', attempts: 0 }
  ] };
  const suggestions = { schemaVersion: 1, contextId: 'guest', items: mode === 'suggestion' ? [
    { schemaVersion: 1, suggestionId: 'suggest-creative', contextId: 'guest', reachableStateId: 'state-creative', visualStateId: 'visual-creative', observationId: 'obs-creative', candidateGroupKey: 'creative/zone', candidate: { type: 'tap', target: '赛考专区' }, source: 'LAYOUT_CLICKABLE', confidence: 0.8, candidateClass: 'STABLE_ENTRY', priority: { riskRank: 0, entryRank: 0, nextPathDepth: 2 }, risk: null, safety: { allowed: true }, status: 'PENDING' },
    { schemaVersion: 1, suggestionId: 'suggest-device', contextId: 'guest', reachableStateId: 'state-settings', visualStateId: 'visual-settings', observationId: 'obs-settings', candidateGroupKey: 'settings/device', candidate: { type: 'tap', target: '设备管理' }, source: 'LAYOUT_CLICKABLE', confidence: 0.9, candidateClass: 'STABLE_ENTRY', priority: { riskRank: 0, entryRank: 0, nextPathDepth: 2, goalRelevance: 7, routeHintStep: 3 }, risk: null, safety: { allowed: true }, status: 'PENDING', guideMatchedTexts: ['设备管理'], routeHintStep: 3 }
  ] : [] };
  const context = mode === 'backfill' ? { schemaVersion: 1, id: 'guest', inheritedCandidateCoverage: { schemaVersion: 1, contextId: 'guest', backfillRequiredStateIds: ['state-creative', 'state-settings'] } } : { schemaVersion: 1, id: 'guest', inheritedCandidateCoverage: null };
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(scanDir, 'goal', 'goal.json'), goal);
  writeJson(path.join(scanDir, 'goal', 'match-result.json'), { schemaVersion: 1, goalId: goal.goalId, status: 'SEARCHING', decisions: [], candidateDecisionIds: [] });
  writeJson(path.join(contextDir, 'context.json'), context);
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), suggestions);
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  return { temp, scanDir, scan, contextId: 'guest', graph, frontier, metrics };
}

function specifiedStartFixture({ resolved = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-scheduler-start-scope-'));
  const scanDir = path.join(temp, 'app-map', 'runs', `scan-start-scope-${resolved ? 'resolved' : 'pending'}`);
  const contextDir = path.join(scanDir, 'contexts', 'guest');
  fs.mkdirSync(contextDir, { recursive: true });
  const scan = {
    schemaVersion: 3,
    scanId: `scan-start-scope-${resolved ? 'resolved' : 'pending'}`,
    status: 'SCANNING',
    contextId: 'guest',
    scanMode: 'exploration',
    scanScope: 'full',
    graphProtocolVersion: 4,
    target: { bundleName: 'com.example.demo', environment: 'test' },
    profile: 'standard',
    strategy: 'exploration',
    budget: { maxActiveMinutes: 30, maxDepth: 1, maxStates: 30, maxDeviceActions: 100, maxColdStarts: 20, maxCandidatesPerState: 5, maxScrollsPerState: 1, depthSlack: 1, cursorFreshnessMs: 60000 },
    verificationRule: 'CANONICAL_SCREEN_PATH'
  };
  const graph = {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [
      { id: 'home', name: '首页' },
      { id: 'settings', name: '设置' },
      { id: 'device', name: '设备管理' },
      { id: 'creative', name: '创作' }
    ],
    visualStates: [
      { id: 'visual-root', logicalScreenKey: 'home', name: '首页', fingerprint: { semantic: { stableTexts: ['首页'], primaryActions: ['我的'] } } },
      { id: 'visual-settings', logicalScreenKey: 'settings', name: '设置', fingerprint: { semantic: { stableTexts: ['设置'], primaryActions: ['设备管理'] } } },
      { id: 'visual-device', logicalScreenKey: 'device', name: '设备管理', fingerprint: { semantic: { stableTexts: ['设备管理'], primaryActions: ['详情'] } } },
      { id: 'visual-detail', logicalScreenKey: 'detail', name: '设备详情', fingerprint: { semantic: { stableTexts: ['设备详情'], primaryActions: [] } } },
      { id: 'visual-creative', logicalScreenKey: 'creative', name: '创作', fingerprint: { semantic: { stableTexts: ['创作'], primaryActions: ['赛考专区'] } } }
    ],
    reachableStates: [
      { id: 'state-root', visualStateId: 'visual-root', contextId: 'guest', depth: { pathDepth: 0 }, runnablePathEdgeIds: [], replayPathEdgeIds: [], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_VERIFIED' },
      { id: 'state-settings', visualStateId: 'visual-settings', contextId: 'guest', depth: { pathDepth: 3 }, runnablePathEdgeIds: ['edge-root-settings'], replayPathEdgeIds: ['edge-root-settings'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'state-device', visualStateId: 'visual-device', contextId: 'guest', depth: { pathDepth: 4 }, runnablePathEdgeIds: ['edge-root-settings', 'edge-settings-device'], replayPathEdgeIds: ['edge-root-settings', 'edge-settings-device'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'state-detail', visualStateId: 'visual-detail', contextId: 'guest', depth: { pathDepth: 5 }, runnablePathEdgeIds: ['edge-root-settings', 'edge-settings-device', 'edge-device-detail'], replayPathEdgeIds: ['edge-root-settings', 'edge-settings-device', 'edge-device-detail'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' },
      { id: 'state-creative', visualStateId: 'visual-creative', contextId: 'guest', depth: { pathDepth: 1 }, runnablePathEdgeIds: ['edge-root-creative'], replayPathEdgeIds: ['edge-root-creative'], verifiedPathEdgeIds: [], pathStatus: 'RUNNABLE_UNVERIFIED' }
    ],
    edges: [
      edge('edge-root-settings', 'state-root', 'state-settings'),
      edge('edge-settings-device', 'state-settings', 'state-device'),
      edge('edge-device-detail', 'state-device', 'state-detail'),
      edge('edge-root-creative', 'state-root', 'state-creative')
    ],
    paths: []
  };
  const frontier = { schemaVersion: 1, contextId: 'guest', items: [
    { id: 'frontier-device', contextId: 'guest', fromReachableStateId: 'state-settings', candidateGroupKey: 'settings/device', candidate: { type: 'tap', target: '设备管理' }, priority: { riskRank: 0, nextPathDepth: 4 }, status: 'PENDING', attempts: 0 },
    { id: 'frontier-device-detail', contextId: 'guest', fromReachableStateId: 'state-device', candidateGroupKey: 'device/detail', candidate: { type: 'tap', target: '详情' }, priority: { riskRank: 0, nextPathDepth: 5 }, status: 'PENDING', attempts: 0 },
    { id: 'frontier-creative', contextId: 'guest', fromReachableStateId: 'state-creative', candidateGroupKey: 'creative/zone', candidate: { type: 'tap', target: '赛考专区' }, priority: { riskRank: 0, nextPathDepth: 2 }, status: 'PENDING', attempts: 0 }
  ] };
  const spec = { kind: 'specified-page', pageName: '设置', routeHints: ['首页', '我的', '设置'], matchEvidence: { requiredTexts: ['设置'], optionalTexts: ['设备管理'] } };
  const start = initialStartProjection('guest', spec);
  if (resolved) Object.assign(start, { status: 'RESOLVED', startReachableStateId: 'state-settings', startVisualStateId: 'visual-settings', pathEdgeIdsFromAppRoot: ['edge-root-settings'], resolvedBy: 'KNOWN_MAP_CONFIRMED' });
  const metrics = { actions: 0, coldStarts: 0, activeDurationMs: 0, deviceMutationSeq: 0 };
  writeJson(path.join(scanDir, 'scan.json'), scan);
  writeJson(path.join(contextDir, 'context.json'), { schemaVersion: 1, id: 'guest', inheritedCandidateCoverage: { schemaVersion: 1, contextId: 'guest', backfillRequiredStateIds: ['state-settings', 'state-device', 'state-creative'] } });
  writeJson(path.join(contextDir, 'graph.json'), graph);
  writeJson(path.join(contextDir, 'frontier.json'), frontier);
  writeJson(path.join(contextDir, 'frontier-suggestions.json'), { schemaVersion: 1, contextId: 'guest', items: [] });
  writeJson(path.join(contextDir, 'verification-queue.json'), { schemaVersion: 2, contextId: 'guest', items: [
    { verificationId: 'verify-device', contextId: 'guest', reason: 'CANONICAL_SCREEN_PATH', logicalScreenKey: 'device', terminalReachableStateId: 'state-device', edgeIds: ['edge-root-settings', 'edge-settings-device'], transitionFingerprints: ['fp-edge-root-settings', 'fp-edge-settings-device'], status: 'PENDING', attemptCount: 0, executions: [], executionIds: [] },
    { verificationId: 'verify-creative', contextId: 'guest', reason: 'CANONICAL_SCREEN_PATH', logicalScreenKey: 'creative', terminalReachableStateId: 'state-creative', edgeIds: ['edge-root-creative'], transitionFingerprints: ['fp-edge-root-creative'], status: 'PENDING', attemptCount: 0, executions: [], executionIds: [] }
  ] });
  writeJson(path.join(contextDir, 'metrics.json'), metrics);
  writeJson(path.join(contextDir, 'exploration-start.json'), start);
  fs.mkdirSync(path.join(scanDir, 'attempts'), { recursive: true });
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
  check(branchWork.recommendedAction, 'CONTINUE_SCAN');
  check(branchWork.openWorkSummary.pendingFrontiers, 1);
  check(scheduler.schedule(branch).frontierId, 'frontier-d');
  const branchPartial = assessFinalization({ scanDir: branch.scanDir, scan: branch.scan, requestedStatus: 'PARTIAL' });
  check(branchPartial.canFinalize, false);
  check(branchPartial.reasonCode, 'FINALIZATION_REQUIRES_CONTINUATION_OR_USER_STOP');
  const branchUserStopMissingConfirmation = assessFinalization({ scanDir: branch.scanDir, scan: branch.scan, requestedStatus: 'PARTIAL', reasonCode: 'USER_STOPPED' });
  check(branchUserStopMissingConfirmation.canFinalize, false);
  check(branchUserStopMissingConfirmation.reasonCode, 'FINALIZATION_REQUIRES_USER_STOP_CONFIRMATION');
  const branchUserStopped = assessFinalization({ scanDir: branch.scanDir, scan: branch.scan, requestedStatus: 'PARTIAL', reasonCode: 'USER_STOPPED', confirmUserStop: true, userStopNote: 'explicit self-test stop' });
  check(branchUserStopped.canFinalize, true);

  const prefix = fixture(['e-ab']);
  const prefixWork = nextWork(prefix);
  check(prefixWork.decision, 'STOP');
  check(prefixWork.reasonCode, 'WORK_BLOCKED_BY_FAILED_DEPENDENCIES');
  check(scheduler.schedule(prefix).reasonCode, 'FRONTIER_BLOCKED_BY_FAILED_DEPENDENCIES');
  const prefixPartial = assessFinalization({ scanDir: prefix.scanDir, scan: prefix.scan, requestedStatus: 'PARTIAL' });
  check(prefixPartial.canFinalize, true);

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
  const completedEmpty = assessFinalization({ scanDir: exhaustedStable.scanDir, scan: exhaustedStable.scan, requestedStatus: 'COMPLETED' });
  check(completedEmpty.canFinalize, true);

  const exhaustedChanged = exhaustedBasisFixture({ changed: true });
  const exhaustedChangedWork = nextWork(exhaustedChanged);
  check(exhaustedChangedWork.decision, 'BACKFILL_FRONTIER_SUGGESTIONS');
  check(exhaustedChangedWork.reachableStateIds, ['state-done']);

  const reviewNeeded = reviewNeededFixture();
  const reviewWork = nextWork(reviewNeeded);
  check(reviewWork.decision, 'REVIEW_FRONTIER_CANDIDATES');
  check(reviewWork.reachableStateId, 'state-complex');

  const pendingStart = specifiedStartFixture({ resolved: false });
  const pendingStartWork = nextWork(pendingStart);
  check(pendingStartWork.decision, 'RESOLVE_EXPLORATION_START');
  check(pendingStartWork.reasonCode, 'SPECIFIED_START_PENDING');
  check(evaluateKnownStartCandidates(pendingStart.graph, pendingStartWork.explorationStart.spec)[0].reachableStateId, 'state-settings');

  const resolvedStart = specifiedStartFixture({ resolved: true });
  const resolvedStartWork = nextWork(resolvedStart);
  check(resolvedStartWork.decision, 'DISCOVER');
  check(scheduler.schedule(resolvedStart).frontierId, 'frontier-device');
  check(resolvedStartWork.openWorkSummary.runnableFrontiers, 1);
  check(resolvedStartWork.openWorkSummary.pendingVerifications, 1);
  check(modeForScan(resolvedStart.scan).observedDepthForBudget(resolvedStart), 0);
  writeJson(path.join(resolvedStart.scanDir, 'attempts', 'attempt-device.json'), { attemptId: 'attempt-device', contextId: 'guest', status: 'COMMITTED', toReachableStateId: 'state-device' });
  check(modeForScan(resolvedStart.scan).observedDepthForBudget(resolvedStart), 1);

  const goalFrontier = goalCorridorFixture({ mode: 'frontier' });
  check(scheduler.schedule(goalFrontier).frontierId, 'frontier-device');

  const goalSuggestion = goalCorridorFixture({ mode: 'suggestion' });
  const goalSuggestionWork = nextWork(goalSuggestion);
  check(goalSuggestionWork.decision, 'SUGGEST_FRONTIER');
  check(goalSuggestionWork.pendingSuggestionId, 'suggest-device');
  check(goalSuggestionWork.suggestedCommand.args.includes('--suggestion-id'), true);
  check(goalSuggestionWork.suggestedCommand.args.includes('suggest-device'), true);

  const goalBackfill = goalCorridorFixture({ mode: 'backfill' });
  const goalBackfillWork = nextWork(goalBackfill);
  check(goalBackfillWork.decision, 'BACKFILL_FRONTIER_SUGGESTIONS');
  check(goalBackfillWork.reachableStateIds, ['state-settings']);

  console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'scheduler', tests }, null, 2));
} finally {
  for (const dir of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('smap-scheduler-deps-') || name.startsWith('smap-scheduler-state-budget-') || name.startsWith('smap-scheduler-coverage-') || name.startsWith('smap-scheduler-current-coverage-') || name.startsWith('smap-scheduler-exhausted-basis-') || name.startsWith('smap-scheduler-review-') || name.startsWith('smap-scheduler-goal-corridor-') || name.startsWith('smap-scheduler-start-scope-'))) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
}

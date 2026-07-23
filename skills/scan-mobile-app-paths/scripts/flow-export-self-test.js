#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256, writeJsonAtomic } = require('./lib/common');
const { summarizePathExportability } = require('./lib/precondition-flow-exporter');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-flow-export-self-test-'));
const scripts = __dirname;
let tests = 0;

function checksum(value) { return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
function check(value, expected) { assert.deepEqual(value, expected); tests += 1; }
function png(label) { return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]); }

function run(file, args = [], allowFailure = false) {
  const result = spawnSync(process.execPath, [path.join(scripts, file), ...args], { encoding: 'utf8', timeout: 30000 });
  if (!allowFailure && result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}

function writeEvidence(root) {
  for (const [observationId, label] of [['obs-start', 'home'], ['obs-end', 'profile']]) {
    const dir = path.join(root, 'runs', 'scan-flow', 'evidence', 'observations', observationId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'screenshot.png'), png(label));
  }
}

function writeSnapshot(root, graph) {
  const generationId = 'snapshot-flow-export-test';
  const dir = path.join(root, 'snapshots', 'generations', generationId);
  fs.mkdirSync(dir, { recursive: true });
  const map = { schemaVersion: 1, appKey: 'flow-export-demo', versionKey: 'build:1', contexts: { guest: graph } };
  const authDiff = { status: 'PARTIAL', missingContexts: ['authenticated'] };
  const unresolved = { schemaVersion: 1, items: [] };
  const metrics = { schemaVersion: 2, contexts: {}, execution: { schemaVersion: 1, totals: { runCount: 0 }, runs: [] }, merge: { policy: 'CANONICAL_MAP_ONLY', replacementCount: 0 }, normalization: { issueCount: 0, droppedWaitEdges: 0, prunedReachableStates: 0 } };
  writeJsonAtomic(path.join(dir, 'map.json'), map);
  writeJsonAtomic(path.join(dir, 'auth-diff.json'), authDiff);
  writeJsonAtomic(path.join(dir, 'unresolved.json'), unresolved);
  writeJsonAtomic(path.join(dir, 'metrics.json'), metrics);
  const manifest = { schemaVersion: 2, generationId, appKey: 'flow-export-demo', appVersion: '1.0', buildVersion: '1', versionKey: 'build:1', aggregationScope: 'CANONICAL_MAP', aggregationPolicy: 'CANONICAL_MAP_ONLY', mapRevisionId: null, mapRevisionIds: ['rev-1'], generatedAt: '2026-07-20T00:00:00.000+08:00', sourceRuns: [], sourcePlans: { guest: ['scan-flow'] }, missingContexts: ['authenticated'], status: 'PARTIAL', checksums: { map: checksum(map), authDiff: checksum(authDiff), unresolved: checksum(unresolved), metrics: checksum(metrics) } };
  writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  writeJsonAtomic(path.join(root, 'snapshots', 'current.json'), { schemaVersion: 1, generationId, relativePath: `generations/${generationId}`, manifestSha256: checksum(manifest), updatedAt: '2026-07-20T00:00:00.000+08:00' });
}

function baseGraph() {
  return {
    schemaVersion: 2,
    contextId: 'guest',
    logicalScreens: [
      { id: 'home', name: '首页', description: '', visualStateIds: ['vs-home'] },
      { id: 'profile', name: '我的', description: '', visualStateIds: ['vs-profile'] }
    ],
    visualStates: [
      { id: 'vs-home', logicalScreenKey: 'home', kind: 'full-screen', evidenceObservationRefs: [{ runId: 'scan-flow', observationId: 'obs-start' }] },
      { id: 'vs-profile', logicalScreenKey: 'profile', kind: 'full-screen', evidenceObservationRefs: [{ runId: 'scan-flow', observationId: 'obs-end' }] }
    ],
    reachableStates: [
      { id: 'rs-home', visualStateId: 'vs-home', depth: { pathDepth: 0, routeDepth: 0, modalDepth: 0 }, incomingEdgeIds: [], runnablePathEdgeIds: [], verifiedPathEdgeIds: [], replayPathEdgeIds: [], pathStatus: 'RUNNABLE_VERIFIED' },
      { id: 'rs-profile', visualStateId: 'vs-profile', depth: { pathDepth: 1, routeDepth: 1, modalDepth: 0 }, incomingEdgeIds: ['edge-profile'], runnablePathEdgeIds: ['edge-profile'], verifiedPathEdgeIds: [], replayPathEdgeIds: ['edge-profile'], pathStatus: 'RUNNABLE_UNVERIFIED' }
    ],
    edges: [
      {
        id: 'edge-profile',
        fromReachableStateId: 'rs-home',
        toReachableStateId: 'rs-profile',
        intent: { schemaVersion: 1, type: 'tap', target: '底部导航栏我的入口', selector: { text: '底部导航栏我的入口' } },
        locatorQuality: 'SEMANTIC_WITH_FALLBACK',
        locatorResolution: 'SEMANTIC_WITH_BOUNDS_FALLBACK',
        locatorEvidence: { schemaVersion: 1, locatorQuality: 'SEMANTIC_WITH_FALLBACK', resolution: 'SEMANTIC_WITH_BOUNDS_FALLBACK', matchedNode: { text: '底部导航栏我的入口', id: null, role: 'button', bounds: [0, 2100, 270, 2400] }, fallbackBounds: [0, 2100, 270, 2400], tapPoint: { x: 135, y: 2250 } },
        replayPolicy: 'AS_RECORDED',
        replayability: 'UNSTABLE',
        sideEffect: 'NONE',
        safety: { allowed: true },
        verification: { replayStatus: 'UNVERIFIED', transitionFingerprint: 'sha256:test', verificationRefs: [] },
        evidence: { sourceRunId: 'scan-flow', beforeObservationId: 'obs-start', afterObservationId: 'obs-end', actionResultId: 'action-1' },
        provenance: [{ runId: 'scan-flow', sourceId: 'edge-profile' }]
      }
    ],
    paths: [
      { id: 'path-root', contextId: 'guest', edgeIds: [], terminalReachableStateId: 'rs-home', canonical: true, runnable: true, pathStatus: 'RUNNABLE_VERIFIED', verifiedEdgeIds: [], verificationStatus: 'COLD_REPLAY_VERIFIED' },
      { id: 'path-profile', contextId: 'guest', edgeIds: ['edge-profile'], terminalReachableStateId: 'rs-profile', canonical: true, runnable: true, pathStatus: 'RUNNABLE_UNVERIFIED', verifiedEdgeIds: [], verificationStatus: 'UNVERIFIED' }
    ]
  };
}

try {
  const appMapRoot = path.join(temp, 'app-map');
  fs.mkdirSync(appMapRoot, { recursive: true });
  writeJsonAtomic(path.join(appMapRoot, 'app.json'), { schemaVersion: 1, appKey: 'flow-export-demo', platform: 'harmony', bundleName: 'com.example.flow', environment: 'test', defaultEntryAbility: 'EntryAbility' });
  writeEvidence(appMapRoot);
  writeSnapshot(appMapRoot, baseGraph());

  const listed = run('export-precondition-flow.js', ['list', '--app-map-root', appMapRoot, '--context', 'guest']).json;
  const profileCandidate = listed.candidates.find(item => item.terminalReachableStateId === 'rs-profile');
  check(Boolean(profileCandidate?.exportable), true);
  check(listed.candidates.some(item => item.terminalReachableStateId === 'rs-home' && item.reasons.includes('FLOW_PATH_EMPTY')), true);
  const unresolvedGraph = baseGraph();
  delete unresolvedGraph.edges[0].locatorEvidence.matchedNode;
  const manualSummary = summarizePathExportability(unresolvedGraph, { ...unresolvedGraph.paths[1], manualExport: true });
  check(manualSummary.exportable, true);
  check(manualSummary.warnings.includes('EDGE_LOCATOR_DEFERRED_RESOLUTION:edge-profile'), true);
  writeSnapshot(appMapRoot, unresolvedGraph);
  const deferred = run('export-precondition-flow.js', ['list', '--app-map-root', appMapRoot, '--context', 'guest']).json;
  check(deferred.candidates.some(item => item.terminalReachableStateId === 'rs-profile' && item.exportable === true && item.warnings.includes('EDGE_LOCATOR_DEFERRED_RESOLUTION:edge-profile')), true);
  writeSnapshot(appMapRoot, baseGraph());

  const preview = run('export-precondition-flow.js', ['preview', '--app-map-root', appMapRoot, '--context', 'guest', '--logical-name', '我的', '--name', '进入我的页', '--business', 'enter-profile-page']).json;
  check(preview.flow.name, '进入我的页');
  check(preview.flow.steps[0].action.target, '底部导航栏我的入口');
  check(preview.warnings.includes('EDGE_NOT_COLD_REPLAY_VERIFIED:edge-profile'), true);
  check(preview.warnings.includes('EDGE_HAS_COORDINATE_EVIDENCE_FALLBACK:edge-profile'), true);

  const workspace = path.join(temp, 'visual-test-workspace');
  const written = run('export-precondition-flow.js', ['write', '--app-map-root', appMapRoot, '--context', 'guest', '--path-id', profileCandidate.pathId, '--name', '进入我的页', '--business', 'enter-profile-page', '--workspace', workspace, '--include-coordinates', 'true']).json;
  const flowPath = path.join(workspace, 'enter-profile-page', 'harmony', 'flow.json');
  check(written.write.flowPath, flowPath);
  check(fs.existsSync(path.join(path.dirname(flowPath), 'assets', 'start.png')), true);
  check(fs.existsSync(path.join(path.dirname(flowPath), 'assets', 'end.png')), true);
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  check(flow.platform, 'harmony');
  check(flow.steps[0].action.coordinateSource, 'flow');
  check(run('export-precondition-flow.js', ['write', '--app-map-root', appMapRoot, '--context', 'guest', '--path-id', profileCandidate.pathId, '--name', '进入我的页', '--business', 'enter-profile-page', '--workspace', workspace], true).stderr.includes('FLOW_OUTPUT_EXISTS'), true);
  const rootCandidate = listed.candidates.find(item => item.terminalReachableStateId === 'rs-home');
  check(run('export-precondition-flow.js', ['preview', '--app-map-root', appMapRoot, '--context', 'guest', '--path-id', rootCandidate.pathId, '--name', '进入首页'], true).stderr.includes('FLOW_PATH_NOT_EXPORTABLE'), true);

  console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'flow-export', tests, tempRoot: temp }, null, 2));
} finally {
  if (!process.env.SMAP_KEEP_SELF_TEST) fs.rmSync(temp, { recursive: true, force: true });
}

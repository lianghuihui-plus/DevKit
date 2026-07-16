#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, assertAbsolute, ensureDir, emptyGraph, writeJsonAtomic, hashObject, output, main, fail } = require('./lib/common');
const { updateCanonicalPaths } = require('./lib/graph-store');
const { runContextIds, isV3 } = require('./lib/run-protocol');

function timeline(scanDir) {
  const ids = new Set();
  return fs.readFileSync(path.join(scanDir, 'timeline.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    let record; try { record = JSON.parse(line); } catch (error) { fail(`Invalid timeline line ${index + 1}: ${error.message}`, 'TIMELINE_INVALID'); }
    if (ids.has(record.eventId)) fail(`Duplicate eventId: ${record.eventId}`, 'TIMELINE_INVALID'); ids.add(record.eventId); return record;
  });
}

function upsert(items, item) { const index = items.findIndex(x => x.id === item.id); if (index >= 0) items[index] = item; else items.push(item); }

function legacyRebuild(scanDir, out, scan, events) {
  const contexts = Object.fromEntries(runContextIds(scan).map(id => [id, { graph: emptyGraph(id), frontier: { schemaVersion: 1, contextId: id, items: [] }, cursor: null }]));
  for (const record of events) {
    const target = contexts[record.contextId]; if (!target) continue;
    if (record.type === 'attemptCommitted' && record.commitProjection) { const projection = record.commitProjection; upsert(target.graph.logicalScreens, projection.logicalScreen); upsert(target.graph.visualStates, projection.visualState); upsert(target.graph.reachableStates, projection.reachableState); upsert(target.graph.edges, projection.edge); upsert(target.frontier.items, projection.frontierItem); if (projection.cursor) target.cursor = projection.cursor; }
    else if (record.type === 'cursorEstablished' && record.cursor) target.cursor = record.cursor;
    else if (record.type === 'cursorInvalidated' && record.cursor) target.cursor = record.cursor;
    else if (record.type === 'visualStateUpserted' && record.logicalScreen && record.visualState) { upsert(target.graph.logicalScreens, record.logicalScreen); upsert(target.graph.visualStates, record.visualState); }
    else if (record.type === 'reachableStateUpserted' && record.reachableState) upsert(target.graph.reachableStates, record.reachableState);
    else if (record.type === 'edgeRecorded' && record.edge) upsert(target.graph.edges, record.edge);
    else if (record.type === 'candidatesRecorded') for (const item of record.items || []) upsert(target.frontier.items, item);
    else if (record.type === 'frontierClaimed' && record.item) upsert(target.frontier.items, record.item);
    else if (record.type === 'frontierResolved' && record.item) upsert(target.frontier.items, record.item);
  }
  const comparisons = {};
  for (const [contextId, rebuilt] of Object.entries(contexts)) {
    for (const state of rebuilt.graph.reachableStates) state.incomingEdgeIds = rebuilt.graph.edges.filter(x => x.toReachableStateId === state.id).map(x => x.id); updateCanonicalPaths(rebuilt.graph);
    const dir = path.join(out, 'contexts', contextId); ensureDir(dir); writeJsonAtomic(path.join(dir, 'graph.json'), rebuilt.graph); writeJsonAtomic(path.join(dir, 'frontier.json'), rebuilt.frontier); if (rebuilt.cursor) writeJsonAtomic(path.join(dir, 'live-cursor.json'), rebuilt.cursor);
    const currentGraph = JSON.parse(fs.readFileSync(path.join(scanDir, 'contexts', contextId, 'graph.json'), 'utf8')); const currentFrontier = JSON.parse(fs.readFileSync(path.join(scanDir, 'contexts', contextId, 'frontier.json'), 'utf8')); const currentCursor = isV3(scan) ? JSON.parse(fs.readFileSync(path.join(scanDir, 'contexts', contextId, 'live-cursor.json'), 'utf8')) : null;
    comparisons[contextId] = { graphEquivalent: hashObject(rebuilt.graph) === hashObject(currentGraph), frontierEquivalent: hashObject(rebuilt.frontier) === hashObject(currentFrontier), cursorEquivalent: !isV3(scan) || hashObject(rebuilt.cursor) === hashObject(currentCursor) };
  }
  return { comparisons, equivalent: Object.values(comparisons).every(item => item.graphEquivalent && item.frontierEquivalent && item.cursorEquivalent !== false), projectedPaths: [] };
}

function criticalProjection(relative) {
  return /^(scan\.json|target\.json|plan\.json|continuation\.json|contexts\/[^/]+\/(context|graph|frontier|metrics|live-cursor|verification-queue|back-capabilities)\.json|attempts\/[^/]+\.json|operations\/[^/]+\.json|evidence\/navigations\/[^/]+\.json)$/.test(relative);
}

function protocolV2Rebuild(scanDir, out, events) {
  const store = require('./lib/event-store'); const projectedPaths = new Set();
  for (const record of events) {
    const ops = record.projectionOps || []; store.applyProjectionOps(out, ops); for (const op of ops) projectedPaths.add(op.path);
  }
  const comparisons = {};
  for (const relative of [...projectedPaths].filter(criticalProjection).sort()) {
    const rebuilt = path.join(out, relative); const current = path.join(scanDir, relative); const equivalent = fs.existsSync(rebuilt) && fs.existsSync(current) && hashObject(JSON.parse(fs.readFileSync(rebuilt, 'utf8'))) === hashObject(JSON.parse(fs.readFileSync(current, 'utf8')));
    comparisons[relative] = { equivalent };
  }
  return { comparisons, equivalent: Object.values(comparisons).every(item => item.equivalent), projectedPaths: [...projectedPaths].sort() };
}

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const out = assertAbsolute(required(args, 'outputDir'), '--output-dir');
  const relative = path.relative(scanDir, out); if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail('Rebuild output must be outside the immutable Run directory', 'PATH_INSIDE_RUN');
  if (fs.existsSync(out) && fs.readdirSync(out).length) fail('Rebuild output directory must be empty', 'REBUILD_OUTPUT_NOT_EMPTY'); ensureDir(out);
  const scan = loadScan(scanDir); const events = timeline(scanDir); const result = Number(scan.projectionProtocolVersion || 1) >= 2 ? protocolV2Rebuild(scanDir, out, events) : legacyRebuild(scanDir, out, scan, events);
  const manifest = { schemaVersion: 2, scanId: scan.scanId, sourceTimeline: path.join(scanDir, 'timeline.jsonl'), eventCount: events.length, projectionProtocolVersion: Number(scan.projectionProtocolVersion || 1), equivalent: result.equivalent, projectedPaths: result.projectedPaths, comparisons: result.comparisons };
  writeJsonAtomic(path.join(out, 'rebuild-manifest.json'), manifest); output({ schemaVersion: 2, ok: result.equivalent, outputDir: out, ...manifest });
});

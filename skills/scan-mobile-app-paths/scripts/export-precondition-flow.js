#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, bool, assertAbsolute, readJson, output, main, fail, safeSegment } = require('./lib/common');
const { checksum, listPathCandidates, selectPath, buildFlowFromPath, flowOutputLayout, writeFlowAssets } = require('./lib/precondition-flow-exporter');
const { updateCanonicalPaths } = require('./lib/graph-store');

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function loadChecked(file, expected, label) {
  const value = readJson(file);
  if (checksum(value) !== expected) fail(`${label} checksum does not match Snapshot manifest`, 'FLOW_SOURCE_CHECKSUM_INVALID');
  return value;
}

function loadSnapshot(appMapRoot) {
  const root = assertAbsolute(appMapRoot, '--app-map-root');
  const app = readJson(path.join(root, 'app.json'));
  const snapshotsRoot = path.join(root, 'snapshots');
  const pointer = readJson(path.join(snapshotsRoot, 'current.json'));
  const generationId = safeSegment(pointer.generationId, 'generationId');
  let generationDir = path.resolve(snapshotsRoot, String(pointer.relativePath || ''));
  if (!inside(snapshotsRoot, generationDir) || path.basename(generationDir) !== generationId || path.basename(path.dirname(generationDir)) !== 'generations') fail('Snapshot pointer escapes the generations directory', 'FLOW_SOURCE_INVALID');
  const realSnapshotsRoot = fs.realpathSync(snapshotsRoot);
  generationDir = fs.realpathSync(generationDir);
  if (!inside(realSnapshotsRoot, generationDir)) fail('Snapshot generation resolves outside snapshots root', 'FLOW_SOURCE_INVALID');
  const manifest = readJson(path.join(generationDir, 'manifest.json'));
  if (manifest.generationId !== generationId || checksum(manifest) !== pointer.manifestSha256) fail('Snapshot pointer manifest verification failed', 'FLOW_SOURCE_CHECKSUM_INVALID');
  if (!manifest.checksums?.map) fail('Snapshot manifest lacks map checksum', 'FLOW_SOURCE_INVALID');
  const map = loadChecked(path.join(generationDir, 'map.json'), manifest.checksums.map, 'map.json');
  return { appMapRoot: root, app, pointer, manifest, generationDir, map };
}

function loadContextGraph(snapshot, contextId) {
  const graph = snapshot.map.contexts?.[contextId];
  if (!graph) fail(`Snapshot has no ${contextId} context graph`, 'FLOW_CONTEXT_MISSING');
  updateCanonicalPaths(graph);
  return graph;
}

function selectorFromArgs(args) {
  return {
    pathId: args.pathId || null,
    terminalReachableStateId: args.terminalReachableStateId || null,
    logicalScreenId: args.logicalScreenId || null,
    logicalName: args.logicalName || null
  };
}

function selectedExportPlan(snapshot, graph, args) {
  const pathItem = selectPath(graph, selectorFromArgs(args));
  const platform = args.platform || 'harmony';
  const business = args.business || null;
  return buildFlowFromPath({
    graph,
    pathItem,
    name: required(args, 'name'),
    business,
    flowId: args.id || null,
    platform,
    startDescription: args.startDescription || null,
    endDescription: args.endDescription || null,
    includeCoordinates: bool(args.includeCoordinates, false)
  });
}

function outputPreview({ snapshot, graph, exportPlan, workspace = null }) {
  const layout = workspace ? flowOutputLayout(workspace, exportPlan.business, exportPlan.platform) : null;
  return {
    schemaVersion: 1,
    ok: true,
    command: 'preview',
    source: {
      appMapRoot: snapshot.appMapRoot,
      generationId: snapshot.manifest.generationId,
      sourceManifestSha256: snapshot.pointer.manifestSha256,
      contextId: graph.contextId,
      pathId: exportPlan.source.pathId
    },
    flow: exportPlan.flow,
    business: exportPlan.business,
    platform: exportPlan.platform,
    warnings: exportPlan.source.warnings,
    output: layout ? { flowPath: layout.flowJsonPath, assetsDir: layout.assetsDir } : null
  };
}

main(() => {
  const args = parseArgs();
  const command = args._[0] || 'list';
  if (!['list', 'preview', 'write'].includes(command)) fail(`Unknown precondition Flow export command: ${command}`, 'COMMAND_INVALID');
  const snapshot = loadSnapshot(required(args, 'appMapRoot'));
  if (snapshot.app.platform !== 'harmony') fail('Precondition Flow export currently supports Harmony app maps only', 'FLOW_APP_PLATFORM_UNSUPPORTED');
  const contextId = args.context || 'guest';
  if (!['guest', 'authenticated'].includes(contextId)) fail('--context must be guest or authenticated', 'CONTEXT_INVALID');
  const graph = loadContextGraph(snapshot, contextId);

  if (command === 'list') {
    output({
      schemaVersion: 1,
      ok: true,
      command,
      source: { appMapRoot: snapshot.appMapRoot, generationId: snapshot.manifest.generationId, sourceManifestSha256: snapshot.pointer.manifestSha256, contextId },
      candidates: listPathCandidates(graph)
    });
    return;
  }

  const exportPlan = selectedExportPlan(snapshot, graph, args);
  if (command === 'preview') {
    output(outputPreview({ snapshot, graph, exportPlan, workspace: args.workspace ? assertAbsolute(args.workspace, '--workspace') : null }));
    return;
  }

  required(args, 'business');
  const workspace = assertAbsolute(required(args, 'workspace'), '--workspace');
  const writeResult = writeFlowAssets({
    appMapRoot: snapshot.appMapRoot,
    workspace,
    exportPlan,
    overwrite: bool(args.overwrite, false),
    validateTarget: !bool(args.skipTargetValidation, false)
  });
  output({ ...outputPreview({ snapshot, graph, exportPlan, workspace }), command, write: writeResult });
});

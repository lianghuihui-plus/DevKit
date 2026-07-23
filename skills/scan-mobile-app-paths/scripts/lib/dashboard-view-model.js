'use strict';

const fs = require('fs');
const path = require('path');
const { fail, safeSegment } = require('./common');
const { assertConsumableGraph } = require('./graph-normalization');
const { label, actionLabel, localizeIssue } = require('./dashboard-localization');
const { summarizePathExportability } = require('./precondition-flow-exporter');
const { edgeRunnableReason, isRunnableEdge } = require('./replayability');
const { updateCanonicalPaths } = require('./graph-store');

const REPLAY_RANK = { STABLE: 0, CONDITIONAL: 1, UNSTABLE: 2 };
const VERIFICATION_RANK = { COLD_REPLAY_VERIFIED: 0, UNVERIFIED: 1, REPLAY_UNSTABLE: 2, INVALIDATED: 3 };

function edgeVisualState(replayStatus = 'UNVERIFIED') {
  if (replayStatus === 'COLD_REPLAY_VERIFIED') return { visualStatus: 'VERIFIED', visualStatusLabel: '冷启动已验证', lineStyle: 'verified', tone: 'green' };
  if (replayStatus === 'REPLAY_UNSTABLE') return { visualStatus: 'REPLAY_UNSTABLE', visualStatusLabel: label('replayStatus', replayStatus, '重放不稳定'), lineStyle: 'unstable', tone: 'amber' };
  if (replayStatus === 'INVALIDATED') return { visualStatus: 'INVALIDATED', visualStatusLabel: label('replayStatus', replayStatus, '验证已失效'), lineStyle: 'invalidated', tone: 'red' };
  return { visualStatus: 'UNVERIFIED', visualStatusLabel: label('replayStatus', replayStatus, '未验证'), lineStyle: 'unverified', tone: 'default' };
}

function unique(items, keyFn = item => JSON.stringify(item)) {
  const seen = new Set(); return items.filter(item => { const key = keyFn(item); if (seen.has(key)) return false; seen.add(key); return true; });
}

function screenshotDataUrl(file) {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

function observationEvidence(appMapRoot, runIdValue, observationIdValue, { embedScreenshot = false } = {}) {
  const runId = safeSegment(runIdValue, 'evidence runId'); const observationId = safeSegment(observationIdValue, 'evidence observationId');
  const relative = path.join('runs', runId, 'evidence', 'observations', observationId); const absolute = path.join(appMapRoot, relative);
  for (const name of ['observation.json', 'screenshot.png', 'layout.json']) if (!fs.existsSync(path.join(absolute, name))) fail(`Dashboard evidence is missing: ${relative}/${name}`, 'DASHBOARD_EVIDENCE_MISSING');
  const encoded = ['..', 'runs', encodeURIComponent(runId), 'evidence', 'observations', encodeURIComponent(observationId)];
  const evidence = { runId, observationId, screenshotUrl: `${encoded.join('/')}/screenshot.png`, observationUrl: `${encoded.join('/')}/observation.json`, layoutUrl: `${encoded.join('/')}/layout.json` };
  if (embedScreenshot) evidence.screenshotDataUrl = screenshotDataUrl(path.join(absolute, 'screenshot.png'));
  return evidence;
}

function resolveAuthDiff(authDiff, screenNames) {
  const names = ids => (ids || []).map(id => ({ id, name: screenNames.get(id) || id }));
  if (authDiff.status !== 'READY') return { status: authDiff.status, statusLabel: label('authDiffStatus', authDiff.status, '数据不完整'), missingContexts: authDiff.missingContexts || [], missingContextLabels: (authDiff.missingContexts || []).map(id => label('context', id)), common: [], guestOnly: [], authenticatedOnly: [] };
  return { status: 'READY', statusLabel: label('authDiffStatus', 'READY'), missingContexts: [], missingContextLabels: [], common: names(authDiff.commonLogicalScreens), guestOnly: names(authDiff.guestOnlyLogicalScreens), authenticatedOnly: names(authDiff.authenticatedOnlyLogicalScreens) };
}

function frontierSummary(counts = {}) {
  return {
    explored: Number(counts.EXPLORED || 0),
    coveredByGroup: Number(counts.COVERED_BY_GROUP || 0),
    skipped: Number(counts.SKIPPED || 0),
    open: Number(counts.PENDING || 0) + Number(counts.CLAIMED || 0) + Number(counts.RETRYABLE || 0),
    blocked: Number(counts.BLOCKED || 0),
    failed: Number(counts.FAILED || 0)
  };
}

function buildExecution(execution = {}) {
  const resolveTotals = totals => ({ ...totals, frontier: frontierSummary(totals?.frontierCounts) });
  const runs = (execution.runs || []).map(run => ({
    ...run,
    statusLabel: label('runStatus', run.status, '未知状态'),
    scanModeLabel: label('scanMode', run.scanMode, '其他模式'),
    scanScopeLabel: label('scanScope', run.scanScope, '其他范围'),
    profileLabel: label('profile', run.profile, '自定义'),
    contextLabels: (run.contexts || []).map(context => label('context', context.contextId, '其他登录态')),
    contexts: (run.contexts || []).map(context => ({ ...context, contextLabel: label('context', context.contextId, '其他登录态'), frontier: frontierSummary(context.frontierCounts) })),
    totals: resolveTotals(run.totals || {})
  }));
  return { schemaVersion: 1, totals: resolveTotals(execution.totals || { runCount: runs.length }), runs };
}

function discoveryPath(graph, targetReachableStateId) {
  const roots = (graph.reachableStates || []).filter(state => Number(state.depth?.pathDepth || 0) === 0).map(state => state.id).sort();
  if (!roots.length) return null;
  if (roots.includes(targetReachableStateId)) return [];
  const queue = roots.map(stateId => ({ stateId, edgeIds: [] }));
  const visited = new Set(roots);
  while (queue.length) {
    const current = queue.shift();
    const outgoing = (graph.edges || []).filter(edge => edge.fromReachableStateId === current.stateId && isRunnableEdge(edge)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const edge of outgoing) {
      if (visited.has(edge.toReachableStateId)) continue;
      const edgeIds = [...current.edgeIds, edge.id];
      if (edge.toReachableStateId === targetReachableStateId) return edgeIds;
      visited.add(edge.toReachableStateId);
      queue.push({ stateId: edge.toReachableStateId, edgeIds });
    }
  }
  return null;
}

function dashboardPaths(graph) {
  const paths = [...(graph.paths || [])];
  const represented = new Set(paths.map(pathItem => pathItem.terminalReachableStateId));
  for (const state of graph.reachableStates || []) {
    if (represented.has(state.id)) continue;
    const edgeIds = discoveryPath(graph, state.id);
    if (!edgeIds || !edgeIds.length) continue;
    paths.push({
      id: `manual-path-${String(state.id).replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
      contextId: graph.contextId,
      edgeIds,
      terminalReachableStateId: state.id,
      canonical: false,
      manualExport: true
    });
    represented.add(state.id);
  }
  return paths;
}

function buildContext(appMapRoot, contextId, graph) {
  updateCanonicalPaths(graph);
  assertConsumableGraph(graph, fail);
  const logicalById = new Map(graph.logicalScreens.map(item => [item.id, item])); const visualById = new Map(graph.visualStates.map(item => [item.id, item])); const stateById = new Map(graph.reachableStates.map(item => [item.id, item])); const edgeById = new Map(graph.edges.map(item => [item.id, item]));
  const evidenceCache = new Map(); const evidenceFor = (ref, options = {}) => { const key = `${ref.runId}/${ref.observationId}/${options.embedScreenshot === true ? 'embedded' : 'linked'}`; if (!evidenceCache.has(key)) evidenceCache.set(key, observationEvidence(appMapRoot, ref.runId, ref.observationId, options)); return evidenceCache.get(key); };
  const visualEvidence = visual => unique((visual.evidenceObservationRefs || []).map(evidenceFor), item => `${item.runId}/${item.observationId}`);
  const logicalNodes = graph.logicalScreens.map(logical => {
    const visuals = graph.visualStates.filter(item => item.logicalScreenKey === logical.id); const visualIds = new Set(visuals.map(item => item.id)); const states = graph.reachableStates.filter(item => visualIds.has(item.visualStateId)); const stateIds = new Set(states.map(item => item.id)); const kinds = unique(visuals.map(item => item.kind || 'full-screen')); const depths = states.map(item => item.depth?.pathDepth || 0); const incoming = graph.edges.filter(item => isRunnableEdge(item) && stateIds.has(item.toReachableStateId)); const outgoing = graph.edges.filter(item => isRunnableEdge(item) && stateIds.has(item.fromReachableStateId));
    const kind = kinds.length === 1 ? kinds[0] : 'mixed';
    return { id: logical.id, label: logical.name, description: logical.description || '', kind, kindLabel: label('kind', kind), kinds, kindLabels: kinds.map(value => label('kind', value)), depth: depths.length ? Math.min(...depths) : 0, maxDepth: depths.length ? Math.max(...depths) : 0, root: states.some(item => (item.depth?.pathDepth || 0) === 0), visualStateIds: visuals.map(item => item.id), reachableStateIds: states.map(item => item.id), visualStateCount: visuals.length, reachableStateCount: states.length, incomingEdgeIds: incoming.map(item => item.id), outgoingEdgeIds: outgoing.map(item => item.id), evidence: unique(visuals.flatMap(visualEvidence), item => `${item.runId}/${item.observationId}`) };
  });
  const logicalForState = stateId => { const state = stateById.get(stateId); return state ? visualById.get(state.visualStateId)?.logicalScreenKey : null; };
  const logicalEdgeGroups = new Map();
  for (const edge of graph.edges) {
    if (!isRunnableEdge(edge)) continue;
    const from = logicalForState(edge.fromReachableStateId); const to = logicalForState(edge.toReachableStateId); if (!from || !to) continue; const key = `${from}->${to}`;
    let item = logicalEdgeGroups.get(key); if (!item) { item = { id: `logical-edge-${logicalEdgeGroups.size + 1}`, from, to, edgeIds: [], actions: [], replayability: 'STABLE', replayStatus: 'COLD_REPLAY_VERIFIED', risks: [], count: 0 }; logicalEdgeGroups.set(key, item); }
    const replayStatus = edge.verification?.replayStatus || 'UNVERIFIED'; item.edgeIds.push(edge.id); item.actions.push(actionLabel(edge.intent)); item.risks.push(edge.risk || 'UNKNOWN'); item.count += 1; if ((REPLAY_RANK[edge.replayability] ?? 2) > (REPLAY_RANK[item.replayability] ?? 0)) item.replayability = edge.replayability || 'UNSTABLE'; if ((VERIFICATION_RANK[replayStatus] ?? 1) > (VERIFICATION_RANK[item.replayStatus] ?? 0)) item.replayStatus = replayStatus;
  }
  const logicalEdges = [...logicalEdgeGroups.values()].map(item => ({ ...item, ...edgeVisualState(item.replayStatus), actions: unique(item.actions), risks: unique(item.risks), replayabilityLabel: label('replayability', item.replayability, '未知'), replayStatusLabel: label('replayStatus', item.replayStatus, '未知'), riskLabels: unique(item.risks).map(value => label('risk', value, '未知')) }));
  const reachableNodes = graph.reachableStates.map(state => { const visual = visualById.get(state.visualStateId); const logical = visual && logicalById.get(visual.logicalScreenKey); const kind = visual?.kind || 'full-screen'; const pathStatus = state.pathStatus || 'NOT_RUNNABLE'; return { id: state.id, label: logical?.name || visual?.name || state.id, description: logical?.description || '', kind, kindLabel: label('kind', kind), depth: state.depth?.pathDepth || 0, routeDepth: state.depth?.routeDepth || 0, modalDepth: state.depth?.modalDepth || 0, root: (state.depth?.pathDepth || 0) === 0, logicalScreenId: visual?.logicalScreenKey || null, visualStateId: state.visualStateId, incomingEdgeIds: graph.edges.filter(item => isRunnableEdge(item) && item.toReachableStateId === state.id).map(item => item.id), outgoingEdgeIds: graph.edges.filter(item => isRunnableEdge(item) && item.fromReachableStateId === state.id).map(item => item.id), runnablePathEdgeIds: state.runnablePathEdgeIds || state.replayPathEdgeIds || [], verifiedPathEdgeIds: state.verifiedPathEdgeIds || [], replayPathEdgeIds: state.replayPathEdgeIds || [], pathStatus, pathStatusLabel: label('pathStatus', pathStatus, '未知'), arrivalSignature: state.arrivalSignature || {}, evidence: visual ? visualEvidence(visual) : [] }; });
  const reachableEdges = graph.edges.filter(isRunnableEdge).map(edge => {
    const sourceRunId = edge.evidence?.sourceRunId || edge.provenance?.[0]?.runId; const before = sourceRunId && edge.evidence?.beforeObservationId ? evidenceFor({ runId: sourceRunId, observationId: edge.evidence.beforeObservationId }, { embedScreenshot: true }) : null; const after = sourceRunId && edge.evidence?.afterObservationId ? evidenceFor({ runId: sourceRunId, observationId: edge.evidence.afterObservationId }, { embedScreenshot: true }) : null;
    const replayability = edge.replayability || 'UNSTABLE'; const replayStatus = edge.verification?.replayStatus || 'UNVERIFIED'; const risk = edge.risk || 'UNKNOWN'; const sideEffect = edge.sideEffect || 'NONE'; const replayPolicy = edge.replayPolicy || 'REPEATABLE';
    const locatorQuality = edge.locatorQuality || 'UNRESOLVED';
    const runnableReason = edgeRunnableReason(edge);
    return { id: edge.id, from: edge.fromReachableStateId, to: edge.toReachableStateId, label: actionLabel(edge.intent), intent: edge.intent || {}, runnable: !runnableReason, runnableReason, locatorQuality, locatorQualityLabel: label('locatorQuality', locatorQuality, '未知'), replayability, replayabilityLabel: label('replayability', replayability, '未知'), replayStatus, replayStatusLabel: label('replayStatus', replayStatus, '未知'), ...edgeVisualState(replayStatus), risk, riskLabel: label('risk', risk, '未知'), sideEffect, sideEffectLabel: label('sideEffect', sideEffect, '未知'), replayPolicy, replayPolicyLabel: label('replayPolicy', replayPolicy, '未知'), evidence: { before, after, actionResultId: edge.evidence?.actionResultId || null }, provenance: edge.provenance || [] };
  });
  const paths = dashboardPaths(graph).map(item => {
    const terminal = stateById.get(item.terminalReachableStateId); const visual = terminal && visualById.get(terminal.visualStateId); const logical = visual && logicalById.get(visual.logicalScreenKey); const steps = (item.edgeIds || []).map(id => edgeById.get(id)).filter(Boolean).map(edge => { const replayability = edge.replayability || 'UNSTABLE'; const replayStatus = edge.verification?.replayStatus || 'UNVERIFIED'; const locatorQuality = edge.locatorQuality || 'UNRESOLVED'; return { edgeId: edge.id, label: actionLabel(edge.intent), from: edge.fromReachableStateId, to: edge.toReachableStateId, locatorQuality, locatorQualityLabel: label('locatorQuality', locatorQuality, '未知'), replayability, replayabilityLabel: label('replayability', replayability, '未知'), replayStatus, replayStatusLabel: label('replayStatus', replayStatus, '未知') }; });
    const flowExport = summarizePathExportability(graph, item);
    return { id: item.id, terminalReachableStateId: item.terminalReachableStateId, terminalLogicalScreenId: visual?.logicalScreenKey || null, terminalLabel: logical?.name || item.terminalReachableStateId, canonical: item.canonical === true, manualExport: item.manualExport === true, runnable: item.runnable !== false, pathStatus: item.pathStatus || terminal?.pathStatus || 'RUNNABLE_UNVERIFIED', pathStatusLabel: label('pathStatus', item.pathStatus || terminal?.pathStatus || 'RUNNABLE_UNVERIFIED', '未知'), edgeIds: item.edgeIds || [], steps, flowExport };
  });
  const maxDepth = Math.max(0, ...reachableNodes.map(item => item.depth));
  return { id: contextId, label: label('context', contextId), summary: { logicalScreens: logicalNodes.length, visualStates: graph.visualStates.length, reachableStates: reachableNodes.length, edges: reachableEdges.length, verifiedEdges: reachableEdges.filter(edge => edge.replayStatus === 'COLD_REPLAY_VERIFIED').length, unstableEdges: reachableEdges.filter(edge => edge.replayStatus === 'REPLAY_UNSTABLE').length, canonicalPaths: paths.length, maxDepth }, logicalGraph: { nodes: logicalNodes, edges: logicalEdges }, reachableGraph: { nodes: reachableNodes, edges: reachableEdges }, paths };
}

function buildDashboardViewModel({ appMapRoot, app, pointer, manifest, map, metrics, authDiff, unresolved, templateSha256 }) {
  const contexts = Object.entries(map.contexts || {}).map(([id, graph]) => buildContext(appMapRoot, id, graph)); const screenNames = new Map();
  for (const context of contexts) for (const node of context.logicalGraph.nodes) if (!screenNames.has(node.id)) screenNames.set(node.id, node.label);
  const totals = contexts.reduce((sum, context) => ({ logicalScreens: sum.logicalScreens + context.summary.logicalScreens, visualStates: sum.visualStates + context.summary.visualStates, reachableStates: sum.reachableStates + context.summary.reachableStates, edges: sum.edges + context.summary.edges, verifiedEdges: sum.verifiedEdges + context.summary.verifiedEdges, unstableEdges: sum.unstableEdges + context.summary.unstableEdges, canonicalPaths: sum.canonicalPaths + context.summary.canonicalPaths }), { logicalScreens: 0, visualStates: 0, reachableStates: 0, edges: 0, verifiedEdges: 0, unstableEdges: 0, canonicalPaths: 0 });
  return { schemaVersion: 1, locale: 'zh-CN', meta: { appKey: app.appKey, bundleName: app.bundleName, environment: app.environment, environmentLabel: label('environment', app.environment, '自定义环境'), platform: app.platform, platformLabel: label('platform', app.platform, '其他平台'), generationId: manifest.generationId, generationLabel: `地图版本 ${String(manifest.generationId).replace(/^snapshot-/, '')}`, snapshotStatus: manifest.status, snapshotStatusLabel: label('snapshotStatus', manifest.status, '未知状态'), versionKey: manifest.versionKey, appVersion: manifest.appVersion, buildVersion: manifest.buildVersion, snapshotGeneratedAt: manifest.generatedAt, sourceManifestSha256: pointer.manifestSha256, templateSha256, missingContexts: manifest.missingContexts || [], missingContextLabels: (manifest.missingContexts || []).map(id => label('context', id, '其他登录态')) }, overview: { ...totals, contextCount: contexts.length, unresolvedCount: (unresolved.items || []).length, metrics }, execution: buildExecution(metrics.execution), contexts, authDiff: resolveAuthDiff(authDiff, screenNames), unresolved: (unresolved.items || []).map(localizeIssue), semantics: { coverage: '当前看板展示已发现且具备可执行路径数据的地图，不代表应用的绝对页面覆盖率。', paths: '同一语义路径使用最新有效记录，未被后续扫描涉及的路径继续保留；路径表示每个可达状态的规范重放步骤。', execution: '执行情况来自当前 Snapshot 已校验的来源 Run；自动扫描活动时间不包含人工暂停时间。' } };
}

module.exports = { buildDashboardViewModel, actionLabel };

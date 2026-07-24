#!/usr/bin/env node
'use strict';

const path = require('path');
const crypto = require('crypto');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, jsonArg, nextId, hashObject, now, commitEvent, commitEventLocked, readJson, contextDir, output, main, fail, withRunLock } = require('./lib/common');
const { FRONTIER_STATUSES } = require('./lib/schema');
const { budgetUsage, exhausted } = require('./lib/budget');
const exploration = require('./strategies/exploration');
const goal = require('./strategies/goal-directed');
const { validateGraphCandidate } = require('./lib/schema');
const { assessAction } = require('./lib/safety');
const { isCurrentRun, activeContextId, runBudget, graphProtocolVersion } = require('./lib/run-protocol');
const scheduler = require('./lib/frontier-scheduler');
const { nextWork } = require('./lib/work-scheduler');
const { makeFrontierItem, frontierUpsertOp } = require('./lib/frontier-store');

main(() => {
  const args = parseArgs(); const command = args._[0] || 'list'; const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: !['list', 'list-imports'].includes(command) }); const contextId = args.context || activeContextId(scan);
  if (!contextId) fail('--context is required when no active context exists', 'CONTEXT_REQUIRED');
  const frontier = loadFrontier(scanDir, contextId);
  if (command === 'list') return output(frontier);
  if (command === 'add') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Frontier mutation requires the active SCANNING context', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const from = required(args, 'fromReachableStateId');
    const candidate = jsonArg(required(args, 'candidate'), null, 'candidate JSON');
    const result = makeFrontierItem({ scanDir, scan, contextId, graph, frontier, fromReachableStateId: from, candidate, candidateGroupKey: args.candidateGroupKey || null, priority: jsonArg(args.priority, {}, 'priority JSON'), sourceFrontierId: args.sourceFrontierId || null });
    if (!result.ok || !result.created) return output({ schemaVersion: 1, ok: result.ok, created: false, reasonCode: result.reasonCode || null, item: result.item || null, safety: result.safety || null });
    frontier.items.push(result.item); commitEvent(scanDir, 'candidatesRecorded', { contextId, frontierIds: [result.item.id], fromReachableStateId: from, items: [result.item] }, [frontierUpsertOp(contextId, result.item)]);
    return output({ schemaVersion: 1, ok: true, created: true, item: result.item });
  }
  if (command === 'claim') {
    const reservedNavigationExecutionId = nextId(scanDir, 'navigationExecution', 'navexec');
    const result = withRunLock(scanDir, () => {
      const currentScan = loadScan(scanDir, { mutable: true });
      if (currentScan.status !== 'SCANNING' || activeContextId(currentScan) !== contextId) fail('Frontier claim requires the active SCANNING context', 'RUN_STATE_INVALID');
      const currentFrontier = loadFrontier(scanDir, contextId); const strategy = currentScan.strategy === 'goal-directed' ? goal : exploration;
      const graph = loadGraph(scanDir, contextId); const runtime = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {});
      const usage = budgetUsage(currentScan, graph, currentFrontier, runtime); const budgetState = exhausted(runBudget(currentScan, contextId), usage, graphProtocolVersion(currentScan));
      const work = isCurrentRun(currentScan) && !budgetState.exhausted ? nextWork({ scanDir, scan: currentScan, contextId, graph, frontier: currentFrontier, metrics: runtime }) : null;
      const decision = budgetState.exhausted ? { decision: 'STOP', reasonCode: budgetState.reasonCode, suggestedTerminalStatus: 'PARTIAL', budgetState } : work?.decision === 'VERIFY' ? { decision: 'VERIFY', reasonCode: work.reasonCode, verification: work.verification, estimate: work.estimate } : work?.decision === 'STOP' ? work : isCurrentRun(currentScan) ? scheduler.schedule({ scanDir, scan: currentScan, contextId, graph, frontier: currentFrontier }) : strategy.decideNext({ frontier: currentFrontier.items, budgetState });
      if (decision.decision !== 'CONTINUE') return { decision };
      const item = currentFrontier.items.find(x => x.id === decision.frontierId); item.status = 'CLAIMED'; item.attempts += 1; item.claimedAt = now(); item.claimToken = crypto.randomUUID(); item.claimedAttemptId = null; item.cursorEpoch = decision.navigationPlan?.cursorEpoch ?? null; item.navigationPlanId = decision.navigationPlan?.navigationPlanId || null; item.navigationPlan = decision.navigationPlan || null; item.navigationExecutionId = decision.navigationPlan ? reservedNavigationExecutionId : null;
      const navigationExecution = decision.navigationPlan ? { ...decision.navigationPlan, schemaVersion: 2, navigationExecutionId: item.navigationExecutionId, requestedMode: decision.navigationPlan.mode, actualMode: null, fallbackFrom: null, fallbackReason: null, status: 'PLANNED', createdAt: now(), startedAt: null, finishedAt: null, terminalObservationId: null, restoreId: null, executedSteps: [] } : null;
      const ops = [{ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item, fallback: { schemaVersion: 1, contextId, items: [] } }]; if (navigationExecution) ops.push({ path: `evidence/navigations/${navigationExecution.navigationExecutionId}.json`, op: 'REPLACE', value: navigationExecution });
      commitEventLocked(scanDir, 'frontierClaimed', { contextId, frontierId: item.id, item, navigationPlan: decision.navigationPlan || null, navigationExecution }, ops); return { decision, item, navigationExecution };
    });
    if (!result.item) return output({ schemaVersion: 1, ok: true, ...result.decision });
    const item = result.item;
    return output({ schemaVersion: 1, ok: true, decision: 'CONTINUE', item });
  }
  if (command === 'resolve') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Frontier resolution requires the active SCANNING context', 'RUN_STATE_INVALID');
    const id = required(args, 'id'); const status = required(args, 'status').toUpperCase();
    if (!FRONTIER_STATUSES.includes(status) || ['PENDING', 'CLAIMED'].includes(status)) fail('Invalid terminal frontier status', 'FRONTIER_STATUS_INVALID');
    const item = frontier.items.find(x => x.id === id); if (!item) fail(`Unknown frontier: ${id}`, 'FRONTIER_NOT_FOUND');
    if (item.status !== 'CLAIMED') fail('Only a CLAIMED frontier may be resolved', 'FRONTIER_STATUS_INVALID');
    item.status = status; item.reasonCode = args.reasonCode || null; item.resolvedAt = now(); item.lastAttemptId = item.claimedAttemptId || null; item.claimToken = null; item.claimedAttemptId = null;
    const ops = [{ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item }]; let navigationExecution = null; if (item.navigationExecutionId) { const file = path.join(scanDir, 'evidence', 'navigations', `${item.navigationExecutionId}.json`); navigationExecution = readJson(file, null); if (navigationExecution?.status === 'PLANNED') { navigationExecution.status = 'CANCELLED'; navigationExecution.reasonCode = item.reasonCode || status; navigationExecution.finishedAt = now(); ops.push({ path: `evidence/navigations/${item.navigationExecutionId}.json`, op: 'REPLACE', value: navigationExecution }); } }
    commitEvent(scanDir, 'frontierResolved', { contextId, frontierId: id, status, reasonCode: item.reasonCode, item, navigationExecution }, ops);
    return output({ schemaVersion: 1, ok: true, item });
  }
  if (command === 'recover') {
    if (!['SCANNING', 'PAUSED'].includes(scan.status) || activeContextId(scan) !== contextId) fail('Frontier recovery requires the active context', 'RUN_STATE_INVALID');
    const recovered = []; const navigationExecutions = []; for (const item of frontier.items) if (item.status === 'CLAIMED') { item.status = item.attempts < 3 ? 'RETRYABLE' : 'FAILED'; item.reasonCode = 'INTERRUPTED'; item.lastAttemptId = item.claimedAttemptId || null; item.claimToken = null; item.claimedAttemptId = null; recovered.push(item); if (item.navigationExecutionId) { const navigation = readJson(path.join(scanDir, 'evidence', 'navigations', `${item.navigationExecutionId}.json`), null); if (navigation?.status === 'PLANNED') { navigation.status = 'CANCELLED'; navigation.reasonCode = 'INTERRUPTED'; navigation.finishedAt = now(); navigationExecutions.push(navigation); } } }
    if (recovered.length) commitEvent(scanDir, 'frontiersRecovered', { contextId, frontierIds: recovered.map(item => item.id), items: recovered, navigationExecutions }, [...recovered.map(item => ({ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item })), ...navigationExecutions.map(item => ({ path: `evidence/navigations/${item.navigationExecutionId}.json`, op: 'REPLACE', value: item }))]); return output({ schemaVersion: 1, ok: true, recovered: recovered.length });
  }
  if (command === 'list-imports') {
    const continuation = readJson(path.join(scanDir, 'continuation.json'), { schemaVersion: 1, importedFrontiers: [] });
    return output({ ...continuation, importedFrontiers: continuation.importedFrontiers.filter(x => x.contextId === contextId), skippedImportedFrontiers: (continuation.skippedImportedFrontiers || []).filter(x => x.contextId === contextId) });
  }
  if (command === 'bind-import') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Imported frontier binding requires the active SCANNING context', 'RUN_STATE_INVALID');
    const continuationFile = path.join(scanDir, 'continuation.json'); const continuation = readJson(continuationFile); const sourceId = required(args, 'sourceFrontierId');
    const imported = continuation.importedFrontiers.find(x => x.contextId === contextId && x.sourceFrontierId === sourceId); if (!imported) fail('Imported frontier not found', 'FRONTIER_IMPORT_NOT_FOUND'); if (imported.status !== 'AWAITING_REBIND') fail('Imported frontier is already bound', 'FRONTIER_IMPORT_BOUND'); validateGraphCandidate(imported.candidate);
    const from = required(args, 'fromReachableStateId'); const observationId = required(args, 'observationId'); const graph = loadGraph(scanDir, contextId); const state = graph.reachableStates.find(x => x.id === from); if (!state) fail('Rebind target must be a new Run ReachableState', 'GRAPH_REFERENCE_MISSING');
    const visual = graph.visualStates.find(x => x.id === state.visualStateId); if (!visual?.evidenceObservationIds?.includes(observationId)) fail('Rebind requires a fresh observation used by the new ReachableState', 'FRESH_OBSERVATION_REQUIRED');
    const evidence = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json')); if (evidence.captureStatus !== 'COMPLETE') fail('Fresh observation is incomplete', 'EVIDENCE_INCOMPLETE');
    const item = { id: nextId(scanDir, 'frontier', 'frontier'), contextId, fromReachableStateId: from, candidateGroupKey: imported.candidateGroupKey, candidate: imported.candidate, priority: imported.priority, status: 'PENDING', attempts: 0, sourceFrontierId: sourceId, createdAt: now() };
    frontier.items.push(item); imported.status = 'BOUND'; imported.boundFrontierId = item.id; imported.boundObservationId = observationId; commitEvent(scanDir, 'candidatesRecorded', { contextId, frontierIds: [item.id], sourceFrontierId: sourceId, freshObservationId: observationId, items: [item] }, [{ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item }, { path: 'continuation.json', op: 'REPLACE', value: continuation }]);
    return output({ schemaVersion: 1, ok: true, item });
  }
  fail(`Unknown frontier command: ${command}`, 'COMMAND_INVALID');
});

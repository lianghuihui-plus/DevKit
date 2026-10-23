'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { readJson, list, safePath, digest } = require('./source-reader');
const { reportingError, requireInput } = require('./errors');
const PLATFORMS = ['android', 'ios', 'harmony'];
function utc(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time > Date.now() + 300000)
    throw reportingError('REPORTING_SOURCE_INVALID', 'Invalid source timestamp');
  return new Date(time).toISOString();
}
function executionCandidates(workspace, caseDir, platform) {
  const root = `platforms/${platform}/executions`;
  return list(caseDir, root).map(name => {
    const relative = `${root}/${name}`, execDir = safePath(caseDir, relative), execution = readJson(execDir, 'execution.json');
    if (execution?.schemaVersion !== 14)
      throw reportingError('REPORTING_SOURCE_VERSION_UNSUPPORTED');
    if (!execution.executionId || execution.platform !== platform)
      throw reportingError('REPORTING_SOURCE_INVALID');
    const startedAt = utc(execution.startedAt);
    const closurePath = `execution-closures/${execution.executionId}.json`, closure = readJson(workspace, closurePath, true);
    if (closure)
      require('../lib/execution-closure').readExecutionClosure(workspace, execDir, execution);
    const completion = safePath(execDir, 'completion.json', true);
    const terminal = execution.status === 'CANCELLED' || execution.finalized === true || !!closure;
    const pending = execution.lifecycle === 'FINALIZING' || (execution.finalized === true && !!safePath(execDir, 'result.json', true) && !completion);
    return {
      execDir,
      execution,
      startedAt,
      terminal,
      pending,
      closure
    };
  });
}
/** A selection freezes identities, never follows the renderer's endedAt picker. */
function selectSources(request, { repository, sourceReader }) {
  requireInput(request && typeof request.workspace === 'string' && ['workspace', 'batch'].includes(request.scope));
  const workspace = path.resolve(request.workspace), marker = repository.readMarker(workspace);
  let state = null, targets = null, batch = null;
  const batchSignatures = [];
  if (request.scope === 'batch') {
    requireInput(typeof request.batchId === 'string');
    state = repository.readRunState(workspace, request.batchId);
    if (!state || !['COMPLETE', 'BLOCKED'].includes(state.phase) || !Array.isArray(state.targets))
      throw reportingError('REPORTING_RUN_STATE_INVALID');
    const batchPath = `runs/${request.batchId}/batch.json`, rawBatch = readJson(workspace, batchPath, true);
    if (rawBatch) {
      readJson(workspace, `runs/${request.batchId}/contract.json`);
      try {
        batch = require('../batch/state-repository').loadBatchForMaintenance(workspace, request.batchId).state;
      }
      catch {
        throw reportingError('REPORTING_RUN_STATE_INVALID');
      }
      if (!['COMPLETED', 'BLOCKED', 'CANCELLED'].includes(batch.status)
        || batch.cases.length !== state.targets.length
        || state.targets.some(t => !batch.cases.some(c => c.caseKey === t.caseKey)))
        throw reportingError('REPORTING_RUN_STATE_INVALID');
      for (const relative of [batchPath, `runs/${request.batchId}/contract.json`]) {
        const file = safePath(workspace, relative);
        batchSignatures.push({
          path: file,
          hash: digest(file)
        });
      }
      targets = new Map(batch.cases.map(t => [t.caseKey, {
          ...t,
          platform: batch.binding.platform
        }]));
    }
    else {
      if (state.environmentConfirmed !== true)
        throw reportingError('REPORTING_RUN_NOT_STARTED');
      targets = new Map(state.targets.map(t => [t.caseKey, {
          ...t,
          executionId: null
        }]));
    }
  }
  const definitions = [], selected = [], excluded = [], signatures = [...batchSignatures], ids = new Map();
  const addOptionalSignature = relative => {
    const file = safePath(workspace, relative, true);
    signatures.push({path:path.join(workspace,relative), hash:file ? digest(file) : null});
  };
  addOptionalSignature('workspace.json');
  const addDirectorySignature = relative => {
    const directory = safePath(workspace, relative, true);
    signatures.push({path:path.join(workspace,relative), directory:true, names:directory ? fs.readdirSync(directory).sort() : null});
  };
  addDirectorySignature('cases');
  for (const name of list(workspace, 'cases')) {
    const caseDir = safePath(workspace, `cases/${name}`), definition = sourceReader.readDefinition(caseDir), caseKey = definition.case.identity.caseKey;
    if (targets && !targets.has(caseKey))
      continue;
    if (definitions.some(d => d.caseKey === caseKey))
      throw reportingError('REPORTING_SELECTION_CONFLICT');
    definitions.push({
      caseKey,
      caseDir
    });
    signatures.push(...definition.signature);
    for (const platform of PLATFORMS) {
      const candidates = executionCandidates(workspace, caseDir, platform);
      addDirectorySignature(path.relative(workspace,path.join(caseDir,'platforms',platform,'executions')).split(path.sep).join('/'));
      for (const c of candidates) {
        const prior = ids.get(c.execution.executionId), binding = `${caseKey}/${platform}`;
        if (prior && prior !== binding)
          throw reportingError('REPORTING_EXECUTION_ID_COLLISION');
        ids.set(c.execution.executionId, binding);
        addOptionalSignature(`execution-closures/${c.execution.executionId}.json`);
        signatures.push({
          path: safePath(c.execDir, 'execution.json'),
          hash: digest(safePath(c.execDir, 'execution.json'))
        });
      }
      let chosen;
      if (targets) {
        const target = targets.get(caseKey);
        if (target.platform && target.platform !== platform)
          continue;
        if (!target.executionId) {
          if (candidates.some(c => c.execution.batchId === request.batchId))
            throw reportingError('REPORTING_RUN_STATE_INVALID');
          continue;
        }
        chosen = candidates.find(c => c.execution.executionId === target.executionId);
        if (!chosen || chosen.execution.batchId !== request.batchId || !chosen.terminal)
          throw reportingError('REPORTING_SOURCE_INVALID');
      }
      else {
        const terminal = candidates.filter(c => c.terminal).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        chosen = terminal[0];
        if (chosen && terminal[1]?.startedAt === chosen.startedAt && terminal[1].execution.executionId !== chosen.execution.executionId)
          throw reportingError('REPORTING_SELECTION_CONFLICT');
      }
      for (const c of candidates.filter(c => !c.terminal))
        excluded.push({
          caseKey,
          platform,
          executionId: c.execution.executionId,
          reason: c.pending ? 'WAITING_PUBLICATION' : 'RUNNING'
        });
      if (!chosen)
        continue;
      if (chosen.pending) {
        sourceReader.inventory(chosen.execDir);
        throw reportingError('REPORTING_WAITING_PUBLICATION');
      }
      const publicationRelative = `runs/${chosen.execution.batchId}/report-publication.json`, publication = readJson(workspace, publicationRelative, true);
      addOptionalSignature(publicationRelative);
      if (publication) {
        if (publication.status !== 'PUBLISHED')
          throw reportingError('REPORTING_WAITING_PUBLICATION');
      }
      selected.push({
        ...chosen,
        caseKey,
        platform
      });
    }
  }
  if (targets && definitions.length !== targets.size)
    throw reportingError('REPORTING_SOURCE_INVALID');
  if (state) {
    const file = safePath(workspace, `runs/${request.batchId}/coordinator-state.json`);
    signatures.push({
      path: file,
      hash: digest(file)
    });
    if (selected.length) {
      const publication = readJson(workspace, `runs/${request.batchId}/report-publication.json`);
      if (publication.status !== 'PUBLISHED')
        throw reportingError('REPORTING_WAITING_PUBLICATION');
    }
  }
  return {
    workspace,
    marker,
    definitions,
    selected,
    excluded,
    signatures
  };
}
module.exports = {
  PLATFORMS,
  utc,
  selectSources
};

#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  bootstrapBatch,
  cancelBatch,
  commitCurrentCase,
  initializeBatch,
  loadBatch,
  loadBatchForMaintenance,
  reconcileBatch,
  recordFinalizationStep,
  startCurrentCase,
} = require('./batch/core');
const { createDeviceSessionAdapter } = require('./batch/device-session');
const {
  acquireBatchPlatformRuntime,
  loadBatchPlatformRuntime,
  releaseBatchPlatformRuntime,
} = require('./batch/platform-runtime');
const { loadExecutionRequest } = require('./lib/run-control');
const { refreshBatchIndex, refreshCommittedCaseReports } = require('./report/report-service');
const { readPublicationState, recordPublicationAttempt } = require('./report/publication-state');
const {
  coordinatorCliErrorResponse,
  parseCoordinatorCliArgs,
  writeCoordinatorCliError,
} = require('./lib/coordinator-interface-contract');

const SKILL_ROOT = path.resolve(__dirname, '..');
function fail(message) {
  const error = new Error(`BATCH_CLI_INVALID: ${message}`);
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  const options = parseCoordinatorCliArgs(argv, 'scripts/batch.js');
  options.workspace = path.resolve(options.workspace);
  return options;
}

function buildRoleContract(role, platform) {
  const output = childProcess.execFileSync(process.execPath, [
    path.join(SKILL_ROOT, 'scripts/build-agent-contract.js'),
    '--role', role, '--platform', platform,
  ], { cwd: SKILL_ROOT, encoding: 'utf8' });
  return JSON.parse(output);
}

function existingPlatform(options) {
  const contractPath = path.join(options.workspace, 'runs', options.batchId, 'contract.json');
  if (!fs.existsSync(contractPath)) fail(`batch contract is missing: ${options.batchId}`);
  return JSON.parse(fs.readFileSync(contractPath, 'utf8')).binding?.platform;
}

function context(options) {
  const platform = options.platform || existingPlatform(options);
  const skillContract = buildRoleContract('case-executor', platform);
  const coordinatorContract = buildRoleContract('batch-coordinator', platform);
  return {
    skillContract,
    coordinatorContract,
    runtimeSha: skillContract.runtimeSha,
    adapterSha: skillContract.adapterSha,
    coordinatorSha: coordinatorContract.coordinatorSha,
    caseProtocolSha: skillContract.protocolSha,
    coordinatorProtocolSha: coordinatorContract.protocolSha,
    adapter: createDeviceSessionAdapter(),
  };
}

function refreshCommittedDashboard(committed, refresh = refreshCommittedCaseReports) {
  const startedAt = Date.now();
  try {
    const report = refresh(committed.item.caseDir, committed.completion.platform);
    return { ...report, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'FAILED',
      errorCode: error?.code || String(error?.message || error).match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'REPORT_REFRESH_FAILED',
      reason: error?.message || String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function commitWithDashboard(common, refresh, commit = commitCurrentCase) {
  const committed = commit(common);
  const dashboardRefresh = refreshCommittedDashboard(committed, refresh);
  let publicationState = null;
  if (common.workspaceRoot && common.batchId) {
    try {
      publicationState = recordPublicationAttempt(common.workspaceRoot, common.batchId, 'case', dashboardRefresh, { now: common.now });
    } catch (error) {
      publicationState = degradedPublicationState(common, error);
    }
  }
  return { ...committed, dashboardRefresh, ...(publicationState ? { publicationState } : {}) };
}

function publicationErrorCode(error) {
  return error?.code || String(error?.message || error).match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'REPORT_PUBLICATION_FAILED';
}

function degradedPublicationState(common, error, code = 'REPORT_PUBLICATION_STATE_INVALID') {
  return {
    schemaVersion: 1,
    batchId: common.batchId,
    status: 'DEGRADED',
    errorCode: code,
    reason: error?.message || String(error),
    classification: 'PERMANENT',
  };
}

function publishTerminalReports(common, current) {
  let existing;
  try {
    existing = readPublicationState(common.workspaceRoot, common.batchId);
  } catch (error) {
    return { publicationState: degradedPublicationState(common, error), publicationAttempted: false };
  }
  if ((Array.isArray(existing.attempts) ? existing.attempts : []).some((attempt) => attempt.scope === 'batch')) {
    return { publicationState: existing, publicationAttempted: false };
  }
  const startedAt = Date.now();
  let publication;
  try {
    const loaded = loadBatchForMaintenance(common.workspaceRoot, common.batchId);
    const refresh = current.refreshBatchIndex || refreshBatchIndex;
    refresh(common.workspaceRoot, loaded.contract.targets.map((target) => target.caseDir));
    publication = { status: 'PUBLISHED', durationMs: Date.now() - startedAt };
  } catch (error) {
    publication = {
      status: 'FAILED',
      errorCode: publicationErrorCode(error),
      reason: error.message || String(error),
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    return {
      publication,
      publicationState: recordPublicationAttempt(common.workspaceRoot, common.batchId, 'batch', publication, { now: common.now }),
      publicationAttempted: true,
    };
  } catch (error) {
    return {
      publication,
      publicationState: degradedPublicationState(common, error),
      publicationAttempted: true,
    };
  }
}

function reconcileWithFinalization(common, current) {
  const progress = [];
  let platformRuntimeCleanup = null;
  for (let transition = 0; transition < 32; transition += 1) {
    const reconciled = reconcileBatch({ ...common, adapter: current.adapter });
    if (['BATCH_COMPLETE', 'BATCH_CANCELLED', 'BATCH_BLOCKED'].includes(reconciled.action)) {
      const reportPublication = publishTerminalReports(common, current);
      if (reportPublication.publicationAttempted) progress.push('PUBLISH_REPORTS');
      progress.push(reconciled.action);
      return { ...reconciled, progress, ...(platformRuntimeCleanup ? { platformRuntimeCleanup } : {}), ...reportPublication };
    }
    progress.push(reconciled.action);
    if (['START_CASE', 'RESUME_CASE_START'].includes(reconciled.action)) {
      return { ...reconciled, action: 'NEED_CASE_AGENT', batchAction: reconciled.action, progress };
    }
    if (reconciled.action === 'COMMIT_CASE') {
      const committed = commitWithDashboard(common);
      progress.push('CASE_COMMITTED');
      if (committed.dashboardRefresh?.status === 'FAILED') progress.push('CASE_REPORT_DEFERRED');
      continue;
    }
    if (reconciled.action === 'SETTLE_EXECUTIONS') {
      recordFinalizationStep({ ...common, step: 'executionsSettled', result: { ok: true } });
      continue;
    }
    if (reconciled.action === 'RELEASE_PLATFORM') {
      let cleanupResult;
      try {
        cleanupResult = releaseBatchPlatformRuntime({ ...common, adapter: current.adapter });
      } catch (error) {
        cleanupResult = {
          ok: false,
          status: 'RELEASE_FAILED',
          failureCode: error.code || 'PLATFORM_RUNTIME_RELEASE_FAILED',
          reason: error.message || String(error),
        };
      }
      platformRuntimeCleanup = cleanupResult;
      if (cleanupResult.ok === true) {
        recordFinalizationStep({ ...common, step: 'platformReleased', result: cleanupResult });
      } else {
        recordFinalizationStep({ ...common, step: 'platformCleanupDeferred', result: cleanupResult });
      }
      continue;
    }
    if (reconciled.action === 'RECONCILE_FATAL') continue;
    return { ...reconciled, progress };
  }
  throw Object.assign(new Error('batch reconcile exceeded the deterministic transition limit'), { code: 'BATCH_RECONCILE_LIMIT' });
}

function cleanupTerminalPlatformRuntime(common, current, result) {
  if (!['COMPLETED', 'CANCELLED', 'BLOCKED'].includes(result?.state?.status)) return result;
  if (result?.platformRuntimeCleanup) return result;
  try {
    return {
      ...result,
      platformRuntimeCleanup: releaseBatchPlatformRuntime({ ...common, adapter: current.adapter }),
    };
  } catch (error) {
    return {
      ...result,
      platformRuntimeCleanup: {
        ok: false,
        status: 'RELEASE_FAILED',
        failureCode: error.code || 'PLATFORM_RUNTIME_RELEASE_FAILED',
        reason: error.message || String(error),
      },
    };
  }
}

function execute(options) {
  if (options.command === 'init') {
    if (options.bindingJson !== undefined || options.targetsJson !== undefined) {
      fail('init no longer accepts --binding-json or --targets-json; create an explicit execution request first');
    }
    const executionRequest = loadExecutionRequest(options.workspace, options.batchId);
    const current = context({ ...options, platform: executionRequest.binding.platform });
    return initializeBatch({
      workspaceRoot: options.workspace,
      batchId: options.batchId,
      runtimeSha: current.runtimeSha,
      adapterSha: current.adapterSha,
      coordinatorSha: current.coordinatorSha,
      caseProtocolSha: current.caseProtocolSha,
      coordinatorProtocolSha: current.coordinatorProtocolSha,
    });
  }
  const current = context(options);
  const common = {
    workspaceRoot: options.workspace,
    batchId: options.batchId,
    runtimeSha: current.runtimeSha,
    adapterSha: current.adapterSha,
    coordinatorSha: current.coordinatorSha,
    caseProtocolSha: current.caseProtocolSha,
    coordinatorProtocolSha: current.coordinatorProtocolSha,
  };
  switch (options.command) {
    case 'bootstrap': {
      const platformRuntime = acquireBatchPlatformRuntime({ ...common, adapter: current.adapter });
      try {
        return cleanupTerminalPlatformRuntime(common, current, bootstrapBatch({
          ...common,
          adapter: current.adapter,
          platformRuntime,
        }));
      } catch (error) {
        try {
          const loaded = loadBatch(options.workspace, options.batchId, common);
          if (loaded.state.status === 'BLOCKING') return reconcileWithFinalization(common, current);
        } catch {
          // Preserve the bootstrap error when state recovery cannot be started.
        }
        throw error;
      }
    }
    case 'reconcile': return cleanupTerminalPlatformRuntime(common, current, reconcileWithFinalization(common, current));
    case 'start': {
      return startCurrentCase({ ...common, skillContract: current.skillContract, continuationReason: options.continuationReason });
    }
    case 'commit': return cleanupTerminalPlatformRuntime(common, current, commitWithDashboard(common));
    case 'status': {
      const loaded = loadBatchForMaintenance(options.workspace, options.batchId);
      return { ...loaded, platformRuntime: loadBatchPlatformRuntime(common) };
    }
    case 'cancel': return cancelBatch({ ...common, reason: options.reason });
    case 'teardown': {
      const loaded = loadBatchForMaintenance(options.workspace, options.batchId);
      return {
        ...loaded,
        platformRuntimeCleanup: releaseBatchPlatformRuntime({ ...common, adapter: current.adapter }),
      };
    }
    default: fail('unsupported command');
  }
}

function batchTechnicalResponse(error, options) {
  return {
    ...coordinatorCliErrorResponse(error, 'scripts/batch.js', options.command),
    batchId: options.batchId,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let response;
  try {
    response = execute(options);
  } catch (error) {
    response = batchTechnicalResponse(error, options);
  }
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/batch.js', process.argv[2]); process.exit(error.exitCode || 2); }
}

module.exports = {
  buildContract: (platform) => buildRoleContract('case-executor', platform),
  buildRoleContract,
  batchTechnicalResponse,
  commitWithDashboard,
  cleanupTerminalPlatformRuntime,
  execute,
  main,
  parseArgs,
  refreshCommittedDashboard,
  reconcileWithFinalization,
};

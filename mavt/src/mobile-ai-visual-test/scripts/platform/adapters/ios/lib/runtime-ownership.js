'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TERMINAL_BATCH_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'BLOCKED']);
const RECLAIMABLE_BATCH_STATUSES = new Set(['BLOCKING', 'CANCELLING']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function derivedOwnerKey(workspaceRoot, batchId, contractSha) {
  return `batch-${crypto.createHash('sha256')
    .update(`${path.resolve(workspaceRoot)}\n${batchId}\n${contractSha}`)
    .digest('hex').slice(0, 24)}`;
}

function resolveManagedOwner(ownerKey, options = {}) {
  if (typeof options.resolveOwnerStatus === 'function') return options.resolveOwnerStatus(ownerKey);
  const workspaceRoot = options.workspaceRoot || process.env.MAVT_IOS_RUNTIME_WORKSPACE_ROOT;
  if (!workspaceRoot || !ownerKey) return { status: 'UNKNOWN', reason: 'framework owner batch cannot be resolved' };
  const runsRoot = path.join(path.resolve(workspaceRoot), 'runs');
  if (!fs.existsSync(runsRoot)) return { status: 'UNKNOWN', reason: 'workspace runs directory is unavailable' };
  for (const batchId of fs.readdirSync(runsRoot)) {
    const batchDir = path.join(runsRoot, batchId);
    if (!fs.statSync(batchDir).isDirectory()) continue;
    const state = readJson(path.join(batchDir, 'batch.json'));
    const contract = readJson(path.join(batchDir, 'contract.json'));
    const runtime = readJson(path.join(batchDir, 'platform-runtime.json'));
    const derived = state?.contractSha && derivedOwnerKey(workspaceRoot, batchId, state.contractSha);
    if (runtime?.ownerKey !== ownerKey && state?.ownerKey !== ownerKey && derived !== ownerKey) continue;
    const batchStatus = state?.status;
    const hasRunningExecution = Array.isArray(state?.cases)
      && state.cases.some((entry) => entry?.status === 'RUNNING');
    const cleanupDeadline = Date.parse(state?.cleanupDeadlineAt || '');
    const nowMs = options.now ? Date.parse(options.now) : Date.now();
    const reclaimable = RECLAIMABLE_BATCH_STATUSES.has(batchStatus)
      && !hasRunningExecution
      && Number.isFinite(cleanupDeadline)
      && Number.isFinite(nowMs)
      && cleanupDeadline <= nowMs;
    return {
      status: TERMINAL_BATCH_STATUSES.has(batchStatus) ? 'TERMINAL' : reclaimable ? 'RECLAIMABLE' : 'ACTIVE',
      batchId,
      batchStatus: batchStatus || null,
      contractSha: contract?.contractSha || state?.contractSha || null,
      ...(reclaimable ? { cleanupDeadlineAt: state.cleanupDeadlineAt } : {}),
    };
  }
  return { status: 'UNKNOWN', reason: 'framework owner batch is not present in the workspace' };
}

module.exports = {
  TERMINAL_BATCH_STATUSES,
  RECLAIMABLE_BATCH_STATUSES,
  derivedOwnerKey,
  resolveManagedOwner,
};

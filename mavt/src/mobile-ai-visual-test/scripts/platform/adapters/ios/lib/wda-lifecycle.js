'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { localIso } = require('./output');
const processLifecycle = require('./process-lifecycle');
const { resolveManagedOwner } = require('./runtime-ownership');

const REGISTRY_SCHEMA_VERSION = 1;

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wdaIdentity(target = {}) {
  return {
    deviceId: String(target.device || target.deviceId || '').trim(),
    bundleId: String(target.updatedWDABundleId || target.bundleId || '').trim(),
  };
}

function canTrackIdentity(identity) {
  return Boolean(identity.deviceId && identity.bundleId);
}

function commandMatchesWda(command, identity) {
  if (!canTrackIdentity(identity)) return false;
  const value = String(command || '');
  const xcodebuild = /(?:^|\s)(?:\S*\/)?xcodebuild(?:\s|$)/.test(value);
  const project = /appium-webdriveragent\/WebDriverAgent\.xcodeproj(?:\s|$)/.test(value);
  const runner = /WebDriverAgentRunner/.test(value);
  const device = new RegExp(`(?:^|\\s)-destination(?:=|\\s+)(?:['"])?[^\\s'"]*id=${escapeRegExp(identity.deviceId)}(?:[,\\s'"]|$)`).test(value);
  const bundle = new RegExp(`(?:^|\\s)PRODUCT_BUNDLE_IDENTIFIER=${escapeRegExp(identity.bundleId)}(?:\\s|$)`).test(value);
  return xcodebuild && project && runner && device && bundle;
}

function runtimeRoot() {
  return path.resolve(process.env.MAVT_IOS_RUNTIME_DIR || path.join(require('os').tmpdir(), 'mavt-ios-runtime'));
}

function registryPath(identityOrTarget) {
  const identity = wdaIdentity(identityOrTarget);
  const key = crypto.createHash('sha256').update(`${identity.deviceId}\n${identity.bundleId}`).digest('hex').slice(0, 20);
  return path.join(runtimeRoot(), `wda-${key}.json`);
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function matchingProcesses(identity, dependencies = {}) {
  const list = dependencies.listProcesses || processLifecycle.listProcesses;
  return list().filter((item) => commandMatchesWda(item.command, identity));
}

function recordMatchesProcess(record, identity, dependencies = {}) {
  if (!record || record.schemaVersion !== REGISTRY_SCHEMA_VERSION || record.status !== 'ACTIVE'
    || record.deviceId !== identity.deviceId || record.bundleId !== identity.bundleId
    || !Number.isInteger(record.pid) || record.pid <= 0
    || !Number.isInteger(record.processGroupId) || record.processGroupId !== record.pid) return false;
  const alive = dependencies.processAlive || processLifecycle.processAlive;
  if (!alive(record.pid)) return false;
  const command = dependencies.processCommand
    ? dependencies.processCommand(record.pid)
    : processLifecycle.processCommand(record.pid);
  if (!commandMatchesWda(command, identity)) return false;
  const startedAt = dependencies.processStartedAt
    ? dependencies.processStartedAt(record.pid)
    : processLifecycle.processStartedAt(record.pid);
  return !record.processStartedAt || record.processStartedAt === startedAt;
}

function removeRegistryIfClaimed(identity, claimToken) {
  const file = registryPath(identity);
  const current = readJson(file, null);
  if (current?.claimToken === claimToken && fs.existsSync(file)) fs.unlinkSync(file);
}

function activeRecord(identity, processInfo, ownerKey, claimToken, dependencies = {}) {
  const startedAt = dependencies.processStartedAt
    ? dependencies.processStartedAt(processInfo.pid)
    : processLifecycle.processStartedAt(processInfo.pid);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    status: 'ACTIVE',
    deviceId: identity.deviceId,
    bundleId: identity.bundleId,
    pid: processInfo.pid,
    parentPid: processInfo.parentPid,
    processGroupId: processInfo.processGroupId,
    processStartedAt: startedAt || undefined,
    claimToken,
    ownerKey,
    registeredAt: localIso(),
  };
}

async function reclaimStaleWda(identity, registered, dependencies = {}) {
  if (!recordMatchesProcess(registered, identity, dependencies)) {
    return { ok: false, failureCode: 'IOS_WDA_OWNERSHIP_UNKNOWN', reason: 'WDA registry does not match a live isolated process' };
  }
  const owner = (dependencies.resolveOwnerStatus || resolveManagedOwner)(registered.ownerKey, dependencies);
  if (owner?.status === 'ACTIVE') return { ok: false, failureCode: 'IOS_WDA_SERVICE_IN_USE', owner };
  if (owner?.status !== 'TERMINAL' && owner?.status !== 'RECLAIMABLE') return { ok: false, failureCode: 'IOS_WDA_OWNERSHIP_UNKNOWN', owner };
  const stop = dependencies.stopProcessGroup || processLifecycle.stopProcessGroup;
  const stopped = await stop(registered, {
    label: 'framework-managed WDA process',
    processAlive: dependencies.processAlive || processLifecycle.processAlive,
    ...(dependencies.signalProcessGroup ? { signalProcessGroup: dependencies.signalProcessGroup } : {}),
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    ...(dependencies.graceMs !== undefined ? { graceMs: dependencies.graceMs } : {}),
  });
  if (!stopped.ok) return { ok: false, failureCode: 'IOS_WDA_STALE_CLEANUP_FAILED', reason: stopped.reason, owner };
  removeRegistryIfClaimed(identity, registered.claimToken);
  return { ok: true, owner, stopped };
}

async function reclaimStalePendingWda(identity, registered, processes, dependencies = {}) {
  const owner = (dependencies.resolveOwnerStatus || resolveManagedOwner)(registered.ownerKey, dependencies);
  if (owner?.status === 'ACTIVE') return { ok: false, failureCode: 'IOS_WDA_SERVICE_IN_USE', owner };
  if (owner?.status !== 'TERMINAL' && owner?.status !== 'RECLAIMABLE') return { ok: false, failureCode: 'IOS_WDA_OWNERSHIP_UNKNOWN', owner };
  const baseline = new Set((registered.baselinePids || []).filter((pid) => Number.isInteger(pid)));
  const candidates = processes.filter((item) => !baseline.has(item.pid));
  if (candidates.length !== 1 || candidates[0].processGroupId !== candidates[0].pid) {
    return {
      ok: false,
      failureCode: 'IOS_WDA_OWNERSHIP_UNKNOWN',
      owner,
      reason: candidates.length
        ? `WDA pending claim has ${candidates.length} non-baseline matching processes`
        : 'WDA pending claim has no uniquely attributable matching process',
    };
  }
  const stop = dependencies.stopProcessGroup || processLifecycle.stopProcessGroup;
  const stopped = await stop(candidates[0], {
    label: 'framework-managed WDA process',
    processAlive: dependencies.processAlive || processLifecycle.processAlive,
    ...(dependencies.signalProcessGroup ? { signalProcessGroup: dependencies.signalProcessGroup } : {}),
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    ...(dependencies.graceMs !== undefined ? { graceMs: dependencies.graceMs } : {}),
  });
  if (!stopped.ok) return { ok: false, failureCode: 'IOS_WDA_STALE_CLEANUP_FAILED', reason: stopped.reason, owner };
  removeRegistryIfClaimed(identity, registered.claimToken);
  return { ok: true, owner, stopped };
}

function acquireWda(target, ownerKey, dependencies = {}) {
  if (process.env.MAVT_IOS_FAKE === '1') {
    return {
      ok: true,
      status: 'PENDING',
      ownership: 'FRAMEWORK_MANAGED',
      resource: { fake: true, ownerKey, baselinePids: [] },
    };
  }
  const identity = wdaIdentity(target);
  if (!canTrackIdentity(identity)) {
    return {
      ok: true,
      status: 'UNTRACKED',
      ownership: 'EXTERNAL',
      resource: { ...identity, reason: 'WDA device id or bundle id is unavailable' },
    };
  }
  const file = registryPath(identity);
  const registered = readJson(file, null);
  const processes = matchingProcesses(identity, dependencies);
  const registeredProcess = recordMatchesProcess(registered, identity, dependencies)
    ? processes.find((item) => item.pid === registered.pid)
    : null;
  const claimToken = crypto.randomBytes(16).toString('hex');
  if (!registeredProcess && registered?.status === 'PENDING' && registered.ownerKey && registered.ownerKey !== ownerKey) {
    return reclaimStalePendingWda(identity, registered, processes, dependencies).then((reclaimed) => {
      if (!reclaimed.ok) {
        const serviceInUse = reclaimed.failureCode === 'IOS_WDA_SERVICE_IN_USE';
        return {
          ok: false,
          status: 'ACQUIRE_FAILED',
          ownership: 'NONE',
          failureCode: reclaimed.failureCode || 'IOS_WDA_OWNERSHIP_UNKNOWN',
          retryable: serviceInUse,
          reason: reclaimed.reason || 'framework-managed WDA pending claim cannot be recovered safely',
          diagnostic: {
            code: reclaimed.failureCode || 'IOS_WDA_OWNERSHIP_UNKNOWN',
            stage: 'PLATFORM_RUNTIME_ACQUIRE',
            summary: reclaimed.reason || 'framework-managed WDA pending claim cannot be recovered safely',
            retryable: serviceInUse,
            owner: reclaimed.owner || null,
            ...(serviceInUse ? { recovery: { kind: 'WAIT_OR_CANCEL_OWNER_BATCH' } } : {}),
          },
        };
      }
      return acquireWda(target, ownerKey, dependencies);
    });
  }
  if (registeredProcess) {
    if (registered.ownerKey && registered.ownerKey !== ownerKey) {
      return reclaimStaleWda(identity, registered, dependencies).then((reclaimed) => {
        if (!reclaimed.ok) {
          const serviceInUse = reclaimed.failureCode === 'IOS_WDA_SERVICE_IN_USE';
          return {
            ok: false,
            status: 'ACQUIRE_FAILED',
            ownership: 'NONE',
            failureCode: reclaimed.failureCode || 'IOS_WDA_SERVICE_IN_USE',
            retryable: serviceInUse,
            reason: reclaimed.reason || 'framework-managed WDA is already owned by another batch',
            diagnostic: {
              code: reclaimed.failureCode || 'IOS_WDA_SERVICE_IN_USE',
              stage: 'PLATFORM_RUNTIME_ACQUIRE',
              summary: reclaimed.reason || 'framework-managed WDA is already owned by another batch',
              retryable: serviceInUse,
              owner: reclaimed.owner || null,
              ...(serviceInUse ? { recovery: { kind: 'WAIT_OR_CANCEL_OWNER_BATCH' } } : {}),
            },
          };
        }
        return acquireWda(target, ownerKey, dependencies);
      });
    }
    const record = activeRecord(identity, registeredProcess, ownerKey, claimToken, dependencies);
    writeJsonAtomic(file, record);
    return {
      ok: true,
      status: 'ACTIVE',
      ownership: 'FRAMEWORK_MANAGED',
      resource: { ...record, baselinePids: processes.filter((item) => item.pid !== record.pid).map((item) => item.pid) },
    };
  }
  const record = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    status: 'PENDING',
    deviceId: identity.deviceId,
    bundleId: identity.bundleId,
    baselinePids: processes.map((item) => item.pid),
    claimToken,
    ownerKey,
    claimedAt: localIso(),
  };
  writeJsonAtomic(file, record);
  return {
    ok: true,
    status: processes.length ? 'ACTIVE' : 'PENDING',
    ownership: processes.length ? 'EXTERNAL' : 'FRAMEWORK_MANAGED',
    resource: { ...record },
  };
}

async function releaseWda(resource, ownerKey, dependencies = {}) {
  if (!resource || resource.fake) {
    return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: true };
  }
  const identity = wdaIdentity(resource);
  if (!canTrackIdentity(identity)) {
    return { ok: true, status: 'RETAINED', ownership: 'EXTERNAL', released: false, resource };
  }
  const file = registryPath(identity);
  const registered = readJson(file, null);
  const alive = dependencies.processAlive || processLifecycle.processAlive;
  const processes = matchingProcesses(identity, dependencies);
  const baselinePids = new Set((resource.baselinePids || []).filter((pid) => Number.isInteger(pid)));
  if (!registered || registered.claimToken !== resource.claimToken || registered.ownerKey !== ownerKey) {
    if (Number.isInteger(resource.pid) && alive(resource.pid)) {
      return {
        ok: false,
        status: 'RELEASE_FAILED',
        ownership: 'FRAMEWORK_MANAGED',
        failureCode: 'IOS_WDA_OWNERSHIP_LOST',
        reason: 'WDA registry no longer matches the batch-owned process',
        resource,
      };
    }
    const unownedCandidates = processes.filter((item) => !baselinePids.has(item.pid));
    if (unownedCandidates.length) {
      return {
        ok: false,
        status: 'RELEASE_FAILED',
        ownership: 'FRAMEWORK_MANAGED',
        failureCode: 'IOS_WDA_OWNERSHIP_LOST',
        reason: `WDA registry is missing or changed while new matching processes remain: ${unownedCandidates.map((item) => item.pid).join(', ')}`,
        resource,
      };
    }
    return processes.length
      ? { ok: true, status: 'RETAINED', ownership: 'EXTERNAL', released: false, resource: { ...resource, retainedPids: processes.map((item) => item.pid) } }
      : { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: true, alreadyStopped: true, resource };
  }

  let managedRecord = null;
  if (recordMatchesProcess(registered, identity, dependencies)) {
    managedRecord = registered;
  } else if (registered.status === 'PENDING') {
    const candidates = processes.filter((item) => !baselinePids.has(item.pid));
    if (candidates.length > 1) {
      return {
        ok: false,
        status: 'RELEASE_FAILED',
        ownership: 'FRAMEWORK_MANAGED',
        failureCode: 'IOS_WDA_OWNERSHIP_LOST',
        reason: `multiple new WDA processes match the batch identity: ${candidates.map((item) => item.pid).join(', ')}`,
        resource,
      };
    }
    if (candidates.length === 1) {
      if (candidates[0].processGroupId !== candidates[0].pid) {
        return {
          ok: false,
          status: 'RELEASE_FAILED',
          ownership: 'FRAMEWORK_MANAGED',
          failureCode: 'IOS_WDA_OWNERSHIP_LOST',
          reason: `WDA process ${candidates[0].pid} does not own an isolated process group`,
          resource,
        };
      }
      managedRecord = activeRecord(identity, candidates[0], ownerKey, resource.claimToken, dependencies);
      writeJsonAtomic(file, managedRecord);
    }
  }

  let stopped = { ok: true, alreadyStopped: true };
  if (managedRecord) {
    const stop = dependencies.stopProcessGroup || processLifecycle.stopProcessGroup;
    stopped = await stop(managedRecord, {
      label: 'framework-managed WDA process',
      processAlive: alive,
      ...(dependencies.signalProcessGroup ? { signalProcessGroup: dependencies.signalProcessGroup } : {}),
      ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      ...(dependencies.graceMs !== undefined ? { graceMs: dependencies.graceMs } : {}),
    });
    if (!stopped.ok) {
      return {
        ok: false,
        status: 'RELEASE_FAILED',
        ownership: 'FRAMEWORK_MANAGED',
        failureCode: 'IOS_WDA_STOP_FAILED',
        reason: stopped.reason,
        resource: { ...resource, ...managedRecord },
      };
    }
  }
  removeRegistryIfClaimed(identity, resource.claimToken);
  const remaining = matchingProcesses(identity, dependencies);
  const retained = remaining.filter((item) => baselinePids.has(item.pid));
  const unexplained = remaining.filter((item) => !baselinePids.has(item.pid));
  if (unexplained.length) {
    return {
      ok: false,
      status: 'RELEASE_FAILED',
      ownership: 'FRAMEWORK_MANAGED',
      failureCode: 'IOS_AUTOMATION_RELEASE_INCOMPLETE',
      reason: `WDA processes remain after release: ${unexplained.map((item) => item.pid).join(', ')}`,
      resource: { ...resource, retainedPids: retained.map((item) => item.pid), remainingPids: unexplained.map((item) => item.pid) },
    };
  }
  return retained.length
    ? { ok: true, status: 'RETAINED', ownership: 'EXTERNAL', released: Boolean(managedRecord), resource: { ...resource, retainedPids: retained.map((item) => item.pid) } }
    : { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: Boolean(managedRecord), alreadyStopped: stopped.alreadyStopped, resource: { ...resource, ...(managedRecord || {}) } };
}

function listeningPorts(ports) {
  return (ports || []).filter((port) => {
    const result = childProcess.spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return result.status === 0 && String(result.stdout || '').trim();
  });
}

module.exports = {
  acquireWda,
  canTrackIdentity,
  commandMatchesWda,
  listeningPorts,
  matchingProcesses,
  recordMatchesProcess,
  registryPath,
  releaseWda,
  reclaimStaleWda,
  reclaimStalePendingWda,
  wdaIdentity,
};

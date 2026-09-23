'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { contractError } = require('../lib/contract-utils');
const { readJson } = require('../lib/execution-lifecycle');
const { validateSessionRef } = require('./warm-session-store');

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function invalid(message) {
  throw contractError('ANDROID_HELPER_RUNTIME_INVALID', message);
}

function deriveOwnerKey(workspaceRoot, batchId, contractSha) {
  return `batch-${crypto.createHash('sha256')
    .update(`${path.resolve(workspaceRoot)}\n${batchId}\n${contractSha}`)
    .digest('hex').slice(0, 24)}`;
}

function validateAndroidRuntimeReference(sessionRef, platformRuntime, binding, helper, execDir) {
  let target;
  try {
    target = validateSessionRef(sessionRef, sessionRef?.batchId);
  } catch (error) {
    invalid(`sessionRef is invalid: ${error.message}`);
  }
  const batchState = readJson(target.state, null);
  if (!batchState || batchState.batchId !== sessionRef.batchId) invalid('sessionRef batchId does not match batch state');
  if (!platformRuntime || platformRuntime.schemaVersion !== 1 || platformRuntime.type !== 'batchPlatformRuntime') {
    invalid('platform runtime type is invalid');
  }
  if (platformRuntime.batchId !== sessionRef.batchId) invalid('platform runtime batchId does not match sessionRef');
  if (platformRuntime.platform !== 'android') invalid('platform runtime platform must be android');
  if (platformRuntime.bindingSha !== bindingSha(binding)) invalid('platform runtime bindingSha does not match the frozen binding');
  const workspaceRoot = path.dirname(path.dirname(path.dirname(target.state)));
  const expectedOwnerKey = batchState.ownerKey
    || (batchState.contractSha ? deriveOwnerKey(workspaceRoot, sessionRef.batchId, batchState.contractSha) : null);
  if (!platformRuntime.ownerKey || (expectedOwnerKey && platformRuntime.ownerKey !== expectedOwnerKey)) {
    invalid('platform runtime ownerKey does not match batch state');
  }

  const policy = binding.androidUiBackend || 'auto';
  if (helper?.backend === 'helper') {
    if (platformRuntime.status !== 'ACTIVE') invalid('Helper runtime status must be ACTIVE');
    if (platformRuntime.ownership !== 'FRAMEWORK_MANAGED') invalid('Helper runtime ownership must be FRAMEWORK_MANAGED');
  }
  if (helper?.backend === 'uiautomator') {
    if (platformRuntime.status !== 'NOT_REQUIRED') invalid('uiautomator runtime status must be NOT_REQUIRED');
    if (platformRuntime.ownership !== 'NONE') invalid('uiautomator runtime ownership must be NONE');
  }
  const activeHelper = platformRuntime.status === 'ACTIVE'
    && platformRuntime.ownership === 'FRAMEWORK_MANAGED'
    && helper?.backend === 'helper';
  const legacy = platformRuntime.status === 'NOT_REQUIRED'
    && platformRuntime.ownership === 'NONE'
    && helper?.backend === 'uiautomator';
  if (policy === 'helper' && !activeHelper) invalid('strict helper policy requires an active Helper runtime');
  if (policy === 'auto' && !activeHelper && !legacy) invalid('auto policy requires active Helper or recorded uiautomator fallback');
  if (policy === 'uiautomator' && !legacy) invalid('uiautomator policy requires a NOT_REQUIRED legacy runtime');
  if (!activeHelper) return { backend: 'uiautomator', platformRuntime, target };

  const sessionStatePath = helper.sessionStatePath;
  if (!path.isAbsolute(sessionStatePath || '')) invalid('Helper sessionStatePath must be absolute');
  if (isWithin(execDir, sessionStatePath) || isWithin(workspaceRoot, sessionStatePath)) {
    invalid('Helper sessionStatePath must remain outside the execution and workspace');
  }
  if (fs.existsSync(sessionStatePath) && fs.lstatSync(sessionStatePath).isSymbolicLink()) {
    invalid('Helper sessionStatePath must not be a symbolic link');
  }
  if (Number(helper.protocolVersion || 0) < 2 || Number(helper.versionCode || 0) < 7) {
    invalid('Helper runtime protocol or version is unsupported');
  }
  return { backend: 'helper', sessionStatePath, platformRuntime, target };
}

function androidHelperAdapterEnvironment(execDir, binding, options = {}) {
  const env = { ...(options.baseEnv || process.env) };
  delete env.MAVT_ANDROID_HELPER_SESSION_STATE;
  if (binding.platform !== 'android') return env;
  const runtime = readJson(path.join(path.resolve(execDir), 'runtime.json'), null);
  if (!runtime?.sessionRef?.platformRuntimePath) invalid('execution runtime does not contain platformRuntimePath');
  const platformRuntime = readJson(runtime.sessionRef.platformRuntimePath, null);
  const helper = platformRuntime?.resource?.androidHelper;
  const selection = validateAndroidRuntimeReference(
    runtime.sessionRef,
    platformRuntime,
    binding,
    helper,
    path.resolve(execDir),
  );
  if (selection.backend === 'helper') env.MAVT_ANDROID_HELPER_SESSION_STATE = selection.sessionStatePath;
  return env;
}

module.exports = {
  androidHelperAdapterEnvironment,
  validateAndroidRuntimeReference,
};

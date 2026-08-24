'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureObject,
  ensureString,
  sha256,
} = require('./contract-utils');
const { validateBinding, bindingSha } = require('./batch-contract');
const { sourceSha, validateCaseContract } = require('../execution/contracts/case-contract');
const { assertWorkspace } = require('./workspace');
const { atomicWrite, readJson, writeJsonAtomic } = require('./execution-lifecycle');
const { buildContract } = require('../build-agent-contract');
const { validateKnowledgeRoots } = require('./knowledge-query');

const ENVIRONMENT_CONFIRMATION_SCHEMA_VERSION = 1;
const EXECUTION_REQUEST_SCHEMA_VERSION = 2;
const EXECUTION_MODES = new Set(['SINGLE', 'BATCH']);
const INTERACTION_POLICY = 'UNATTENDED';

function environmentConfirmationPath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), 'environment-confirmation.json');
}

function executionRequestPath(workspaceRoot, batchId) {
  ensureId(batchId, 'batchId', 'EXECUTION_REQUEST_INVALID');
  return path.join(path.resolve(workspaceRoot), 'runs', batchId, 'execution-request.json');
}

function executionRequestDraftPath(workspaceRoot, batchId) {
  ensureId(batchId, 'batchId', 'EXECUTION_REQUEST_INVALID');
  return path.join(path.resolve(workspaceRoot), 'runs', batchId, 'execution-request.draft.json');
}

function executionRequestTargetsRoot(workspaceRoot, batchId) {
  ensureId(batchId, 'batchId', 'EXECUTION_REQUEST_INVALID');
  return path.join(path.resolve(workspaceRoot), 'runs', batchId, 'request-targets');
}

function environmentConfirmationSha(value) {
  const unsigned = { ...value };
  delete unsigned.confirmationSha;
  return sha256(canonicalJson(unsigned), 'environment-confirmation', 24);
}

function validateProbeSelection(probe, binding) {
  ensureObject(probe, 'probe', 'ENVIRONMENT_CONFIRMATION_INVALID');
  if (probe.ready !== true) throw contractError('ENVIRONMENT_NOT_READY', 'environment probe must be ready before confirmation');
  if (probe.platform !== binding.platform) throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'probe platform does not match binding');
  const devices = ensureArray(probe.devices, 'probe.devices', 'ENVIRONMENT_CONFIRMATION_INVALID');
  const selected = devices.some((device) => [device?.id, device?.serial, device?.udid, device?.name]
    .filter(Boolean).some((value) => String(value) === String(binding.deviceId)));
  if (!selected) throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'confirmed device is not present in the probe result');
  return probe;
}

function validateEnvironmentConfirmation(value) {
  ensureObject(value, 'environment confirmation', 'ENVIRONMENT_CONFIRMATION_INVALID');
  if (value.schemaVersion !== ENVIRONMENT_CONFIRMATION_SCHEMA_VERSION) {
    throw contractError('ENVIRONMENT_CONFIRMATION_SCHEMA_UNSUPPORTED', `schemaVersion must be ${ENVIRONMENT_CONFIRMATION_SCHEMA_VERSION}`);
  }
  ensureId(value.confirmationId, 'confirmationId', 'ENVIRONMENT_CONFIRMATION_INVALID');
  if (value.status !== 'CONFIRMED') throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'status must be CONFIRMED');
  validateBinding(value.binding);
  if (value.bindingSha !== bindingSha(value.binding)) throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'bindingSha does not match binding');
  ensureString(value.probeSha, 'probeSha', 'ENVIRONMENT_CONFIRMATION_INVALID');
  ensureString(value.userConfirmation, 'userConfirmation', 'ENVIRONMENT_CONFIRMATION_INVALID');
  if (value.userConfirmationSha !== sha256(value.userConfirmation, 'user-confirmation', 24)) {
    throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'userConfirmationSha does not match user confirmation');
  }
  if (Number.isNaN(Date.parse(value.confirmedAt))) throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'confirmedAt is invalid');
  if (value.confirmationSha !== environmentConfirmationSha(value)) {
    throw contractError('ENVIRONMENT_CONFIRMATION_INVALID', 'confirmationSha does not match environment confirmation');
  }
  return value;
}

function confirmEnvironment(options) {
  const workspace = assertWorkspace(options.workspaceRoot, { allowTest: true });
  const binding = validateBinding({ ...options.binding });
  const probe = validateProbeSelection(options.probe, binding);
  const userConfirmation = ensureString(options.userConfirmation, 'userConfirmation', 'ENVIRONMENT_CONFIRMATION_INVALID');
  const confirmedAt = options.now || new Date().toISOString();
  const seed = canonicalJson({ binding, probeSha: sha256(canonicalJson(probe), 'probe', 24), userConfirmation, confirmedAt });
  const value = {
    schemaVersion: ENVIRONMENT_CONFIRMATION_SCHEMA_VERSION,
    confirmationId: sha256(seed, 'env', 16),
    status: 'CONFIRMED',
    binding,
    bindingSha: bindingSha(binding),
    probeSha: sha256(canonicalJson(probe), 'probe', 24),
    userConfirmation,
    userConfirmationSha: sha256(userConfirmation, 'user-confirmation', 24),
    confirmedAt,
  };
  value.confirmationSha = environmentConfirmationSha(value);
  validateEnvironmentConfirmation(value);
  writeJsonAtomic(environmentConfirmationPath(workspace.root), value);
  return value;
}

function loadEnvironmentConfirmation(workspaceRoot) {
  const workspace = assertWorkspace(workspaceRoot, { allowTest: true });
  const value = readJson(environmentConfirmationPath(workspace.root), null);
  if (!value) throw contractError('ENVIRONMENT_NOT_CONFIRMED', 'environment has not been explicitly confirmed by the user');
  return validateEnvironmentConfirmation(value);
}

function resolveLiveExecutionTargets(workspaceRoot, inputTargets) {
  if (!Array.isArray(inputTargets) || !inputTargets.length) {
    throw contractError('EXECUTION_REQUEST_INVALID', 'targets must not be empty');
  }
  const casesRoot = fs.realpathSync(path.join(workspaceRoot, 'cases'));
  const keys = new Set();
  return inputTargets.map((target, index) => {
    if (!target || typeof target.caseDir !== 'string' || !target.caseDir.trim()) {
      throw contractError('EXECUTION_REQUEST_TARGET_INVALID', `targets[${index}].caseDir is required`);
    }
    let caseDir;
    try {
      caseDir = fs.realpathSync(path.resolve(target.caseDir));
    } catch (error) {
      throw contractError('EXECUTION_REQUEST_TARGET_INVALID', `targets[${index}].caseDir does not exist`);
    }
    const relative = path.relative(casesRoot, caseDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw contractError('EXECUTION_REQUEST_TARGET_OUTSIDE_WORKSPACE', `targets[${index}].caseDir must be inside workspace cases`);
    }
    const caseJson = readJson(path.join(caseDir, 'case.json'), null);
    try {
      validateCaseContract(caseJson);
    } catch (error) {
      throw contractError('EXECUTION_REQUEST_TARGET_INVALID', `targets[${index}] has an invalid case.json: ${error.message}`);
    }
    if (caseJson.identity.caseKey !== target.caseKey) {
      throw contractError('EXECUTION_REQUEST_TARGET_MISMATCH', `targets[${index}].caseKey does not match case.json`);
    }
    if (keys.has(target.caseKey)) throw contractError('EXECUTION_REQUEST_INVALID', `duplicate caseKey: ${target.caseKey}`);
    keys.add(target.caseKey);
    const sourcePath = path.join(caseDir, 'source.md');
    if (!fs.existsSync(sourcePath)) {
      throw contractError('EXECUTION_REQUEST_TARGET_INVALID', `targets[${index}] is missing source.md`);
    }
    const sourceText = fs.readFileSync(sourcePath, 'utf8');
    if (sourceSha(sourceText) !== caseJson.identity.sourceSha) {
      throw contractError('EXECUTION_REQUEST_TARGET_INVALID', `targets[${index}] source.md does not match case.json`);
    }
    return { caseKey: target.caseKey, caseDir, caseJson, sourceText };
  });
}

function snapshotTargetDescriptor(workspaceRoot, batchId, target, index) {
  const order = index + 1;
  const snapshotPath = path.join(executionRequestTargetsRoot(workspaceRoot, batchId), `${String(order).padStart(4, '0')}-${target.caseKey}`);
  return {
    order,
    caseKey: target.caseKey,
    caseDir: target.caseDir,
    snapshotPath,
    sourceSha: target.caseJson.identity.sourceSha,
    caseContractSha: target.caseJson.contractSha,
  };
}

function writeFrozenSnapshotFile(file, content) {
  if (!fs.existsSync(file)) {
    atomicWrite(file, content);
    return;
  }
  if (fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, 'utf8') !== content) {
    throw contractError('EXECUTION_REQUEST_SNAPSHOT_CHANGED', `frozen snapshot changed: ${file}`);
  }
}

function snapshotTarget(workspaceRoot, batchId, target, descriptor) {
  const root = executionRequestTargetsRoot(workspaceRoot, batchId);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw contractError('EXECUTION_REQUEST_SNAPSHOT_CHANGED', 'request-targets must not be a symbolic link');
  if (fs.existsSync(descriptor.snapshotPath)) {
    if (!fs.lstatSync(descriptor.snapshotPath).isDirectory() || fs.lstatSync(descriptor.snapshotPath).isSymbolicLink()) {
      throw contractError('EXECUTION_REQUEST_SNAPSHOT_CHANGED', `snapshot target is not a regular directory: ${descriptor.snapshotPath}`);
    }
  } else {
    fs.mkdirSync(descriptor.snapshotPath);
  }
  writeFrozenSnapshotFile(path.join(descriptor.snapshotPath, 'source.snapshot.md'), target.sourceText);
  writeFrozenSnapshotFile(path.join(descriptor.snapshotPath, 'case.snapshot.json'), `${JSON.stringify(target.caseJson, null, 2)}\n`);
  validateSnapshotTarget(workspaceRoot, batchId, descriptor, descriptor.order - 1);
  return descriptor;
}

function validateSnapshotTarget(workspaceRoot, batchId, target, index) {
  ensureObject(target, `targets[${index}]`, 'EXECUTION_REQUEST_INVALID');
  if (target.order !== index + 1) throw contractError('EXECUTION_REQUEST_INVALID', `targets[${index}].order is invalid`);
  ensureId(target.caseKey, `targets[${index}].caseKey`, 'EXECUTION_REQUEST_INVALID');
  ensureString(target.caseDir, `targets[${index}].caseDir`, 'EXECUTION_REQUEST_INVALID');
  ensureString(target.snapshotPath, `targets[${index}].snapshotPath`, 'EXECUTION_REQUEST_INVALID');
  ensureString(target.sourceSha, `targets[${index}].sourceSha`, 'EXECUTION_REQUEST_INVALID');
  ensureString(target.caseContractSha, `targets[${index}].caseContractSha`, 'EXECUTION_REQUEST_INVALID');
  const expectedRoot = executionRequestTargetsRoot(workspaceRoot, batchId);
  const resolved = path.resolve(target.snapshotPath);
  const relative = path.relative(expectedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError('EXECUTION_REQUEST_INVALID', `targets[${index}].snapshotPath is outside request-targets`);
  }
  if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isDirectory()) {
    throw contractError('EXECUTION_REQUEST_SNAPSHOT_MISSING', `targets[${index}] snapshot directory is missing or unsafe`);
  }
  const sourcePath = path.join(resolved, 'source.snapshot.md');
  const casePath = path.join(resolved, 'case.snapshot.json');
  if (!fs.existsSync(sourcePath)) throw contractError('EXECUTION_REQUEST_SNAPSHOT_MISSING', `targets[${index}] source snapshot is missing`);
  if (fs.lstatSync(sourcePath).isSymbolicLink() || (fs.existsSync(casePath) && fs.lstatSync(casePath).isSymbolicLink())) {
    throw contractError('EXECUTION_REQUEST_SNAPSHOT_CHANGED', `targets[${index}] snapshot files must not be symbolic links`);
  }
  const caseJson = readJson(casePath, null);
  if (!caseJson) throw contractError('EXECUTION_REQUEST_SNAPSHOT_MISSING', `targets[${index}] case snapshot is missing`);
  validateCaseContract(caseJson);
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  if (sourceSha(sourceText) !== target.sourceSha || caseJson.identity.sourceSha !== target.sourceSha
    || caseJson.contractSha !== target.caseContractSha || caseJson.identity.caseKey !== target.caseKey) {
    throw contractError('EXECUTION_REQUEST_SNAPSHOT_CHANGED', `targets[${index}] frozen snapshot binding changed`);
  }
  return { ...target, snapshotPath: resolved };
}

function resolveExecutionTargets(workspaceRoot, inputTargets, batchId) {
  if (!batchId) return resolveLiveExecutionTargets(workspaceRoot, inputTargets).map(({ caseJson, sourceText, ...target }) => target);
  return inputTargets.map((target, index) => validateSnapshotTarget(workspaceRoot, batchId, target, index));
}

function executionRequestSha(value) {
  const unsigned = { ...value };
  delete unsigned.requestSha;
  return sha256(canonicalJson(unsigned), 'execution-request', 24);
}

function validateExecutionRequest(value, options = {}) {
  ensureObject(value, 'execution request', 'EXECUTION_REQUEST_INVALID');
  if (value.schemaVersion !== EXECUTION_REQUEST_SCHEMA_VERSION) {
    throw contractError('EXECUTION_REQUEST_SCHEMA_UNSUPPORTED', `schemaVersion must be ${EXECUTION_REQUEST_SCHEMA_VERSION}`);
  }
  ensureId(value.requestId, 'requestId', 'EXECUTION_REQUEST_INVALID');
  ensureId(value.batchId, 'batchId', 'EXECUTION_REQUEST_INVALID');
  if (!EXECUTION_MODES.has(value.mode)) throw contractError('EXECUTION_REQUEST_INVALID', 'mode must be SINGLE or BATCH');
  if (value.interactionPolicy !== INTERACTION_POLICY) throw contractError('EXECUTION_REQUEST_INVALID', 'interactionPolicy must be UNATTENDED');
  ensureId(value.environmentConfirmationId, 'environmentConfirmationId', 'EXECUTION_REQUEST_INVALID');
  ensureString(value.environmentConfirmationSha, 'environmentConfirmationSha', 'EXECUTION_REQUEST_INVALID');
  ensureString(value.caseExecutorProtocolSha, 'caseExecutorProtocolSha', 'EXECUTION_REQUEST_INVALID');
  ensureString(value.coordinatorProtocolSha, 'coordinatorProtocolSha', 'EXECUTION_REQUEST_INVALID');
  ensureString(value.implementationSha, 'implementationSha', 'EXECUTION_REQUEST_INVALID');
  validateBinding(value.binding);
  const targets = ensureArray(value.targets, 'targets', 'EXECUTION_REQUEST_INVALID');
  if (!targets.length) throw contractError('EXECUTION_REQUEST_INVALID', 'targets must not be empty');
  if (value.mode === 'SINGLE' && targets.length !== 1) throw contractError('EXECUTION_REQUEST_INVALID', 'SINGLE mode requires exactly one target');
  const keys = new Set();
  targets.forEach((target, index) => {
    if (options.workspaceRoot) validateSnapshotTarget(options.workspaceRoot, value.batchId, target, index);
    if (keys.has(target.caseKey)) throw contractError('EXECUTION_REQUEST_INVALID', `duplicate caseKey: ${target.caseKey}`);
    keys.add(target.caseKey);
  });
  ensureString(value.userInstruction, 'userInstruction', 'EXECUTION_REQUEST_INVALID');
  if (value.userInstructionSha !== sha256(value.userInstruction, 'user-instruction', 24)) {
    throw contractError('EXECUTION_REQUEST_INVALID', 'userInstructionSha does not match user instruction');
  }
  if (Number.isNaN(Date.parse(value.requestedAt))) throw contractError('EXECUTION_REQUEST_INVALID', 'requestedAt is invalid');
  if (value.requestSha !== executionRequestSha(value)) throw contractError('EXECUTION_REQUEST_INVALID', 'requestSha does not match execution request');
  return value;
}

function createExecutionRequest(options) {
  const workspace = assertWorkspace(options.workspaceRoot, { allowTest: true });
  const environment = loadEnvironmentConfirmation(workspace.root);
  const batchId = ensureId(options.batchId, 'batchId', 'EXECUTION_REQUEST_INVALID');
  const mode = String(options.mode || '').trim().toUpperCase();
  if (!EXECUTION_MODES.has(mode)) throw contractError('EXECUTION_REQUEST_INVALID', 'mode must be SINGLE or BATCH');
  const requestFile = executionRequestPath(workspace.root, batchId);
  const draftFile = executionRequestDraftPath(workspace.root, batchId);
  const existing = readJson(requestFile, null);
  if (existing) {
    const validated = validateExecutionRequest(existing, { workspaceRoot: workspace.root });
    const requestedKeys = (options.targets || []).map((target) => target?.caseKey);
    if (validated.mode !== mode || validated.userInstruction !== options.userInstruction
      || canonicalJson(validated.targets.map((target) => target.caseKey)) !== canonicalJson(requestedKeys)) {
      throw contractError('EXECUTION_REQUEST_EXISTS', `batch ${batchId} already has a different execution request`);
    }
    const draft = readJson(draftFile, null);
    if (draft && draft.request?.requestId !== validated.requestId) {
      throw contractError('EXECUTION_REQUEST_DRAFT_INVALID', 'published request does not match the remaining draft');
    }
    if (draft) fs.unlinkSync(draftFile);
    return validated;
  }
  const userInstruction = ensureString(options.userInstruction, 'userInstruction', 'EXECUTION_REQUEST_INVALID');
  let draft = readJson(draftFile, null);
  if (draft) {
    const requestedKeys = (options.targets || []).map((target) => target?.caseKey);
    const frozenKeys = (draft.request?.targets || []).map((target) => target.caseKey);
    if (draft.schemaVersion !== 1 || !['STARTED', 'SNAPSHOTS_READY'].includes(draft.status)
      || draft.request?.batchId !== batchId || draft.request?.mode !== mode
      || draft.request?.userInstruction !== userInstruction
      || canonicalJson(requestedKeys) !== canonicalJson(frozenKeys)
      || draft.request?.environmentConfirmationSha !== environment.confirmationSha) {
      throw contractError('EXECUTION_REQUEST_DRAFT_INVALID', 'active execution request draft does not match this request');
    }
  } else {
    const liveTargets = resolveLiveExecutionTargets(workspace.root, options.targets);
    if (mode === 'SINGLE' && liveTargets.length !== 1) throw contractError('EXECUTION_REQUEST_INVALID', 'SINGLE mode requires exactly one target');
    validateKnowledgeRoots([
      path.join(options.skillRoot || path.join(__dirname, '..', '..'), 'knowledge'),
      path.join(workspace.root, 'knowledge'),
    ], { now: options.now });
    const requestedAt = options.now || new Date().toISOString();
    const skillRoot = path.resolve(options.skillRoot || path.join(__dirname, '..', '..'));
    const provider = options.provider || 'codex';
    const contractOptions = { skillRoot, provider, platform: environment.binding.platform };
    const caseExecutorContract = buildContract({ ...contractOptions, role: 'case-executor' });
    const coordinatorContract = buildContract({ ...contractOptions, role: 'batch-coordinator' });
    if (caseExecutorContract.implementationSha !== coordinatorContract.implementationSha) {
      throw contractError('AGENT_IMPLEMENTATION_MISMATCH', 'Agent roles do not share one implementation digest');
    }
    const targets = liveTargets.map((target, index) => snapshotTargetDescriptor(workspace.root, batchId, target, index));
    const value = {
      schemaVersion: EXECUTION_REQUEST_SCHEMA_VERSION,
      requestId: sha256(canonicalJson({ batchId, mode, targets, userInstruction, requestedAt }), 'request', 16),
      batchId,
      mode,
      interactionPolicy: INTERACTION_POLICY,
      environmentConfirmationId: environment.confirmationId,
      environmentConfirmationSha: environment.confirmationSha,
      caseExecutorProtocolSha: caseExecutorContract.protocolSha,
      coordinatorProtocolSha: coordinatorContract.protocolSha,
      implementationSha: caseExecutorContract.implementationSha,
      binding: { ...environment.binding },
      targets,
      userInstruction,
      userInstructionSha: sha256(userInstruction, 'user-instruction', 24),
      requestedAt,
    };
    draft = { schemaVersion: 1, status: 'STARTED', request: value, snapshotInputs: liveTargets };
    writeJsonAtomic(draftFile, draft);
  }
  if (options.interruptAfter === 'draft') throw new Error('MAVT_EXECUTION_REQUEST_INTERRUPTED: draft');
  draft.snapshotInputs.forEach((target, index) => {
    snapshotTarget(workspace.root, batchId, target, draft.request.targets[index]);
    if (options.interruptAfter === `snapshot-${index + 1}`) throw new Error(`MAVT_EXECUTION_REQUEST_INTERRUPTED: snapshot-${index + 1}`);
  });
  draft.status = 'SNAPSHOTS_READY';
  writeJsonAtomic(draftFile, draft);
  const value = draft.request;
  value.requestSha = executionRequestSha(value);
  validateExecutionRequest(value, { workspaceRoot: workspace.root });
  writeJsonAtomic(requestFile, value);
  if (options.interruptAfter === 'request') throw new Error('MAVT_EXECUTION_REQUEST_INTERRUPTED: request');
  fs.unlinkSync(draftFile);
  return value;
}

function loadExecutionRequest(workspaceRoot, batchId, options = {}) {
  const workspace = assertWorkspace(workspaceRoot, { allowTest: true });
  const value = readJson(executionRequestPath(workspace.root, batchId), null);
  if (!value) throw contractError('EXECUTION_REQUEST_REQUIRED', `batch ${batchId} has no explicit execution request`);
  const request = validateExecutionRequest(value, { workspaceRoot: workspace.root });
  if (request.batchId !== batchId) throw contractError('EXECUTION_REQUEST_INVALID', 'execution request batchId mismatch');
  if (options.requireCurrentEnvironment !== false) {
    const environment = loadEnvironmentConfirmation(workspace.root);
    if (environment.confirmationId !== request.environmentConfirmationId || environment.confirmationSha !== request.environmentConfirmationSha
      || canonicalJson(environment.binding) !== canonicalJson(request.binding)) {
      throw contractError('EXECUTION_REQUEST_ENVIRONMENT_CHANGED', 'environment confirmation changed after the execution request');
    }
  }
  resolveExecutionTargets(workspace.root, request.targets, batchId);
  return request;
}

module.exports = {
  ENVIRONMENT_CONFIRMATION_SCHEMA_VERSION,
  EXECUTION_MODES,
  EXECUTION_REQUEST_SCHEMA_VERSION,
  INTERACTION_POLICY,
  confirmEnvironment,
  createExecutionRequest,
  environmentConfirmationPath,
  environmentConfirmationSha,
  executionRequestPath,
  executionRequestDraftPath,
  executionRequestTargetsRoot,
  executionRequestSha,
  loadEnvironmentConfirmation,
  loadExecutionRequest,
  resolveExecutionTargets,
  resolveLiveExecutionTargets,
  validateEnvironmentConfirmation,
  validateExecutionRequest,
};

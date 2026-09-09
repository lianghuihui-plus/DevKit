'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureObject,
  ensureString,
  sha256,
} = require('./contract-utils');
const { normalizeDeviceBinding } = require('./target-binding');
const {
  appProvisioningSha,
  bootstrapPolicySha,
  initialStatePreflightSha,
  initialStateRequirementSha,
  preparationPolicySha,
  validateAppProvisioning,
  validateBootstrapPolicy,
  validateInitialStatePreflight,
  validateInitialStateRequirement,
  validatePreparationPolicy,
} = require('./app-provisioning');

const BATCH_CONTRACT_SCHEMA_VERSION = 7;
const PLATFORMS = new Set(['harmony', 'android', 'ios']);
const EXECUTION_MODES = new Set(['SINGLE', 'BATCH']);

function bindingSha(binding) {
  return sha256(canonicalJson(binding), 'target-binding', 24);
}

function batchContractSha(value) {
  const unsigned = { ...value };
  delete unsigned.contractSha;
  return sha256(canonicalJson(unsigned), 'batch-contract', 24);
}

function validateBinding(binding) {
  ensureObject(binding, 'binding', 'BATCH_CONTRACT_INVALID');
  let normalized;
  try {
    normalized = normalizeDeviceBinding(binding);
  } catch (error) {
    throw contractError('BATCH_CONTRACT_INVALID', error.message);
  }
  ensureString(normalized.deviceId, 'binding.deviceId', 'BATCH_CONTRACT_INVALID');
  ensureString(normalized.appId, 'binding.appId', 'BATCH_CONTRACT_INVALID');
  if (!PLATFORMS.has(normalized.platform)) throw contractError('BATCH_CONTRACT_INVALID', 'binding.platform is invalid');
  if (normalized.platform !== 'ios') ensureString(normalized.entry, 'binding.entry', 'BATCH_CONTRACT_INVALID');
  return normalized;
}

function validateBatchContract(value) {
  ensureObject(value, 'batch contract', 'BATCH_CONTRACT_INVALID');
  if (value.schemaVersion !== BATCH_CONTRACT_SCHEMA_VERSION) {
    throw contractError('BATCH_CONTRACT_SCHEMA_UNSUPPORTED', `schemaVersion must be ${BATCH_CONTRACT_SCHEMA_VERSION}`);
  }
  ensureId(value.batchId, 'batchId', 'BATCH_CONTRACT_INVALID');
  ensureString(value.caseProtocolSha, 'caseProtocolSha', 'BATCH_CONTRACT_INVALID');
  ensureString(value.coordinatorProtocolSha, 'coordinatorProtocolSha', 'BATCH_CONTRACT_INVALID');
  ensureString(value.runtimeSha, 'runtimeSha', 'BATCH_CONTRACT_INVALID');
  ensureString(value.adapterSha, 'adapterSha', 'BATCH_CONTRACT_INVALID');
  ensureString(value.coordinatorSha, 'coordinatorSha', 'BATCH_CONTRACT_INVALID');
  ensureId(value.executionRequestId, 'executionRequestId', 'BATCH_CONTRACT_INVALID');
  ensureString(value.executionRequestSha, 'executionRequestSha', 'BATCH_CONTRACT_INVALID');
  if (!EXECUTION_MODES.has(value.mode)) throw contractError('BATCH_CONTRACT_INVALID', 'mode must be SINGLE or BATCH');
  if (value.interactionPolicy !== 'UNATTENDED') throw contractError('BATCH_CONTRACT_INVALID', 'interactionPolicy must be UNATTENDED');
  validateBinding(value.binding);
  const provisioning = validateAppProvisioning(value.appProvisioning, {
    platform: value.binding.platform,
    appId: value.binding.appId,
    deviceType: value.binding.deviceType,
  });
  if (value.appProvisioningSha !== appProvisioningSha(provisioning)) throw contractError('BATCH_CONTRACT_INVALID', 'appProvisioningSha does not match appProvisioning');
  const bootstrapPolicy = validateBootstrapPolicy(value.bootstrapPolicy);
  if (value.bootstrapPolicySha !== bootstrapPolicySha(bootstrapPolicy)) throw contractError('BATCH_CONTRACT_INVALID', 'bootstrapPolicySha does not match bootstrapPolicy');
  if (bootstrapPolicy.mode === 'REINSTALL_FROZEN' && provisioning.mode !== 'ARTIFACT_MANAGED') {
    throw contractError('BATCH_CONTRACT_INVALID', 'REINSTALL_FROZEN requires ARTIFACT_MANAGED provisioning');
  }
  const targets = ensureArray(value.targets, 'targets', 'BATCH_CONTRACT_INVALID');
  if (!targets.length) throw contractError('BATCH_CONTRACT_INVALID', 'targets must not be empty');
  const keys = new Set();
  for (const [index, target] of targets.entries()) {
    ensureObject(target, `targets[${index}]`, 'BATCH_CONTRACT_INVALID');
    if (target.caseNo !== undefined) ensureString(target.caseNo, `targets[${index}].caseNo`, 'BATCH_CONTRACT_INVALID');
    ensureId(target.caseKey, `targets[${index}].caseKey`, 'BATCH_CONTRACT_INVALID');
    ensureString(target.caseDir, `targets[${index}].caseDir`, 'BATCH_CONTRACT_INVALID');
    ensureString(target.snapshotPath, `targets[${index}].snapshotPath`, 'BATCH_CONTRACT_INVALID');
    ensureString(target.sourceSha, `targets[${index}].sourceSha`, 'BATCH_CONTRACT_INVALID');
    ensureString(target.caseContractSha, `targets[${index}].caseContractSha`, 'BATCH_CONTRACT_INVALID');
    ensureString(target.caseSpecSha, `targets[${index}].caseSpecSha`, 'BATCH_CONTRACT_INVALID');
    const policy = validatePreparationPolicy(target.preparationPolicy);
    if (target.preparationPolicySha !== preparationPolicySha(policy)) throw contractError('BATCH_CONTRACT_INVALID', `targets[${index}].preparationPolicySha does not match preparationPolicy`);
    const requirement = validateInitialStateRequirement(target.initialStateRequirement);
    if (target.initialStateRequirementSha !== initialStateRequirementSha(requirement)) throw contractError('BATCH_CONTRACT_INVALID', `targets[${index}].initialStateRequirementSha does not match initialStateRequirement`);
    if (target.initialStatePreflightSha !== initialStatePreflightSha(target.initialStatePreflight)) throw contractError('BATCH_CONTRACT_INVALID', `targets[${index}].initialStatePreflightSha does not match initialStatePreflight`);
    validateInitialStatePreflight(target.initialStatePreflight, {
      requirement,
      preparationPolicy: policy,
      appProvisioning: provisioning,
      platform: value.binding.platform,
      provisioningOptions: { platform: value.binding.platform, appId: value.binding.appId, deviceType: value.binding.deviceType },
    });
    if (target.order !== index + 1) throw contractError('BATCH_CONTRACT_INVALID', `targets[${index}].order is invalid`);
    if (keys.has(target.caseKey)) throw contractError('BATCH_CONTRACT_INVALID', `duplicate caseKey: ${target.caseKey}`);
    keys.add(target.caseKey);
  }
  const expectedSha = batchContractSha(value);
  if (value.contractSha !== expectedSha) throw contractError('BATCH_CONTRACT_INVALID', 'contractSha does not match batch contract');
  return value;
}

function createBatchContract({ batchId, executionRequest }) {
  const value = {
    schemaVersion: BATCH_CONTRACT_SCHEMA_VERSION,
    batchId,
    caseProtocolSha: executionRequest.caseProtocolSha,
    coordinatorProtocolSha: executionRequest.coordinatorProtocolSha,
    runtimeSha: executionRequest.runtimeSha,
    adapterSha: executionRequest.adapterSha,
    coordinatorSha: executionRequest.coordinatorSha,
    executionRequestId: executionRequest.requestId,
    executionRequestSha: executionRequest.requestSha,
    mode: executionRequest.mode,
    interactionPolicy: executionRequest.interactionPolicy,
    binding: validateBinding({ ...executionRequest.binding }),
    appProvisioning: validateAppProvisioning(executionRequest.appProvisioning, {
      platform: executionRequest.binding.platform,
      appId: executionRequest.binding.appId,
      deviceType: executionRequest.binding.deviceType,
    }),
    appProvisioningSha: executionRequest.appProvisioningSha,
    bootstrapPolicy: validateBootstrapPolicy(executionRequest.bootstrapPolicy),
    bootstrapPolicySha: executionRequest.bootstrapPolicySha,
    targets: executionRequest.targets.map((target) => ({ ...target })),
  };
  value.contractSha = batchContractSha(value);
  return validateBatchContract(value);
}

function assertBatchImplementation(contract, versions = {}) {
  validateBatchContract(contract);
  for (const field of ['runtimeSha', 'adapterSha', 'coordinatorSha']) {
    if (versions[field] && contract[field] !== versions[field]) {
      throw contractError('BATCH_IMPLEMENTATION_MISMATCH', `batch belongs to a different ${field}`);
    }
  }
  if (versions.caseProtocolSha && contract.caseProtocolSha !== versions.caseProtocolSha) {
    throw contractError('BATCH_PROTOCOL_MISMATCH', 'batch belongs to a different case protocol');
  }
  if (versions.coordinatorProtocolSha && contract.coordinatorProtocolSha !== versions.coordinatorProtocolSha) {
    throw contractError('BATCH_PROTOCOL_MISMATCH', 'batch belongs to a different coordinator protocol');
  }
  return contract;
}

module.exports = {
  BATCH_CONTRACT_SCHEMA_VERSION,
  assertBatchImplementation,
  batchContractSha,
  bindingSha,
  createBatchContract,
  validateBatchContract,
  validateBinding,
};

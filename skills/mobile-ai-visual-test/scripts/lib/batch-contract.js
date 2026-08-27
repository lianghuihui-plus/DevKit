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

const BATCH_CONTRACT_SCHEMA_VERSION = 3;
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
  ensureString(value.implementationSha, 'implementationSha', 'BATCH_CONTRACT_INVALID');
  ensureString(value.caseExecutorProtocolSha, 'caseExecutorProtocolSha', 'BATCH_CONTRACT_INVALID');
  ensureString(value.coordinatorProtocolSha, 'coordinatorProtocolSha', 'BATCH_CONTRACT_INVALID');
  ensureId(value.executionRequestId, 'executionRequestId', 'BATCH_CONTRACT_INVALID');
  ensureString(value.executionRequestSha, 'executionRequestSha', 'BATCH_CONTRACT_INVALID');
  if (!EXECUTION_MODES.has(value.mode)) throw contractError('BATCH_CONTRACT_INVALID', 'mode must be SINGLE or BATCH');
  if (value.interactionPolicy !== 'UNATTENDED') throw contractError('BATCH_CONTRACT_INVALID', 'interactionPolicy must be UNATTENDED');
  validateBinding(value.binding);
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
    if (target.order !== index + 1) throw contractError('BATCH_CONTRACT_INVALID', `targets[${index}].order is invalid`);
    if (keys.has(target.caseKey)) throw contractError('BATCH_CONTRACT_INVALID', `duplicate caseKey: ${target.caseKey}`);
    keys.add(target.caseKey);
  }
  const expectedSha = batchContractSha(value);
  if (value.contractSha !== expectedSha) throw contractError('BATCH_CONTRACT_INVALID', 'contractSha does not match batch contract');
  return value;
}

function createBatchContract({ batchId, implementationSha, executionRequest }) {
  const value = {
    schemaVersion: BATCH_CONTRACT_SCHEMA_VERSION,
    batchId,
    implementationSha,
    caseExecutorProtocolSha: executionRequest.caseExecutorProtocolSha,
    coordinatorProtocolSha: executionRequest.coordinatorProtocolSha,
    executionRequestId: executionRequest.requestId,
    executionRequestSha: executionRequest.requestSha,
    mode: executionRequest.mode,
    interactionPolicy: executionRequest.interactionPolicy,
    binding: validateBinding({ ...executionRequest.binding }),
    targets: executionRequest.targets.map((target) => ({ ...target })),
  };
  value.contractSha = batchContractSha(value);
  return validateBatchContract(value);
}

function assertBatchImplementation(contract, implementationSha, protocols = {}) {
  validateBatchContract(contract);
  if (contract.implementationSha !== implementationSha) {
    throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'batch belongs to a different implementation');
  }
  if (protocols.caseExecutorProtocolSha && contract.caseExecutorProtocolSha !== protocols.caseExecutorProtocolSha) {
    throw contractError('BATCH_PROTOCOL_MISMATCH', 'batch belongs to a different case executor protocol');
  }
  if (protocols.coordinatorProtocolSha && contract.coordinatorProtocolSha !== protocols.coordinatorProtocolSha) {
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

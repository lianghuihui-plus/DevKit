#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');

const PLATFORMS = new Set(['harmony', 'android', 'ios']);
const RESULT_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']);
const SKILL_ROLES = new Set(['batch-coordinator', 'case-executor']);
const RUNTIME_OPERATIONS = new Set(['OPEN_SESSION', 'AWAIT_RESULT', 'INTERRUPT_SESSION', 'RELEASE_SESSION']);
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function ensureAbsolute(value, label) {
  if (!value || typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function normalizeProviderId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Agent Runtime provider is required');
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalized)) throw new Error('Agent Runtime provider must be a canonical machine identifier');
  return normalized;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function caseAgentRequestSha(request) {
  const unsigned = { ...request };
  delete unsigned.requestSha;
  return `request-${crypto.createHash('sha256').update(canonicalJson(unsigned)).digest('hex').slice(0, 16)}`;
}

function validateSkillContract(contract) {
  ensureObject(contract, 'skillContract');
  if (contract.schemaVersion !== 1) throw new Error('skillContract.schemaVersion must be 1');
  if (contract.name !== 'mobile-ai-visual-test') throw new Error('skillContract.name must be mobile-ai-visual-test');
  if (!SKILL_ROLES.has(contract.role)) throw new Error('skillContract.role is invalid');
  ensureAbsolute(contract.root, 'skillContract.root');
  if (!contract.protocolSha || !/^agent-protocol-[0-9a-f]{16}$/.test(contract.protocolSha)) throw new Error('skillContract.protocolSha is invalid');
  if (!/^agent-implementation-[0-9a-f]{16}$/.test(contract.implementationSha || '')) throw new Error('skillContract.implementationSha is invalid');
  if (!Array.isArray(contract.requiredResources) || !contract.requiredResources.length) throw new Error('skillContract.requiredResources must be a non-empty array');
  if (!Array.isArray(contract.allowedEntrypoints) || !contract.allowedEntrypoints.length) throw new Error('skillContract.allowedEntrypoints must be a non-empty array');
  for (const value of [...contract.requiredResources, ...contract.allowedEntrypoints]) {
    if (typeof value !== 'string' || path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new Error('skillContract resources and entrypoints must be safe relative paths');
  }
  return contract;
}

function validateCaseAgentRequest(request) {
  ensureObject(request, 'CaseAgentRequest');
  if (request.schemaVersion !== 1) throw new Error('CaseAgentRequest.schemaVersion must be 1');
  ensureAbsolute(request.workspaceCwd, 'CaseAgentRequest.workspaceCwd');
  ensureAbsolute(request.caseDir, 'CaseAgentRequest.caseDir');
  const relativeCase = path.relative(request.workspaceCwd, request.caseDir);
  if (!relativeCase || relativeCase.startsWith('..') || path.isAbsolute(relativeCase)) throw new Error('CaseAgentRequest.caseDir must be inside workspaceCwd');
  if (!PLATFORMS.has(request.platform)) throw new Error('CaseAgentRequest.platform is invalid');
  if (normalizeProviderId(request.provider) !== request.provider) throw new Error('CaseAgentRequest.provider must be canonical');
  if (!request.executionId || typeof request.executionId !== 'string') throw new Error('CaseAgentRequest.executionId is required');
  if (request.batchId !== null && request.batchId !== undefined && (typeof request.batchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.batchId))) throw new Error('CaseAgentRequest.batchId is invalid');
  if (typeof request.requestId !== 'string' || !request.requestId) throw new Error('CaseAgentRequest.requestId is required');
  if (!/^request-[0-9a-f]{16}$/.test(request.requestSha || '')) throw new Error('CaseAgentRequest.requestSha is required');
  if (caseAgentRequestSha(request) !== request.requestSha) throw new Error('CaseAgentRequest.requestSha does not match request content');
  if (!/^precondition-plan-/.test(request.preconditionPlanSha || '')) throw new Error('CaseAgentRequest.preconditionPlanSha is invalid');
  if (!/^contract-/.test(request.caseContractSha || '')) throw new Error('CaseAgentRequest.caseContractSha is invalid');
  validateSkillContract(request.skillContract);
  if (request.skillContract.role !== 'case-executor') throw new Error('CaseAgentRequest requires case-executor skillContract');
  if (!Array.isArray(request.confirmedPreconditions)) throw new Error('CaseAgentRequest.confirmedPreconditions must be an array');
  for (const item of request.confirmedPreconditions) {
    ensureObject(item, 'confirmedPrecondition');
    if (!item.id || typeof item.id !== 'string') throw new Error('confirmedPrecondition.id is required');
    if (!['PASS', 'PREPARED'].includes(item.status)) throw new Error('confirmedPrecondition.status must be PASS or PREPARED');
    if (!String(item.reason || '').trim()) throw new Error('confirmedPrecondition.reason is required');
  }
  const policy = ensureObject(request.executionPolicy, 'CaseAgentRequest.executionPolicy');
  if (policy.sessionScope !== 'case') throw new Error('CaseAgentRequest.executionPolicy.sessionScope must be case');
  if (policy.allowDestructiveActions !== false) throw new Error('CaseAgentRequest must forbid destructive actions');
  if (!Number.isFinite(Number(policy.maxDurationMs)) || Number(policy.maxDurationMs) <= 0) throw new Error('CaseAgentRequest.executionPolicy.maxDurationMs is invalid');
  for (const forbidden of ['conversation', 'history', 'timeline', 'screenshots', 'imageBase64']) {
    if (request[forbidden] !== undefined) throw new Error(`CaseAgentRequest must not embed ${forbidden}`);
  }
  return request;
}

function validateCaseAgentResult(result) {
  ensureObject(result, 'CaseAgentResult');
  if (result.schemaVersion !== 1) throw new Error('CaseAgentResult.schemaVersion must be 1');
  if (normalizeProviderId(result.provider) !== result.provider) throw new Error('CaseAgentResult.provider must be canonical');
  if (!result.executionId || typeof result.executionId !== 'string') throw new Error('CaseAgentResult.executionId is required');
  if (!/^request-[0-9a-f]{16}$/.test(result.requestSha || '')) throw new Error('CaseAgentResult.requestSha is required');
  if (!/^agent-protocol-[0-9a-f]{16}$/.test(result.protocolSha || '')) throw new Error('CaseAgentResult.protocolSha is invalid');
  if (!/^agent-implementation-[0-9a-f]{16}$/.test(result.implementationSha || '')) throw new Error('CaseAgentResult.implementationSha is invalid');
  if (!RESULT_STATUSES.has(result.status)) throw new Error('CaseAgentResult.status is invalid');
  if (result.failureCode !== null && result.failureCode !== undefined && typeof result.failureCode !== 'string') throw new Error('CaseAgentResult.failureCode must be a string or null');
  if (result.reason !== undefined && typeof result.reason !== 'string') throw new Error('CaseAgentResult.reason must be a string');
  if (result.finalized !== true) throw new Error('CaseAgentResult.finalized must be true');
  ensureAbsolute(result.resultPath, 'CaseAgentResult.resultPath');
  ensureAbsolute(result.metricsPath, 'CaseAgentResult.metricsPath');
  return result;
}

function validateRuntimeOperation(value) {
  ensureObject(value, 'RuntimeOperation');
  if (value.schemaVersion !== 1 || !value.operationId || !RUNTIME_OPERATIONS.has(value.kind)) throw new Error('RuntimeOperation identity is invalid');
  if (!value.executionId || normalizeProviderId(value.provider) !== value.provider) throw new Error('RuntimeOperation provider and executionId are required');
  if (value.kind === 'OPEN_SESSION') {
    ensureAbsolute(value.requestPath, 'RuntimeOperation.requestPath');
    ensureAbsolute(value.contractPath, 'RuntimeOperation.contractPath');
    if (!/^mavt_case_[0-9a-f]{16}$/.test(value.providerTaskName || '')) throw new Error('RuntimeOperation.providerTaskName is invalid');
  } else if (!String(value.sessionId || '').trim()) {
    throw new Error(`${value.kind} requires sessionId`);
  }
  if (['OPEN_SESSION', 'AWAIT_RESULT'].includes(value.kind)) {
    if (Number.isNaN(new Date(value.deadlineAt).getTime()) || !Number.isFinite(value.remainingMs) || value.remainingMs < 0) throw new Error(`${value.kind} deadline is invalid`);
  }
  return value;
}

function validateRuntimeOperationResult(value) {
  ensureObject(value, 'RuntimeOperationResult');
  if (!value.operationId || typeof value.operationId !== 'string') throw new Error('RuntimeOperationResult.operationId is required');
  if (typeof value.ok !== 'boolean') throw new Error('RuntimeOperationResult.ok must be boolean');
  if (value.timedOut !== undefined && typeof value.timedOut !== 'boolean') throw new Error('RuntimeOperationResult.timedOut must be boolean');
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') throw new Error('RuntimeOperationResult.sessionId must be a string');
  if (value.result !== undefined) ensureObject(value.result, 'RuntimeOperationResult.result');
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('RuntimeOperationResult.reason must be a string');
  return value;
}

module.exports = {
  caseAgentRequestSha,
  canonicalJson,
  normalizeProviderId,
  validateCaseAgentRequest,
  validateCaseAgentResult,
  validateRuntimeOperation,
  validateRuntimeOperationResult,
  validateSkillContract,
};

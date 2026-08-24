'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
  sha256,
} = require('./contract-utils');

const PLATFORMS = new Set(['harmony', 'android', 'ios']);
const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const EXECUTION_STATUSES = new Set(['COMPLETED', 'STOPPED_BY_BUDGET', 'TECHNICALLY_BLOCKED', 'INTERRUPTED']);
const FORBIDDEN_REQUEST_FIELDS = new Set([
  'conversation', 'history', 'timeline', 'screenshots', 'imageBase64', 'preconditionPlan',
  'preconditionPlanSha', 'preconditionInputs', 'preconditionInputsSha', 'steps', 'nextWork',
]);

function assertAgentContractDigests(value) {
  const { contractDigest, implementationDigest } = require('../build-agent-contract');
  const expectedProtocol = contractDigest(
    value.root,
    value.role,
    value.provider,
    value.platform,
    value.requiredResources,
    value.allowedEntrypoints,
  );
  const expectedImplementation = implementationDigest(value.root, value.role, value.platform);
  if (value.protocolSha !== expectedProtocol || value.implementationSha !== expectedImplementation.implementationSha
    || canonicalJson(value.implementationFiles) !== canonicalJson(expectedImplementation.implementationFiles)) {
    throw contractError('AGENT_PROTOCOL_MISMATCH', 'Skill contract digests do not match current files');
  }
}

function ensureAbsolute(value, label, code) {
  ensureString(value, label, code);
  if (!path.isAbsolute(value)) throw contractError(code, `${label} must be an absolute path`);
  return path.resolve(value);
}

function ensureInside(root, value, label, code) {
  const resolvedRoot = path.resolve(root);
  const resolved = ensureAbsolute(value, label, code);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError(code, `${label} must be inside ${resolvedRoot}`);
  }
  return resolved;
}

function validateAgentDrivenSkillContract(value) {
  ensureObject(value, 'skillContract', 'AGENT_CONTRACT_INVALID');
  if (value.schemaVersion !== 2 || value.profile !== undefined) {
    throw contractError('AGENT_CONTRACT_SCHEMA_UNSUPPORTED', 'current Skill contract is required and profile selection is not allowed');
  }
  if (value.name !== 'mobile-ai-visual-test' || value.role !== 'case-executor') {
    throw contractError('AGENT_CONTRACT_INVALID', 'Skill contract identity is invalid');
  }
  if (!PLATFORMS.has(value.platform)) throw contractError('AGENT_CONTRACT_INVALID', 'Skill contract platform is invalid');
  ensureAbsolute(value.root, 'skillContract.root', 'AGENT_CONTRACT_INVALID');
  ensureString(value.provider, 'skillContract.provider', 'AGENT_CONTRACT_INVALID');
  if (!/^agent-protocol-[0-9a-f]{16}$/.test(value.protocolSha || '')) throw contractError('AGENT_CONTRACT_INVALID', 'protocolSha is invalid');
  if (!/^agent-implementation-[0-9a-f]{16}$/.test(value.implementationSha || '')) throw contractError('AGENT_CONTRACT_INVALID', 'implementationSha is invalid');
  for (const field of ['requiredResources', 'allowedEntrypoints', 'implementationFiles']) {
    const values = ensureArray(value[field], `skillContract.${field}`, 'AGENT_CONTRACT_INVALID');
    if (!values.length) throw contractError('AGENT_CONTRACT_INVALID', `skillContract.${field} must not be empty`);
    for (const relative of values) {
      ensureString(relative, `${field} item`, 'AGENT_CONTRACT_INVALID');
      if (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) throw contractError('AGENT_CONTRACT_INVALID', `${field} contains an unsafe path`);
      if (!fs.existsSync(path.join(value.root, relative))) throw contractError('AGENT_PROTOCOL_MISMATCH', `missing contract file: ${relative}`);
    }
  }
  for (const forbidden of ['scripts/batch-runtime.js', 'scripts/execute-next-work.js']) {
    if (value.allowedEntrypoints.includes(forbidden)) throw contractError('AGENT_CONTRACT_INVALID', `${forbidden} is forbidden for a case Agent`);
  }
  if (value.allowedEntrypoints.some((entry) => entry.includes('/adapters/') || /restart/i.test(entry))) {
    throw contractError('AGENT_CONTRACT_INVALID', 'case Agent cannot call adapters or restart entrypoints');
  }
  assertAgentContractDigests(value);
  return value;
}

function agentRequestSha(value) {
  const unsigned = { ...value };
  delete unsigned.requestSha;
  return sha256(canonicalJson(unsigned), 'request', 24);
}

function validateAgentRequest(value) {
  ensureObject(value, 'CaseAgentRequest', 'AGENT_REQUEST_INVALID');
  if (value.schemaVersion !== 2) throw contractError('AGENT_REQUEST_SCHEMA_UNSUPPORTED', 'unsupported CaseAgentRequest schema');
  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    if (value[field] !== undefined) throw contractError('AGENT_REQUEST_CONTEXT_FORBIDDEN', `CaseAgentRequest must not embed ${field}`);
  }
  ensureId(value.requestId, 'requestId', 'AGENT_REQUEST_INVALID');
  ensureId(value.caseKey, 'caseKey', 'AGENT_REQUEST_INVALID');
  ensureId(value.executionId, 'executionId', 'AGENT_REQUEST_INVALID');
  ensureId(value.batchId, 'batchId', 'AGENT_REQUEST_INVALID');
  ensureId(value.sessionId, 'sessionId', 'AGENT_REQUEST_INVALID');
  if (!PLATFORMS.has(value.platform)) throw contractError('AGENT_REQUEST_INVALID', 'platform is invalid');
  ensureString(value.provider, 'provider', 'AGENT_REQUEST_INVALID');
  ensureString(value.sourceSha, 'sourceSha', 'AGENT_REQUEST_INVALID');
  ensureString(value.contractSha, 'contractSha', 'AGENT_REQUEST_INVALID');
  ensureString(value.batchContractSha, 'batchContractSha', 'AGENT_REQUEST_INVALID');
  ensureString(value.executionRequestSha, 'executionRequestSha', 'AGENT_REQUEST_INVALID');
  ensureString(value.implementationSha, 'implementationSha', 'AGENT_REQUEST_INVALID');
  ensureString(value.caseExecutorProtocolSha, 'caseExecutorProtocolSha', 'AGENT_REQUEST_INVALID');
  ensureString(value.coordinatorProtocolSha, 'coordinatorProtocolSha', 'AGENT_REQUEST_INVALID');
  ensureInteger(value.warmSessionGeneration, 'warmSessionGeneration', 'AGENT_REQUEST_INVALID', 1);
  const workspaceRoot = ensureAbsolute(value.workspaceCwd, 'workspaceCwd', 'AGENT_REQUEST_INVALID');
  const caseDir = ensureInside(workspaceRoot, value.caseDir, 'caseDir', 'AGENT_REQUEST_INVALID');
  const execDir = ensureInside(caseDir, value.execDir, 'execDir', 'AGENT_REQUEST_INVALID');
  ensureInside(execDir, value.sourcePath, 'sourcePath', 'AGENT_REQUEST_INVALID');
  if (path.resolve(value.sourcePath) !== path.join(execDir, 'source.snapshot.md')) throw contractError('AGENT_REQUEST_INVALID', 'sourcePath must reference the frozen source snapshot');
  ensureInside(execDir, value.agentContractPath, 'agentContractPath', 'AGENT_REQUEST_INVALID');
  if (path.resolve(value.agentContractPath) !== path.join(execDir, 'agent', 'contract.json')) {
    throw contractError('AGENT_REQUEST_INVALID', 'agentContractPath must reference the frozen runtime contract');
  }
  const runtimeContract = JSON.parse(fs.readFileSync(value.agentContractPath, 'utf8'));
  ensureString(value.agentContractSha, 'agentContractSha', 'AGENT_REQUEST_INVALID');
  const unsignedRuntimeContract = { ...runtimeContract };
  delete unsignedRuntimeContract.contractSha;
  const expectedRuntimeContractSha = sha256(canonicalJson(unsignedRuntimeContract), 'case-agent-runtime-contract', 24);
  if (runtimeContract.contractSha !== expectedRuntimeContractSha
    || runtimeContract.contractSha !== value.agentContractSha
    || runtimeContract.protocolSha !== value.caseExecutorProtocolSha
    || runtimeContract.implementationSha !== value.implementationSha
    || runtimeContract.platform !== value.platform) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'runtime Agent contract does not match the request');
  }
  const artifactPaths = ensureObject(value.artifactPaths, 'artifactPaths', 'AGENT_REQUEST_INVALID');
  const expectedArtifactNames = { understanding: 'understanding.json', plan: 'plan.json', result: 'result.json', metrics: 'metrics.json' };
  if (canonicalJson(Object.keys(artifactPaths).sort()) !== canonicalJson(Object.keys(expectedArtifactNames).sort())) {
    throw contractError('AGENT_REQUEST_INVALID', 'artifactPaths contains unsupported fields');
  }
  for (const [field, name] of Object.entries(expectedArtifactNames)) {
    ensureInside(execDir, artifactPaths[field], `artifactPaths.${field}`, 'AGENT_REQUEST_INVALID');
    if (path.resolve(artifactPaths[field]) !== path.join(execDir, name)) throw contractError('AGENT_REQUEST_INVALID', `artifactPaths.${field} is invalid`);
  }
  const roots = ensureArray(value.knowledgeRoots, 'knowledgeRoots', 'AGENT_REQUEST_INVALID');
  if (roots.length !== 2) throw contractError('AGENT_REQUEST_INVALID', 'knowledgeRoots must contain Skill and workspace roots');
  roots.forEach((root, index) => ensureAbsolute(root, `knowledgeRoots[${index}]`, 'AGENT_REQUEST_INVALID'));
  const expectedRoots = [path.join(value.skillContract?.root || '', 'knowledge'), path.join(workspaceRoot, 'knowledge')].map((root) => path.resolve(root));
  if (canonicalJson(roots.map((root) => path.resolve(root))) !== canonicalJson(expectedRoots)) {
    throw contractError('AGENT_REQUEST_INVALID', 'knowledgeRoots must be the frozen Skill and workspace knowledge directories');
  }
  const policy = ensureObject(value.executionPolicy, 'executionPolicy', 'AGENT_REQUEST_INVALID');
  if (canonicalJson(Object.keys(policy).sort()) !== canonicalJson(['actionAuthorization', 'interactionPolicy', 'maxDurationMs', 'sessionScope', 'userInteraction'])) {
    throw contractError('AGENT_REQUEST_INVALID', 'executionPolicy contains unsupported fields');
  }
  if (policy.sessionScope !== 'case' || policy.actionAuthorization !== 'agent-plan') throw contractError('AGENT_REQUEST_INVALID', 'executionPolicy is invalid');
  if (policy.interactionPolicy !== 'UNATTENDED' || policy.userInteraction !== 'forbidden') {
    throw contractError('AGENT_REQUEST_INVALID', 'case execution must forbid user interaction');
  }
  if (policy.maxDurationMs !== 30 * 60 * 1000) throw contractError('AGENT_REQUEST_INVALID', 'maxDurationMs must be 30 minutes');
  if (Number.isNaN(Date.parse(value.startedAt)) || Number.isNaN(Date.parse(value.deadlineAt))) throw contractError('AGENT_REQUEST_INVALID', 'request timestamps are invalid');
  if (Date.parse(value.deadlineAt) - Date.parse(value.startedAt) !== policy.maxDurationMs) throw contractError('AGENT_REQUEST_INVALID', 'deadlineAt does not match the execution time limit');
  validateAgentDrivenSkillContract(value.skillContract);
  if (value.skillContract.platform !== value.platform || value.skillContract.provider !== value.provider || value.skillContract.implementationSha !== value.implementationSha) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'request does not match its Skill contract');
  }
  if (value.skillContract.protocolSha !== value.caseExecutorProtocolSha) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'request does not match its frozen case executor protocol');
  }
  if (value.requestSha !== agentRequestSha(value)) throw contractError('AGENT_REQUEST_INVALID', 'requestSha does not match request content');
  return value;
}

function validateLiveAgentBinding(execDir) {
  const requestPath = path.join(execDir, 'agent', 'request.json');
  const executionPath = path.join(execDir, 'execution.json');
  const runtimePath = path.join(execDir, 'agent', 'runtime.json');
  if (!fs.existsSync(runtimePath)) throw contractError('AGENT_RUNTIME_NOT_BOUND', 'Agent Runtime must be BOUND to the current execution');
  if (!fs.existsSync(requestPath) || !fs.existsSync(executionPath)) {
    throw contractError('AGENT_REQUEST_ARTIFACT_MISSING', 'Agent request and execution state are required');
  }
  const request = validateAgentRequest(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const bindings = [
    ['executionId', execution.executionId],
    ['batchId', execution.batchId],
    ['implementationSha', execution.implementationSha],
    ['caseExecutorProtocolSha', execution.caseExecutorProtocolSha],
    ['coordinatorProtocolSha', execution.coordinatorProtocolSha],
    ['contractSha', execution.contractSha],
    ['batchContractSha', execution.batchContractSha],
    ['executionRequestSha', execution.executionRequestSha],
    ['warmSessionGeneration', execution.warmSessionGeneration],
  ];
  for (const [field, expected] of bindings) {
    if (request[field] !== expected) throw contractError('AGENT_REQUEST_BINDING_MISMATCH', `${field} drifted after request creation`);
  }
  if (runtime.status !== 'BOUND' || runtime.executionId !== execution.executionId || runtime.sessionId !== request.sessionId
    || runtime.batchId !== execution.batchId || runtime.warmSessionGeneration !== execution.warmSessionGeneration) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'Agent Runtime drifted after request creation');
  }
  return { request, execution, runtime };
}

function withAgentRequestSha(value) {
  const request = { ...value };
  request.requestSha = agentRequestSha(request);
  return request;
}

function validateAgentResult(value, options = {}) {
  ensureObject(value, 'CaseAgentResult', 'AGENT_RESULT_INVALID');
  if (value.schemaVersion !== 2) throw contractError('AGENT_RESULT_SCHEMA_UNSUPPORTED', 'unsupported CaseAgentResult schema');
  ensureId(value.executionId, 'executionId', 'AGENT_RESULT_INVALID');
  ensureId(value.sessionId, 'sessionId', 'AGENT_RESULT_INVALID');
  ensureString(value.requestSha, 'requestSha', 'AGENT_RESULT_INVALID');
  ensureString(value.protocolSha, 'protocolSha', 'AGENT_RESULT_INVALID');
  ensureString(value.caseExecutorProtocolSha, 'caseExecutorProtocolSha', 'AGENT_RESULT_INVALID');
  ensureString(value.coordinatorProtocolSha, 'coordinatorProtocolSha', 'AGENT_RESULT_INVALID');
  ensureString(value.implementationSha, 'implementationSha', 'AGENT_RESULT_INVALID');
  ensureString(value.contractSha, 'contractSha', 'AGENT_RESULT_INVALID');
  ensureString(value.batchContractSha, 'batchContractSha', 'AGENT_RESULT_INVALID');
  ensureString(value.executionRequestSha, 'executionRequestSha', 'AGENT_RESULT_INVALID');
  ensureString(value.resultSha256, 'resultSha256', 'AGENT_RESULT_INVALID');
  ensureString(value.metricsSha256, 'metricsSha256', 'AGENT_RESULT_INVALID');
  ensureInteger(value.warmSessionGeneration, 'warmSessionGeneration', 'AGENT_RESULT_INVALID', 1);
  if (!VERDICTS.has(value.verdict) || !EXECUTION_STATUSES.has(value.executionStatus)) throw contractError('AGENT_RESULT_INVALID', 'result status is invalid');
  if (value.finalized !== true) throw contractError('AGENT_RESULT_INVALID', 'finalized must be true');
  ensureAbsolute(value.resultPath, 'resultPath', 'AGENT_RESULT_INVALID');
  ensureAbsolute(value.metricsPath, 'metricsPath', 'AGENT_RESULT_INVALID');
  if (options.request) {
    const request = validateAgentRequest(options.request);
    for (const field of ['executionId', 'sessionId', 'requestSha', 'caseExecutorProtocolSha', 'coordinatorProtocolSha', 'implementationSha', 'contractSha', 'batchContractSha', 'executionRequestSha', 'warmSessionGeneration']) {
      if (value[field] !== request[field]) throw contractError('AGENT_RESULT_BINDING_MISMATCH', `${field} does not match request`);
    }
    if (value.protocolSha !== request.skillContract.protocolSha) throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'protocolSha does not match request');
    if (value.resultSha256 !== require('./completion-contract').sha256File(value.resultPath)
      || value.metricsSha256 !== require('./completion-contract').sha256File(value.metricsPath)) {
      throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'result artifact hash does not match AgentResult');
    }
    if (path.dirname(value.resultPath) !== request.execDir || path.dirname(value.metricsPath) !== request.execDir) throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'result artifacts belong to another execution');
  }
  return value;
}

module.exports = {
  FORBIDDEN_REQUEST_FIELDS,
  agentRequestSha,
  validateAgentDrivenSkillContract,
  validateLiveAgentBinding,
  validateAgentRequest,
  validateAgentResult,
  withAgentRequestSha,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { sourceSha } = require('../execution/contracts/case-contract');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { sha256File } = require('../lib/completion-contract');
const { buildExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');
const { validateResultKnowledgeSnapshots } = require('../lib/knowledge-snapshot');
const { timelineEvents } = require('../execution/core');
const { canonicalJson } = require('../lib/contract-utils');
const { buildCaseAgentRuntimeContract } = require('../lib/case-agent-runtime-contract');
const {
  validateAgentDrivenSkillContract,
  validateAgentRequest,
  validateAgentResult,
  withAgentRequestSha,
} = require('../lib/agent-driven-contract');

const CASE_TIME_LIMIT_MS = 30 * 60 * 1000;

function caseDirFromExecDir(execDir) {
  return path.resolve(execDir, '..', '..', '..', '..');
}

function createAgentRequest(options) {
  const execDir = fs.realpathSync(path.resolve(options.execDir));
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const snapshot = readJson(path.join(execDir, 'case.snapshot.json'), null);
  const runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
  const sourcePath = path.join(execDir, 'source.snapshot.md');
  if (!execution || !snapshot || !runtime || !fs.existsSync(sourcePath)) throw contractError('AGENT_REQUEST_ARTIFACT_MISSING', 'execution, snapshot, runtime, and source are required');
  if (execution.finalized || execution.lifecycle !== 'RUNNING' || runtime.status !== 'BOUND') throw contractError('AGENT_REQUEST_STATE_INVALID', 'execution and Agent Runtime must be running and bound');
  if (runtime.executionId !== execution.executionId || runtime.batchId !== execution.batchId || runtime.warmSessionGeneration !== execution.warmSessionGeneration) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'Agent Runtime does not match execution');
  }
  const skillContract = validateAgentDrivenSkillContract(options.skillContract);
  if (skillContract.implementationSha !== execution.implementationSha || skillContract.platform !== execution.platform) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'Skill contract does not match execution implementation or platform');
  }
  if (execution.caseExecutorProtocolSha && skillContract.protocolSha !== execution.caseExecutorProtocolSha) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'Skill contract does not match the frozen case executor protocol');
  }
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  if (sourceSha(sourceText) !== execution.sourceSha || snapshot.identity.sourceSha !== execution.sourceSha) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'source snapshot does not match execution');
  }
  const workspaceCwd = fs.realpathSync(path.resolve(options.workspaceRoot));
  const caseDir = caseDirFromExecDir(execDir);
  const startedAt = execution.startedAt;
  const runtimeContract = buildCaseAgentRuntimeContract({
    platform: execution.platform,
    protocolSha: skillContract.protocolSha,
    implementationSha: execution.implementationSha,
  });
  const agentContractPath = path.join(execDir, 'agent', 'contract.json');
  writeJsonAtomic(agentContractPath, runtimeContract);
  const request = withAgentRequestSha({
    schemaVersion: 2,
    requestId: `request-${execution.executionId}`,
    workspaceCwd,
    caseDir,
    execDir,
    caseKey: snapshot.identity.caseKey,
    platform: execution.platform,
    provider: skillContract.provider,
    executionId: execution.executionId,
    batchId: execution.batchId,
    sessionId: runtime.sessionId,
    sourcePath,
    sourceSha: execution.sourceSha,
    contractSha: execution.contractSha,
    batchContractSha: execution.batchContractSha,
    executionRequestSha: execution.executionRequestSha,
    implementationSha: execution.implementationSha,
    caseExecutorProtocolSha: execution.caseExecutorProtocolSha,
    coordinatorProtocolSha: execution.coordinatorProtocolSha,
    warmSessionGeneration: execution.warmSessionGeneration,
    knowledgeRoots: [
      path.join(skillContract.root, 'knowledge'),
      path.join(workspaceCwd, 'knowledge'),
    ],
    agentContractPath,
    agentContractSha: runtimeContract.contractSha,
    artifactPaths: {
      understanding: path.join(execDir, 'understanding.json'),
      plan: path.join(execDir, 'plan.json'),
      result: path.join(execDir, 'result.json'),
      metrics: path.join(execDir, 'metrics.json'),
    },
    startedAt,
    deadlineAt: new Date(Date.parse(startedAt) + CASE_TIME_LIMIT_MS).toISOString(),
    executionPolicy: {
      maxDurationMs: CASE_TIME_LIMIT_MS,
      sessionScope: 'case',
      actionAuthorization: 'agent-plan',
      interactionPolicy: execution.interactionPolicy,
      userInteraction: 'forbidden',
    },
    skillContract,
  });
  validateAgentRequest(request);
  const output = options.output || path.join(execDir, 'agent', 'request.json');
  writeJsonAtomic(output, request);
  return request;
}

function rebindAgentRequestGeneration(execDir, warmSessionGeneration) {
  const resolved = path.resolve(execDir);
  const requestPath = path.join(resolved, 'agent', 'request.json');
  if (!fs.existsSync(requestPath)) return null;
  const rawRequest = readJson(requestPath, null);
  if (rawRequest?.schemaVersion !== 2) return null;
  const request = validateAgentRequest(rawRequest);
  if (!Number.isInteger(warmSessionGeneration) || warmSessionGeneration < request.warmSessionGeneration) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'warm session generation cannot move backwards');
  }
  if (warmSessionGeneration === request.warmSessionGeneration) return request;
  const archivePath = path.join(resolved, 'agent', `request-generation-${request.warmSessionGeneration}.json`);
  const archived = readJson(archivePath, null);
  if (archived && archived.requestSha !== request.requestSha) {
    throw contractError('AGENT_REQUEST_BINDING_MISMATCH', 'archived Agent request does not match the current generation');
  }
  if (!archived) writeJsonAtomic(archivePath, request);
  const rebound = withAgentRequestSha({ ...request, warmSessionGeneration });
  validateAgentRequest(rebound);
  writeJsonAtomic(requestPath, rebound);
  return rebound;
}

function createAgentResult(options) {
  const execDir = fs.realpathSync(path.resolve(options.execDir));
  const request = validateAgentRequest(readJson(path.join(execDir, 'agent', 'request.json'), null));
  const runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const result = readJson(path.join(execDir, 'result.json'), null);
  const metrics = readJson(path.join(execDir, 'metrics.json'), null);
  if (!execution?.finalized || !result || !metrics) throw contractError('AGENT_RESULT_STATE_INVALID', 'execution must be finalized with result and metrics');
  if (!runtime || runtime.status !== 'BOUND' || runtime.executionId !== execution.executionId || runtime.sessionId !== request.sessionId
    || runtime.batchId !== execution.batchId || runtime.warmSessionGeneration !== execution.warmSessionGeneration) {
    throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'Agent Runtime does not match request');
  }
  validateResultKnowledgeSnapshots(execDir, result, timelineEvents(execDir));
  buildExecutionArtifactManifest(execDir, { now: options.now });
  const value = {
    schemaVersion: 2,
    executionId: execution.executionId,
    sessionId: runtime.sessionId,
    requestSha: request.requestSha,
    protocolSha: request.skillContract.protocolSha,
    caseExecutorProtocolSha: request.caseExecutorProtocolSha,
    coordinatorProtocolSha: request.coordinatorProtocolSha,
    implementationSha: execution.implementationSha,
    contractSha: execution.contractSha,
    batchContractSha: execution.batchContractSha,
    executionRequestSha: execution.executionRequestSha,
    warmSessionGeneration: execution.warmSessionGeneration,
    verdict: result.verdict,
    executionStatus: result.executionStatus,
    finalized: true,
    resultPath: path.join(execDir, 'result.json'),
    metricsPath: path.join(execDir, 'metrics.json'),
    resultSha256: sha256File(path.join(execDir, 'result.json')),
    metricsSha256: sha256File(path.join(execDir, 'metrics.json')),
  };
  validateAgentResult(value, { request });
  const output = path.join(execDir, 'agent', 'result.json');
  const existing = readJson(output, null);
  if (existing && canonicalJson(existing) !== canonicalJson(value)) {
    throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'agent/result.json is already bound to different artifacts');
  }
  if (!existing) writeJsonAtomic(output, value);
  return value;
}

module.exports = {
  CASE_TIME_LIMIT_MS,
  caseDirFromExecDir,
  createAgentRequest,
  createAgentResult,
  rebindAgentRequestGeneration,
};

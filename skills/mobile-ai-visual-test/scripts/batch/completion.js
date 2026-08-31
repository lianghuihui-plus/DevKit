'use strict';

const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { completionPaths, sha256File, validatePublishedCompletion } = require('../lib/completion-contract');
const { validateResultKnowledgeSnapshots } = require('../lib/knowledge-snapshot');
const { timelineEvents } = require('../execution/core');
const { validateAgentRequest, validateAgentResult } = require('../lib/agent-driven-contract');
const { buildExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');

function releaseRuntime(execDir, options = {}) {
  const runtimePath = path.join(execDir, 'agent', 'runtime.json');
  const runtime = readJson(runtimePath, null);
  if (!runtime) throw contractError('AGENT_RUNTIME_MISSING', 'Agent Runtime is missing');
  if (runtime.status === 'RELEASED') return runtime;
  const released = { ...runtime, status: 'RELEASED', releasedAt: options.now || new Date().toISOString() };
  writeJsonAtomic(runtimePath, released);
  return released;
}

function prepareCurrentCompletion(execDir) {
  const execution = readJson(path.join(execDir, 'execution.json'));
  const snapshot = readJson(path.join(execDir, 'case.snapshot.json'));
  const result = readJson(path.join(execDir, 'result.json'));
  const metrics = readJson(path.join(execDir, 'metrics.json'));
  const request = validateAgentRequest(readJson(path.join(execDir, 'agent', 'request.json'), null));
  const agentResult = validateAgentResult(readJson(path.join(execDir, 'agent', 'result.json'), null), { request });
  validateResultKnowledgeSnapshots(execDir, result, timelineEvents(execDir));
  if (agentResult.verdict !== result.verdict || agentResult.executionStatus !== result.executionStatus
    || agentResult.warmSessionGeneration !== execution.warmSessionGeneration) {
    throw contractError('AGENT_RESULT_BINDING_MISMATCH', 'AgentResult does not match finalized execution artifacts');
  }
  return { execution, snapshot, result, metrics };
}

function buildCurrentCompletion(execDir, state, item, prepared, runtime) {
  const { execution, snapshot, result, metrics } = prepared;
  if (runtime?.status !== 'RELEASED' || runtime.executionId !== execution.executionId) {
    throw contractError('AGENT_RUNTIME_STATE_INVALID', 'completion requires the current Agent Runtime to be released');
  }
  const paths = completionPaths(execDir);
  buildExecutionArtifactManifest(execDir);
  const completion = {
    schemaVersion: 2,
    executionId: execution.executionId,
    batchId: state.batchId,
    caseKey: item.caseKey,
    platform: execution.platform,
    completionSource: 'framework',
    implementationSha: execution.implementationSha,
    contractSha: execution.contractSha,
    batchContractSha: state.contractSha,
    resultSchemaVersion: 2,
    metricsSchemaVersion: 2,
    verdict: result.verdict,
    executionStatus: result.executionStatus,
    sessionReleased: true,
    resultSha256: sha256File(paths.result),
    metricsSha256: sha256File(paths.metrics),
    agentResultSha256: sha256File(paths.agentResult),
    artifactManifestSha256: sha256File(paths.artifactManifest),
    validationSha256: null,
  };
  return { completion, execution, snapshot, result, metrics };
}

function publishCurrentCompletion(execDir, prepared) {
  const { completion, execution, snapshot, result, metrics } = prepared;
  const paths = completionPaths(execDir);
  validatePublishedCompletion(execDir, completion, { execution, snapshot, result, metrics });
  const existing = readJson(paths.completion, null);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(completion)) {
      throw contractError('EXECUTION_COMPLETION_MISMATCH', 'completion.json is already bound to different artifacts');
    }
    return existing;
  }
  writeJsonAtomic(paths.completion, completion);
  return completion;
}

module.exports = {
  buildCurrentCompletion,
  prepareCurrentCompletion,
  publishCurrentCompletion,
  releaseRuntime,
};

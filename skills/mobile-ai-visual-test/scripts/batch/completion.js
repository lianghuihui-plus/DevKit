'use strict';

const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { completionPaths, sha256File, validateCompletionBinding } = require('../lib/completion-contract');
const { buildExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');

function releaseRuntime(execDir) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution?.schemaVersion !== 6) throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  const runtime = readJson(path.join(execDir, 'runtime.json'), null);
  if (!runtime || runtime.status !== 'COMPLETED') throw contractError('CASE_RUNTIME_INCOMPLETE', 'Case Runtime has not completed');
  return runtime;
}

function prepareCurrentCompletion(execDir, options = {}) {
  const committed = caseRuntimeLifecycle.commitExecution({ executionDir: execDir });
  const { execution, result, metrics } = committed;
  const snapshot = readJson(path.join(execDir, 'case.snapshot.json'));
  if (execution?.schemaVersion !== 6) throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  if (metrics?.schemaVersion !== 3 || metrics.executionId !== execution.executionId || metrics.verdict !== result.verdict) {
    throw contractError('CASE_RUNTIME_RESULT_BINDING_MISMATCH', 'Case Runtime result and metrics do not match the execution');
  }
  const artifactManifest = buildExecutionArtifactManifest(execDir, { hashFile: options.hashFile });
  const paths = completionPaths(execDir);
  const validationContext = {
    artifactManifest,
    resultSha256: (options.hashFile || sha256File)(paths.result),
    metricsSha256: (options.hashFile || sha256File)(paths.metrics),
    artifactManifestSha256: (options.hashFile || sha256File)(paths.artifactManifest),
  };
  return { execution, snapshot, result, metrics, validationContext };
}

function buildCurrentCompletion(execDir, state, item, prepared, runtime) {
  const { execution, snapshot, result, metrics, validationContext } = prepared;
  if (execution.schemaVersion !== 6) throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  if (runtime?.status !== 'COMPLETED' || runtime.executionId !== execution.executionId) {
    throw contractError('CASE_RUNTIME_STATE_INVALID', 'completion requires a completed Case Runtime');
  }
  return { completion: {
    schemaVersion: 3,
    executionId: execution.executionId,
    batchId: state.batchId,
    caseKey: item.caseKey,
    platform: execution.platform,
    completionSource: 'framework',
    runtimeSha: execution.runtimeSha,
    adapterSha: execution.adapterSha,
    contractSha: execution.contractSha,
    batchContractSha: state.contractSha,
    metricsSchemaVersion: 3,
    verdict: result.verdict,
    executionStatus: metrics.executionStatus,
    runtimeCompleted: true,
    resultSha256: validationContext.resultSha256,
    metricsSha256: validationContext.metricsSha256,
    artifactManifestSha256: validationContext.artifactManifestSha256,
  }, execution, snapshot, result, metrics, validationContext };
}

function publishCurrentCompletion(execDir, prepared) {
  const { completion, execution, snapshot, result, metrics } = prepared;
  const paths = completionPaths(execDir);
  validateCompletionBinding(completion, {
    executionId: execution.executionId,
    batchId: execution.batchId,
    caseKey: snapshot.identity?.caseKey,
    platform: execution.platform,
    completionSource: 'framework',
    runtimeSha: execution.runtimeSha,
    adapterSha: execution.adapterSha,
    contractSha: execution.contractSha,
    batchContractSha: execution.batchContractSha,
  });
  if (!prepared.validationContext?.artifactManifest) throw contractError('EXECUTION_VALIDATION_CONTEXT_MISSING', 'completion publication requires validated artifacts');
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

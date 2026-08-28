#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateResultKnowledgeSnapshots } = require('./knowledge-snapshot');
const { manifestPath, validateExecutionArtifactManifest } = require('./execution-artifact-manifest');

function sha256File(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing completion artifact: ${file}`);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function completionPaths(execDir) {
  return {
    completion: path.join(execDir, 'completion.json'),
    execution: path.join(execDir, 'execution.json'),
    snapshot: path.join(execDir, 'case.snapshot.json'),
    result: path.join(execDir, 'result.json'),
    metrics: path.join(execDir, 'metrics.json'),
    timeline: path.join(execDir, 'timeline.jsonl'),
    agentResult: path.join(execDir, 'agent', 'result.json'),
    runtime: path.join(execDir, 'agent', 'runtime.json'),
    artifactManifest: manifestPath(execDir),
  };
}

function validateCurrentCompletionBinding(value, expected) {
  for (const field of ['executionId', 'batchId', 'caseKey', 'platform', 'completionSource', 'implementationSha', 'contractSha', 'batchContractSha']) {
    if ((value[field] || null) !== (expected[field] || null)) throw new Error(`Execution completion ${field} mismatch`);
  }
  if (value.resultSchemaVersion !== 2 || value.metricsSchemaVersion !== 2) throw new Error('Execution completion artifact schema mismatch');
  if (!['agent', 'framework'].includes(value.completionSource)) throw new Error('Execution completion source is invalid');
  if (typeof value.implementationSha !== 'string' || !value.implementationSha.trim() || typeof value.contractSha !== 'string' || !value.contractSha.trim()) {
    throw new Error('Execution completion implementation binding is invalid');
  }
  if (typeof value.batchContractSha !== 'string' || !value.batchContractSha.trim()) throw new Error('Execution completion batch binding is invalid');
  if (!['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(value.verdict)) throw new Error('Execution completion verdict is invalid');
  if (!['COMPLETED', 'STOPPED_BY_BUDGET', 'TECHNICALLY_BLOCKED', 'INTERRUPTED'].includes(value.executionStatus)) throw new Error('Execution completion executionStatus is invalid');
  if (!/^[0-9a-f]{64}$/.test(value.resultSha256 || '') || !/^[0-9a-f]{64}$/.test(value.metricsSha256 || '') || !/^[0-9a-f]{64}$/.test(value.agentResultSha256 || '')) throw new Error('Execution completion artifact hash is invalid');
  if (value.artifactManifestSha256 !== undefined && !/^[0-9a-f]{64}$/.test(value.artifactManifestSha256 || '')) throw new Error('Execution completion artifact manifest hash is invalid');
  if (value.sessionReleased !== true) throw new Error('Current execution completion requires a released Agent session');
  if (value.completionSource !== 'framework' || value.validationSha256) throw new Error('Current completion must be published by the framework');
  return value;
}

function validateCompletionBinding(value, expected) {
  if (value?.schemaVersion !== 2) throw new Error(`Unsupported execution completion schema: ${value?.schemaVersion ?? 'missing'}`);
  return validateCurrentCompletionBinding(value, expected);
}

function validatePublishedCompletion(execDir, completion, artifacts) {
  if (completion?.schemaVersion !== 2) throw new Error(`Unsupported execution completion schema: ${completion?.schemaVersion ?? 'missing'}`);
  return validateCurrentPublishedCompletion(execDir, completion, artifacts);
}

function validateCurrentPublishedCompletion(execDir, completion, artifacts) {
  const paths = completionPaths(execDir);
  const { execution, result, metrics, snapshot } = artifacts;
  if (!execution?.finalized || !result || !metrics || !snapshot) throw new Error('Execution completion artifacts are incomplete');
  validateCurrentCompletionBinding(completion, {
    executionId: execution.executionId,
    batchId: execution.batchId,
    caseKey: snapshot.identity?.caseKey,
    platform: execution.platform || result.platform || null,
    completionSource: completion.completionSource,
    implementationSha: execution.implementationSha,
    contractSha: execution.contractSha,
    batchContractSha: execution.batchContractSha,
  });
  if (result.schemaVersion !== completion.resultSchemaVersion || metrics.schemaVersion !== completion.metricsSchemaVersion) throw new Error('Execution completion artifact schema mismatch');
  if (result.executionId !== execution.executionId || metrics.executionId !== execution.executionId) throw new Error('Execution completion artifact binding mismatch');
  if (result.verdict !== completion.verdict || metrics.verdict !== completion.verdict || result.executionStatus !== completion.executionStatus || metrics.executionStatus !== completion.executionStatus) {
    throw new Error('Execution completion result mismatch');
  }
  if (sha256File(paths.result) !== completion.resultSha256 || sha256File(paths.metrics) !== completion.metricsSha256) throw new Error('Execution completion artifact hash mismatch');
  if (sha256File(paths.agentResult) !== completion.agentResultSha256) throw new Error('Execution completion AgentResult hash mismatch');
  const events = fs.existsSync(paths.timeline)
    ? fs.readFileSync(paths.timeline, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  validateResultKnowledgeSnapshots(execDir, result, events);
  if (completion.artifactManifestSha256) validateExecutionArtifactManifest(execDir, completion.artifactManifestSha256);
  return completion;
}

function completionDisplayResult(result, completion) {
  if (!completion) return result;
  return { ...result, verdict: completion.verdict, executionStatus: completion.executionStatus, completionSource: completion.completionSource };
}

module.exports = {
  completionDisplayResult,
  completionPaths,
  sha256File,
  validateCompletionBinding,
  validateCurrentCompletionBinding,
  validatePublishedCompletion,
};

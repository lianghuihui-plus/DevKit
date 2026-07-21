#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  caseRuntimeDir,
  readJson,
  readJsonl,
} = require('./common');
const { validateCaseAgentRequest, validateCaseAgentResult } = require('./lib/agent-runtime-contract');

function usage() {
  console.error('Usage: validate-case-agent-result.js <case-dir> --platform <platform> --request-json <json> --result-json <json>');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const caseDir = path.resolve(args[0]);
  const options = {};
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': options.platform = args[++i]; break;
      case '--request-json': options.request = JSON.parse(args[++i]); break;
      case '--result-json': options.result = JSON.parse(args[++i]); break;
      default: usage();
    }
  }
  if (!options.platform || !options.request || !options.result) usage();
  const request = validateCaseAgentRequest(options.request);
  const agentResult = validateCaseAgentResult(options.result);
  if (request.caseDir !== caseDir || request.platform !== options.platform) throw new Error('AGENT_RESULT_INVALID: request target mismatch');
  if (agentResult.executionId !== request.executionId) throw new Error('AGENT_RESULT_INVALID: executionId mismatch');
  if (agentResult.requestSha !== request.requestSha) throw new Error('AGENT_RESULT_INVALID: requestSha mismatch');
  if (agentResult.protocolSha !== request.skillContract.protocolSha) throw new Error('AGENT_RESULT_INVALID: protocolSha mismatch');
  if (agentResult.implementationSha !== request.skillContract.implementationSha) throw new Error('AGENT_RESULT_INVALID: implementationSha mismatch');
  if (agentResult.provider !== request.provider) throw new Error(`AGENT_RESULT_INVALID: provider mismatch: expected ${request.provider}, received ${agentResult.provider}`);
  const execDir = path.join(caseRuntimeDir(caseDir, options.platform), 'executions', request.executionId);
  const agentDir = path.join(execDir, 'agent');
  const persistedContract = readJson(path.join(agentDir, 'contract.json'));
  if (persistedContract && (persistedContract.protocolSha !== request.skillContract.protocolSha || persistedContract.implementationSha !== request.skillContract.implementationSha)) throw new Error('AGENT_RESULT_INVALID: persisted contract mismatch');
  const persistedRuntime = readJson(path.join(agentDir, 'runtime.json'));
  if (!persistedRuntime) throw new Error('AGENT_RESULT_INVALID: missing runtime.json');
  if (persistedRuntime.provider !== request.provider || persistedRuntime.requestSha !== request.requestSha || persistedRuntime.protocolSha !== request.skillContract.protocolSha || persistedRuntime.implementationSha !== request.skillContract.implementationSha) {
    throw new Error('AGENT_RESULT_INVALID: persisted runtime request binding mismatch');
  }
  if ((persistedRuntime.batchId || null) !== (request.batchId || null)) throw new Error('AGENT_RESULT_INVALID: persisted runtime batch binding mismatch');
  const bound = readJsonl(path.join(execDir, 'timeline.jsonl')).find((event) => event.type === 'agentRuntime' && event.status === 'BOUND');
  if (!bound) throw new Error('AGENT_RESULT_INVALID: missing Agent Runtime BOUND event');
  if (bound.provider !== request.provider) throw new Error(`AGENT_RESULT_INVALID: runtime provider mismatch: expected ${request.provider}, bound ${bound.provider}`);
  if (bound.protocolSha !== agentResult.protocolSha) throw new Error('AGENT_RESULT_INVALID: runtime protocolSha mismatch');
  if (bound.implementationSha !== agentResult.implementationSha) throw new Error('AGENT_RESULT_INVALID: runtime implementationSha mismatch');
  if (bound.requestSha !== request.requestSha || !bound.sessionId) throw new Error('AGENT_RESULT_INVALID: runtime request/session binding mismatch');
  const expectedResultPath = path.join(execDir, 'result.json');
  const expectedMetricsPath = path.join(execDir, 'metrics.json');
  if (path.resolve(agentResult.resultPath) !== expectedResultPath || path.resolve(agentResult.metricsPath) !== expectedMetricsPath) {
    throw new Error('AGENT_RESULT_INVALID: result artifact path mismatch');
  }
  if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedMetricsPath)) throw new Error('AGENT_RESULT_INVALID: missing result or metrics artifact');
  const execution = readJson(path.join(execDir, 'execution.json'));
  const result = readJson(expectedResultPath);
  const metrics = readJson(expectedMetricsPath);
  if (!execution?.finalized || !agentResult.finalized) throw new Error('AGENT_RESULT_INVALID: execution is not finalized');
  if ((execution.batchId || null) !== (request.batchId || null)) throw new Error('AGENT_RESULT_INVALID: execution batch binding mismatch');
  if (result.executionId !== request.executionId || metrics.executionId !== request.executionId) throw new Error('AGENT_RESULT_INVALID: artifact executionId mismatch');
  for (const artifact of [result, metrics]) {
    if (artifact.caseContractSha !== request.caseContractSha) throw new Error('AGENT_RESULT_INVALID: caseContractSha mismatch');
    if (artifact.preconditionPlanSha !== request.preconditionPlanSha) throw new Error('AGENT_RESULT_INVALID: preconditionPlanSha mismatch');
  }
  if (result.status !== agentResult.status || (result.failureCode || null) !== (agentResult.failureCode || null)) {
    throw new Error('AGENT_RESULT_INVALID: agent status does not match result.json');
  }
  if (metrics.status !== result.status || (metrics.failureCode || null) !== (result.failureCode || null)) {
    throw new Error('AGENT_RESULT_INVALID: metrics status does not match result.json');
  }
  const validation = {
    schemaVersion: 1,
    valid: true,
    executionId: request.executionId,
    status: result.status,
    failureCode: result.failureCode || null,
    resultPath: expectedResultPath,
    metricsPath: expectedMetricsPath,
  };
  console.log(JSON.stringify(validation, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}

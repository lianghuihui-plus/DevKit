#!/usr/bin/env node
'use strict';

const path = require('path');
const { caseRuntimeDir, readJson } = require('./common');
const { validateCaseAgentRequest, validateCaseAgentResult } = require('./lib/agent-runtime-contract');

function usage() {
  console.error('Usage: build-case-agent-result.js <case-dir> --platform <platform> --execution-id <id>');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const caseDir = path.resolve(args[0]);
  const options = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--platform') options.platform = args[++i];
    else if (args[i] === '--execution-id') options.executionId = args[++i];
    else usage();
  }
  if (!options.platform || !options.executionId) usage();
  const execDir = path.join(caseRuntimeDir(caseDir, options.platform), 'executions', options.executionId);
  const agentDir = path.join(execDir, 'agent');
  const request = validateCaseAgentRequest(readJson(path.join(agentDir, 'request.json')));
  const execution = readJson(path.join(execDir, 'execution.json'));
  const result = readJson(path.join(execDir, 'result.json'));
  const metrics = readJson(path.join(execDir, 'metrics.json'));
  if (!execution?.finalized || !result || !metrics) throw new Error('Execution must be finalized before building CaseAgentResult');
  const value = {
    schemaVersion: 1,
    provider: request.provider,
    executionId: options.executionId,
    requestSha: request.requestSha,
    protocolSha: request.skillContract.protocolSha,
    implementationSha: request.skillContract.implementationSha,
    status: result.status,
    failureCode: result.failureCode || null,
    reason: result.reason || '',
    finalized: true,
    resultPath: path.join(execDir, 'result.json'),
    metricsPath: path.join(execDir, 'metrics.json'),
  };
  validateCaseAgentResult(value);
  console.log(JSON.stringify(value, null, 2));
}

try { main(); } catch (error) { console.error(error.message || String(error)); process.exit(1); }

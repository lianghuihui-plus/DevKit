#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  caseContractSha,
  caseRuntimeDir,
  readJson,
  writeJson,
} = require('./common');
const { caseAgentRequestSha, validateCaseAgentRequest, validateSkillContract } = require('./lib/agent-runtime-contract');
const { validateExecutionEnvironment } = require('./lib/execution-environment');
const { validateFrozenPreconditionInputs } = require('./lib/precondition-inputs');

function usage() {
  console.error('Usage: build-case-agent-request.js <case-dir> --platform <platform> --execution-id <id> --provider <id> --skill-contract-json <json> [--workspace-cwd <path>] [--output <path>]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const caseDir = path.resolve(args[0]);
  const options = { workspaceCwd: process.cwd() };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': options.platform = args[++i]; break;
      case '--execution-id': options.executionId = args[++i]; break;
      case '--provider': options.provider = args[++i]; break;
      case '--skill-contract-json': options.skillContract = JSON.parse(args[++i]); break;
      case '--workspace-cwd': options.workspaceCwd = path.resolve(args[++i]); break;
      case '--output': options.output = path.resolve(args[++i]); break;
      default: usage();
    }
  }
  if (!options.platform || !options.executionId || !options.provider || !options.skillContract) usage();
  validateSkillContract(options.skillContract);
  const execDir = path.join(caseRuntimeDir(caseDir, options.platform), 'executions', options.executionId);
  const execution = readJson(path.join(execDir, 'execution.json'));
  if (!execution) throw new Error(`Execution was not started: ${options.executionId}`);
  if (execution.finalized || execution.lifecycle !== 'RUNNING') throw new Error(`Execution is not RUNNING: ${options.executionId}`);
  const caseJson = readJson(path.join(execDir, 'case.snapshot.json'));
  if (!caseJson) throw new Error(`EXECUTION_CONTRACT_CORRUPTED: missing case.snapshot.json in ${execDir}`);
  if (execution.caseContractSha && execution.caseContractSha !== caseContractSha(caseJson)) throw new Error('EXECUTION_CONTRACT_CORRUPTED: case snapshot mismatch');
  validateExecutionEnvironment(execution, options.platform);
  const preconditionInputs = validateFrozenPreconditionInputs(execution);
  const request = {
    schemaVersion: 1,
    requestId: `case-${options.executionId}`,
    workspaceCwd: options.workspaceCwd,
    caseDir,
    platform: options.platform,
    provider: options.provider,
    executionId: options.executionId,
    batchId: execution.batchId || null,
    preconditionPlanSha: execution.preconditionPlanSha,
    preconditionInputsSha: execution.preconditionInputsSha,
    environmentSha: execution.environmentSha,
    caseContractSha: execution.caseContractSha || caseContractSha(caseJson),
    skillContract: options.skillContract,
    preconditionInputs,
    executionPolicy: {
      maxDurationMs: execution.budget?.maxDurationMs || 30 * 60 * 1000,
      sessionScope: 'case',
      actionPolicy: {
        mode: 'case_step_authorized',
        authorizationSource: 'case.snapshot.json',
        allowAgentInitiatedSideEffects: false,
      },
    },
  };
  request.requestSha = caseAgentRequestSha(request);
  validateCaseAgentRequest(request);
  if (options.output) writeJson(options.output, request);
  console.log(JSON.stringify(request, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { caseContractSha, caseRuntimeDir, readJson, readJsonl, validateCaseExecutionContract } = require('../common');
const { deriveNextWork } = require('./execution-reducer');
const { nextWorkToken } = require('./next-work-contract');

function latestExecutionId(runtimeDir) {
  const root = path.join(runtimeDir, 'executions');
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory()).sort().at(-1) || null;
}

function loadCaseExecutionContext(options) {
  const runtimeDir = caseRuntimeDir(options.caseDir, options.platform);
  const executionId = options.executionId || latestExecutionId(runtimeDir);
  if (!executionId) throw new Error('No execution exists. Run --start first or pass --execution-id.');
  const execDir = path.join(runtimeDir, 'executions', executionId);
  const execution = readJson(path.join(execDir, 'execution.json'));
  if (!execution) throw new Error(`Execution was not started: ${executionId}`);
  const snapshotPath = path.join(execDir, 'case.snapshot.json');
  const caseJson = readJson(snapshotPath);
  if (!caseJson) throw new Error(`EXECUTION_CONTRACT_CORRUPTED: missing ${snapshotPath}`);
  validateCaseExecutionContract(caseJson);
  if (!execution.caseContractSha || execution.caseContractSha !== caseContractSha(caseJson)) {
    throw new Error('EXECUTION_CONTRACT_CORRUPTED: case.snapshot.json does not match execution.json');
  }
  const events = readJsonl(path.join(execDir, 'timeline.jsonl'));
  const request = readJson(path.join(execDir, 'agent', 'request.json'), null);
  const nextWork = deriveNextWork({
    caseJson,
    execution,
    events,
    execDir,
    confirmedPreconditions: request?.confirmedPreconditions || [],
  });
  return {
    runtimeDir,
    executionId,
    execDir,
    execution,
    caseJson,
    events,
    request,
    nextWork,
    workToken: nextWorkToken({ execution, events, nextWork }),
  };
}

module.exports = { latestExecutionId, loadCaseExecutionContext };

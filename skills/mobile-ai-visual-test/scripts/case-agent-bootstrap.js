#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseCliArgs } = require('./lib/cli-args');
const { prepareAgentHandoff } = require('./batch/agent-handoff');
const { AGENT_FACING_PROTOCOL, documentationRefFor } = require('./case-runtime/agent-facing-contract');

function parseArgs(argv) {
  const parsed = parseCliArgs(argv, {
    context: 'case-agent-bootstrap',
    valueOptions: ['--workspace', '--handoff', '--sha256', '--execution-id', '--case-protocol-sha', '--claim-token'],
    maxPositionals: 0,
  });
  for (const flag of ['--workspace', '--handoff', '--sha256', '--execution-id', '--case-protocol-sha', '--claim-token']) {
    if (!parsed.values[flag]) {
      const error = new Error(`CASE_AGENT_BOOTSTRAP_INVALID: ${flag} is required`);
      error.code = 'CASE_AGENT_BOOTSTRAP_INVALID';
      error.errorKind = 'INPUT';
      error.issues = [{ fieldPath: flag.slice(2), code: 'REQUIRED_FIELD_MISSING', expected: 'a non-empty value from loaderCommand' }];
      error.exitCode = 2;
      throw error;
    }
  }
  return {
    workspaceRoot: path.resolve(parsed.values['--workspace']),
    handoffPath: path.resolve(parsed.values['--handoff']),
    sha256: parsed.values['--sha256'],
    executionId: parsed.values['--execution-id'],
    caseProtocolSha: parsed.values['--case-protocol-sha'],
    claimToken: parsed.values['--claim-token'],
  };
}

function loaderErrorResponse(error) {
  const inputInvalid = error?.errorKind === 'INPUT' || error?.code === 'CASE_AGENT_BOOTSTRAP_INVALID';
  let code = 'CASE_RUNTIME_TECHNICAL';
  if (inputInvalid) code = 'AGENT_INPUT_INVALID';
  else if (String(error?.code || '').startsWith('HANDOFF_')) code = 'BINDING_INVALID';
  else if (error?.code === 'AGENT_PROTOCOL_MISMATCH') code = 'PROTOCOL_MISMATCH';
  return {
    protocol: AGENT_FACING_PROTOCOL,
    status: inputInvalid ? 'REQUEST_INVALID' : 'TECHNICAL',
    code,
    message: error?.message || String(error),
    retryable: inputInvalid,
    ...(inputInvalid ? {
      issues: error?.issues?.length ? error.issues : [{ fieldPath: 'loaderCommand', code: 'INVALID_ARGUMENT', expected: 'the original loaderCommand without changes' }],
    } : {
      facts: { technical: { code: error?.code || 'CASE_AGENT_BOOTSTRAP_FAILED', stage: 'HANDOFF_LOADER' } },
    }),
    documentationRef: documentationRefFor(code),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { claim, ...loaded } = prepareAgentHandoff(options);
  const { listExecutionDirs, readJson } = require('./lib/execution-lifecycle');
  const matches = listExecutionDirs(options.workspaceRoot).filter((execDir) => (
    readJson(path.join(execDir, 'execution.json'), null)?.executionId === options.executionId
  ));
  if (matches.length !== 1) throw Object.assign(new Error('Handoff execution binding is unavailable or ambiguous'), { code: 'HANDOFF_BINDING_INVALID' });
  const resource = require('./case-runtime/agent-resource-store').publishCaseBrief(matches[0], options.handoffPath, options.workspaceRoot);
  const output = `${JSON.stringify({ ...loaded, caseBriefRef: resource.data.ref })}\n`;
  claim();
  process.stdout.write(output);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify(loaderErrorResponse(error), null, 2)}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = { loaderErrorResponse, main, parseArgs };

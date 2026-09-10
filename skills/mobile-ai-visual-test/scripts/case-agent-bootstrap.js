#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseCliArgs } = require('./lib/cli-args');
const { loadAgentHandoff } = require('./batch/agent-handoff');

function parseArgs(argv) {
  const parsed = parseCliArgs(argv, {
    context: 'case-agent-bootstrap',
    valueOptions: ['--workspace', '--handoff', '--sha256', '--execution-id', '--case-protocol-sha', '--claim-token'],
    maxPositionals: 0,
  });
  for (const flag of ['--workspace', '--handoff', '--sha256', '--execution-id', '--case-protocol-sha']) {
    if (!parsed.values[flag]) {
      const error = new Error(`CASE_AGENT_BOOTSTRAP_INVALID: ${flag} is required`);
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

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(loadAgentHandoff(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = { main, parseArgs };

#!/usr/bin/env node
'use strict';

const path = require('path');
const { ensureWorkspace } = require('./lib/workspace');
const { ensureWorkspaceCaseNumbers } = require('./lib/case-numbering');
const { renderIndexForRoot } = require('./report/report-service');
const { capabilityCards } = require('./coordinator/agent-facing-contract');
const { writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--cwd') throw new Error('WORKSPACE_CLI_INVALID: --cwd is required');
  const result = ensureWorkspace(path.resolve(argv[1]));
  const numbering = ensureWorkspaceCaseNumbers(result.root);
  if (numbering.changed) renderIndexForRoot(result.root);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(__dirname, 'workspace.js'))} --cwd ${JSON.stringify(result.root)}`;
  const coordinatorCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(__dirname, 'coordinator-agent.js'))}`;
  process.stdout.write(`${JSON.stringify({
    ...result,
    caseNumbering: numbering,
    coordinatorFacade: {
      schemaVersion: 1,
      entrypoint: 'scripts/coordinator-agent.js',
      command,
      prepareUsage: `${coordinatorCommand} prepare --workspace ${JSON.stringify(result.root)} --case-nos <014,015>`,
      capabilities: capabilityCards(),
    },
  }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/workspace.js'); process.exit(error.exitCode || 2); }
}

module.exports = { main };

#!/usr/bin/env node
'use strict';

const path = require('path');
const { ensureWorkspace } = require('./lib/workspace');
const { ensureWorkspaceCaseNumbers } = require('./lib/case-numbering');
const { renderIndexForRoot } = require('./report/report-service');
const { AGENT_FACING_INTERFACE_KIND, AGENT_FACING_PROTOCOL } = require('./coordinator/agent-facing-contract');
const { parseCoordinatorCliArgs, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function main(argv = process.argv.slice(2)) {
  const options = parseCoordinatorCliArgs(argv, 'scripts/workspace.js');
  const result = ensureWorkspace(path.resolve(options.cwd));
  const numbering = ensureWorkspaceCaseNumbers(result.root);
  if (numbering.changed) renderIndexForRoot(result.root);
  const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  const coordinatorCommand = `${quote(process.execPath)} ${quote(path.resolve(__dirname, 'coordinator-agent.js'))} --workspace ${quote(result.root)}`;
  process.stdout.write(`${JSON.stringify({
    ...result,
    caseNumbering: numbering,
    coordinatorFacade: {
      interfaceKind: AGENT_FACING_INTERFACE_KIND,
      protocol: AGENT_FACING_PROTOCOL,
      command: coordinatorCommand,
      documentation: 'references/coordinator.md',
    },
  }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/workspace.js'); process.exit(error.exitCode || 2); }
}

module.exports = { main };

#!/usr/bin/env node
'use strict';

const path = require('path');
const { assertWorkspace } = require('./lib/workspace');
const { validateKnowledgeRoots } = require('./lib/knowledge-query');
const { writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function parseArgs(argv) {
  if (argv[0] !== 'validate') throw new Error('KNOWLEDGE_CLI_INVALID: command must be validate');
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--workspace') options.workspace = path.resolve(argv[++index]);
    else if (argv[index] === '--now') options.now = argv[++index];
    else throw new Error(`KNOWLEDGE_CLI_INVALID: unknown option ${argv[index]}`);
  }
  if (!options.workspace) throw new Error('KNOWLEDGE_CLI_INVALID: --workspace is required');
  return options;
}

function validateWorkspaceKnowledge(options) {
  const workspace = assertWorkspace(options.workspace, { allowTest: true });
  return validateKnowledgeRoots([
    path.join(__dirname, '..', 'knowledge'),
    path.join(workspace.root, 'knowledge'),
  ], { now: options.now });
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(validateWorkspaceKnowledge(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/knowledge.js', process.argv[2]); process.exit(error.exitCode || 2); }
}

module.exports = { main, parseArgs, validateWorkspaceKnowledge };

#!/usr/bin/env node
'use strict';

const path = require('path');
const { assertWorkspace } = require('./lib/workspace');
const { validateKnowledgeRoots } = require('./lib/knowledge-query');
const { parseCoordinatorCliArgs, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function parseArgs(argv) {
  const options = parseCoordinatorCliArgs(argv, 'scripts/knowledge.js');
  options.workspace = path.resolve(options.workspace);
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

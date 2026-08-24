#!/usr/bin/env node
'use strict';

const path = require('path');
const { runAgentCli } = require('./cli-support');

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--exec-dir') options.execDir = path.resolve(argv[++index]);
    else if (argv[index] === '--request-json') options.request = JSON.parse(argv[++index]);
    else throw new Error(`AGENT_CONCLUDE_CLI_INVALID: unknown option ${argv[index]}`);
  }
  if (!options.execDir || !options.request) throw new Error('AGENT_CONCLUDE_CLI_INVALID: --exec-dir and --request-json are required');
  return require('./facade-core').conclude(options.execDir, options.request);
}

if (require.main === module) runAgentCli('conclude', process.argv.slice(2), {
  command: "node scripts/agent/conclude.js --exec-dir <execution> --request-json '<json>'",
}, main);

module.exports = { main };

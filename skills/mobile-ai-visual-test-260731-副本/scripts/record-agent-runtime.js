#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const path = require('path');

function usage() {
  console.error('Usage: record-agent-runtime.js <case-dir> --platform <platform> --execution-id <id> --event-json <json>');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const caseDir = path.resolve(args[0]);
  const options = {};
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': options.platform = args[++i]; break;
      case '--execution-id': options.executionId = args[++i]; break;
      case '--event-json': options.eventJson = args[++i]; break;
      default: usage();
    }
  }
  if (!options.platform || !options.executionId || !options.eventJson) usage();
  const event = JSON.parse(options.eventJson);
  event.type = 'agentRuntime';
  event.source = 'record-agent-runtime.js';
  const stdout = childProcess.execFileSync(process.execPath, [
    path.join(__dirname, 'run-case.js'), caseDir,
    '--platform', options.platform,
    '--record-agent-runtime-json', JSON.stringify(event),
    '--execution-id', options.executionId,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MAVT_AGENT_RUNTIME_WRITER: '1' },
  });
  process.stdout.write(stdout);
}

try {
  main();
} catch (error) {
  console.error(error.stderr ? String(error.stderr).trim() : error.message || String(error));
  process.exit(error.status || 1);
}

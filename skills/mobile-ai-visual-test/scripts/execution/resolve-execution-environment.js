#!/usr/bin/env node
'use strict';

const path = require('path');
const { caseRuntimeDir, readJson } = require('../common');
const { environmentAdapterArgs, validateExecutionEnvironment } = require('../lib/execution-environment');

function usage() {
  console.error('Usage: resolve-execution-environment.js <args|validate> --case-dir <dir> --platform <platform> --execution-id <id> [--purpose <action|observe>] [--device <id>] [--app <id>] [--entry <id>]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (!['args', 'validate'].includes(args[0])) usage();
  const options = { command: args[0], purpose: 'observe' };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--case-dir': options.caseDir = path.resolve(args[++i]); break;
      case '--platform': options.platform = args[++i]; break;
      case '--execution-id': options.executionId = args[++i]; break;
      case '--purpose': options.purpose = args[++i]; break;
      case '--device': options.device = args[++i]; break;
      case '--app': options.app = args[++i]; break;
      case '--entry': options.entry = args[++i]; break;
      default: usage();
    }
  }
  if (!options.caseDir || !['harmony', 'android', 'ios'].includes(options.platform) || !options.executionId) usage();
  if (!['action', 'observe'].includes(options.purpose)) usage();
  const execDir = path.join(caseRuntimeDir(options.caseDir, options.platform), 'executions', options.executionId);
  const execution = readJson(path.join(execDir, 'execution.json'));
  const snapshot = validateExecutionEnvironment(execution, options.platform);
  const binding = snapshot.binding;
  for (const [field, actual] of [['device', options.device], ['appId', options.app], ['entry', options.entry]]) {
    if (actual && String(actual) !== String(binding[field] || '')) {
      const error = new Error(`ENVIRONMENT_BINDING_MISMATCH: ${field} does not match frozen execution environment`);
      error.exitCode = 2;
      throw error;
    }
  }
  if (options.command === 'validate') {
    console.log(JSON.stringify({ environmentSha: execution.environmentSha, environment: binding }, null, 2));
    return;
  }
  process.stdout.write(`${environmentAdapterArgs(binding, options.purpose).join('\n')}\n`);
}

try { main(); } catch (error) { console.error(error.message || String(error)); process.exit(error.exitCode || 1); }

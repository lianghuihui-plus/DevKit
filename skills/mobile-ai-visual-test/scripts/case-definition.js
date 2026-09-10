#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCaseNo } = require('./lib/case-numbering');
const { loadPublishedCaseDefinition, publishCaseDefinition, readCaseSource, compilerLoaderCommand } = require('./case/definition-store');

function fail(message) {
  const error = new Error(`CASE_DEFINITION_CLI_INVALID: ${message}`);
  error.code = 'CASE_DEFINITION_CLI_INVALID';
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['status', 'load-source', 'publish'].includes(command)) fail(`unknown command: ${command || 'missing'}`);
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`invalid option: ${flag}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  return options;
}

function resolveCaseDir(options) {
  if (options.caseDir) return path.resolve(options.caseDir);
  if (!options.workspace || !options.caseNo) fail('--case-dir or --workspace with --case-no is required');
  const resolved = resolveCaseNo(path.resolve(options.workspace), options.caseNo);
  if (!resolved) fail(`case number does not exist: ${options.caseNo}`);
  return resolved.caseDir;
}

function parseJson(value, flag) {
  if (!value) fail(`${flag} is required`);
  try { return JSON.parse(value); } catch (error) { fail(`${flag} is invalid JSON: ${error.message}`); }
}

function execute(options) {
  const caseDir = resolveCaseDir(options);
  if (options.command === 'load-source') {
    const source = readCaseSource(caseDir);
    const script = path.resolve(__filename);
    return {
      caseKey: source.caseJson.identity.caseKey,
      caseNo: source.caseJson.identity.caseNo,
      source: source.sourceText,
      compilerPrompt: fs.readFileSync(path.resolve(__dirname, '../prompts/case-definition-compiler.md'), 'utf8'),
      publisher: {
        command: process.execPath,
        args: [script, 'publish', '--case-dir', caseDir, '--compiler-profile-sha', 'case-definition-compiler-v1'],
        candidateArgument: '--candidate-json',
      },
    };
  }
  if (options.command === 'publish') {
    return publishCaseDefinition({
      caseDir,
      candidate: parseJson(options.candidateJson, '--candidate-json'),
      compilerProfileSha: options.compilerProfileSha || 'case-definition-compiler-v1',
    });
  }
  try {
    const published = loadPublishedCaseDefinition(caseDir);
    return {
      status: 'READY',
      caseKey: published.caseJson.identity.caseKey,
      caseNo: published.caseJson.identity.caseNo,
      definitionRef: {
        definitionId: published.definition.definitionId,
        definitionSha: published.definition.definitionSha,
      },
    };
  } catch (error) {
    if (error.code !== 'CASE_DEFINITION_REQUIRED') throw error;
    return {
      status: 'CASE_DEFINITION_REQUIRED',
      caseKey: error.caseKey,
      compilerHandoff: { loaderCommand: compilerLoaderCommand(caseDir) },
    };
  }
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(execute(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'ERROR', code: error.code || 'CASE_DEFINITION_FAILED', message: error.message || String(error) })}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { execute, main, parseArgs };

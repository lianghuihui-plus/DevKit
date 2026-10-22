#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(PLUGIN_ROOT, 'runtime/mobile-ai-visual-test');
const { assertWorkspace, ensureWorkspace } = require(path.join(SOURCE_ROOT, 'scripts/lib/workspace'));
const { bundleError, pinBundle, verifyBundle } = require(path.join(SOURCE_ROOT, 'scripts/lib/runtime-bundle'));
const { readRunBinding } = require(path.join(SOURCE_ROOT, 'scripts/lib/runtime-binding'));

function parse(argv) {
  const [operation, ...args] = argv;
  const values = {};
  const allowed = operation === 'workspace' ? ['--cwd'] : ['--workspace', ...(operation === 'resume' ? ['--run'] : [])];
  if (!['workspace', 'knowledge', 'resume', 'doctor'].includes(operation)) throw bundleError('MAVT_ENTRY_INPUT_INVALID', 'expected workspace, knowledge, resume or doctor');
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || Object.hasOwn(values, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw bundleError('MAVT_ENTRY_INPUT_INVALID', 'invalid or repeated argument');
    values[args[i]] = args[i + 1];
  }
  const value = values[operation === 'workspace' ? '--cwd' : '--workspace'];
  if (!value || !path.isAbsolute(value)) throw bundleError('MAVT_ENTRY_INPUT_INVALID', 'provide an absolute workspace path');
  return { operation, workspace: path.resolve(value), run: values['--run'] };
}
function listRuns(workspace) {
  const directory = path.join(workspace, 'runs');
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.name.startsWith('.')) continue;
    try {
      if (!entry.isDirectory()) throw bundleError('MAVT_RUNTIME_BINDING_INVALID', 'Run path is not an ordinary directory');
      const loaded = readRunBinding(workspace, entry.name);
      result.push({ batchId: entry.name, phase: loaded.state.phase, legacy: !loaded.binding, ...(loaded.binding ? { bundleId: loaded.binding.bundleId } : {}) });
    } catch (error) { result.push({ batchId: entry.name, code: error.code || 'MAVT_RUNTIME_BINDING_INVALID', message: error.message }); }
  }
  return result;
}
function staging(workspace) {
  const entries = relative => {
    const directory = path.join(workspace, relative);
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name !== '.publish.lock').sort() : [];
  };
  return { runs: entries('.mavt/run-staging'), bundles: entries('.mavt/runtime-bundles').filter(name => name.startsWith('.staging-')) };
}
function execute(argv) {
  const options = parse(argv);
  if (options.operation === 'workspace') ensureWorkspace(options.workspace);
  else assertWorkspace(options.workspace);
  const workspace = fs.realpathSync(options.workspace);
  if (options.operation === 'doctor') {
    const runs = listRuns(workspace);
    const bundles = [];
    const root = path.join(workspace, '.mavt/runtime-bundles');
    if (fs.existsSync(root)) for (const id of fs.readdirSync(root).filter(name => !name.startsWith('.')).sort()) {
      try { verifyBundle(path.join(root, id), id); bundles.push({ bundleId: id, status: 'VALID' }); }
      catch (error) { bundles.push({ bundleId: id, status: 'INVALID', code: error.code, message: error.message }); }
    }
    return { status: runs.some(run => run.code) || bundles.some(bundle => bundle.status === 'INVALID') ? 'FAILED' : 'SUCCEEDED', workspace, runs, bundles, staging: staging(workspace), reportPath: path.join(workspace, 'index.html') };
  }
  if (options.operation === 'resume') {
    let run = options.run;
    if (!run) {
      const candidates = listRuns(workspace);
      if (candidates.length !== 1) return { status: 'SUCCEEDED', outcome: 'NEED_RUN_SELECTION', workspace, candidates, staging: staging(workspace) };
      run = candidates[0].batchId;
    }
    const loaded = readRunBinding(workspace, run);
    if (!loaded.binding) throw bundleError('MAVT_LEGACY_RUN_REQUIRES_ORIGINAL_RUNTIME', 'finish or cancel this Run through its original standalone runtime');
    return { status: 'SUCCEEDED', workspace, batchId: run, bundleId: loaded.bundleId, runtimeRoot: loaded.runtimeRoot, documentationRoot: loaded.documentationRoot,
      hostProfilePath: loaded.hostProfilePath, knowledgeRoot: loaded.knowledgeRoot,
      coordinatorFacade: { command: loaded.state.command, documentation: 'references/coordinator.md', documentationRoot: loaded.documentationRoot } };
  }
  const pinned = pinBundle(PLUGIN_ROOT, workspace);
  if (options.operation === 'knowledge') return { status: 'SUCCEEDED', workspace, ...pinned, entry: path.join(pinned.knowledgeRoot, 'scripts/knowledge-manager.js') };
  const opened = JSON.parse(execFileSync(process.execPath, [path.join(pinned.runtimeRoot, 'scripts/workspace.js'), '--cwd', workspace], { encoding: 'utf8' }));
  return { status: 'SUCCEEDED', ...opened, ...pinned };
}
function main(argv = process.argv.slice(2)) {
  let response;
  try { response = execute(argv); }
  catch (error) { response = { status: 'FAILED', code: error.code || 'MAVT_ENTRY_TECHNICAL', message: error.message }; }
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (response.status !== 'SUCCEEDED') process.exitCode = 2;
  return response;
}
if (require.main === module) main();
module.exports = { execute, listRuns, main, parse };

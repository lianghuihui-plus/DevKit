'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { assertWorkspace, ensureWorkspace } = require('../lib/workspace');
const { pinBundle, plainPath, verifyBundle, bundleError } = require('../lib/runtime-bundle');
const { readRunBinding } = require('../lib/runtime-binding');
const { createContext, resolveContext, existingPath, safeTree, safeWorkspace, workspacePath } = require('./bindings');
const { definitions, validate } = require('./contract');
const { successEnvelope } = require('../lib/agent-facing-envelope');
function load(context, relative) { return require(plainPath(context.runtimeRoot, relative.endsWith('.js') ? relative : relative + '.js', 'file')); }
function runFailure(context, operation, error) {
  if (error.status === 'UNKNOWN') return failureValue(error);
  const service = load(context, 'scripts/coordinator/agent-facing-service');
  const stalled = error.code === 'COORDINATOR_INPUT_INVALID' && service.recordCoordinatorInputFailure(context.statePath, operation, error);
  const resources = !String(error.code).startsWith('MAVT_RUNTIME_') ? service.failureResources(context.statePath, error) : [];
  const response = load(context, 'scripts/coordinator-agent').errorResponse(error, operation, stalled, resources);
  service.recordProtocolResponse(context.statePath, response, 0, { hostTransport: 'mcp' });
  return { ...response, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) };
}
function diagnostic(workspace) {
  safeWorkspace(workspace);
  const runs = fs.existsSync(path.join(workspace, 'runs')) ? fs.readdirSync(path.join(workspace, 'runs')).filter(name => !name.startsWith('.')).sort().map(batchId => {
    try { const loaded = readRunBinding(workspace, batchId); return { batchId, phase: loaded.state.phase, legacy: !loaded.binding, ...(loaded.binding ? { bundleId: loaded.bundleId } : {}) }; }
    catch (error) { return { batchId, code: error.code, message: error.message }; }
  }) : [];
  const root = path.join(workspace, '.mavt/runtime-bundles');
  const bundles = fs.existsSync(root) ? fs.readdirSync(root).filter(name => !name.startsWith('.')).sort().map(bundleId => {
    try { verifyBundle(path.join(root, bundleId), bundleId); return { bundleId, status: 'VALID' }; }
    catch (error) { return { bundleId, status: 'INVALID', code: error.code, message: error.message }; }
  }) : [];
  const entries = relative => fs.existsSync(path.join(workspace, relative)) ? fs.readdirSync(path.join(workspace, relative)).sort() : [];
  return { status: runs.some(run => run.code) || bundles.some(bundle => bundle.status === 'INVALID') ? 'FAILED' : 'SUCCEEDED', workspace, runs, bundles,
    staging: { runs: entries('.mavt/run-staging'), bundles: entries('.mavt/runtime-bundles').filter(name => name.startsWith('.staging-')) }, reportPath: path.join(workspace, 'index.html') };
}
function open(pluginRoot, args, initialize) {
  workspacePath(args.workspace);
  if (initialize) {
    // Protect existing trees before ensureWorkspace performs initialization or recovery.
    safeWorkspace(args.workspace, { allowUnready: true });
    ensureWorkspace(args.workspace);
  } else assertWorkspace(args.workspace);
  safeWorkspace(args.workspace);
  let pinned;
  if (args.batchId) {
    if (args.role !== 'coordinator') throw bundleError('MAVT_MCP_CONTEXT_INVALID', 'Run opening requires coordinator role');
    const loaded = readRunBinding(args.workspace, args.batchId);
    if (!loaded.binding) return { status: 'REJECTED', code: 'MAVT_LEGACY_RUN_REQUIRES_ORIGINAL_RUNTIME', message: 'Use the original CLI/Loader for this legacy Run', command: loaded.state.command };
    pinned = loaded;
  } else pinned = pinBundle(pluginRoot, args.workspace);
  return { status: 'SUCCEEDED', ...createContext({ workspace: args.workspace, bundleId: pinned.bundleId, role: args.role, scope: args.batchId ? 'run' : 'workspace', ...(args.batchId ? { batchId: args.batchId } : {}) }) };
}
function invokeBound(context, name, args) {
  if (name === 'mavt_cases_import') {
    // Import republishes derived case reports, so its relevant authority is the case tree.
    safeTree(context.workspace, 'cases');
    for (const relative of ['index.html', 'report-metadata.json']) existingPath(context.workspace, relative);
    return load(context, 'scripts/case/import-drafts').importDrafts(context.workspace, args.request);
  }
  if (name.startsWith('mavt_knowledge_')) {
    const knowledge = relative => require(plainPath(context.knowledgeRoot, `scripts/lib/${relative}`, 'file'));
    const action = name.slice(15);
    if (action === 'prepare' || action === 'apply') {
      const transaction = knowledge('knowledge-transaction.js');
      for (const operation of args.request.operations) if (operation.draftPath) {
        const draft = operation.draftPath;
        plainPath(path.parse(draft).root, draft.slice(path.parse(draft).root.length), 'file');
      }
      if (action === 'apply') existingPath(context.workspace, '.mavt/knowledge-maintenance/backups');
      const options = { codeIdentity: context.bundleId };
      return action === 'prepare' ? transaction.prepareTransaction(context.workspace, args.request, options)
        : transaction.applyTransaction(context.workspace, args.request, args.planHash, options);
    }
    const store = knowledge('knowledge-store.js');
    return action === 'list' ? store.listKnowledge(context.workspace) : action === 'show' ? store.showKnowledge(context.workspace, args.entryId) : store.inspectKnowledge(context.workspace);
  }
  const service = load(context, 'scripts/coordinator/agent-facing-service');
  const action = name.slice(9);
  if (action === 'status' || action === 'report') {
    const state = service.loadCoordinatorState(context.statePath);
    if (action === 'status') return { status: 'SUCCEEDED', batchId: context.batchId, phase: state.phase, caseCount: state.targets.length,
      environmentConfirmed: state.environmentConfirmed === true, ...(state.outcome ? { outcome: state.outcome } : {}),
      ...(state.cancelReason ? { cancelReason: state.cancelReason } : {}),
      ...(state.reportPublication ? { reportStatus: state.reportPublication.status || state.reportPublication.reportStatus } : {}) };
    const resource = load(context, 'scripts/coordinator/agent-resource-store').terminalResource(state);
    return { status: 'SUCCEEDED', workspace: context.workspace, batchId: context.batchId, reportPath: path.join(context.workspace, 'index.html'), summary: resource?.data || null };
  }
  if (action === 'read') {
    const state = service.loadCoordinatorState(context.statePath);
    const resource = load(context, 'scripts/coordinator/agent-resource-store').readResource(state, args.input.ref);
    return successEnvelope({ operation: 'read', result: { outcome: 'READ', resourceRef: resource.data.ref, resourceType: resource.data.type }, data: resource.data, resources: resource.resources });
  }
  const request = { operation: `${action}Run`, input: args.input };
  if (action === 'prepare') {
    // Preparing reads the case catalog, not historical execution evidence.
    for (const name of fs.readdirSync(path.join(context.workspace, 'cases'))) {
      plainPath(context.workspace, `cases/${name}`, 'directory');
      for (const file of ['case.json', 'source.md']) existingPath(context.workspace, `cases/${name}/${file}`);
    }
    const { response: result, batchId } = service.prepareRunBound(request, { workspace: context.workspace, hostTransport: 'mcp' });
    return { ...result, ...createContext({ workspace: context.workspace, bundleId: context.bundleId, role: 'coordinator', scope: 'run', batchId }) };
  }
  try { return service.executeRunRequest(context.statePath, request, { hostTransport: 'mcp' }); }
  catch (error) { return runFailure(context, request.operation, error); }
}
function execute(pluginRoot, name, args) {
  try { validate(name, args); }
  catch (error) {
    // A valid bound Run retains the existing repeated-domain-input stop rule.
    // Unknown tools, invalid bindings, and all reads reject without recording anything.
    if (error.code === 'MAVT_MCP_INPUT_INVALID' && ['mavt_run_confirm', 'mavt_run_advance', 'mavt_run_cancel'].includes(name) && typeof args?.contextRef === 'string') {
      const context = resolveContext(args.contextRef, { role: 'coordinator', scope: 'run' });
      if (fs.existsSync(path.join(context.runtimeRoot, 'scripts/mcp/management-service.js'))) {
        const implementation = load(context, 'scripts/mcp/management-service.js');
        return implementation.runFailure(context, `${name.slice(9)}Run`, Object.assign(new Error(error.message), { code: 'COORDINATOR_INPUT_INVALID', issues: error.issues }));
      }
    }
    throw error;
  }
  if (name === 'mavt_workspace_init' || name === 'mavt_workspace_open') return open(pluginRoot, args, name.endsWith('_init'));
  if (name === 'mavt_workspace_doctor') return diagnostic(args.workspace);
  const role = name.startsWith('mavt_knowledge_') ? 'knowledge' : name === 'mavt_cases_import' ? 'author' : 'coordinator';
  const scope = name.startsWith('mavt_run_') && name !== 'mavt_run_prepare' ? 'run' : 'workspace';
  const context = resolveContext(args.contextRef, { role, scope });
  // The chosen implementation belongs to the verified pinned bundle, even after installation changes.
  if (!fs.existsSync(path.join(context.runtimeRoot, 'scripts/mcp/management-service.js'))) return { status: 'REJECTED', code: 'MAVT_MCP_LEGACY_INTERFACE',
    message: 'This fixed bundle predates the MCP interface; continue with its original CLI/Loader',
    ...(context.state ? { command: context.state.command } : {}), runtimeRoot: context.runtimeRoot, knowledgeRoot: context.knowledgeRoot };
  const implementation = load(context, 'scripts/mcp/management-service.js');
  return implementation.invokeBound(context, name, args);
}
function toolResult(value) {
  const failed = ['FAILED', 'REJECTED', 'UNKNOWN', 'REQUEST_INVALID'].includes(value.status);
  const summary = { ...Object.fromEntries(Object.entries(value).filter(([key, entry]) => ['string', 'number', 'boolean'].includes(typeof entry) && !['content', 'command'].includes(key))),
    status: value.status || value.type || 'SUCCEEDED', ...(value.error ? { error: value.error } : {}),
    ...(value.result ? { result: Object.fromEntries(Object.entries(value.result).filter(([key]) => key !== 'command')) } : {}),
    ...(value.data ? { data: { ref: value.data.ref, type: value.data.type } } : {}),
    ...(value.resources?.length ? { resources: value.resources } : {}),
    fields: Object.keys(value) };
  return { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: value, isError: failed };
}
function failureValue(error) {
  const code = error.code || 'MAVT_MCP_TECHNICAL';
  const rejected = /INVALID|STALE|NOT_FOUND|DUPLICATE|CONFLICT|REQUIRED|NOT_ALLOWED|MISSING|RESOURCE_UNKNOWN|MCP_TOOL_UNKNOWN/.test(code) ||
    code.startsWith('KNOWLEDGE_') && !/FAILED|INTERRUPTED|TECHNICAL/.test(code);
  return { status: ['UNKNOWN', 'FAILED', 'REJECTED'].includes(error.status) ? error.status : rejected ? 'REJECTED' : 'FAILED', code, message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}), ...(error.issues ? { issues: error.issues } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}
function createServer({ pluginRoot }) {
  pluginRoot = path.resolve(pluginRoot);
  return { listTools: definitions, callTool(name, args = {}) {
    try { return toolResult(execute(pluginRoot, name, args)); }
    catch (error) { return toolResult(failureValue(error)); }
  } };
}
module.exports = { createServer, execute, invokeBound, runFailure, failureValue, toolResult, diagnostic };

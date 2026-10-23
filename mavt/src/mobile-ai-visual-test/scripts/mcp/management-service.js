'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { assertWorkspace, ensureWorkspace } = require('../lib/workspace');
const { pinBundle, plainPath, verifyBundle, bundleError } = require('../lib/runtime-bundle');
const { readRunBinding } = require('../lib/runtime-binding');
const { createContext, resolveContext, existingPath, safeTree, safeWorkspace, workspacePath } = require('./bindings');
const { definitions, validate } = require('./contract');
const { descriptor: reportingDescriptor } = require('../reporting/tools');
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
  workspace = canonicalUserWorkspace(workspace);
  safeWorkspace(workspace);
  const verifiedBundles = new Map();
  const root = path.join(workspace, '.mavt/runtime-bundles');
  const bundles = fs.existsSync(root) ? fs.readdirSync(root).filter(name => !name.startsWith('.')).sort().map(bundleId => {
    const bundleRoot = path.join(root, bundleId);
    try {
      verifiedBundles.set(bundleId, { bundleRoot, manifest: verifyBundle(bundleRoot, bundleId) });
      return { bundleId, status: 'VALID' };
    }
    catch (error) {
      verifiedBundles.set(bundleId, { bundleRoot, error });
      return { bundleId, status: 'INVALID', code: error.code, message: error.message };
    }
  }) : [];
  const runs = fs.existsSync(path.join(workspace, 'runs')) ? fs.readdirSync(path.join(workspace, 'runs')).filter(name => !name.startsWith('.')).sort().map(batchId => {
    try { const loaded = readRunBinding(workspace, batchId, { verifiedBundles }); return { batchId, phase: loaded.state.phase, legacy: !loaded.binding, ...(loaded.binding ? { bundleId: loaded.bundleId } : {}) }; }
    catch (error) { return { batchId, code: error.code, message: error.message }; }
  }) : [];
  const entries = relative => fs.existsSync(path.join(workspace, relative)) ? fs.readdirSync(path.join(workspace, relative)).sort() : [];
  return { status: runs.some(run => run.code) || bundles.some(bundle => bundle.status === 'INVALID') ? 'FAILED' : 'SUCCEEDED', workspace, runs, bundles,
    staging: { runs: entries('.mavt/run-staging'), bundles: entries('.mavt/runtime-bundles').filter(name => name.startsWith('.staging-')) }, reportPath: path.join(workspace, 'index.html') };
}
function canonicalUserWorkspace(workspace) {
  workspacePath(workspace);
  return fs.realpathSync(workspace);
}
function open(pluginRoot, args, initialize) {
  args = { ...args, workspace: canonicalUserWorkspace(args.workspace) };
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
    if (!loaded.binding) return { status: 'REJECTED', code: 'MAVT_LEGACY_RUN_REQUIRES_ORIGINAL_RUNTIME', message: 'This legacy Run requires its original plugin version' };
    pinned = loaded;
  } else pinned = pinBundle(pluginRoot, args.workspace);
  return { status: 'SUCCEEDED', ...createContext({ workspace: args.workspace, bundleId: pinned.bundleId, role: args.role, scope: args.batchId ? 'run' : 'workspace', ...(args.batchId ? { batchId: args.batchId } : {}) }) };
}
function invokeBound(context, name, args) {
  if (reportingDescriptor(name)) return load(context, 'scripts/reporting/tools').invoke(name, args, context);
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
        if (fs.lstatSync(draft).isSymbolicLink()) throw bundleError('MAVT_MCP_INPUT_INVALID', 'knowledge draft must be an ordinary file');
        const canonical = fs.realpathSync(draft);
        plainPath(path.parse(canonical).root, canonical.slice(path.parse(canonical).root.length), 'file');
        operation.draftPath = canonical;
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
    let reporting;
    try { reporting = { reporting: load(context, 'scripts/reporting/service').createReportingService().status(context.workspace)
      .filter(item => item.batchId === context.batchId) }; } catch { reporting = { reporting: { code: 'REPORTING_UNAVAILABLE' } }; }
    if (action === 'status') return { status: 'SUCCEEDED', batchId: context.batchId, phase: state.phase, caseCount: state.targets.length,
      environmentConfirmed: state.environmentConfirmed === true, ...(state.outcome ? { outcome: state.outcome } : {}),
      ...(state.cancelReason ? { cancelReason: state.cancelReason } : {}),
      ...(state.reportPublication ? { reportStatus: state.reportPublication.status || state.reportPublication.reportStatus } : {}), ...reporting };
    const resource = load(context, 'scripts/coordinator/agent-resource-store').terminalResource(state);
    return { status: 'SUCCEEDED', workspace: context.workspace, batchId: context.batchId, reportPath: path.join(context.workspace, 'index.html'), summary: resource?.data || null, ...reporting };
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
function invokeValidated(context, name, args) {
  if (name.startsWith('mavt_case_')) throw bundleError('MAVT_MCP_CONTEXT_INVALID', 'Case execution scope is required');
  let validationError;
  try { validate(name, args); }
  catch (error) { if (error.code !== 'MAVT_MCP_INPUT_INVALID') throw error; validationError = error; }
  const reporting = reportingDescriptor(name);
  const role = reporting?.role || (name.startsWith('mavt_knowledge_') ? 'knowledge' : name === 'mavt_cases_import' ? 'author' : 'coordinator');
  const scope = reporting?.scope || (name.startsWith('mavt_run_') && name !== 'mavt_run_prepare' ? 'run' : 'workspace');
  if (context.role !== role || context.scope !== scope) throw bundleError('MAVT_MCP_CONTEXT_INVALID', 'context role/scope mismatch');
  if (validationError) {
    // Only this pinned contract may record invalid-input facts for its valid Run.
    if (['mavt_run_confirm', 'mavt_run_advance', 'mavt_run_cancel'].includes(name)) return runFailure(context, `${name.slice(9)}Run`,
      Object.assign(new Error(validationError.message), { code: 'COORDINATOR_INPUT_INVALID', issues: validationError.issues }));
    throw validationError;
  }
  return invokeBound(context, name, args);
}
function invokeCaseValidated(context, name, args) {
  if (context.role !== 'case' || context.scope !== 'execution') throw bundleError('MAVT_MCP_CONTEXT_INVALID', 'Case execution scope is required');
  if (reportingDescriptor(name)) throw bundleError('MAVT_MCP_CONTEXT_INVALID', 'Reporting requires reporting workspace scope');
  return load(context, 'scripts/mcp/case-service').invoke(context, name, args);
}
function execute(pluginRoot, name, args) {
  if (['mavt_workspace_init', 'mavt_workspace_open', 'mavt_workspace_doctor'].includes(name)) {
    validate(name, args);
    return name === 'mavt_workspace_doctor' ? diagnostic(args.workspace) : open(pluginRoot, args, name.endsWith('_init'));
  }
  if (reportingDescriptor(name)?.scope === 'global') {
    verifyBundle(pluginRoot);
    const installed = plainPath(pluginRoot, 'runtime/mobile-ai-visual-test/scripts', 'directory');
    require(plainPath(installed, 'mcp/contract.js', 'file')).validate(name, args);
    return require(plainPath(installed, 'reporting/tools.js', 'file')).invoke(name, args);
  }
  // This stable envelope locates authority only; installed schemas must not inspect
  // the versioned payload or account failures on behalf of another pinned bundle.
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.contextRef !== 'string' || !/^mavt-context:[A-Za-z0-9_-]+$/.test(args.contextRef)) {
    if (!definitions().some(tool => tool.name === name)) throw Object.assign(new Error(`Unknown MAVT tool: ${name}`), { code: 'MAVT_MCP_TOOL_UNKNOWN' });
    throw Object.assign(new Error('A valid contextRef locator is required'), { code: 'MAVT_MCP_INPUT_INVALID' });
  }
  const context = resolveContext(args.contextRef);
  // The whole request is validated by its selected, verified pinned implementation.
  const implementation = fs.existsSync(path.join(context.runtimeRoot, 'scripts/mcp/management-service.js'))
    ? load(context, 'scripts/mcp/management-service.js') : null;
  if (context.role === 'case') {
    if (typeof implementation?.invokeCaseValidated !== 'function') return { status: 'REJECTED', code: 'MAVT_MCP_LEGACY_INTERFACE',
      message: 'This fixed bundle lacks Case MCP; use its original plugin version',
      runtimeRoot: context.runtimeRoot, documentationRoot: context.documentationRoot, hostProfilePath: context.hostProfilePath };
    return implementation.invokeCaseValidated(context, name, args);
  }
  if (typeof implementation?.invokeValidated !== 'function') return { status: 'REJECTED', code: 'MAVT_MCP_LEGACY_INTERFACE',
    message: 'This fixed bundle lacks the validated MCP interface; use its original plugin version',
    runtimeRoot: context.runtimeRoot, knowledgeRoot: context.knowledgeRoot };
  return implementation.invokeValidated(context, name, args);
}
function toolResult(value) {
  const { image, ...structured } = value;
  const failed = ['FAILED', 'REJECTED', 'UNKNOWN', 'REQUEST_INVALID'].includes(value.status);
  const summary = { ...Object.fromEntries(Object.entries(structured).filter(([key, entry]) => ['string', 'number', 'boolean'].includes(typeof entry) && !['content', 'command'].includes(key))),
    status: value.status || value.type || 'SUCCEEDED', ...(value.error ? { error: value.error } : {}),
    ...(value.result ? { result: Object.fromEntries(Object.entries(value.result).filter(([key]) => key !== 'command')) } : {}),
    ...(value.data ? { data: { ref: value.data.ref, type: value.data.type } } : {}),
    ...(value.resources?.length ? { resources: value.resources } : {}),
    fields: Object.keys(structured) };
  return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...(image ? [image] : [])], structuredContent: structured, isError: failed };
}
function failureValue(error) {
  const code = error.code || 'MAVT_MCP_TECHNICAL';
  const rejected = /INVALID|STALE|NOT_FOUND|DUPLICATE|CONFLICT|REQUIRED|NOT_ALLOWED|MISSING|RESOURCE_UNKNOWN|MCP_TOOL_UNKNOWN|HANDOFF_/.test(code) ||
    code.startsWith('KNOWLEDGE_') && !/FAILED|INTERRUPTED|TECHNICAL/.test(code);
  return { status: ['UNKNOWN', 'FAILED', 'REJECTED'].includes(error.status) ? error.status : /INTEGRITY|ARTIFACT_CHANGED/.test(code) ? 'FAILED' : rejected ? 'REJECTED' : 'FAILED', code, message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}), ...(error.issues ? { issues: error.issues } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}
function createServer({ pluginRoot }) {
  pluginRoot = path.resolve(pluginRoot);
  return { listTools: definitions, callTool(name, args = {}) {
    try { return toolResult(execute(pluginRoot, name, args)); }
    catch (error) { return toolResult(failureValue(error)); }
  } };
}
module.exports = { createServer, execute, invokeCaseValidated, invokeValidated, invokeBound, runFailure, failureValue, toolResult, diagnostic };

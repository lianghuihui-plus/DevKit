'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildPlugin } = require('../build-plugin');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixture(t, options = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-mcp-case-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const built = buildPlugin({ outputRoot: path.join(temp, 'build') });
  if (options.barrier) {
    const filename = path.join(built.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp/case-service.js');
    fs.appendFileSync(filename, `\nconst originalInvoke = module.exports.invoke;\nmodule.exports.invoke = function(context, name, args) {\n  if (name === 'mavt_case_act') {\n    require('node:fs').appendFileSync(${JSON.stringify(path.join(temp, 'entered'))}, context.executionId + '\\n');\n    while (!require('node:fs').existsSync(${JSON.stringify(path.join(temp, 'release'))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n  }\n  return originalInvoke(context, name, args);\n};\n`);
    if (options.controlBarrier) {
      const management = path.join(built.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp/management-service.js');
      fs.appendFileSync(management, `\nconst originalValidated = module.exports.invokeValidated;\nmodule.exports.invokeValidated = function(context, name, args) {\n  if (name === 'mavt_run_cancel') {\n    require('node:fs').writeFileSync(${JSON.stringify(path.join(temp, 'cancel-entered'))}, 'entered');\n    while (!require('node:fs').existsSync(${JSON.stringify(path.join(temp, 'cancel-release'))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n  }\n  return originalValidated(context, name, args);\n};\n`);
    }
    const { createManifest } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
    fs.writeFileSync(path.join(built.pluginRoot, 'bundle.manifest.json'), JSON.stringify(createManifest(built.pluginRoot, '0.1.1')));
  }
  const entry = path.join(built.pluginRoot, 'scripts/mavt-mcp.js');
  const server = require(entry).createServer({ pluginRoot: built.pluginRoot });
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const call = (name, args) => server.callTool(name, args).structuredContent;
  const author = call('mavt_workspace_init', { workspace, role: 'author' }).contextRef;
  assert.ok(author);
  const imported = call('mavt_cases_import', { contextRef: author,
    request: { cases: [{ sourceLocator: '/fixture/source', title: 'Case', sourceText: 'Check screen.' }] } });
  assert.equal(imported.cases.length, 1);
  const coordinator = call('mavt_workspace_open', { workspace, role: 'coordinator' }).contextRef;
  const prepared = call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  assert.equal(prepared.status, 'SUCCEEDED');
  const runtimeRoot = prepared.runtimeRoot || path.join(workspace, '.mavt/runtime-bundles', prepared.bundleId, 'runtime/mobile-ai-visual-test');
  const agentHandoff = require(path.join(runtimeRoot, 'scripts/batch/agent-handoff'));
  const resources = require(path.join(runtimeRoot, 'scripts/case-runtime/agent-resource-store'));
  function startCase(executionId) {
    const execDir = path.join(workspace, 'cases', 'case-' + executionId, 'platforms/harmony/executions', executionId);
    fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(execDir, 'execution.json'), JSON.stringify({ schemaVersion: 14, runtime: 'case-runtime',
      executionId, batchId: prepared.batchId, caseProtocolSha: 'case-protocol-fixture', platform: 'harmony', finalized: false }));
    fs.writeFileSync(path.join(execDir, 'runtime.json'), JSON.stringify({ schemaVersion: 1, executionId,
      sessionRef: { statePath: path.join(workspace, 'runs', prepared.batchId, 'coordinator-state.json') } }));
    fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
    const handoff = agentHandoff.createAgentHandoff({ workspaceRoot: workspace, batchId: prepared.batchId,
      executionId, caseProtocolSha: 'case-protocol-fixture', casePrompt: 'Execute the case',
      brief: { case: { source: 'Check screen.' }, runtime: { command: 'original fixed CLI' } } });
    const loader = spawnSync('/bin/sh', ['-c', handoff.loaderCommand], { encoding: 'utf8' });
    assert.equal(loader.status, 0, loader.stderr);
    const loaded = JSON.parse(loader.stdout);
    assert.equal(loaded.status, 'SUCCEEDED');
    assert.ok(loaded.contextRef, 'Loader returns a Case context only after claiming the handoff');
    return { execDir, handoff, loaded, contextRef: loaded.contextRef };
  }
  return { ...built, temp, workspace, entry, server, call, prepared, coordinator, runtimeRoot, resources, startCase };
}

async function awaitFile(filename) {
  const started = Date.now();
  while (!fs.existsSync(filename)) {
    if (Date.now() - started > 10000) throw new Error(`Barrier was not entered: ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function awaitLines(filename, count) {
  const started = Date.now();
  while (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8').trim().split('\n').length < count) {
    if (Date.now() - started > 10000) throw new Error(`Only some Case calls entered barrier: ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function within(promise, milliseconds = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Control operation starved behind Case call')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test('Case Loader creates execution and dispatch scoped refs; two Cases interleave without crossing resources', t => {
  const f = fixture(t);
  const a = f.startCase('case-a'), b = f.startCase('case-b');
  const first = f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } });
  const second = f.call('mavt_case_read', { contextRef: b.contextRef, input: { ref: b.loaded.data.ref } });
  assert.equal(first.status, 'SUCCEEDED', JSON.stringify(first));
  assert.equal(second.status, 'SUCCEEDED', JSON.stringify(second));
  assert.equal(first.data.type, 'caseBrief');
  assert.equal(f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: b.loaded.data.ref } }).error.code, 'RESOURCE_SCOPE_MISMATCH');
  assert.equal(f.call('mavt_case_read', { contextRef: f.coordinator, input: { ref: a.loaded.data.ref } }).code, 'MAVT_MCP_CONTEXT_INVALID');
  const restarted = require(f.entry).createServer({ pluginRoot: f.pluginRoot });
  assert.equal(restarted.callTool('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } }).structuredContent.status, 'SUCCEEDED');
  const continuation = f.resources.readPublishedResource(a.execDir, a.loaded.data.ref);
  assert.equal(continuation.data.content.case.source, 'Check screen.');
});

test('Case calls revalidate active dispatch after server startup, including reads', t => {
  const f = fixture(t), a = f.startCase('case-a');
  assert.equal(f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } }).status, 'SUCCEEDED');
  const handoff = require(path.join(f.runtimeRoot, 'scripts/batch/agent-handoff'));
  handoff.createAgentHandoff({ workspaceRoot: f.workspace, batchId: f.prepared.batchId,
    executionId: 'case-a', caseProtocolSha: 'case-protocol-fixture', casePrompt: 'Continuation',
    brief: { case: { source: 'Check screen.' } }, mode: 'CONTINUATION', sequence: 2,
    continuationReason: 'original Agent stopped' });
  const inputState = path.join(a.execDir, 'agent-facing-state.json');
  const before = fs.existsSync(inputState) ? fs.readFileSync(inputState, 'utf8') : null;
  const result = f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } });
  assert.equal(result.code, 'HANDOFF_REPLACED', JSON.stringify(result));
  assert.equal(fs.existsSync(inputState) ? fs.readFileSync(inputState, 'utf8') : null, before);
});

test('Case MCP schema errors retain the pinned runtime repeated-input count', t => {
  const f = fixture(t), a = f.startCase('case-invalid');
  const request = { contextRef: a.contextRef, input: {} };
  assert.equal(f.call('mavt_case_act', request).error.code, 'AGENT_INPUT_INVALID');
  assert.equal(f.call('mavt_case_act', request).error.code, 'AGENT_INPUT_STALLED');
  const state = JSON.parse(fs.readFileSync(path.join(a.execDir, 'agent-facing-state.json'), 'utf8'));
  assert.equal(state.lastInvalid.count, 2);
});

test('on-demand image returns verified published bytes and does not register visual inspection', t => {
  const f = fixture(t), a = f.startCase('case-image');
  const screenshot = path.join(a.execDir, 'screenshots/image.png');
  fs.writeFileSync(screenshot, PNG);
  const published = f.resources.publishResource(a.execDir, { type: 'screenshot', id: 'screenshots/image.png',
    source: { kind: 'binary', path: 'screenshots/image.png', mediaType: 'image/png' },
    params: { width: 1, height: 1, mediaType: 'image/png' } });
  const eventsBefore = fs.readFileSync(path.join(a.execDir, 'events.jsonl'));
  const response = f.server.callTool('mavt_case_image', { contextRef: a.contextRef, ref: published.data.ref });
  assert.equal(response.structuredContent.status, 'SUCCEEDED', JSON.stringify(response.structuredContent));
  const image = response.content.find(item => item.type === 'image');
  assert.ok(image);
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64'), fs.readFileSync(response.structuredContent.path));
  assert.equal(response.structuredContent.ref, published.data.ref);
  assert.deepEqual(fs.readFileSync(path.join(a.execDir, 'events.jsonl')), eventsBefore);
  fs.writeFileSync(screenshot, Buffer.from('corrupt'));
  const corrupt = f.server.callTool('mavt_case_image', { contextRef: a.contextRef, ref: published.data.ref });
  assert.equal(corrupt.structuredContent.code, 'RESOURCE_INTEGRITY_INVALID');
  fs.unlinkSync(screenshot);
  assert.equal(f.server.callTool('mavt_case_image', { contextRef: a.contextRef, ref: published.data.ref }).structuredContent.code, 'RESOURCE_INTEGRITY_INVALID');
});

test('explicit workspace and draft aliases resolve to one canonical authority without allowing managed tree links', t => {
  const f = fixture(t);
  const alias = path.join(f.temp, 'workspace-alias');
  fs.symlinkSync(f.workspace, alias);
  const opened = f.call('mavt_workspace_open', { workspace: alias, role: 'knowledge' });
  assert.equal(opened.status, 'SUCCEEDED', JSON.stringify(opened));
  assert.equal(opened.workspace, f.workspace);
  assert.equal(f.call('mavt_workspace_doctor', { workspace: alias }).workspace, f.workspace);
  const draft = path.join(f.temp, 'draft.md');
  fs.writeFileSync(draft, '# K-test 页面规则\n\n## 适用范围\n- App: com.example.test\n- Platform: harmony\n\n## 可观察现象\n首页入口没有展示。\n\n## 结论与处理建议\n这是已确认的平台差异。\n\n## 追溯信息\n产品确认，2026-10-22。\n');
  const draftAlias = path.join(f.temp, 'draft-alias');
  fs.symlinkSync(f.temp, draftAlias);
  const prepared = f.call('mavt_knowledge_prepare', { contextRef: opened.contextRef,
    request: { schemaVersion: 1, reason: '校验路径别名', operations: [{ type: 'ADD', draftPath: path.join(draftAlias, 'draft.md') }] } });
  assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  const external = path.join(f.temp, 'external'); fs.mkdirSync(external);
  fs.renameSync(path.join(f.workspace, 'knowledge'), path.join(external, 'knowledge'));
  fs.symlinkSync(path.join(external, 'knowledge'), path.join(f.workspace, 'knowledge'));
  assert.equal(f.call('mavt_knowledge_list', { contextRef: opened.contextRef }).status, 'REJECTED');
});

test('persistent worker keeps Coordinator status and cancel responsive while a Case domain call is blocked', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-slow');
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 3, maxPending: 4 } });
  assert.equal(typeof asyncServer.workerStats, 'function', 'stdio path must expose persistent worker execution');
  t.after(() => asyncServer.close());
  const action = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  try {
    const status = await within(asyncServer.callTool('mavt_run_status', { contextRef: f.prepared.contextRef }));
    assert.equal(status.structuredContent.status, 'SUCCEEDED', JSON.stringify(status.structuredContent));
    const cancel = await within(asyncServer.callTool('mavt_run_cancel', { contextRef: f.prepared.contextRef, input: { reason: 'offline cancellation' } }));
    assert.equal(cancel.structuredContent.status, 'SUCCEEDED', JSON.stringify(cancel.structuredContent));
    assert.ok(asyncServer.workerStats().started <= 3);
  } finally { fs.writeFileSync(path.join(f.temp, 'release'), 'release'); }
  const result = await action;
  assert.equal(result.structuredContent.error.code, 'AGENT_INPUT_INVALID');
});

test('worker crash reports dispatched Case effect as UNKNOWN once without replay', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-crash');
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 3, maxPending: 4 } });
  assert.equal(typeof asyncServer.workerStats, 'function', 'stdio path must expose persistent worker execution');
  t.after(() => asyncServer.close());
  const action = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  const worker = asyncServer.workerStats().workers.find(item => item.busyKey === `case:${a.execDir}:write`);
  assert.ok(worker?.pid);
  process.kill(worker.pid, 'SIGKILL');
  const result = await within(action);
  assert.equal(result.structuredContent.status, 'UNKNOWN', JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.contextRef, a.contextRef);
  assert.equal(fs.readFileSync(path.join(f.temp, 'entered'), 'utf8').trim(), 'case-crash');
});

test('two Loader references for one execution serialize Case writes and retain invalid-input count', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-two-refs');
  const repeated = spawnSync('/bin/sh', ['-c', a.handoff.loaderCommand], { encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr);
  const secondRef = JSON.parse(repeated.stdout).contextRef;
  assert.notEqual(secondRef, a.contextRef);
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 4, maxPending: 4 } });
  t.after(() => asyncServer.close());
  const first = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  const second = asyncServer.callTool('mavt_case_act', { contextRef: secondRef, input: {} });
  try { assert.equal(asyncServer.workerStats().pending, 1, 'the second ref must share the execution write lane'); }
  finally { fs.writeFileSync(path.join(f.temp, 'release'), 'release'); }
  assert.equal((await first).structuredContent.error.code, 'AGENT_INPUT_INVALID');
  assert.equal((await second).structuredContent.error.code, 'AGENT_INPUT_STALLED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.execDir, 'agent-facing-state.json'), 'utf8')).lastInvalid.count, 2);
});

test('invalid Case read through another Loader reference waits behind the execution write', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-read-ref');
  const repeated = spawnSync('/bin/sh', ['-c', a.handoff.loaderCommand], { encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr);
  const secondRef = JSON.parse(repeated.stdout).contextRef;
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 4, maxPending: 4 } });
  t.after(() => asyncServer.close());
  const action = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  const read = asyncServer.callTool('mavt_case_read', { contextRef: secondRef, input: {} });
  try { assert.equal(asyncServer.workerStats().pending, 1); }
  finally { fs.writeFileSync(path.join(f.temp, 'release'), 'release'); }
  assert.equal((await action).structuredContent.error.code, 'AGENT_INPUT_INVALID');
  assert.equal((await read).structuredContent.error.code, 'AGENT_INPUT_INVALID');
});

test('worker exit before accepting a Case call reports definitely undispatched', async t => {
  const f = fixture(t), a = f.startCase('case-preaccept');
  const workerPath = path.join(f.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp/worker-child.js');
  fs.writeFileSync(workerPath, `process.exit(17);\n${fs.readFileSync(workerPath, 'utf8')}`);
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 3, maxPending: 4 } });
  t.after(() => asyncServer.close());
  const response = await within(asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} }));
  assert.equal(response.structuredContent.status, 'REJECTED', JSON.stringify(response.structuredContent));
  assert.equal(response.structuredContent.code, 'MAVT_MCP_WORKER_NOT_DISPATCHED');
  assert.equal(fs.existsSync(path.join(f.temp, 'entered')), false);
});

test('worker timeout after entering a Case effect reports UNKNOWN once and clears its lane', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-timeout');
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot,
    workerPool: { maxWorkers: 3, maxPending: 4, maxOperationMs: 1200 } });
  t.after(() => asyncServer.close());
  const action = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  const response = await within(action, 5000);
  assert.equal(response.structuredContent.status, 'UNKNOWN', JSON.stringify(response.structuredContent));
  assert.match(response.structuredContent.message, /timed out/i);
  assert.equal(fs.readFileSync(path.join(f.temp, 'entered'), 'utf8').trim(), 'case-timeout');
  const status = await within(asyncServer.callTool('mavt_run_status', { contextRef: f.prepared.contextRef }));
  assert.equal(status.structuredContent.status, 'SUCCEEDED');
});

test('three blocked Case effects and blocked same-Run cancel leave a read lane for status', async t => {
  const f = fixture(t, { barrier: true, controlBarrier: true });
  const cases = ['case-1', 'case-2', 'case-3'].map(id => f.startCase(id));
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 5, maxPending: 8 } });
  t.after(() => asyncServer.close());
  const actions = cases.map(item => asyncServer.callTool('mavt_case_act', { contextRef: item.contextRef, input: {} }));
  await awaitLines(path.join(f.temp, 'entered'), 3);
  let cancel;
  try {
    cancel = asyncServer.callTool('mavt_run_cancel', { contextRef: f.prepared.contextRef, input: { reason: 'offline cancellation' } });
    await awaitFile(path.join(f.temp, 'cancel-entered'));
    const status = await within(asyncServer.callTool('mavt_run_status', { contextRef: f.prepared.contextRef }));
    assert.equal(status.structuredContent.status, 'SUCCEEDED', JSON.stringify(status.structuredContent));
    assert.ok(asyncServer.workerStats().active <= 5);
  } finally {
    fs.writeFileSync(path.join(f.temp, 'release'), 'release');
    fs.writeFileSync(path.join(f.temp, 'cancel-release'), 'release');
  }
  assert.equal((await cancel).structuredContent.status, 'SUCCEEDED');
  assert.equal((await Promise.all(actions)).length, 3);
});

test('bounded queue rejects an undispatched Case effect and never replays it', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-bounded');
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 3, maxPending: 1 } });
  t.after(() => asyncServer.close());
  const first = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  const second = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  const rejected = await asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  assert.equal(rejected.structuredContent.code, 'MAVT_MCP_BUSY');
  assert.equal(fs.readFileSync(path.join(f.temp, 'entered'), 'utf8').trim().split('\n').length, 1);
  fs.writeFileSync(path.join(f.temp, 'release'), 'release');
  await Promise.all([first, second]);
  assert.equal(fs.readFileSync(path.join(f.temp, 'entered'), 'utf8').trim().split('\n').length, 2);
});

test('full effect queue still admits a status read onto an idle reserved worker', async t => {
  const f = fixture(t, { barrier: true }), a = f.startCase('case-queued');
  const asyncServer = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { maxWorkers: 3, maxPending: 1 } });
  t.after(() => asyncServer.close());
  const first = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  await awaitFile(path.join(f.temp, 'entered'));
  const queued = asyncServer.callTool('mavt_case_act', { contextRef: a.contextRef, input: {} });
  try {
    assert.equal(asyncServer.workerStats().pending, 1);
    const status = await within(asyncServer.callTool('mavt_run_status', { contextRef: f.prepared.contextRef }));
    assert.equal(status.structuredContent.status, 'SUCCEEDED', JSON.stringify(status.structuredContent));
  } finally { fs.writeFileSync(path.join(f.temp, 'release'), 'release'); }
  await Promise.all([first, queued]);
});

test('stdio EOF drains accepted operations and releases worker processes', t => {
  const f = fixture(t);
  const workspace = path.join(f.temp, 'eof-workspace'); fs.mkdirSync(workspace);
  const requests = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mavt_workspace_init', arguments: { workspace, role: 'knowledge' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mavt_workspace_open', arguments: { workspace, role: 'knowledge' } } },
  ];
  const processResult = spawnSync(process.execPath, [f.entry], { encoding: 'utf8', input: requests.map(item => JSON.stringify(item)).join('\n') + '\n', timeout: 15000 });
  assert.equal(processResult.status, 0, processResult.stderr);
  const responses = processResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses.find(item => item.id === 1).result.structuredContent.status, 'SUCCEEDED');
  assert.equal(responses.find(item => item.id === 2).result.structuredContent.status, 'SUCCEEDED');
});

test('new installation routes an old Case ref through its sealed A implementation', t => {
  const f = fixture(t), a = f.startCase('case-pinned-a');
  const newer = buildPlugin({ outputRoot: path.join(f.temp, 'newer-b') });
  const modulePath = path.join(newer.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp/case-service.js');
  fs.appendFileSync(modulePath, "\nmodule.exports.invoke = () => ({ status: 'FAILED', code: 'B_IMPLEMENTATION_USED' });\n");
  const { createManifest } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
  fs.writeFileSync(path.join(newer.pluginRoot, 'bundle.manifest.json'), JSON.stringify(createManifest(newer.pluginRoot, '0.1.2')));
  const b = require(path.join(newer.pluginRoot, 'scripts/mavt-mcp')).createServer({ pluginRoot: newer.pluginRoot });
  fs.renameSync(f.pluginRoot, f.pluginRoot + '-removed');
  const result = b.callTool('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } }).structuredContent;
  assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
  assert.equal(result.data.type, 'caseBrief');
});

test('older fixed Loader without Case MCP capability keeps its original CLI handoff', t => {
  const f = fixture(t);
  const older = buildPlugin({ outputRoot: path.join(f.temp, 'older-a') });
  const modulePath = path.join(older.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp/management-service.js');
  fs.appendFileSync(modulePath, '\ndelete module.exports.invokeCaseValidated;\n');
  const { createManifest } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
  fs.writeFileSync(path.join(older.pluginRoot, 'bundle.manifest.json'), JSON.stringify(createManifest(older.pluginRoot, '0.1.0')));
  const workspace = path.join(f.temp, 'older-workspace'); fs.mkdirSync(workspace);
  const server = require(path.join(older.pluginRoot, 'scripts/mavt-mcp')).createServer({ pluginRoot: older.pluginRoot });
  const call = (name, args) => server.callTool(name, args).structuredContent;
  const author = call('mavt_workspace_init', { workspace, role: 'author' }).contextRef;
  call('mavt_cases_import', { contextRef: author, request: { cases: [{ sourceLocator: '/old', title: 'Old', sourceText: 'Check old UI.' }] } });
  const coordinator = call('mavt_workspace_open', { workspace, role: 'coordinator' }).contextRef;
  const prepared = call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  const runtimeRoot = prepared.runtimeRoot;
  const executionId = 'case-old';
  const execDir = path.join(workspace, 'cases/old/platforms/harmony/executions', executionId);
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'execution.json'), JSON.stringify({ schemaVersion: 14, runtime: 'case-runtime',
    executionId, batchId: prepared.batchId, caseProtocolSha: 'old-protocol', platform: 'harmony' }));
  fs.writeFileSync(path.join(execDir, 'runtime.json'), JSON.stringify({ schemaVersion: 1, executionId,
    sessionRef: { statePath: path.join(workspace, 'runs', prepared.batchId, 'coordinator-state.json') } }));
  const handoff = require(path.join(runtimeRoot, 'scripts/batch/agent-handoff')).createAgentHandoff({
    workspaceRoot: workspace, batchId: prepared.batchId, executionId, caseProtocolSha: 'old-protocol',
    casePrompt: 'Old fixed instruction', brief: { runtime: { command: 'old fixed CLI command' } } });
  const loaded = spawnSync('/bin/sh', ['-c', handoff.loaderCommand], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  const response = JSON.parse(loaded.stdout);
  assert.equal(response.data.content.runtime.command, 'old fixed CLI command');
  assert.equal(response.contextRef, undefined);
  assert.equal(call('mavt_run_status', { contextRef: prepared.contextRef }).status, 'SUCCEEDED');
});

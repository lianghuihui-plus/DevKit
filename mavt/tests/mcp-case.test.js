'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  let server, call, coordinator, prepared;
  if (!options.cliSetup) {
    server = require(entry).createServer({ pluginRoot: built.pluginRoot });
    call = (name, args) => server.callTool(name, args).structuredContent;
    const author = call('mavt_workspace_init', { workspace, role: 'author' }).contextRef;
    assert.ok(author);
    const imported = call('mavt_cases_import', { contextRef: author,
      request: { cases: [{ sourceLocator: '/fixture/source', title: 'Case', sourceText: 'Check screen.' }] } });
    assert.equal(imported.cases.length, 1);
    coordinator = call('mavt_workspace_open', { workspace, role: 'coordinator' }).contextRef;
    prepared = call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  } else {
    const opened = spawnSync(process.execPath, [path.join(built.pluginRoot, 'scripts/mavt-entry.js'), 'workspace', '--cwd', workspace], { encoding: 'utf8' });
    assert.equal(opened.status, 0, opened.stderr);
    const runtimeRoot = JSON.parse(opened.stdout).runtimeRoot;
    require('../src/mobile-ai-visual-test/scripts/case/import-drafts').importDrafts(workspace,
      { cases: [{ sourceLocator: '/fixture/source', title: 'Case', sourceText: 'Check screen.' }] });
    const run = spawnSync(process.execPath, [path.join(runtimeRoot, 'scripts/coordinator-agent.js'), '--workspace', workspace],
      { encoding: 'utf8', input: JSON.stringify({ operation: 'prepareRun', input: { caseNos: ['001'] } }) });
    assert.equal(run.status, 0, run.stderr);
    prepared = { ...JSON.parse(run.stdout), runtimeRoot,
      batchId: fs.readdirSync(path.join(workspace, 'runs')).find(name => !name.startsWith('.')) };
  }
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
      sessionRef: { statePath: path.join(workspace, 'runs', prepared.batchId, 'batch.json') } }));
    fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
    const handoff = agentHandoff.createAgentHandoff({ workspaceRoot: workspace, batchId: prepared.batchId,
      executionId, caseProtocolSha: 'case-protocol-fixture', casePrompt: 'Execute the case',
      brief: { case: { source: 'Check screen.' }, runtime: { command: 'original fixed CLI' } } });
    const loader = spawnSync('/bin/sh', ['-c', handoff.loaderCommand], { encoding: 'utf8' });
    assert.equal(loader.status, 0, loader.stderr);
    const loaded = JSON.parse(loader.stdout);
    assert.equal(loaded.status, 'SUCCEEDED');
    return { execDir, handoff, loaded, contextRef: loaded.contextRef };
  }
  function startDispatchedCase(platform) {
    const service = require(path.join(runtimeRoot, 'scripts/coordinator/agent-facing-service'));
    const batch = require(path.join(runtimeRoot, 'scripts/batch'));
    const core = require(path.join(runtimeRoot, 'scripts/batch/core'));
    const statePath = path.join(workspace, 'runs', prepared.batchId, 'coordinator-state.json');
    const binding = { platform, deviceId: 'offline-device', appId: 'com.example.offline',
      ...(platform === 'ios' ? { deviceType: 'realDevice', platformVersion: '15.4.1',
        xcodeOrgId: 'TESTTEAM01', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.WDARunner' }
        : { entry: platform === 'android' ? '.MainActivity' : 'EntryAbility' }) };
    // Only hardware/environment ports are replaced. The request, batch, execution,
    // sessionRef, Handoff, Loader and MCP calls all use the built release code.
    const options = {
      probeEnvironment: () => ({ schemaVersion: 1, type: 'environmentProbe', platform,
        ready: true, devices: [{ id: binding.deviceId }], diagnostics: [] }),
      resolveEnvironment: () => ({ status: 'READY', binding }),
      prepareEnvironment: () => ({ schemaVersion: 1, type: 'environmentPrepare', platform, ok: true }),
      batchExecute: input => {
        assert.equal(input.command, 'init', 'offline initialization must never dispatch device operations');
        return batch.execute(input);
      },
    };
    const offer = service.confirmRun(statePath, { operation: 'confirmRun', input: {
      decision: 'SELECT_PLATFORM', platform, appId: binding.appId,
    } }, options);
    assert.equal(offer.data.content.environmentStatus, 'READY', JSON.stringify(offer));
    const confirmed = service.confirmRun(statePath, { operation: 'confirmRun', input: {
      decision: 'CONFIRM_ENVIRONMENT', environmentRef: offer.data.content.environmentRef,
      userInstruction: 'Offline MCP integration verification only',
    } }, options);
    assert.equal(confirmed.result.outcome, 'CONFIRMED', JSON.stringify(confirmed));
    core.bootstrapBatch({ workspaceRoot: workspace, batchId: prepared.batchId,
      adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) } });
    const started = core.startCurrentCase({ workspaceRoot: workspace, batchId: prepared.batchId });
    assert.equal(started.action, 'DELEGATE_CASE_AGENT');
    const loader = spawnSync('/bin/sh', ['-c', started.handoff.loaderCommand], { encoding: 'utf8', timeout: 10000 });
    assert.equal(loader.status, 0, loader.stderr || loader.stdout);
    const loaded = JSON.parse(loader.stdout);
    assert.equal(loaded.status, 'SUCCEEDED');
    const state = core.loadBatch(workspace, prepared.batchId).state;
    const execDir = path.dirname(state.cases[0].runtimePath);
    return { execDir, loaded, contextRef: loaded.contextRef };
  }
  return { ...built, temp, workspace, entry, server, call, prepared, coordinator, runtimeRoot, resources, startCase, startDispatchedCase };
}

for (const platform of ['ios', 'android', 'harmony']) {
  test(`real batch dispatch reaches Case MCP on ${platform}`, async t => {
    const f = fixture(t), a = f.startDispatchedCase(platform);
    const read = f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } });
    assert.equal(read.status, 'SUCCEEDED', JSON.stringify(read));
    assert.equal(read.data.type, 'caseBrief');
    const server = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { idleTimeoutMs: 30000 } });
    t.after(() => server.close());
    const workerRead = (await server.callTool('mavt_case_read', {
      contextRef: a.contextRef, input: { ref: a.loaded.data.ref },
    })).structuredContent;
    assert.equal(workerRead.status, 'SUCCEEDED', JSON.stringify(workerRead));
    assert.equal(workerRead.data.type, 'caseBrief');
  });
}

test('Case MCP rejects replaced session state paths after real batch dispatch', t => {
  const f = fixture(t), a = f.startDispatchedCase('harmony');
  const filename = path.join(a.execDir, 'runtime.json');
  const runtime = JSON.parse(fs.readFileSync(filename));
  for (const statePath of [
    path.join(f.workspace, 'runs', f.prepared.batchId, 'coordinator-state.json'),
    path.join(f.workspace, 'runs', 'another-batch', 'batch.json'),
    path.join(f.temp, 'batch.json'),
    undefined,
  ]) {
    fs.writeFileSync(filename, JSON.stringify({ ...runtime, sessionRef: { ...runtime.sessionRef, statePath } }));
    const result = f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } });
    assert.equal(result.code, 'MAVT_MCP_CONTEXT_INVALID', JSON.stringify(result));
  }
  fs.writeFileSync(filename, JSON.stringify(runtime));
  assert.equal(f.call('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } }).status, 'SUCCEEDED');
});

test('the single MCP build issues a scoped Loader context even when initialized through the compatibility CLI', t => {
  const f = fixture(t, { cliSetup: true });
  const loaded = f.startCase('case-cli-default').loaded;
  assert.equal(loaded.status, 'SUCCEEDED');
  assert.ok(loaded.contextRef);
  assert.equal(loaded.role, 'case');
  assert.equal(loaded.scope, 'execution');
  assert.equal(loaded.dispatchSequence, loaded.result.dispatchSequence);
  assert.equal(loaded.data.content.runtime.transport, 'MCP');
  assert.equal(loaded.data.content.runtime.command, undefined);
  assert.equal(loaded.data.content.runtime.invocation.shellTemplate, undefined);
  assert.equal(loaded.data.content.runtime.invocation.toolPrefix, 'mavt_case_');
  assert.equal(loaded.result.executionId, 'case-cli-default');
});

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

test('warm worker Case read rejects pinned byte changes on the next call', async t => {
  const f = fixture(t), a = f.startCase('case-integrity');
  const server = require(f.entry).createServer({ pluginRoot: f.pluginRoot, workerPool: { idleTimeoutMs: 30000 } });
  t.after(() => server.close());
  const args = { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } };
  assert.equal((await server.callTool('mavt_case_read', args)).structuredContent.status, 'SUCCEEDED');
  fs.appendFileSync(path.join(f.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js'), '\n// changed after first read\n');
  const result = (await server.callTool('mavt_case_read', args)).structuredContent;
  assert.equal(result.status, 'REJECTED');
  assert.match(result.code, /MAVT_RUNTIME_BUNDLE_INVALID|MAVT_MCP_CONTEXT_INVALID/);
});

test('CLI Case read still rejects changed pinned bytes after request-local validation', t => {
  const f = fixture(t), a = f.startCase('case-cli-integrity');
  const entry = path.join(f.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js');
  const read = () => {
    const child = spawnSync(process.execPath, [entry, '--dispatch-sequence', '1'], { encoding: 'utf8',
      input: JSON.stringify({ operation: 'read', input: { ref: a.loaded.data.ref } }),
      env: { ...process.env, MAVT_EXECUTION_DIR: a.execDir } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.equal(read().status, 'SUCCEEDED');
  fs.appendFileSync(entry, '\n// changed after CLI read\n');
  const result = read();
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'CASE_RUNTIME_TECHNICAL');
});

async function delayedCliRequest(t, f, a, beforeInput) {
  const entry = path.join(f.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js');
  const hook = path.join(f.temp, 'stdin-barrier.cjs');
  const release = path.join(f.temp, 'stdin-release');
  fs.writeFileSync(hook, `const fs = require('node:fs');
const original = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (file === 0) {
    process.send({ stage: 'BEFORE_STDIN_READ' });
    while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return original.call(this, file, ...args);
};\n`);
  const child = spawn(process.execPath, ['--require', hook, entry, '--dispatch-sequence', '1'], {
    env: { ...process.env, MAVT_EXECUTION_DIR: a.execDir }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not reach stdin barrier: ${stderr}`)), 10000);
    child.once('message', message => { clearTimeout(timer); assert.equal(message.stage, 'BEFORE_STDIN_READ'); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  beforeInput(entry);
  // The child performs a synchronous read. Keep it behind the barrier until
  // the pipe has finished writing and closed, otherwise it can read EAGAIN.
  await new Promise((resolve, reject) => {
    child.stdin.once('error', reject);
    child.stdin.end(JSON.stringify({ operation: 'act', input: {} }), resolve);
  });
  fs.writeFileSync(release, 'go');
  const exitCode = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout);
}

test('CLI Case request rejects pinned bytes changed while stdin is withheld', async t => {
  const f = fixture(t), a = f.startCase('case-delayed-stdin');
  const result = await delayedCliRequest(t, f, a, entry => fs.appendFileSync(entry, '\n// changed before stdin arrived\n'));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'CASE_RUNTIME_TECHNICAL');
});

test('CLI Case request rejects a dispatch replaced while stdin is withheld', async t => {
  const f = fixture(t), a = f.startCase('case-delayed-dispatch');
  const result = await delayedCliRequest(t, f, a, () => {
    require(path.join(f.runtimeRoot, 'scripts/batch/agent-handoff')).createAgentHandoff({
      workspaceRoot: f.workspace, batchId: f.prepared.batchId, executionId: 'case-delayed-dispatch',
      caseProtocolSha: 'case-protocol-fixture', casePrompt: 'Continuation',
      brief: { case: { source: 'Check screen.' } }, mode: 'CONTINUATION', sequence: 2,
      continuationReason: 'original Agent stopped',
    });
  });
  assert.equal(result.status, 'REJECTED', JSON.stringify(result));
  assert.equal(result.error.code, 'BINDING_INVALID', JSON.stringify(result));
});

test('a supplied manifest cannot bypass Run binding byte verification', t => {
  const f = fixture(t), a = f.startCase('case-forged-manifest');
  const binding = require(path.join(f.runtimeRoot, 'scripts/lib/runtime-binding'));
  const bundleRoot = path.dirname(path.dirname(f.runtimeRoot));
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'bundle.manifest.json')));
  fs.appendFileSync(path.join(f.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js'), '\n// tampered\n');
  assert.throws(() => binding.readRunBinding(f.workspace, f.prepared.batchId,
    { verifiedBundle: { bundleRoot, manifest } }), /bundle.*invalid|bytes.*mismatch|MAVT_RUNTIME/i);
  assert.ok(a.contextRef);
});

test('Case MCP schema errors retain the pinned runtime repeated-input count', t => {
  const f = fixture(t), a = f.startCase('case-invalid');
  const request = { contextRef: a.contextRef, input: {} };
  assert.equal(f.call('mavt_case_act', request).error.code, 'AGENT_INPUT_INVALID');
  assert.equal(f.call('mavt_case_act', request).error.code, 'AGENT_INPUT_STALLED');
  const state = JSON.parse(fs.readFileSync(path.join(a.execDir, 'agent-facing-state.json'), 'utf8'));
  assert.equal(state.lastInvalid.count, 2);
});

test('MCP rejects invalid FAIL evidence and preserves its pending correction across reads and restart', t => {
  const f = fixture(t), a = f.startCase('case-rejected-fail');
  const request = { contextRef: a.contextRef, input: { results: [{ checkNodeRef: 'N4', status: 'FAIL', actual: '顺序不符', reason: '非法字段',
    evidence: { knowledgeRefs: ['mavt:0123456789abcdef01234567:knowledgeReview:event-1'] } }] } };
  const rejected = f.call('mavt_case_recordResult', request);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.error.code, 'AGENT_INPUT_INVALID');
  const store = require(path.join(f.runtimeRoot, 'scripts/case-runtime/store'));
  const review = require(path.join(f.runtimeRoot, 'scripts/case-runtime/final-review'));
  assert.equal(store.events(a.execDir).filter(event => event.type === 'checkpointResultRejected').length, 1);
  // No known CHECK exists in this minimal fixture: a successful corrected result
  // can resolve the recoverable wildcard, rather than trapping an unknown ref.
  assert.deepEqual(review.pendingCorrections(a.execDir).map(([ref]) => ref), ['*']);
  const restarted = require(f.entry).createServer({ pluginRoot: f.pluginRoot });
  assert.equal(restarted.callTool('mavt_case_read', { contextRef: a.contextRef, input: { ref: a.loaded.data.ref } }).structuredContent.status, 'SUCCEEDED');
  assert.deepEqual(review.pendingCorrections(a.execDir).map(([ref]) => ref), ['*']);
  assert.equal(store.events(a.execDir).some(event => event.type === 'expectationResultUpdated'), false);
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
  // A predates the MCP-only distribution marker. Do not model it as a new MCP Handoff.
  fs.unlinkSync(path.join(older.pluginRoot, 'runtime/mobile-ai-visual-test/mcp-transport.json'));
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
    sessionRef: { statePath: path.join(workspace, 'runs', prepared.batchId, 'batch.json') } }));
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

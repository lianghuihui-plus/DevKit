#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const { buildPlugin } = require('../build-plugin');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixture(root) {
  const built = buildPlugin({ outputRoot: path.join(root, 'built') });
  const entry = path.join(built.pluginRoot, 'scripts/mavt-mcp.js');
  const server = require(entry).createServer({ pluginRoot: built.pluginRoot });
  const call = (name, args) => server.callTool(name, args).structuredContent;
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const author = call('mavt_workspace_init', { workspace, role: 'author' }).contextRef;
  call('mavt_cases_import', { contextRef: author,
    request: { cases: [{ sourceLocator: '/probe', title: 'Probe', sourceText: 'Check screen.' }] } });
  const coordinator = call('mavt_workspace_open', { workspace, role: 'coordinator' }).contextRef;
  const prepared = call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  assert.equal(prepared.status, 'SUCCEEDED');
  const executionId = 'case-host-probe';
  const execDir = path.join(workspace, 'cases/probe/platforms/harmony/executions', executionId);
  fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(execDir, 'execution.json'), JSON.stringify({ schemaVersion: 14, runtime: 'case-runtime',
    executionId, batchId: prepared.batchId, caseProtocolSha: 'case-host-probe-protocol', platform: 'harmony', finalized: false }));
  fs.writeFileSync(path.join(execDir, 'runtime.json'), JSON.stringify({ schemaVersion: 1, executionId,
    sessionRef: { statePath: path.join(workspace, 'runs', prepared.batchId, 'coordinator-state.json') } }));
  fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
  const handoff = require(path.join(prepared.runtimeRoot, 'scripts/batch/agent-handoff')).createAgentHandoff({
    workspaceRoot: workspace, batchId: prepared.batchId, executionId, caseProtocolSha: 'case-host-probe-protocol',
    casePrompt: 'Offline host probe', brief: { case: { source: 'Check screen.' }, runtime: { command: 'fixed CLI' } } });
  const loader = cp.spawnSync('/bin/sh', ['-c', handoff.loaderCommand], { encoding: 'utf8' });
  assert.equal(loader.status, 0, loader.stderr);
  const caseContext = JSON.parse(loader.stdout).contextRef;
  assert.ok(caseContext);
  fs.writeFileSync(path.join(execDir, 'screenshots/probe.png'), PNG);
  const image = require(path.join(prepared.runtimeRoot, 'scripts/case-runtime/agent-resource-store')).publishResource(execDir,
    { type: 'screenshot', id: 'screenshots/probe.png', source: { kind: 'binary', path: 'screenshots/probe.png', mediaType: 'image/png' },
      params: { width: 1, height: 1, mediaType: 'image/png' } });
  const relocated = path.join(root, 'relocated-marketplace');
  fs.renameSync(built.marketplaceRoot, relocated);
  const pluginRoot = path.join(relocated, 'plugins/mavt');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
  const registration = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest.mcpServers), 'utf8')).mavt;
  assert.ok(registration && !path.isAbsolute(registration.command) && registration.args.every(arg => !path.isAbsolute(arg)));
  const cwd = path.resolve(pluginRoot, registration.cwd);
  assert.equal(cwd, pluginRoot);
  assert.equal(path.resolve(cwd, registration.args[0]), path.join(pluginRoot, 'scripts/mavt-mcp.js'));
  return { pluginRoot, marketplaceRoot: relocated, registration, cwd, workspace, caseContext, imageRef: image.data.ref };
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-actual-host-probe-')));
  let child;
  try {
    const f = fixture(root), codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(codexHome);
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: root, CODEX_HOME: codexHome, LANG: process.env.LANG || 'en_US.UTF-8' };
    const command = process.env.MAVT_CODEX_CLI || 'codex';
    child = cp.spawn(command, ['-c', 'mcp_servers.mavt_probe.command=' + JSON.stringify(f.registration.command),
      '-c', 'mcp_servers.mavt_probe.args=' + JSON.stringify(f.registration.args),
      '-c', 'mcp_servers.mavt_probe.cwd=' + JSON.stringify(f.cwd), 'app-server', '--stdio'],
    { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let nextId = 0;
    const pending = new Map(), diagnostics = [];
    child.stderr.on('data', chunk => diagnostics.push(chunk.toString()));
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer); pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; ${diagnostics.join('').slice(-1000)}`)); }, 25000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    await call('initialize', { clientInfo: { name: 'mavt_actual_no_model_probe', version: '0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const plugin = await call('plugin/read', { pluginName: 'mavt', marketplacePath: path.join(f.marketplaceRoot, '.agents/plugins/marketplace.json') });
    assert.ok(plugin.plugin.mcpServers.includes('mavt'));
    assert.deepEqual(plugin.plugin.skills.map(skill => skill.name).sort(), ['mavt:author-cases', 'mavt:manage-knowledge', 'mavt:run-tests']);
    const started = await call('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = started.thread.id;
    const discovery = await call('mcpServerStatus/list', { threadId, serverName: 'mavt_probe' });
    const connected = discovery.data?.find(item => item.name === 'mavt_probe');
    assert.equal(connected?.runtimeStatus, 'connected');
    assert.equal(connected?.toolsError, null);
    assert.ok(connected.tools.mavt_case_image?.inputSchema);
    assert.ok(connected.tools.mavt_case_read?.inputSchema);
    const doctor = await call('mcpServer/tool/call', { threadId, server: 'mavt_probe', tool: 'mavt_workspace_doctor', arguments: { workspace: f.workspace } });
    const image = await call('mcpServer/tool/call', { threadId, server: 'mavt_probe', tool: 'mavt_case_image',
      arguments: { contextRef: f.caseContext, ref: f.imageRef } });
    const imageBlock = image.content?.find(item => item.type === 'image');
    assert.equal(imageBlock?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(imageBlock.data, 'base64'), PNG, 'Actual host image bytes must match published screenshot');
    assert.equal(doctor.structuredContent?.status, 'SUCCEEDED');
    process.stdout.write(JSON.stringify({ status: 'PASS', noModelTurns: true, noInstall: true,
      isolatedHome: codexHome, hostStatus: connected.runtimeStatus, manifestRegistration: true,
      relocatedPluginRead: { mcpServers: plugin.plugin.mcpServers, skills: plugin.plugin.skills.map(skill => skill.name).sort() },
      discoveredToolCount: Object.keys(connected.tools).length, discoveredToolNames: Object.keys(connected.tools).sort(),
      doctorStatus: doctor.structuredContent.status,
      image: { ref: f.imageRef, exactBytes: true, byteLength: PNG.length, mediaType: imageBlock.mimeType } }, null, 2) + '\n');
  } finally {
    if (child) { child.stdin.end(); child.kill('SIGTERM'); }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });

#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { buildPlugin } = require('../build-plugin');
const { tools: RELEASE_TOOLS } = require('./support/release-contract');
const { DEFAULT_IDLE_TIMEOUT_MS } = require('../src/mobile-ai-visual-test/scripts/mcp/worker-pool');

// Declared before measurements. Every warm path must beat its own CLI p50 and p95.
const GATES = Object.freeze({ warmP50Ratio: 1, warmP95Ratio: 1, minimumSamples: 12 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function summarize(samples) {
  assert.ok(samples.length);
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
function gate(cli, mcp) {
  return { pass: mcp.p50Ms <= cli.p50Ms * GATES.warmP50Ratio && mcp.p95Ms <= cli.p95Ms * GATES.warmP95Ratio,
    p50LimitMs: cli.p50Ms * GATES.warmP50Ratio, p95LimitMs: cli.p95Ms * GATES.warmP95Ratio };
}
function acceptancePass(result) {
  return result.warmMcpPass && result.cliComparisonPass && result.coldMcpParityPass;
}
function run(script, args, options = {}) {
  const started = performance.now();
  const child = cp.spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000, ...options });
  const elapsedMs = performance.now() - started;
  if (child.error || child.status !== 0) throw new Error(`${script}: ${child.error || child.stderr || child.stdout}`);
  return { value: JSON.parse(child.stdout), bytes: Buffer.byteLength(child.stdout), elapsedMs };
}
function shell(command, input, env) {
  const started = performance.now();
  const child = cp.spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', input: JSON.stringify(input), timeout: 60000, env });
  const elapsedMs = performance.now() - started;
  if (child.error || child.status !== 0) throw new Error(`${command}: ${child.error || child.stderr || child.stdout}`);
  return { value: JSON.parse(child.stdout), bytes: Buffer.byteLength(child.stdout), elapsedMs };
}
function cliPeakRss(script, args, options = {}) {
  const result = cp.spawnSync('/usr/bin/time', ['-l', process.execPath, script, ...args], { encoding: 'utf8', timeout: 60000, ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const bytes = /\b(\d+)\s+maximum resident set size\b/.exec(result.stderr)?.[1];
  return bytes ? Number(bytes) / 1024 : null;
}
function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, item.name), filename = path.join(root, name);
      hash.update(name); hash.update(item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other');
      if (item.isDirectory()) visit(name);
      else if (item.isFile()) hash.update(fs.readFileSync(filename));
      else throw new Error(`Unexpected workspace entry: ${name}`);
    }
  }
  visit(''); return hash.digest('hex');
}
function fixture(pluginRoot, root) {
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
  const entry = path.join(pluginRoot, 'scripts/mavt-entry.js');
  const workspaceEntry = run(entry, ['workspace', '--cwd', workspace]);
  const opened = workspaceEntry.value;
  const importRequest = path.join(root, 'import.json');
  fs.writeFileSync(importRequest, JSON.stringify({ cases: [{ sourceLocator: '/benchmark/case', title: 'Benchmark', sourceText: 'Check screen.' }] }));
  run(path.join(opened.runtimeRoot, 'scripts/import-cases.js'), ['--workspace', workspace, '--request-file', importRequest]);
  const knowledge = path.join(workspace, 'knowledge/K-bench.md');
  fs.writeFileSync(knowledge, '# K-bench 性能基线\n\n## 适用范围\n- App: com.example.bench\n\n## 可观察现象\n' + '测试页面内容。'.repeat(6000) + '\n\n## 结论与处理建议\n按已确认规则处理。\n\n## 追溯信息\n离线性能 fixture。\n');
  const prepared = shell(opened.coordinatorFacade.command, { operation: 'prepareRun', input: { caseNos: ['001'] } }).value;
  assert.equal(prepared.status, 'SUCCEEDED');
  const batchId = fs.readdirSync(path.join(workspace, 'runs')).find(name => !name.startsWith('.'));
  assert.ok(batchId);
  const caseSample = createCaseSample({ pluginRoot, opened, workspace, batchId }, 'benchmark-case');
  const { execDir, brief, loaderMs } = caseSample;
  // Grown evidence must not turn a read into a full workspace scan.
  const evidence = path.join(execDir, 'offline-evidence'); fs.mkdirSync(evidence);
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(evidence, `${i}.json`), JSON.stringify({ id: i, content: 'evidence'.repeat(128) }));
  return { pluginRoot, entry, opened, workspaceEntryMs: workspaceEntry.elapsedMs, loaderMs, workspace, prepared, batchId, execDir, brief, imageRef: caseSample.imageRef,
    knowledgeEntry: path.join(opened.knowledgeRoot, 'scripts/knowledge-manager.js') };
}
function createCaseSample(f, executionId) {
  const { opened, workspace, batchId } = f;
  const execDir = path.join(workspace, 'cases/benchmark/platforms/harmony/executions', executionId);
  fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(execDir, 'execution.json'), JSON.stringify({ schemaVersion: 14, runtime: 'case-runtime', executionId,
    batchId, caseProtocolSha: 'benchmark-protocol', platform: 'harmony', finalized: false }));
  fs.writeFileSync(path.join(execDir, 'runtime.json'), JSON.stringify({ schemaVersion: 1, executionId,
    sessionRef: { statePath: path.join(workspace, 'runs', batchId, 'batch.json') } }));
  fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(execDir, 'screenshots/probe.png'), PNG);
  const resourceStore = require(path.join(opened.runtimeRoot, 'scripts/case-runtime/agent-resource-store'));
  const imageRef = resourceStore.publishResource(execDir, { type: 'screenshot', id: 'screenshots/probe.png',
    source: { kind: 'binary', path: 'screenshots/probe.png', mediaType: 'image/png' }, params: { width: 1, height: 1, mediaType: 'image/png' } }).data.ref;
  const handoff = require(path.join(opened.runtimeRoot, 'scripts/batch/agent-handoff')).createAgentHandoff({ workspaceRoot: workspace,
    batchId, executionId, caseProtocolSha: 'benchmark-protocol', casePrompt: 'Offline benchmark',
    brief: { case: { source: 'Check screen. '.repeat(12000) }, runtime: { command: 'fixed CLI' } } });
  const loaderStarted = performance.now();
  const loaded = cp.spawnSync('/bin/sh', ['-c', handoff.loaderCommand], { encoding: 'utf8', timeout: 60000 });
  const loaderMs = performance.now() - loaderStarted;
  assert.equal(loaded.status, 0, loaded.stderr);
  const brief = JSON.parse(loaded.stdout);
  assert.equal(brief.status, 'SUCCEEDED');
  return { execDir, brief, loaderMs, imageRef };
}
function cliWorkloads(f) {
  return {
    doctor: () => run(f.entry, ['doctor', '--workspace', f.workspace]),
    knowledgeList: () => run(f.knowledgeEntry, ['list', '--workspace', f.workspace]),
    knowledgeShowLarge: () => run(f.knowledgeEntry, ['show', '--workspace', f.workspace, '--entry-id', 'K-bench']),
    runRead: () => shell(f.prepared.result.command, { operation: 'read', input: { ref: f.prepared.data.ref } }),
    caseRead: () => run(path.join(f.opened.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js'), ['--dispatch-sequence', '1'], {
      input: JSON.stringify({ operation: 'read', input: { ref: f.brief.data.ref } }), env: { ...process.env, MAVT_EXECUTION_DIR: f.execDir },
    }),
  };
}
function mcpClient(pluginRoot) {
  const child = cp.spawn(process.execPath, [path.join(pluginRoot, 'scripts/mavt-mcp.js')], { cwd: pluginRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), stderr = []; let sequence = 0;
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const request = pending.get(value.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(value.id);
    if (value.error) request.reject(new Error(JSON.stringify(value.error)));
    else request.resolve({ value: value.result, bytes: Buffer.byteLength(line) });
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${stderr.join('').slice(-500)}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, close: () => { child.stdin.end(); child.kill('SIGTERM'); } };
}
function processStats(serverPid) {
  const result = cp.spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ps failed');
  const processes = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const children = processes.filter(([, parent]) => parent === serverPid);
  return { serverPid, workerCount: children.length, serverRssKiB: processes.find(([pid]) => pid === serverPid)?.[2] || null,
    workerRssKiB: children.map(([, , rss]) => rss), totalRssKiB: (processes.find(([pid]) => pid === serverPid)?.[2] || 0) + children.reduce((sum, [, , rss]) => sum + rss, 0) };
}
function comparable(name, value) {
  if (name === 'doctor') return { status: value.status, runCount: value.runs.length, bundlesValid: value.bundles.every(item => item.status === 'VALID') };
  if (name === 'knowledgeList') return { status: value.status, entries: value.entries?.map(entry => entry.id || entry.entryId) };
  if (name === 'knowledgeShowLarge') return { status: value.status, content: value.content || value.entry?.content || value.data?.content };
  if (name === 'runRead') return { status: value.status, type: value.data?.type, outcome: value.result?.outcome };
  if (name === 'caseRead') return { status: value.status, type: value.data?.type, source: value.data?.content?.case?.source };
  throw new Error(`Unknown workload: ${name}`);
}
async function main(argv) {
  const baselineIndex = argv.indexOf('--baseline-source');
  if (baselineIndex < 0 || !argv[baselineIndex + 1]) throw new Error('Usage: node tests/benchmark-mcp.js --baseline-source /absolute/original/mavt [--samples N] [--cold-samples N] [--output /absolute/verification/raw.json]');
  const baselineSource = path.resolve(argv[baselineIndex + 1]);
  const samplesIndex = argv.indexOf('--samples'), samples = samplesIndex < 0 ? 15 : Number(argv[samplesIndex + 1]);
  const coldIndex = argv.indexOf('--cold-samples'), coldSamples = coldIndex < 0 ? 12 : Number(argv[coldIndex + 1]);
  const outputIndex = argv.indexOf('--output'), outputPath = outputIndex < 0 ? null : path.resolve(argv[outputIndex + 1]);
  if (!Number.isInteger(samples) || samples < GATES.minimumSamples) throw new Error(`Require at least ${GATES.minimumSamples} samples`);
  if (!Number.isInteger(coldSamples) || coldSamples < 5) throw new Error('Require at least 5 independent cold samples');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-benchmark-')));
  let client;
  try {
    const baseline = require(path.join(baselineSource, 'build-plugin')).buildPlugin({ outputRoot: path.join(root, 'old-build') });
    const current = buildPlugin({ outputRoot: path.join(root, 'new-build') });
    const old = fixture(baseline.pluginRoot, path.join(root, 'old'));
    const newer = fixture(current.pluginRoot, path.join(root, 'new'));
    const mcp = fixture(current.pluginRoot, path.join(root, 'mcp'));
    const oldCli = cliWorkloads(old), newCli = cliWorkloads(newer);
    const coldOldCase = oldCli.caseRead(), coldNewCase = newCli.caseRead();
    assert.ok(newer.brief.contextRef, 'Current Loader must issue the scoped MCP context');
    assert.ok(mcp.brief.contextRef, 'Current Loader did not mint a scoped MCP context');
    client = mcpClient(current.pluginRoot);
    const startup = performance.now();
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mavt_benchmark', version: '1' } });
    client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await client.request('tools/list', {});
    const coldConnectMs = performance.now() - startup;
    const idleProcesses = processStats(client.child.pid);
    assert.deepEqual(catalog.value.tools.map(tool => tool.name).sort(), RELEASE_TOOLS);
    const call = async (name, args) => {
      const started = performance.now();
      const response = await client.request('tools/call', { name, arguments: args });
      if (response.value.isError) throw new Error(`${name}: ${JSON.stringify(response.value.structuredContent)}`);
      return { value: response.value.structuredContent, bytes: response.bytes, elapsedMs: performance.now() - started };
    };
    const coldMcpCase = await call('mavt_case_read', { contextRef: mcp.brief.contextRef, input: { ref: mcp.brief.data.ref } });
    assert.deepEqual(comparable('caseRead', coldMcpCase.value), comparable('caseRead', coldOldCase.value));
    const pings = [];
    for (let i = 0; i < samples; i++) {
      const started = performance.now(); await client.request('ping', {}); pings.push(performance.now() - started);
    }
    const author = await call('mavt_workspace_open', { workspace: mcp.workspace, role: 'author' });
    const coldFirstToolMs = coldMcpCase.elapsedMs;
    const knowledge = await call('mavt_workspace_open', { workspace: mcp.workspace, role: 'knowledge' });
    const coordinator = await call('mavt_workspace_open', { workspace: mcp.workspace, role: 'coordinator', batchId: mcp.batchId });
    const refs = { author: author.value.contextRef, knowledge: knowledge.value.contextRef, run: coordinator.value.contextRef, case: mcp.brief.contextRef };
    assert.ok(refs.case);
    const mcpWorkloads = {
      doctor: () => call('mavt_workspace_doctor', { workspace: mcp.workspace }),
      knowledgeList: () => call('mavt_knowledge_list', { contextRef: refs.knowledge }),
      knowledgeShowLarge: () => call('mavt_knowledge_show', { contextRef: refs.knowledge, entryId: 'K-bench' }),
      runRead: () => call('mavt_run_read', { contextRef: refs.run, input: { ref: mcp.prepared.data.ref } }),
      caseRead: () => call('mavt_case_read', { contextRef: refs.case, input: { ref: mcp.brief.data.ref } }),
    };
    const workloads = Object.keys(oldCli);
    const results = {};
    for (const name of workloads) {
      const before = !['caseRead', 'runRead'].includes(name)
        ? [treeDigest(old.workspace), treeDigest(newer.workspace), treeDigest(mcp.workspace)] : null;
      const firstOld = oldCli[name](), firstNew = newCli[name](), firstMcp = await mcpWorkloads[name]();
      const expected = comparable(name, firstOld.value);
      assert.deepEqual(comparable(name, firstNew.value), expected, `${name} new CLI domain parity`);
      assert.deepEqual(comparable(name, firstMcp.value), expected, `${name} MCP domain parity`);
      const rows = { oldCli: [firstOld], newCli: [firstNew], mcp: [firstMcp] };
      for (let i = 0; i < samples; i++) {
        if (i % 2) { rows.newCli.push(newCli[name]()); rows.oldCli.push(oldCli[name]()); }
        else { rows.oldCli.push(oldCli[name]()); rows.newCli.push(newCli[name]()); }
        rows.mcp.push(await mcpWorkloads[name]());
      }
      if (before) assert.deepEqual([treeDigest(old.workspace), treeDigest(newer.workspace), treeDigest(mcp.workspace)], before,
        `${name} changed workspace bytes`);
      const summarizeRows = values => ({ coldMs: values[0].elapsedMs, warm: summarize(values.slice(1).map(item => item.elapsedMs)),
        responseBytes: values.at(-1).bytes, subprocessesPerCall: values === rows.mcp ? 0 : 1 });
      results[name] = { oldCli: summarizeRows(rows.oldCli), newCli: summarizeRows(rows.newCli), mcp: summarizeRows(rows.mcp) };
      results[name].gates = { versusOld: gate(results[name].oldCli.warm, results[name].mcp.warm),
        versusNew: gate(results[name].newCli.warm, results[name].mcp.warm),
        newCliVersusOld: gate(results[name].oldCli.warm, results[name].newCli.warm) };
    }
    const readonlyBefore = treeDigest(mcp.workspace);
    const status = await call('mavt_run_status', { contextRef: refs.run });
    const report = await call('mavt_run_report', { contextRef: refs.run });
    assert.equal(status.value.status, 'SUCCEEDED');
    assert.equal(report.value.status, 'SUCCEEDED');
    assert.equal(treeDigest(mcp.workspace), readonlyBefore, 'MCP progress/report changed workspace bytes');
    const imageRows = [];
    const imageBefore = treeDigest(mcp.workspace);
    for (let i = 0; i < samples; i++) {
      const image = await call('mavt_case_image', { contextRef: refs.case, ref: mcp.imageRef });
      assert.equal(image.value.byteLength, PNG.length);
      imageRows.push(image);
    }
    assert.equal(treeDigest(mcp.workspace), imageBefore, 'MCP image read changed workspace bytes');
    const activeProcesses = processStats(client.child.pid);
    const cliPeakRssKiB = {
      oldDoctor: cliPeakRss(old.entry, ['doctor', '--workspace', old.workspace]),
      newDoctor: cliPeakRss(newer.entry, ['doctor', '--workspace', newer.workspace]),
      oldCaseRead: cliPeakRss(path.join(old.opened.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js'), ['--dispatch-sequence', '1'],
        { input: JSON.stringify({ operation: 'read', input: { ref: old.brief.data.ref } }), env: { ...process.env, MAVT_EXECUTION_DIR: old.execDir } }),
      newCaseRead: cliPeakRss(path.join(newer.opened.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js'), ['--dispatch-sequence', '1'],
        { input: JSON.stringify({ operation: 'read', input: { ref: newer.brief.data.ref } }), env: { ...process.env, MAVT_EXECUTION_DIR: newer.execDir } }),
    };
    await new Promise(resolve => setTimeout(resolve, DEFAULT_IDLE_TIMEOUT_MS + 1000));
    const reclaimedProcesses = processStats(client.child.pid);
    assert.equal(reclaimedProcesses.workerCount, 0, 'Worker did not exit after the default idle timeout');
    const independentCold = { oldCli: [], newCli: [], mcp: [] };
    for (let i = 0; i < coldSamples; i++) {
      for (const [name, f] of [['oldCli', old], ['newCli', newer]]) {
        const sample = createCaseSample(f, `cold-${name}-${i}`);
        const first = run(path.join(f.opened.runtimeRoot, 'scripts/case-runtime/agent-facing-client.js'), ['--dispatch-sequence', '1'], {
          input: JSON.stringify({ operation: 'read', input: { ref: sample.brief.data.ref } }),
          env: { ...process.env, MAVT_EXECUTION_DIR: sample.execDir },
        });
        assert.deepEqual(comparable('caseRead', first.value), comparable('caseRead', coldOldCase.value));
        independentCold[name].push(sample.loaderMs + first.elapsedMs);
      }
      const sample = createCaseSample(mcp, `cold-mcp-${i}`);
      const coldClient = mcpClient(current.pluginRoot);
      try {
        const started = performance.now();
        await coldClient.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mavt_benchmark_cold', version: '1' } });
        coldClient.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const response = await coldClient.request('tools/call', { name: 'mavt_case_read',
          arguments: { contextRef: sample.brief.contextRef, input: { ref: sample.brief.data.ref } } });
        assert.equal(response.value.isError, false, JSON.stringify(response.value.structuredContent));
        assert.deepEqual(comparable('caseRead', response.value.structuredContent), comparable('caseRead', coldOldCase.value));
        independentCold.mcp.push(sample.loaderMs + performance.now() - started);
      } finally { coldClient.close(); }
    }
    const output = { schemaVersion: 2, node: process.version, baselineSource, baselineBundleId: baseline.manifest.bundleId,
      newBundleId: current.manifest.bundleId, gates: GATES, coldConnectMs, coldFirstToolMs,
      coldCasePath: { oldCliMs: old.loaderMs + coldOldCase.elapsedMs, newCliMs: newer.loaderMs + coldNewCase.elapsedMs,
        mcpMs: mcp.loaderMs + coldConnectMs + coldMcpCase.elapsedMs,
        oldLoaderMs: old.loaderMs, newLoaderMs: newer.loaderMs, mcpLoaderMs: mcp.loaderMs,
        oldFirstReadMs: coldOldCase.elapsedMs, newFirstReadMs: coldNewCase.elapsedMs,
        mcpFirstReadMs: coldMcpCase.elapsedMs },
      independentColdCasePath: { sampleCount: coldSamples, oldCli: summarize(independentCold.oldCli),
        newCli: summarize(independentCold.newCli), mcp: summarize(independentCold.mcp),
        newCliVersusOld: gate(summarize(independentCold.oldCli), summarize(independentCold.newCli)),
        mcpVersusOld: gate(summarize(independentCold.oldCli), summarize(independentCold.mcp)),
        mcpVersusNew: gate(summarize(independentCold.newCli), summarize(independentCold.mcp)) },
      initialWorkspaceEntryMs: { oldCli: old.workspaceEntryMs, newCli: newer.workspaceEntryMs }, catalogBytes: catalog.bytes,
      catalogDefinitionBytes: Buffer.byteLength(JSON.stringify(catalog.value.tools)), transportPing: summarize(pings),
      idleProcesses, activeProcesses, reclaimedProcesses, cliPeakRssKiB,
      subprocessesPerCliCall: 1, subprocessesPerWarmMcpCall: 0,
      grownEvidenceFilesPerWorkspace: 100,
      readonlyProgress: { statusBytes: status.bytes, reportBytes: report.bytes, workspaceBytesUnchanged: true },
      cliReadNote: 'Coordinator CLI read and Case CLI read record telemetry; these are measured but not classified byte-readonly.',
      image: { responseBytes: imageRows.at(-1).bytes, sourceBytes: PNG.length, warm: summarize(imageRows.map(item => item.elapsedMs)), workspaceBytesUnchanged: true }, results,
      warmMcpPass: workloads.every(name => results[name].gates.versusOld.pass && results[name].gates.versusNew.pass),
      cliComparisonPass: workloads.every(name => results[name].gates.newCliVersusOld.pass) &&
        gate(summarize(independentCold.oldCli), summarize(independentCold.newCli)).pass,
      coldMcpParityPass: gate(summarize(independentCold.oldCli), summarize(independentCold.mcp)).pass &&
        gate(summarize(independentCold.newCli), summarize(independentCold.mcp)).pass };
    output.pass = acceptancePass(output);
    const serialized = JSON.stringify(output, null, 2) + '\n';
    if (outputPath) { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, serialized); }
    process.stdout.write(serialized);
    if (!output.pass) process.exitCode = 1;
  } finally { client?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { summarize, gate, acceptancePass, GATES };

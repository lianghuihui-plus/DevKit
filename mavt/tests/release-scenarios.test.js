'use strict';

// These scenarios exercise built release code only. The sealed report inputs
// are synthetic test artifacts; no device, simulator, probe or adapter runs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { buildPlugin } = require('../build-plugin');
const repoRoot = path.resolve(__dirname, '..');
const sourceRuntime = path.join(repoRoot, 'src/mobile-ai-visual-test');
const { createManifest } = require(path.join(sourceRuntime, 'scripts/lib/runtime-bundle'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
}
function invoke(script, args = [], input, env = {}) {
  const child = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env },
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input),
  });
  assert.ifError(child.error);
  const output = child.stdout.trim() || child.stderr.trim();
  assert.ok(output, `no JSON output: ${script}: ${child.stderr}`);
  return { code: child.status, data: JSON.parse(output) };
}
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-release-scenarios-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const a = buildPlugin({ outputRoot: path.join(temp, '安装 A') });
  const b = buildPlugin({ outputRoot: path.join(temp, '安装 B') });
  // Model an actual code/profile update, not just a version-string change.
  fs.appendFileSync(path.join(b.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/case-runtime/runtime-core.js'), '\n// release B\n');
  fs.appendFileSync(path.join(b.pluginRoot, 'hosts/codex/delegation.md'), '\nRelease B\n');
  b.manifest = createManifest(b.pluginRoot, '0.1.1');
  writeJson(path.join(b.pluginRoot, 'bundle.manifest.json'), b.manifest);
  const workspace = path.join(temp, '工作 空间');
  fs.mkdirSync(workspace);
  const entry = built => path.join(built.pluginRoot, 'scripts/mavt-entry.js');
  const openedA = invoke(entry(a), ['workspace', '--cwd', workspace]);
  const openedB = invoke(entry(b), ['workspace', '--cwd', workspace]);
  assert.equal(openedA.code, 0);
  assert.equal(openedB.code, 0);
  assert.notEqual(openedA.data.bundleId, openedB.data.bundleId);
  return { temp, workspace, a, b, entry, pinnedA: openedA.data, pinnedB: openedB.data };
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().flatMap(relative => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    return stat.isFile() ? [[relative, stat.mode & 0o777,
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]] : [];
  });
}
function prepareRun(f) {
  require(path.join(f.pinnedA.runtimeRoot, 'scripts/case/import-drafts')).importDrafts(f.workspace, {
    cases: [{ sourceLocator: '/fixture/release.md#1', title: '离线绑定验证', sourceText: '检查标题。' }],
  });
  const result = invoke(path.join(f.pinnedA.runtimeRoot, 'scripts/coordinator-agent.js'), ['--workspace', f.workspace], {
    operation: 'prepareRun', input: { caseNos: ['001'] },
  });
  assert.equal(result.code, 0);
  assert.equal(result.data.result.outcome, 'NEED_USER_CONFIRMATION');
  const [batchId] = fs.readdirSync(path.join(f.workspace, 'runs'));
  return { batchId, bindingPath: path.join(f.workspace, 'runs', batchId, 'runtime-binding.json') };
}
function syntheticEvidence(workspace, options) {
  const previousSelfTest = process.env.MAVT_SELF_TEST;
  const markerPath = path.join(workspace, 'workspace.json');
  const readyMarker = fs.readFileSync(markerPath);
  try {
    process.env.MAVT_SELF_TEST = '1';
    const helpers = require(path.join(sourceRuntime, 'scripts/tests/support/workspace-fixture'));
    // Generate in place so sealed scene paths point at their final location.
    // Only the test-only fixture helper executes before READY is restored.
    writeJson(markerPath, { schemaVersion: 1, type: helpers.TEST_WORKSPACE_TYPE, testOnly: true });
    return options.map(value => helpers.createCurrentFixture(workspace, value));
  } finally {
    fs.writeFileSync(markerPath, readyMarker);
    if (previousSelfTest === undefined) delete process.env.MAVT_SELF_TEST;
    else process.env.MAVT_SELF_TEST = previousSelfTest;
  }
}
const offlineEnvironmentPorts = {
  probeEnvironment: (platform, deviceId) => ({ schemaVersion: 1, type: 'environmentProbe', platform, ready: true,
    devices: [{ id: deviceId || 'offline-fixture-device' }], diagnostics: [] }),
  resolveEnvironment: ({ binding }) => binding.appId ? { status: 'READY', binding }
    : { status: 'NEED_SELECTION', selectionKind: 'APP', coverage: 'limited', allowTargetInput: true, candidates: [] },
  prepareEnvironment: ({ binding }) => ({ schemaVersion: 1, type: 'environmentPrepare', platform: binding.platform, ok: true }),
};
function selectFakeEnvironment(service, statePath) {
  const response = service.confirmRun(statePath, {
    operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'harmony' },
  }, { ...offlineEnvironmentPorts, probeEnvironment: () => ({ schemaVersion: 1, type: 'environmentProbe', platform: 'harmony', ready: true,
    devices: [{ id: 'offline-fixture-device' }], diagnostics: [] }) });
  assert.equal(response.result.phase, 'NEED_BINDING_CONFIRMATION');
}
const fakeBindingConfirmation = { operation: 'confirmRun', input: {
  decision: 'CONFIRM_BINDING', userInstruction: '仅离线验证状态机，不访问设备',
  binding: { platform: 'harmony', deviceId: 'offline-fixture-device', appId: 'com.example.offline', entry: 'EntryAbility' },
} };
function initializationOnly(runtimeRoot) {
  const batch = require(path.join(runtimeRoot, 'scripts/batch'));
  return input => {
    assert.equal(input.command, 'init', 'this offline port never allows bootstrap or device operations');
    return batch.execute(input);
  };
}

test('knowledge prepare/apply retains pinned A after installation A disappears and B is active', t => {
  const f = fixture(t);
  const knowledge = invoke(f.entry(f.a), ['knowledge', '--workspace', f.workspace]);
  assert.equal(knowledge.code, 0);
  assert.ok(knowledge.data.entry.startsWith(f.pinnedA.bundleRoot + path.sep));
  const draft = path.join(f.temp, '知识草稿.md');
  fs.writeFileSync(draft, '# K-release-001 页面规则\n\n## 适用范围\n- App: com.example.test\n- Platform: harmony\n\n## 可观察现象\n首页分类入口未展示。\n\n## 结论与处理建议\n已确认的平台差异。\n\n## 追溯信息\n产品确认，2026-10-21。\n');
  const request = path.join(f.temp, '知识请求.json');
  writeJson(request, { schemaVersion: 1, reason: '离线验证代码固定', operations: [{ type: 'ADD', draftPath: draft }] });
  const before = snapshot(f.workspace);
  const prepared = invoke(knowledge.data.entry, ['prepare', '--workspace', f.workspace, '--request', request]);
  assert.equal(prepared.code, 0);
  assert.equal(prepared.data.status, 'PREPARED');
  assert.deepEqual(snapshot(f.workspace), before, 'prepare must not mutate knowledge or the pinned runtime');
  fs.renameSync(f.a.pluginRoot, f.a.pluginRoot + '-removed');
  const selectedB = invoke(f.entry(f.b), ['knowledge', '--workspace', f.workspace]);
  assert.equal(selectedB.data.bundleId, f.pinnedB.bundleId);
  assert.notEqual(selectedB.data.entry, knowledge.data.entry);
  const applied = invoke(knowledge.data.entry, ['apply', '--workspace', f.workspace, '--request', request, '--plan-hash', prepared.data.planHash]);
  assert.equal(applied.code, 0);
  assert.equal(applied.data.status, 'APPLIED');
  assert.equal(applied.data.changes[0].entryId, 'K-release-001');
  assert.ok(applied.data.backupPath.startsWith(path.join(f.workspace, '.mavt/knowledge-maintenance') + path.sep));
  const listed = invoke(knowledge.data.entry, ['list', '--workspace', f.workspace]);
  assert.deepEqual(listed.data.entries.map(item => item.entryId), ['K-release-001']);
});

async function waitForFile(file) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function reportWorker(t, runtimeRoot, args) {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const [root, workspace, caseDir, ready, release, result] = process.argv.slice(1);
    const lock = require(path.join(root, 'scripts/report/publication-lock'));
    const reports = require(path.join(root, 'scripts/report/report-service'));
    try {
      if (release !== '-') lock.withWorkspaceReportPublication(workspace, () => {
        fs.writeFileSync(ready, 'locked');
        const until = Date.now() + 10000;
        while (!fs.existsSync(release)) {
          if (Date.now() > until) throw new Error('test release signal timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      });
      else fs.writeFileSync(ready, 'attempting');
      const response = reports.refreshCommittedCaseReports(caseDir, 'harmony');
      fs.writeFileSync(result, JSON.stringify({ lockPath: lock.reportPublicationLockPath(workspace), response }));
    } catch (error) { console.error(error); process.exitCode = 1; }
  `;
  const child = spawn(process.execPath, ['-e', script, runtimeRoot, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'close').then(([code]) => assert.equal(code, 0, stderr));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, done };
}

test('A/B report publication serializes on the workspace lock and preserves both sealed executions', async t => {
  const f = fixture(t);
  const currents = syntheticEvidence(f.workspace, [{ suffix: 'release-a', verdict: 'PASS' }, { suffix: 'release-b', verdict: 'FAIL' }]);
  const cases = currents.map(current => ({ caseDir: current.caseDir, execDir: current.execDir }));
  const before = cases.map(current => snapshot(current.execDir));
  const aReady = path.join(f.temp, 'a-held');
  const bReady = path.join(f.temp, 'b-attempted');
  const release = path.join(f.temp, 'release-a');
  const aResult = path.join(f.temp, 'a-result.json');
  const bResult = path.join(f.temp, 'b-result.json');
  const a = reportWorker(t, f.pinnedA.runtimeRoot, [f.workspace, cases[0].caseDir, aReady, release, aResult]);
  await waitForFile(aReady);
  assert.ok(fs.existsSync(path.join(f.workspace, '.report-publication.lock')));
  const b = reportWorker(t, f.pinnedB.runtimeRoot, [f.workspace, cases[1].caseDir, bReady, '-', bResult]);
  await waitForFile(bReady);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(fs.existsSync(bResult), false, 'B must wait while A holds the shared workspace lock');
  fs.writeFileSync(release, 'release');
  await Promise.all([a.done, b.done]);
  const publishedA = JSON.parse(fs.readFileSync(aResult));
  const publishedB = JSON.parse(fs.readFileSync(bResult));
  assert.equal(publishedA.lockPath, path.join(f.workspace, '.report-publication.lock'));
  assert.equal(publishedB.lockPath, publishedA.lockPath);
  assert.equal(publishedA.response.status, 'UPDATED');
  assert.equal(publishedB.response.status, 'UPDATED');
  // Deliberately publish A again after B, then render with B: both versions
  // consume the same authoritative inputs rather than overwriting evidence.
  require(path.join(f.pinnedA.runtimeRoot, 'scripts/report/report-service')).refreshCommittedCaseReports(cases[0].caseDir, 'harmony');
  require(path.join(f.pinnedB.runtimeRoot, 'scripts/report/report-service')).renderIndexForRoot(f.workspace);
  assert.deepEqual(cases.map(current => snapshot(current.execDir)), before);
  const index = fs.readFileSync(path.join(f.workspace, 'index.html'), 'utf8');
  for (let i = 0; i < cases.length; i += 1) {
    const metadata = JSON.parse(fs.readFileSync(path.join(cases[i].caseDir, 'platforms/harmony/report-metadata.json')));
    assert.equal(metadata.executionId, currents[i].execution.executionId);
    assert.ok(index.includes(currents[i].caseJson.identity.caseKey));
    const completion = require(path.join(f.pinnedB.runtimeRoot, 'scripts/lib/completion-contract'));
    const read = name => JSON.parse(fs.readFileSync(path.join(cases[i].execDir, name)));
    assert.equal(completion.validatePublishedCompletion(cases[i].execDir, read('completion.json'), {
      execution: read('execution.json'), result: read('result.json'), metrics: read('metrics.json'), snapshot: read('case.snapshot.json'),
    }).verdict, i === 0 ? 'PASS' : 'FAIL');
  }
  assert.equal(fs.existsSync(path.join(f.workspace, '.report-publication.lock')), false);
});

test('interrupted A initialization resumes its frozen request after B replaces the installation', t => {
  const f = fixture(t);
  const run = prepareRun(f);
  const statePath = path.join(f.workspace, 'runs', run.batchId, 'coordinator-state.json');
  const service = require(path.join(f.pinnedA.runtimeRoot, 'scripts/coordinator/agent-facing-service'));
  selectFakeEnvironment(service, statePath);
  assert.throws(() => service.confirmRun(statePath, fakeBindingConfirmation, {
    ...offlineEnvironmentPorts,
    interruptAfter: 'executionRequestCreated', batchExecute: () => { throw new Error('initialization must stop before Batch'); },
  }), /MAVT_COORDINATOR_INTERRUPTED: executionRequestCreated/);
  const interrupted = service.loadCoordinatorState(statePath);
  assert.equal(interrupted.phase, 'INITIALIZING_RUN');
  const frozenRequest = fs.readFileSync(path.join(path.dirname(statePath), 'execution-request.json'));
  const binding = fs.readFileSync(run.bindingPath);
  fs.renameSync(f.a.pluginRoot, f.a.pluginRoot + '-removed');
  const selected = invoke(f.entry(f.b), ['resume', '--workspace', f.workspace, '--run', run.batchId]);
  assert.equal(selected.data.bundleId, f.pinnedA.bundleId);
  const recoveredService = require(path.join(selected.data.runtimeRoot, 'scripts/coordinator/agent-facing-service'));
  const recovered = recoveredService.advanceRun(statePath, { batchExecute: initializationOnly(selected.data.runtimeRoot) });
  assert.equal(recovered.result.outcome, 'CONFIRMED');
  const state = recoveredService.loadCoordinatorState(statePath);
  assert.equal(state.phase, 'BATCH_READY');
  assert.deepEqual(state.initialization.environmentFrozen, interrupted.initialization.environmentFrozen);
  assert.deepEqual(state.initialization.executionRequestCreated, interrupted.initialization.executionRequestCreated);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(statePath), 'execution-request.json')), frozenRequest);
  assert.deepEqual(fs.readFileSync(run.bindingPath), binding);
  assert.ok(fs.existsSync(path.join(path.dirname(statePath), 'batch.json')));
});

test('A reuses PREPARED dispatch and waits for CONSUMED dispatch after upgrade without taking over', t => {
  const f = fixture(t);
  const run = prepareRun(f);
  const statePath = path.join(f.workspace, 'runs', run.batchId, 'coordinator-state.json');
  const service = require(path.join(f.pinnedA.runtimeRoot, 'scripts/coordinator/agent-facing-service'));
  selectFakeEnvironment(service, statePath);
  assert.equal(service.confirmRun(statePath, fakeBindingConfirmation, {
    ...offlineEnvironmentPorts,
    batchExecute: initializationOnly(f.pinnedA.runtimeRoot),
  }).result.outcome, 'CONFIRMED');
  const state = service.loadCoordinatorState(statePath);
  const target = state.targets[0];
  const executionId = 'execution-upgrade-dispatch';
  const execDir = path.join(target.caseDir, 'platforms/harmony/executions', executionId);
  writeJson(path.join(execDir, 'execution.json'), { schemaVersion: 14, runtime: 'case-runtime', executionId, batchId: run.batchId, platform: 'harmony', finalized: false });
  const handoffs = require(path.join(f.pinnedA.runtimeRoot, 'scripts/batch/agent-handoff'));
  const dispatches = require(path.join(f.pinnedA.runtimeRoot, 'scripts/lib/dispatch-lease'));
  const handoff = handoffs.createAgentHandoff({ workspaceRoot: f.workspace, batchId: run.batchId, executionId,
    caseProtocolSha: 'agent-protocol-upgrade-offline', casePrompt: 'Offline fixture only', brief: { caseKey: target.caseKey } });
  const directory = path.dirname(handoff.path);
  // Batch/device transitions are an explicit offline port. Dispatch persistence,
  // consumption, Coordinator projection and resume routing remain production.
  const batchPort = input => {
    if (input.command === 'start') return { agentRequired: true, caseKey: target.caseKey, executionId, handoff };
    assert.equal(input.command, 'reconcile');
    const active = dispatches.readActiveDispatch(directory, executionId);
    return { action: active.status === 'PREPARED' ? 'NEED_CASE_AGENT' : 'WAIT_EXECUTION_RESULT', caseKey: target.caseKey, executionId,
      progress: { executionPhase: active.status === 'CONSUMED' ? 'HANDOFF_CONSUMED' : 'HANDOFF_PREPARED' } };
  };
  const first = service.advanceRun(statePath, { batchExecute: batchPort });
  assert.equal(first.result.outcome, 'NEED_CASE_AGENT');
  assert.equal(first.data.content.loaderCommand, handoff.loaderCommand);
  const preparedDispatch = snapshot(directory);
  fs.renameSync(f.a.pluginRoot, f.a.pluginRoot + '-removed');
  const resumed = invoke(f.entry(f.b), ['resume', '--workspace', f.workspace, '--run', run.batchId]);
  assert.equal(resumed.data.bundleId, f.pinnedA.bundleId);
  const repeated = service.advanceRun(statePath, { batchExecute: batchPort });
  assert.equal(repeated.data.content.loaderCommand, first.data.content.loaderCommand);
  assert.deepEqual(snapshot(directory), preparedDispatch);
  const envelope = JSON.parse(fs.readFileSync(handoff.path));
  handoffs.loadAgentHandoff({ workspaceRoot: f.workspace, handoffPath: handoff.path, sha256: handoff.sha256,
    executionId, caseProtocolSha: envelope.caseProtocolSha, claimToken: dispatches.claimTokenFor(envelope) });
  assert.equal(dispatches.readActiveDispatch(directory, executionId).status, 'CONSUMED');
  const consumedDispatch = snapshot(directory);
  for (let i = 0; i < 2; i += 1) {
    const waiting = service.advanceRun(statePath, { batchExecute: batchPort });
    assert.equal(waiting.result.outcome, 'WAITING');
    assert.equal(waiting.result.waitFor, 'EXECUTION_RESULT');
    assert.equal(waiting.data.content.progress.executionPhase, 'HANDOFF_CONSUMED');
    assert.equal(service.loadCoordinatorState(statePath).phase, 'WAITING_FOR_CASE_AGENT');
    assert.deepEqual(snapshot(directory), consumedDispatch, 'resume must neither consume again nor create a continuation');
  }
});

test('terminal A Run observes its deferred report recovery through A after B is installed', t => {
  const f = fixture(t);
  const [current] = syntheticEvidence(f.workspace, [{ suffix: 'report-retry', verdict: 'PASS' }]);
  const service = require(path.join(f.pinnedA.runtimeRoot, 'scripts/coordinator/agent-facing-service'));
  const prepared = service.prepareRun({ operation: 'prepareRun', input: { caseNos: ['001'] } }, {
    workspace: f.workspace, batchId: 'batch-report-retry-upgrade',
  });
  assert.equal(prepared.result.outcome, 'NEED_USER_CONFIRMATION');
  const statePath = path.join(f.workspace, 'runs/batch-report-retry-upgrade/coordinator-state.json');
  selectFakeEnvironment(service, statePath);
  assert.equal(service.confirmRun(statePath, fakeBindingConfirmation, {
    ...offlineEnvironmentPorts,
    batchExecute: initializationOnly(f.pinnedA.runtimeRoot),
  }).result.outcome, 'CONFIRMED');
  const publication = require(path.join(f.pinnedA.runtimeRoot, 'scripts/report/publication-state'));
  const deferred = publication.recordPublicationAttempt(f.workspace, 'batch-report-retry-upgrade', 'batch', {
    status: 'FAILED', errorCode: 'EXECUTION_LOCKED', reason: 'offline publication contention fixture',
  });
  const terminal = service.advanceRun(statePath, { batchExecute: () => ({ action: 'BATCH_COMPLETE',
    state: { status: 'COMPLETED' }, publicationState: deferred }) });
  assert.equal(terminal.data.content.reportStatus, 'RETRY_REQUIRED');
  assert.equal(terminal.data.content.runOutcome, 'COMPLETED');
  const evidence = snapshot(current.execDir);
  fs.renameSync(f.a.pluginRoot, f.a.pluginRoot + '-removed');
  const selected = invoke(f.entry(f.b), ['resume', '--workspace', f.workspace, '--run', 'batch-report-retry-upgrade']);
  assert.equal(selected.data.bundleId, f.pinnedA.bundleId);
  const reports = require(path.join(selected.data.runtimeRoot, 'scripts/report/report-service'));
  reports.renderIndexForRoot(f.workspace);
  assert.equal(publication.readPublicationState(f.workspace, 'batch-report-retry-upgrade').status, 'PUBLISHED');
  const completed = invoke(path.join(selected.data.runtimeRoot, 'scripts/coordinator-agent.js'), ['--state', statePath], {
    operation: 'advanceRun', input: {},
  });
  assert.equal(completed.code, 0);
  assert.equal(completed.data.data.content.reportStatus, 'PUBLISHED');
  assert.equal(completed.data.data.content.runOutcome, 'COMPLETED');
  assert.equal(completed.data.data.content.reportPath, path.join(f.workspace, 'index.html'));
  assert.deepEqual(snapshot(current.execDir), evidence);
});

test('Loader, Case client and maintenance reject wrong/missing/malformed Run binding before any write', t => {
  const f = fixture(t);
  const run = prepareRun(f);
  const executionId = 'execution-offline-release';
  const execDir = path.join(f.workspace, 'cases/offline/platforms/harmony/executions', executionId);
  writeJson(path.join(execDir, 'execution.json'), { schemaVersion: 14, runtime: 'case-runtime', executionId, batchId: run.batchId, platform: 'harmony', finalized: false });
  const handoff = require(path.join(f.pinnedA.runtimeRoot, 'scripts/batch/agent-handoff')).createAgentHandoff({
    workspaceRoot: f.workspace, batchId: run.batchId, executionId, caseProtocolSha: 'agent-protocol-release-offline',
    casePrompt: 'Offline guard validation only', brief: { caseKey: 'ck-offline' },
  });
  const envelope = JSON.parse(fs.readFileSync(handoff.path));
  const claimToken = require(path.join(f.pinnedA.runtimeRoot, 'scripts/lib/dispatch-lease')).claimTokenFor(envelope);
  const loaderArgs = ['--workspace', f.workspace, '--handoff', handoff.path, '--sha256', handoff.sha256,
    '--execution-id', executionId, '--case-protocol-sha', envelope.caseProtocolSha, '--claim-token', claimToken];
  const original = fs.readFileSync(run.bindingPath);
  for (const scenario of ['wrong bundle', 'missing binding', 'malformed binding']) {
    if (scenario === 'missing binding') fs.unlinkSync(run.bindingPath);
    if (scenario === 'malformed binding') fs.writeFileSync(run.bindingPath, '{');
    const runtimeRoot = scenario === 'wrong bundle' ? f.pinnedB.runtimeRoot : f.pinnedA.runtimeRoot;
    const entries = [
      { file: 'scripts/case-agent-bootstrap.js', args: loaderArgs },
      { file: 'scripts/case-runtime/agent-facing-client.js', args: [], input: { operation: 'read', input: { ref: 'invalid' } }, env: { MAVT_EXECUTION_DIR: execDir } },
      { file: 'scripts/case-runtime/agent-facing-client.js', args: [], input: '{', env: { MAVT_EXECUTION_DIR: execDir } },
      { file: 'scripts/batch.js', args: ['init', '--workspace', f.workspace, '--batch-id', run.batchId] },
      { file: 'scripts/execution-request.js', args: ['create', '--workspace', f.workspace, '--batch-id', run.batchId,
        '--mode', 'single', '--targets-json', '{', '--user-instruction', 'offline guard validation'] },
    ];
    for (const entry of entries) {
      const before = snapshot(f.workspace);
      const response = invoke(path.join(runtimeRoot, entry.file), entry.args, entry.input, entry.env);
      assert.notEqual(response.data.status, 'SUCCEEDED', `${scenario}: ${entry.file}`);
      assert.deepEqual(snapshot(f.workspace), before, `${scenario}: ${entry.file} must not write telemetry, claims, resources or state`);
      if (entry.file === 'scripts/batch.js' || entry.file === 'scripts/execution-request.js') {
        if (entry.file === 'scripts/execution-request.js') assert.equal(response.code, 2);
        assert.equal(response.data.code, 'MAVT_RUNTIME_BINDING_INVALID');
      }
    }
    fs.writeFileSync(run.bindingPath, original);
  }
});

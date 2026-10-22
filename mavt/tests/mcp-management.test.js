'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildPlugin } = require('../build-plugin');
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-mcp-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const built = buildPlugin({ outputRoot: path.join(temp, 'build') });
  const entry = path.join(built.pluginRoot, 'scripts/mavt-mcp.js');
  assert.ok(fs.existsSync(entry), 'build must expose the management MCP entry');
  const server = require(entry).createServer({ pluginRoot: built.pluginRoot });
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  return { ...built, temp, workspace, entry, server, call: (name, args) => server.callTool(name, args).structuredContent };
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map(name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file).toString('base64') : '/'];
  });
}
const draft = { cases: [{ sourceLocator: '/fixture/source#1', title: '检查标题', sourceText: '打开首页，检查标题。' }] };
const knowledge = '# K-test 页面规则\n\n## 适用范围\n- App: com.example.test\n- Platform: harmony\n\n## 可观察现象\n首页入口没有展示。\n\n## 结论与处理建议\n这是已确认的平台差异。\n\n## 追溯信息\n产品确认，2026-10-22。\n';
function init(f, role, workspace = f.workspace) { return f.call('mavt_workspace_init', { workspace, role }).contextRef; }
test('nonempty init and unready knowledge reject without writes', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.workspace, 'unrelated'), 'preserve');
  const before = snapshot(f.workspace);
  assert.equal(f.call('mavt_workspace_init', { workspace: f.workspace, role: 'author' }).code, 'WORKSPACE_INVALID');
  assert.equal(f.call('mavt_workspace_open', { workspace: f.workspace, role: 'knowledge' }).code, 'WORKSPACE_INVALID');
  assert.deepEqual(snapshot(f.workspace), before);
});
test('persisted scoped contexts interleave workspaces and import idempotently', t => {
  const f = fixture(t), a = init(f, 'author');
  const second = path.join(f.temp, 'second'); fs.mkdirSync(second);
  const b = init(f, 'author', second);
  const first = f.call('mavt_cases_import', { contextRef: a, request: draft });
  assert.equal(first.cases?.length, 1, JSON.stringify(first));
  assert.deepEqual(f.call('mavt_cases_import', { contextRef: a, request: draft }).cases.map(c => c.caseJson.identity.caseKey), first.cases.map(c => c.caseJson.identity.caseKey));
  assert.equal(fs.readdirSync(path.join(f.workspace, 'cases')).length, 1);
  assert.equal(fs.readdirSync(path.join(second, 'cases')).length, 0);
  assert.equal(f.call('mavt_cases_import', { contextRef: b, request: draft }).cases.length, 1);
  const restarted = require(f.entry).createServer({ pluginRoot: f.pluginRoot });
  assert.equal(restarted.callTool('mavt_cases_import', { contextRef: a, request: draft }).structuredContent.cases.length, 1);
  const before = snapshot(f.workspace);
  assert.equal(f.call('mavt_knowledge_list', { contextRef: a }).code, 'MAVT_MCP_CONTEXT_INVALID');
  assert.equal(f.call('mavt_cases_import', { contextRef: a, request: draft, workspace: second }).code, 'MAVT_MCP_INPUT_INVALID');
  assert.deepEqual(snapshot(f.workspace), before);
});
test('knowledge direct prepare/apply rejects changed content and code identity', t => {
  const f = fixture(t), contextRef = init(f, 'knowledge');
  const draftPath = path.join(f.temp, 'draft.md'); fs.writeFileSync(draftPath, knowledge);
  const request = { schemaVersion: 1, reason: '同步确认规则', operations: [{ type: 'ADD', draftPath }] };
  const args = { contextRef, request };
  const plan = f.call('mavt_knowledge_prepare', args);
  assert.equal(plan.status, 'PREPARED');
  const before = snapshot(f.workspace);
  fs.appendFileSync(draftPath, '\n补充说明。\n');
  assert.equal(f.call('mavt_knowledge_apply', { ...args, planHash: plan.planHash }).code, 'KNOWLEDGE_PLAN_STALE');
  assert.deepEqual(snapshot(f.workspace), before);
  fs.writeFileSync(draftPath, knowledge);
  const other = buildPlugin({ outputRoot: path.join(f.temp, 'other') });
  fs.appendFileSync(path.join(other.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/workspace.js'), '\n// B\n');
  const manifest = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle').createManifest(other.pluginRoot, '0.1.1');
  fs.writeFileSync(path.join(other.pluginRoot, 'bundle.manifest.json'), JSON.stringify(manifest));
  const newer = require(path.join(other.pluginRoot, 'scripts/mavt-mcp')).createServer({ pluginRoot: other.pluginRoot });
  const newerContext = newer.callTool('mavt_workspace_open', { workspace: f.workspace, role: 'knowledge' }).structuredContent.contextRef;
  assert.equal(newer.callTool('mavt_knowledge_apply', { contextRef: newerContext, request, planHash: plan.planHash }).structuredContent.code, 'KNOWLEDGE_PLAN_STALE');
  assert.equal(newer.callTool('mavt_knowledge_apply', { ...args, planHash: plan.planHash }).structuredContent.status, 'APPLIED', 'A context still uses pinned A');
});
test('doctor, knowledge, run status/report/read are byte-readonly and pinned A survives removal', t => {
  const f = fixture(t), author = init(f, 'author');
  f.call('mavt_cases_import', { contextRef: author, request: draft });
  const coordinator = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'coordinator' }).contextRef;
  const prepared = f.call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  assert.equal(prepared.status, 'SUCCEEDED', JSON.stringify(prepared)); assert.ok(prepared.contextRef);
  const knowledgeRef = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'knowledge' }).contextRef;
  const before = snapshot(f.workspace);
  assert.equal(f.call('mavt_workspace_doctor', { workspace: f.workspace }).status, 'SUCCEEDED');
  assert.equal(f.call('mavt_knowledge_inspect', { contextRef: knowledgeRef }).status, 'VALID');
  const status = f.call('mavt_run_status', { contextRef: prepared.contextRef });
  assert.equal(status.status, 'SUCCEEDED', JSON.stringify({ status, prepared }));
  assert.equal(status.caseCount, 1);
  assert.equal(Object.hasOwn(status, 'state'), false);
  assert.equal(f.call('mavt_run_report', { contextRef: prepared.contextRef }).status, 'SUCCEEDED');
  const ref = prepared.data.ref;
  assert.equal(f.call('mavt_run_read', { contextRef: prepared.contextRef, input: { ref } }).status, 'SUCCEEDED');
  assert.deepEqual(snapshot(f.workspace), before);
  fs.renameSync(f.pluginRoot, f.pluginRoot + '-removed');
  assert.equal(f.call('mavt_run_cancel', { contextRef: prepared.contextRef, input: { reason: 'offline test' } }).status, 'SUCCEEDED');
});
test('malformed calls and symlink escape reject before domain effects', t => {
  const f = fixture(t), contextRef = init(f, 'author');
  const before = snapshot(f.workspace);
  assert.equal(f.call('unknown', {}).code, 'MAVT_MCP_TOOL_UNKNOWN');
  assert.equal(f.call('mavt_cases_import', { contextRef, request: { cases: [...draft.cases, { title: 'invalid' }] } }).status, 'REJECTED');
  assert.deepEqual(snapshot(f.workspace), before);
  fs.renameSync(path.join(f.workspace, 'cases'), path.join(f.temp, 'external-cases'));
  fs.symlinkSync(path.join(f.temp, 'external-cases'), path.join(f.workspace, 'cases'));
  const externalBefore = snapshot(path.join(f.temp, 'external-cases'));
  assert.equal(f.call('mavt_cases_import', { contextRef, request: draft }).status, 'REJECTED');
  assert.deepEqual(snapshot(path.join(f.temp, 'external-cases')), externalBefore);
});
test('initialization recovery rejects nested symbolic links before writing artifacts', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: 'mobile-ai-visual-test-workspace', initializationState: 'INITIALIZING' }));
  fs.mkdirSync(path.join(f.workspace, 'cases'));
  const outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.workspace, 'cases', 'escape'));
  const before = snapshot(f.workspace);
  assert.equal(f.call('mavt_workspace_init', { workspace: f.workspace, role: 'author' }).status, 'REJECTED');
  assert.deepEqual(snapshot(f.workspace), before);
});
test('changed context authority and modified pinned code invalidate warmed references', t => {
  const f = fixture(t), contextRef = init(f, 'knowledge');
  assert.equal(f.call('mavt_knowledge_list', { contextRef }).status, 'VALID');
  const before = snapshot(path.join(f.workspace, 'knowledge'));
  const token = JSON.parse(Buffer.from(contextRef.slice(13), 'base64url'));
  const recordPath = path.join(f.workspace, '.mavt/mcp-contexts', token.id + '.json');
  const original = fs.readFileSync(recordPath, 'utf8');
  const record = JSON.parse(original); record.role = 'author'; fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(f.call('mavt_knowledge_list', { contextRef }).code, 'MAVT_MCP_CONTEXT_INVALID');
  fs.writeFileSync(recordPath, original);
  fs.appendFileSync(path.join(f.workspace, '.mavt/runtime-bundles', record.bundleId, 'runtime/mavt-knowledge-manager/scripts/lib/knowledge-store.js'), '\n// corrupted after warm load\n');
  assert.equal(f.call('mavt_knowledge_list', { contextRef }).code, 'MAVT_RUNTIME_BUNDLE_INVALID');
  assert.deepEqual(snapshot(path.join(f.workspace, 'knowledge')), before);
});
test('knowledge reads do not traverse accumulated evidence in unrelated Runs', t => {
  const f = fixture(t), contextRef = init(f, 'knowledge');
  const evidence = path.join(f.workspace, 'runs', 'unrelated', 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  for (let index = 0; index < 1000; index += 1) fs.writeFileSync(path.join(evidence, `${index}.json`), '{}');
  // A dangling link makes unwanted traversal observable without a noisy timing threshold.
  fs.symlinkSync(path.join(f.temp, 'missing'), path.join(evidence, 'historical-external-link'));
  const result = f.call('mavt_knowledge_list', { contextRef });
  assert.equal(result.status, 'VALID', JSON.stringify(result));
  assert.equal(result.entries.length, 0);
});
test('older managed bundle without MCP keeps its original CLI compatibility path', t => {
  const f = fixture(t), author = init(f, 'author');
  f.call('mavt_cases_import', { contextRef: author, request: draft });
  const older = buildPlugin({ outputRoot: path.join(f.temp, 'older') });
  fs.rmSync(path.join(older.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp'), { recursive: true });
  const { createManifest, pinBundle } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
  fs.writeFileSync(path.join(older.pluginRoot, 'bundle.manifest.json'), JSON.stringify(createManifest(older.pluginRoot, '0.1.0')));
  const pinned = pinBundle(older.pluginRoot, f.workspace);
  const oldService = require(path.join(pinned.runtimeRoot, 'scripts/coordinator/agent-facing-service'));
  const prepared = oldService.prepareRunBound({ operation: 'prepareRun', input: { caseNos: ['001'] } }, { workspace: f.workspace });
  const opened = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'coordinator', batchId: prepared.batchId });
  const before = snapshot(f.workspace);
  const result = f.call('mavt_run_advance', { contextRef: opened.contextRef, input: {} });
  assert.equal(result.code, 'MAVT_MCP_LEGACY_INTERFACE');
  assert.equal(result.command, prepared.response.result.command);
  assert.deepEqual(snapshot(f.workspace), before);
});
test('run resource scope mismatches and malformed inputs stay byte-readonly', t => {
  const f = fixture(t), author = init(f, 'author');
  f.call('mavt_cases_import', { contextRef: author, request: draft });
  const coordinator = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'coordinator' }).contextRef;
  const a = f.call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  const b = f.call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  const before = snapshot(f.workspace);
  assert.equal(f.call('mavt_run_read', { contextRef: b.contextRef, input: { ref: a.data.ref } }).code, 'RESOURCE_SCOPE_MISMATCH');
  assert.equal(f.call('mavt_run_status', { contextRef: coordinator }).code, 'MAVT_MCP_CONTEXT_INVALID');
  assert.equal(f.call('mavt_run_read', { contextRef: a.contextRef, input: { ref: a.data.ref, invalid: true } }).code, 'MAVT_MCP_INPUT_INVALID');
  assert.deepEqual(snapshot(f.workspace), before);
});
test('valid bound Run retains repeated invalid-input stop rule', t => {
  const f = fixture(t), author = init(f, 'author');
  f.call('mavt_cases_import', { contextRef: author, request: draft });
  const coordinator = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'coordinator' }).contextRef;
  const prepared = f.call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  const args = { contextRef: prepared.contextRef, input: { decision: 'SELECT_PLATFORM', platform: 'invalid' } };
  assert.equal(f.call('mavt_run_confirm', args).error?.code, 'COORDINATOR_INPUT_INVALID');
  assert.equal(f.call('mavt_run_confirm', args).error?.code, 'AGENT_INPUT_STALLED');
  const status = f.call('mavt_run_status', { contextRef: prepared.contextRef });
  assert.equal(status.phase, 'NEED_ENVIRONMENT_DECISION');
});
test('installed B schema divergence cannot reject or stall valid pinned A requests', t => {
  const f = fixture(t), author = init(f, 'author');
  f.call('mavt_cases_import', { contextRef: author, request: draft });
  const coordinator = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'coordinator' }).contextRef;
  const prepared = f.call('mavt_run_prepare', { contextRef: coordinator, input: { caseNos: ['001'] } });
  const knowledgeRef = f.call('mavt_workspace_open', { workspace: f.workspace, role: 'knowledge' }).contextRef;
  const b = buildPlugin({ outputRoot: path.join(f.temp, 'schema-B') });
  const contractPath = path.join(b.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp/contract.js');
  fs.appendFileSync(contractPath, `\n// B requires an argument that is forbidden by A.\nschemas.mavt_run_advance.properties.input.properties.bOnly = { type: 'boolean' };\nschemas.mavt_run_advance.properties.input.required = ['bOnly'];\nschemas.mavt_knowledge_list.properties.bOnly = { type: 'boolean' };\nschemas.mavt_knowledge_list.required.push('bOnly');\n`);
  const { createManifest } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
  fs.writeFileSync(path.join(b.pluginRoot, 'bundle.manifest.json'), JSON.stringify(createManifest(b.pluginRoot, '0.1.2')));
  const serverB = require(path.join(b.pluginRoot, 'scripts/mavt-mcp')).createServer({ pluginRoot: b.pluginRoot });
  const callB = (name, args) => serverB.callTool(name, args).structuredContent;
  assert.ok(serverB.listTools().find(tool => tool.name === 'mavt_run_advance').inputSchema.properties.input.required.includes('bOnly'));
  for (let index = 0; index < 2; index += 1) {
    const result = callB('mavt_run_advance', { contextRef: prepared.contextRef, input: {} });
    assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
    assert.equal(result.result.outcome, 'NEED_USER_CONFIRMATION');
  }
  const statePath = path.join(f.workspace, 'runs', prepared.batchId, 'coordinator-state.json');
  assert.equal(JSON.parse(fs.readFileSync(statePath)).lastInvalid, null, 'B validation must not increment A invalid-input counters');
  const before = snapshot(f.workspace);
  assert.equal(callB('mavt_knowledge_list', { contextRef: knowledgeRef }).status, 'VALID');
  assert.equal(callB('mavt_knowledge_list', { contextRef: knowledgeRef, bOnly: true }).code, 'MAVT_MCP_INPUT_INVALID', 'B-only accepted fields must be rejected by A before reading');
  assert.deepEqual(snapshot(f.workspace), before);
});

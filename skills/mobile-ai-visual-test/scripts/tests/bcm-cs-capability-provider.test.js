#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBcmCsProvider } = require('../case-runtime/capability-modules/modules/bcm-cs');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-operation-contract');
const { run } = require('../case-runtime/agent-facing-client');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-bcm-cs-provider-'));
const executable = path.join(root, 'fake-bcm-cs.js');
const log = path.join(root, 'argv.jsonl');
fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BCM_FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.length === 1 && args[0] === 'version') {
  process.stdout.write('bcm-cs version 0.1.1\\n');
} else if (args.join(' ') === '--output json capabilities list') {
  if (process.env.BCM_FAKE_403 === '1') {
    process.stderr.write('HTTP 403: forbidden token=server-secret\\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ result: { capabilities: [
      { id: 'get_user_id', availability: { status: 'available', available: true } },
      { id: 'query_package_terms', availability: { status: 'available', available: true } },
      { id: 'create_term_data', availability: { status: 'available', available: true } },
      { id: 'create_pre_live_room', availability: { status: 'api_ready', available: false } }
    ] }, upstream: { calls: [] } }) + '\\n');
  }
} else if (args.slice(0, 4).join(' ') === '--output json capabilities describe') {
  const id = args[4];
  const common = {
    id, status: 'implemented', availability: { status: 'available', available: true },
    implementation: { backend: true, cli: true, frontend: 'guide' },
    supports: { dry_run: false, confirm: false, json_output: true, raw_output: true, task: false },
    output: { summary_fields: [], sensitive_fields: ['phone_number'] }
  };
  const values = {
    get_user_id: { ...common, title: '查询用户 ID', description: '按手机号查询 BCM 绑定主用户 ID。',
      params: { env: { type: 'string', description: '固定 test 环境', default: 'test', enum: ['test'] },
        phone_number: { type: 'string', description: '手机号' },
        phone_numbers: { type: 'array', description: '批量手机号', items: { type: 'string' } } }, required: ['env'],
      rest: { execute: { method: 'POST', path: '/users/user-id' } } },
    query_package_terms: { ...common, title: '查询课包课期', description: '按课包 ID 查询课期列表。',
      params: { env: { type: 'string', default: 'test', enum: ['test'] },
        package_id: { type: 'integer', minimum: 1 }, page: { type: 'integer', default: 1, minimum: 1 } },
      required: ['env', 'package_id'], rest: { query: { method: 'GET', path: '/packages/{package_id}/terms' } } },
    create_term_data: { ...common, title: '创建课期数据', description: '创建测试课期、班级、排课和解锁计划。',
      params: { env: { type: 'string', default: 'test', enum: ['test'] }, package_id: { type: 'integer', minimum: 1 } },
      required: ['env', 'package_id'], rest: { preview: { method: 'POST', path: '/test-data/terms/preview' },
        execute: { method: 'POST', path: '/test-data/terms' } },
      supports: { dry_run: true, confirm: true, json_output: true, raw_output: true, task: false } }
  };
  process.stdout.write(JSON.stringify({ result: values[id], upstream: { calls: [] } }) + '\\n');
} else if (args[0] === '--output' && args[1] === 'json' && args[2] === 'api') {
  const body = JSON.parse(args[6]);
  if (body.phone_number === '16606020003') {
    process.stderr.write('HTTP 400: {"phone_number":"19900001111"} phone_number=16606020003 rejected for 16606020003\\n');
    process.exitCode = 1;
  } else if (body.phone_number === 'timeout') {
    process.stderr.write('request timeout after delivery\\n');
    process.exitCode = 124;
  } else if (args[4].endsWith('/preview')) {
    process.stdout.write(JSON.stringify({ result: { data: { preview_id: 'preview-1' } }, upstream: { calls: [] } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ success: true, result: { path: args[4], body } }) + '\\n');
  }
} else {
  process.stderr.write('unexpected args: ' + JSON.stringify(args) + '\\n');
  process.exitCode = 2;
}
`);
fs.chmodSync(executable, 0o755);

const context = { executionId: 'execution-bcm', processRunner: undefined };
const provider = createBcmCsProvider({ executable, env: { ...process.env, BCM_FAKE_LOG: log } });
const probe = provider.probe(context);
assert.strictEqual(probe.status, 'READY');
assert.match(probe.implementationVersion, /0\.1\.1/);
assert.ok(probe.discoverySeed);

const definitions = provider.listCapabilities(context, probe);
assert.deepStrictEqual(definitions.map((item) => item.name), ['get_user_id', 'query_package_terms', 'create_term_data']);
assert.strictEqual(definitions.diagnostics.length, 1);
assert.deepStrictEqual(definitions[0].invocation, {
  method: 'POST', path: '/api/v1/bcm-tools/users/user-id', capabilityId: 'get_user_id',
  pathParameters: [], confirmationRequired: false,
});
assert.deepStrictEqual(definitions[0].inputSchema.required, ['env']);
assert.strictEqual(definitions[0].inputSchema.properties.env.default, 'test');
assert.strictEqual(definitions[0].inputSchema.properties.env.description, '固定 test 环境');
assert.strictEqual(Object.hasOwn(definitions[0].inputSchema.properties.phone_number, 'sensitive'), false);
assert.deepStrictEqual(definitions[0].sensitiveFields, {
  input: ['phone_number', 'phone_numbers'], output: ['phone_number'],
});
assert.deepStrictEqual(definitions[1].invocation.pathParameters, ['package_id']);
assert.deepStrictEqual(definitions[2].invocation.preview, {
  method: 'POST', path: '/api/v1/bcm-tools/test-data/terms/preview', pathParameters: [],
});
assert.strictEqual(definitions[2].invocation.confirmationRequired, true);

const success = provider.invoke({ capability: definitions[0], input: { env: 'test', phone_number: '16606020001' } }, context);
assert.strictEqual(success.status, 'SUCCEEDED');
assert.deepStrictEqual(success.output.result.body, { env: 'test', phone_number: '16606020001' });
const query = provider.invoke({ capability: definitions[1], input: { env: 'test', package_id: 42, page: 2 } }, context);
assert.strictEqual(query.status, 'SUCCEEDED');
assert.strictEqual(query.output.result.path, '/api/v1/bcm-tools/packages/42/terms');
assert.deepStrictEqual(query.output.result.body, { env: 'test', page: 2 });
const mutation = provider.invoke({ capability: definitions[2], input: { env: 'test', package_id: 7 } }, context);
assert.strictEqual(mutation.status, 'SUCCEEDED');
assert.deepStrictEqual(mutation.output.result.body, {
  env: 'test', package_id: 7, confirm: true, preview_id: 'preview-1',
});
assert.strictEqual(provider.invoke({ capability: definitions[0], input: { env: 'test', phone_number: '16606020003' } }, context).status, 'FAILED');
assert.strictEqual(provider.invoke({ capability: definitions[0], input: { env: 'test', phone_number: 'timeout' } }, context).status, 'UNKNOWN');

const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
assert.strictEqual(calls.filter((args) => args.join(' ') === '--output json capabilities list').length, 1,
  'probe discoverySeed must prevent a second list call');
assert.strictEqual(calls.some((args) => args.includes('create_pre_live_room')), false,
  'capabilities explicitly marked unavailable must not be described or exposed');
const apiCall = calls.find((args) => args[2] === 'api' && args.includes('/api/v1/bcm-tools/users/user-id'));
assert.deepStrictEqual(apiCall.slice(0, 6), ['--output', 'json', 'api', 'POST', '/api/v1/bcm-tools/users/user-id', '--body']);
assert.deepStrictEqual(JSON.parse(apiCall[6]), { env: 'test', phone_number: '16606020001' });

const forbiddenProvider = createBcmCsProvider({
  executable,
  env: { ...process.env, BCM_FAKE_LOG: log, BCM_FAKE_403: '1' },
});
const unavailable = forbiddenProvider.probe(context);
assert.strictEqual(unavailable.status, 'UNAVAILABLE');
assert.strictEqual(unavailable.diagnostic, 'bcm-cs capability discovery unavailable');
assert.doesNotMatch(JSON.stringify(unavailable), /server-secret/);

const execDir = path.join(root, 'execution');
fs.mkdirSync(execDir, { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 14, runtime: 'case-runtime', executionId: 'execution-bcm', platform: 'harmony',
  targetBinding: { appId: 'com.example.test' }, lifecycle: 'RUNNING', finalized: false,
});
writeJsonAtomic(path.join(execDir, 'runtime.json'), {
  schemaVersion: 1, executionId: 'execution-bcm', status: 'READY', entry: path.join(execDir, 'agent-facing-client.js'),
  broker: { allowedOperations: AGENT_OPERATIONS },
});
const brokerOptions = { bcmCsExecutable: executable, capabilityProcessRunner: undefined,
  capabilityProviders: [provider], now: '2026-10-09T10:00:00.000Z' };
const catalog = run(execDir, { operation: 'queryCapabilities', input: {} }, brokerOptions);
assert.deepStrictEqual(catalog.data.content.available.map((item) => item.name), [
  'bcm-cs.create_term_data', 'bcm-cs.get_user_id', 'bcm-cs.query_package_terms',
]);
const getUser = catalog.data.content.available.find((item) => item.name === 'bcm-cs.get_user_id');
const invoked = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: getUser.capabilityRef, input: { env: 'test', phone_numbers: ['16606020002'] }, purpose: 'Prepare BCM users',
} }, brokerOptions);
assert.strictEqual(invoked.status, 'SUCCEEDED');
assert.strictEqual(invoked.result.capabilityName, 'bcm-cs.get_user_id');
assert.strictEqual(JSON.stringify(invoked.data.content).includes('16606020002'), false);
assert.strictEqual(invoked.data.content.input.phone_numbers, '[REDACTED]');
assert.strictEqual(invoked.data.content.output.result.body.phone_numbers, '[REDACTED]');

const failedInvocation = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: getUser.capabilityRef, input: { env: 'test', phone_number: '16606020003' }, purpose: 'Verify BCM failure',
} }, brokerOptions);
assert.strictEqual(failedInvocation.status, 'FAILED');
const persistedFailure = [
  fs.readFileSync(path.join(execDir, 'events.jsonl'), 'utf8'),
  ...failedInvocation.resources.map((resource) => JSON.stringify(
    require('../case-runtime/agent-resource-store').readPublishedResource(execDir, resource.ref).data.content,
  )),
].join('\n');
assert.doesNotMatch(persistedFailure, /16606020003|19900001111/);

console.log('bcm-cs capability provider tests passed');

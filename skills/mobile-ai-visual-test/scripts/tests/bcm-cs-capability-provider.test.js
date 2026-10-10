#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBcmCsProvider } = require('../case-runtime/capability-modules/modules/bcm-cs');
const { invocationResult } = require('../case-runtime/capability-modules/modules/bcm-cs/response-mapper');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-operation-contract');
const { run } = require('../case-runtime/agent-facing-client');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-bcm-cs-provider-'));
const executable = path.join(root, 'fake-bcm-cs.js');
const log = path.join(root, 'argv.jsonl');
const shellSideEffect = path.join(root, 'shell-side-effect');
fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
function readArg(name) {
  const equal = args.find((arg) => arg.startsWith(name + '='));
  if (equal) return equal.slice(equal.indexOf('=') + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}
fs.appendFileSync(process.env.BCM_FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.length === 1 && args[0] === 'version') {
  process.stdout.write('bcm-cs version 0.1.1\\n');
} else if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: bcm-cs <command> [options]\\nRun bcm-cs --help to show help.\\n');
} else if (args.join(' ') === 'capabilities list -o json') {
  process.stdout.write(JSON.stringify({ result: { capabilities: [
    { id: 'get_user_id', availability: { status: 'available', available: true } },
    { id: 'create_instant_live_room', availability: { status: 'available', available: true } }
  ] } }) + '\\n');
} else if (args.slice(0, 3).join(' ') === 'live instant create') {
  process.stdout.write(JSON.stringify({ success: true, result: {
    room_uuid: 'room-native-cli',
    student_phone: readArg('--student-phone'),
    argv: args,
  } }) + '\\n');
} else if (args[0] === 'fail') {
  const positionalPhones = args.find((arg) => /^1\\d{10}(?:,1\\d{10})+$/.test(arg));
  const phoneValue = readArg('--student-phones') || readArg('--student-phone') || positionalPhones || 'missing';
  const token = readArg('--token') || 'missing';
  const echoedPhones = phoneValue.split(',').map((value) => 'phone=' + value).join(' ');
  process.stderr.write('HTTP 400 token=' + token + ' rejected ' + echoedPhones + '\\n');
  process.exitCode = 3;
} else if (args[0] === 'timeout') {
  process.stderr.write('request timeout after delivery\\n');
  process.exitCode = 124;
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
assert.strictEqual(probe.discoverySeed, null);

const definitions = provider.listCapabilities(context, probe);
assert.deepStrictEqual(definitions.map((item) => item.name), ['cli']);
assert.match(definitions[0].summary, /bcm-cs.*CLI/i);
assert.deepStrictEqual(definitions[0].inputSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    args: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      description: 'Arguments passed after bcm-cs. Use --help and command-level help to discover native commands.',
    },
  },
  required: ['args'],
});
assert.deepStrictEqual(definitions[0].sensitiveFields, { input: ['args'], output: [] });
assert.deepStrictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [['version']],
  'discovery must not call BCM business list/describe APIs');

const help = provider.invoke({ capability: definitions[0], input: { args: ['--help'] } }, context);
assert.strictEqual(help.status, 'SUCCEEDED');
assert.match(help.output, /^Usage: bcm-cs/);

const listed = provider.invoke({ capability: definitions[0], input: {
  args: ['capabilities', 'list', '-o', 'json'],
} }, context);
assert.strictEqual(listed.status, 'SUCCEEDED');
assert.deepStrictEqual(listed.output.result.capabilities.map((item) => item.id), [
  'get_user_id', 'create_instant_live_room',
]);

const phone = '13223222360';
const otherPhone = '13323222361';
const suspiciousRoomName = `room; touch ${shellSideEffect}`;
const createArgs = [
  'live', 'instant', 'create', `--student-phone=${phone}`, '--room-name', suspiciousRoomName, '-o', 'json',
];
const created = provider.invoke({ capability: definitions[0], input: { args: createArgs } }, context);
assert.strictEqual(created.status, 'SUCCEEDED');
assert.strictEqual(created.output.result.room_uuid, 'room-native-cli');
assert.deepStrictEqual(created.output.result.argv, createArgs);
assert.strictEqual(fs.existsSync(shellSideEffect), false, 'argv must never be interpreted by a shell');

const failed = provider.invoke({ capability: definitions[0], input: {
  args: ['fail', `--student-phone=${phone}`, '--token=server-secret'],
} }, context);
assert.strictEqual(failed.status, 'FAILED');
assert.match(failed.diagnostic, /HTTP 400/);
const unknown = provider.invoke({ capability: definitions[0], input: { args: ['timeout'] } }, context);
assert.strictEqual(unknown.status, 'UNKNOWN');
assert.strictEqual(invocationResult({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }, 'cli').status, 'UNKNOWN');
assert.strictEqual(invocationResult({
  status: 2, signal: null, stdout: '', stderr: 'unknown flag: --timeout',
}, 'cli').status, 'FAILED');
assert.strictEqual(invocationResult({
  status: 2, signal: null, stdout: '', stderr: 'invalid timeout value',
}, 'cli').status, 'FAILED');

const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
assert.deepStrictEqual(calls.slice(1), [
  ['--help'],
  ['capabilities', 'list', '-o', 'json'],
  createArgs,
  ['fail', `--student-phone=${phone}`, '--token=server-secret'],
  ['timeout'],
]);
assert.strictEqual(calls.some((args) => args.includes('api') || args.includes('--body')), false,
  'provider must not translate native commands to BCM REST calls');

const unavailable = createBcmCsProvider({ executable: path.join(root, 'missing-bcm-cs') }).probe(context);
assert.strictEqual(unavailable.status, 'UNAVAILABLE');
assert.strictEqual(unavailable.diagnostic, 'bcm-cs executable unavailable');
assert.doesNotMatch(JSON.stringify(unavailable), /ENOENT|missing-bcm-cs/);

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
const brokerOptions = {
  bcmCsExecutable: executable,
  capabilityProviders: [provider],
  now: '2026-10-09T10:00:00.000Z',
};
const catalog = run(execDir, { operation: 'queryCapabilities', input: {} }, brokerOptions);
assert.deepStrictEqual(catalog.data.content.available.map((item) => item.name), ['bcm-cs.cli']);
const cli = catalog.data.content.available[0];
const brokerHelp = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: cli.capabilityRef,
  input: { args: ['--help'] },
  purpose: 'Read native bcm-cs help',
} }, brokerOptions);
assert.strictEqual(brokerHelp.status, 'SUCCEEDED');
assert.deepStrictEqual(brokerHelp.data.content.input, { args: ['--help'] });
assert.match(brokerHelp.data.content.output, /bcm-cs --help/);
const invoked = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: cli.capabilityRef,
  input: { args: createArgs },
  purpose: 'Create an instant live room through native bcm-cs',
} }, brokerOptions);
assert.strictEqual(invoked.status, 'SUCCEEDED');
assert.strictEqual(invoked.result.capabilityName, 'bcm-cs.cli');
assert.deepStrictEqual(invoked.data.content.input, { args: [
  'live', 'instant', 'create', '--student-phone=[REDACTED]', '--room-name', suspiciousRoomName, '-o', 'json',
] });
assert.strictEqual(invoked.data.content.output.result.room_uuid, 'room-native-cli');
assert.strictEqual(JSON.stringify(invoked.data.content).includes(phone), false);

const failedInvocation = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: cli.capabilityRef,
  input: { args: ['fail', `--student-phones=${phone},${otherPhone}`, '--token', 'server-secret'] },
  purpose: 'Verify BCM failure handling',
} }, brokerOptions);
assert.strictEqual(failedInvocation.status, 'FAILED');
const failedResources = failedInvocation.resources.map((resource) => (
  require('../case-runtime/agent-resource-store').readPublishedResource(execDir, resource.ref).data.content
));
const failedRecord = failedResources.find((content) => content.type === 'capabilityInvocation');
assert.deepStrictEqual(failedRecord.input, { args: [
  'fail', '--student-phones=[REDACTED]', '--token', '[REDACTED]',
] });
const persistedFailure = [
  fs.readFileSync(path.join(execDir, 'events.jsonl'), 'utf8'),
  ...failedResources.map(JSON.stringify),
].join('\n');
assert.doesNotMatch(persistedFailure, /13223222360|13323222361|server-secret/);

const positionalFailure = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: cli.capabilityRef,
  input: { args: ['fail', `${phone},${otherPhone}`, '--token=server-secret'] },
  purpose: 'Verify positional BCM argument redaction',
} }, brokerOptions);
assert.strictEqual(positionalFailure.status, 'FAILED');
const positionalResources = positionalFailure.resources.map((resource) => (
  require('../case-runtime/agent-resource-store').readPublishedResource(execDir, resource.ref).data.content
));
const positionalRecord = positionalResources.find((content) => content.type === 'capabilityInvocation');
assert.deepStrictEqual(positionalRecord.input, { args: [
  'fail', '[REDACTED]', '--token=[REDACTED]',
] });
assert.doesNotMatch(JSON.stringify(positionalResources), /13223222360|13323222361|server-secret/);

console.log('bcm-cs capability provider tests passed');

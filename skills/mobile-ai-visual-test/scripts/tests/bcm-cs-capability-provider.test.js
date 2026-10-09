#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBcmCsProvider } = require('../case-runtime/capability-modules/modules/bcm-cs');

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
    process.stdout.write(JSON.stringify({ capabilities: [{ id: 'student.update' }, { id: 'broken.item' }] }) + '\\n');
  }
} else if (args.slice(0, 4).join(' ') === '--output json capabilities describe') {
  const id = args[4];
  const value = id === 'student.update' ? {
    capability: {
      id,
      summary: 'Update one student',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: { studentId: { type: 'string', minLength: 1 } }, required: ['studentId'],
      },
      invocation: { method: 'POST', path: '/api/v1/bcm-tools/students/update' },
    },
  } : { capability: { id, summary: 'Broken item', input_schema: { type: 'string' } } };
  process.stdout.write(JSON.stringify(value) + '\\n');
} else if (args[0] === '--output' && args[1] === 'json' && args[2] === 'api') {
  const body = JSON.parse(args[6]);
  if (body.studentId === 'failed') {
    process.stderr.write('HTTP 400: rejected\\n');
    process.exitCode = 1;
  } else if (body.studentId === 'timeout') {
    process.stderr.write('request timeout after delivery\\n');
    process.exitCode = 124;
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { studentId: body.studentId } }) + '\\n');
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
assert.deepStrictEqual(definitions.map((item) => item.name), ['student.update']);
assert.strictEqual(definitions.diagnostics.length, 1);
assert.deepStrictEqual(definitions[0].invocation, {
  method: 'POST', path: '/api/v1/bcm-tools/students/update', capabilityId: 'student.update',
});

const success = provider.invoke({ capability: definitions[0], input: { studentId: '42' } }, context);
assert.deepStrictEqual(success, {
  status: 'SUCCEEDED', summary: 'BCM capability student.update completed',
  output: { success: true, data: { studentId: '42' } }, diagnostic: null,
});
assert.strictEqual(provider.invoke({ capability: definitions[0], input: { studentId: 'failed' } }, context).status, 'FAILED');
assert.strictEqual(provider.invoke({ capability: definitions[0], input: { studentId: 'timeout' } }, context).status, 'UNKNOWN');

const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
assert.strictEqual(calls.filter((args) => args.join(' ') === '--output json capabilities list').length, 1,
  'probe discoverySeed must prevent a second list call');
assert.deepStrictEqual(calls.find((args) => args.includes('api') && args.includes('42')), undefined);
const apiCall = calls.find((args) => args[2] === 'api' && args.includes('/api/v1/bcm-tools/students/update'));
assert.deepStrictEqual(apiCall.slice(0, 6), ['--output', 'json', 'api', 'POST', '/api/v1/bcm-tools/students/update', '--body']);
assert.deepStrictEqual(JSON.parse(apiCall[6]), { studentId: '42' });

const forbiddenProvider = createBcmCsProvider({
  executable,
  env: { ...process.env, BCM_FAKE_LOG: log, BCM_FAKE_403: '1' },
});
const unavailable = forbiddenProvider.probe(context);
assert.strictEqual(unavailable.status, 'UNAVAILABLE');
assert.strictEqual(unavailable.diagnostic, 'bcm-cs capability discovery unavailable');
assert.doesNotMatch(JSON.stringify(unavailable), /server-secret/);

console.log('bcm-cs capability provider tests passed');

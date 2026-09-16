'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const caseContract = require('../case-runtime/agent-facing-contract');
const coordinatorContract = require('../coordinator/agent-facing-contract');
const currentExecution = require('../lib/readers/current-execution');
const { parseRequest } = require('../case-runtime/agent-facing-client');

assert.strictEqual(caseContract.AGENT_FACING_PROTOCOL, 'agent-facing');
assert.strictEqual(coordinatorContract.AGENT_FACING_PROTOCOL, 'agent-facing');
assert.strictEqual(currentExecution.SCHEMA_VERSION, 12);
assert.deepStrictEqual(Object.keys(currentExecution).sort(), ['READER_FAMILY', 'SCHEMA_VERSION', 'assertSchema', 'supports']);

for (const name of ['capabilityCards', 'finishTemplate', 'projectActions']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(caseContract, name), false, `${name} must not be public`);
}
assert.strictEqual(Object.prototype.hasOwnProperty.call(coordinatorContract, 'capabilityCards'), false);
assert.ok(caseContract.validateAgentFacingRequest({
  capability: 'inspect', basedOnSceneRef: 'scene-1', channel: 'capabilities',
}).length > 0, 'capabilities inspect must not exist');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-single-contract-'));
const requestPath = path.join(temp, 'request.json');
fs.writeFileSync(requestPath, JSON.stringify({ capability: 'observe' }));
assert.throws(() => parseRequest([], '', requestPath), /stdin/i);
fs.rmSync(temp, { recursive: true, force: true });

assert.strictEqual(fs.existsSync(path.join(root, 'scripts/case-runtime/runtime-client.js')), false);
for (const relative of [
  'scripts/case-runtime/agent-facing-client.js',
  'scripts/case-runtime/lifecycle.js',
  'scripts/case-runtime/runtime-broker.js',
  'scripts/coordinator/agent-facing-contract.js',
  'scripts/workspace.js',
  'scripts/build-agent-contract.js',
]) {
  assert.doesNotMatch(read(relative), /capabilityCards|compatibilityMode/, `${relative} retains a parallel contract path`);
}

for (const relative of [
  'scripts/batch/completion.js',
  'scripts/batch/completion-service.js',
  'scripts/batch/dispatch-service.js',
  'scripts/batch/reconcile-service.js',
  'scripts/case-runtime/store.js',
  'scripts/case-runtime/result-integrity.js',
  'scripts/execution/contracts/validation-profile-contract.js',
  'scripts/lib/completion-contract.js',
  'scripts/lib/execution-artifact-manifest.js',
  'scripts/lib/execution-closure.js',
  'scripts/lib/execution-evidence-graph.js',
  'scripts/lib/execution-lifecycle.js',
  'scripts/lib/readers/current-execution.js',
]) {
  assert.doesNotMatch(read(relative), /\[11,\s*12\]|11,\s*12/, `${relative} must accept only the current execution schema`);
}

console.log('agent-facing single contract passed');

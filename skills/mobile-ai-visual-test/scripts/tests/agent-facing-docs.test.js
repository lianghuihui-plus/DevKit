'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PUBLIC_CONTRACT: caseContract } = require('../case-runtime/agent-facing-contract');
const { PUBLIC_CONTRACT: coordinatorContract } = require('../coordinator/agent-facing-contract');
const { buildDocs, outputFiles } = require('../build-agent-facing-docs');

const root = path.resolve(__dirname, '../..');
const requiredMethodFields = [
  'name', 'summary', 'requestSchema', 'parameterDescriptions',
  'conditionalRequirements', 'contextualValidationRules', 'successStatuses',
  'errorCodes', 'sideEffects', 'idempotency', 'minimalExample',
].sort();

function assertContract(contract, expectedMethods) {
  assert.strictEqual(contract.protocol, 'agent-facing');
  assert.deepStrictEqual(Object.keys(contract.methods), expectedMethods);
  for (const method of Object.values(contract.methods)) {
    assert.deepStrictEqual(Object.keys(method).sort(), requiredMethodFields);
    assert.ok(method.name && method.summary && method.requestSchema);
    assert.ok(Object.keys(method.parameterDescriptions).length > 0);
    for (const code of method.errorCodes) assert.ok(contract.errors[code], `${method.name} unknown error ${code}`);
  }
}

assertContract(caseContract, ['observe', 'inspect', 'plan', 'recordResult', 'act', 'knowledge', 'recover', 'finish']);
assertContract(coordinatorContract, ['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun']);
assert.deepStrictEqual(caseContract.methods.observe.successStatuses, ['SCENE']);
assert.deepStrictEqual(caseContract.methods.act.successStatuses, ['SCENE']);
assert.deepStrictEqual(caseContract.methods.recover.successStatuses, ['SCENE', 'EXTERNAL_ACTION_RECORDED']);
buildDocs({ root, check: true });

const files = outputFiles({ root });
for (const relative of [
  'references/case-runtime.md',
  'references/case-runtime/action-refs.md',
  'references/case-runtime/errors.md',
  'references/coordinator.md',
  'references/coordinator/errors.md',
]) assert.ok(files.has(relative), `missing generated output ${relative}`);

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const caseIndex = read('references/case-runtime.md');
const coordinatorIndex = read('references/coordinator.md');
assert.ok(Buffer.byteLength(caseIndex) <= 6 * 1024);
assert.ok(caseIndex.split('\n').length <= 160);
assert.ok(Buffer.byteLength(coordinatorIndex) <= 4 * 1024);
assert.ok(coordinatorIndex.split('\n').length <= 120);
assert.match(read('references/case-runtime/errors.md'), /<a id="error-action-not-available"><\/a>/);
assert.match(read('references/coordinator/errors.md'), /<a id="error-environment-not-ready"><\/a>/);
assert.doesNotMatch(caseIndex, /retryWith|nextCall|capability cards/i);

console.log('agent-facing generated docs passed');

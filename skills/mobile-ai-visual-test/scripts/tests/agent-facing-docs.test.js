'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PUBLIC_CONTRACT: caseContract,
  documentationRefFor: caseDocumentationRefFor,
} = require('../case-runtime/agent-facing-contract');
const {
  PUBLIC_CONTRACT: coordinatorContract,
  documentationRefFor: coordinatorDocumentationRefFor,
} = require('../coordinator/agent-facing-contract');
const { roleResources } = require('../lib/agent-contract-manifest');
const {
  INTERFACE_CONTRACTS,
  coordinatorCliErrorResponse,
  coordinatorContractError,
} = require('../lib/coordinator-interface-contract');
const { assertLinks, buildDocs, outputFiles } = require('../build-agent-facing-docs');
const { projectAgentFacingError } = require('../case-runtime/agent-facing-translator');
const { errorResponse } = require('../coordinator-agent');
for (const operation of ['recordResult', 'runPlan']) {
  const value = projectAgentFacingError({ status: 'REQUEST_INVALID', code: 'AGENT_INPUT_INVALID', issues: [] }, { operation, input: {} });
  assert.strictEqual(value.error.operationDocumentationRef, `references/case-runtime/methods/${operation.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}.md`);
}
assert.strictEqual(projectAgentFacingError({ status: 'TECHNICAL', code: 'CASE_RUNTIME_TECHNICAL' }, { operation: 'act', input: {} }).error.operationDocumentationRef, undefined);
assert.strictEqual(errorResponse({ code: 'COORDINATOR_TECHNICAL' }, 'advanceRun').error.operationDocumentationRef, undefined);
assert.strictEqual(errorResponse({ code: 'COORDINATOR_INPUT_INVALID' }, 'missing').error.operationDocumentationRef, undefined);
assert.match(errorResponse({ code: 'COORDINATOR_INPUT_INVALID' }, 'confirmRun').error.operationDocumentationRef, /confirm-run.md$/);
for (const [contractModule, operation] of [[require('../case-runtime/agent-facing-contract'), 'act'], [require('../coordinator/agent-facing-contract'), 'confirmRun']]) {
  const validate = contractModule.validateAgentFacingRequest || contractModule.validateCoordinatorRequest;
  const issues = validate({ operation, input: {} });
  const error = operation === 'act'
    ? projectAgentFacingError({ status: 'REJECTED', code: 'AGENT_INPUT_INVALID', issues }, { operation, input: {} }).error
    : errorResponse({ code: 'COORDINATOR_INPUT_INVALID', issues }, operation).error;
  assert.ok(error.issues.some((issue) => issue.field && issue.code && issue.expected));
  assert.ok(error.documentationRef && error.operationDocumentationRef);
}

const root = path.resolve(__dirname, '../..');
assert.strictEqual(caseContract.methods.runPlan.inputSchema.properties.steps.items,
  require('../case-runtime/plan-contract').PLAN_STEP_SCHEMA);
assert.strictEqual(caseContract.methods.runPlan.inputSchema.properties.steps.items.oneOf.length, 6);
const requiredMethodFields = [
  'name', 'summary', 'requestSchema', 'inputSchema', 'responseProjection', 'parameterDescriptions',
  'conditionalRequirements', 'contextualValidationRules', 'successStatuses',
  'errorCodes', 'sideEffects', 'idempotency', 'minimalExample', 'minimalExamples',
].sort();

function assertContract(contract, expectedMethods) {
  assert.strictEqual(contract.protocol, 'agent-facing');
  assert.deepStrictEqual(Object.keys(contract.methods), expectedMethods);
  for (const method of Object.values(contract.methods)) {
    assert.deepStrictEqual(Object.keys(method).sort(), requiredMethodFields);
    assert.ok(method.name && method.summary && method.requestSchema);
    for (const example of method.minimalExamples) {
      assert.deepStrictEqual(require('../lib/agent-json-contract').validateAgentJson(example, method.requestSchema), [], `${method.name} invalid generated example`);
    }
    const branches = method.inputSchema.oneOf || [method.inputSchema];
    for (const branch of branches) {
      const discriminator = branch.properties?.mode ? 'mode' : branch.properties?.decision ? 'decision' : null;
      if (discriminator) assert.ok(method.minimalExamples.some((example) => example.input[discriminator] === branch.properties[discriminator].const));
    }
    assert.ok(Object.keys(method.parameterDescriptions).length > 0 || Object.keys(method.inputSchema.properties || {}).length === 0);
    for (const code of method.errorCodes) assert.ok(contract.errors[code], `${method.name} unknown error ${code}`);
  }
  for (const [code, definition] of Object.entries(contract.errors)) {
    assert.strictEqual(typeof definition.retryable, 'boolean', `${code} must declare retryable`);
    assert.ok(definition.summary, `${code} must declare summary`);
    assert.ok(definition.recovery, `${code} must declare targeted recovery`);
  }
}

assertContract(caseContract, ['observe', 'read', 'inspect', 'plan', 'recordResult', 'act', 'runPlan', 'knowledge', 'recover', 'finish']);
assertContract(coordinatorContract, ['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun', 'read']);
for (const contract of [caseContract, coordinatorContract]) {
  for (const method of Object.values(contract.methods)) assert.deepStrictEqual(method.successStatuses, ['SUCCEEDED']);
  assert.ok(contract.resourceCatalog);
}
buildDocs({ root, check: true });

const files = outputFiles({ root });
for (const [relative, content] of files) {
  if (!relative.includes('/methods/')) continue;
  for (const [, source] of content.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const request = JSON.parse(source);
    const contract = relative.startsWith('references/coordinator/') ? coordinatorContract : caseContract;
    assert.deepStrictEqual(require('../lib/agent-json-contract').validateAgentJson(request, contract.requestSchema), []);
  }
}
for (const relative of [
  'references/commands.md',
  'references/commands/workspace.md',
  'references/commands/authoring.md',
  'references/commands/environment.md',
  'references/commands/app-artifact.md',
  'references/commands/execution.md',
  'references/commands/reporting.md',
  'references/commands/protocol-maintenance.md',
  'references/commands/transports.md',
  'references/case-runtime.md',
  'references/case-runtime/resources.md',
  'references/case-runtime/methods/read.md',
  'references/case-runtime/action-refs.md',
  'references/case-runtime/errors.md',
  'references/case-runtime/errors/scene-action.md',
  'references/coordinator.md',
  'references/coordinator/resources.md',
  'references/coordinator/methods/read.md',
  'references/coordinator/errors.md',
  'references/coordinator/errors/environment.md',
]) assert.ok(files.has(relative), `missing generated output ${relative}`);
assert.strictEqual(files.has('references/commands/knowledge.md'), false);
assert.strictEqual(files.has('references/commands/errors/knowledge.md'), false);
assert.strictEqual(fs.existsSync(path.join(root, 'references/commands/knowledge.md')), false);
assert.strictEqual(fs.existsSync(path.join(root, 'references/commands/errors/knowledge.md')), false);

for (const [entrypoint, definition] of Object.entries(INTERFACE_CONTRACTS)) {
  assert.ok(definition.module, `${entrypoint} must declare module`);
  assert.ok(['DIRECT', 'ON_DEMAND', 'PREBOUND'].includes(definition.access), `${entrypoint} must declare access`);
  assert.ok(Array.isArray(definition.roles) && definition.roles.length, `${entrypoint} must declare roles`);
  for (const command of definition.commands) {
    assert.match(command.usage, /<skill-root>/, `${entrypoint} usage must be cwd independent`);
    assert.ok(command.documentationRef, `${entrypoint} command must have documentationRef`);
  }
}

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const caseIndex = read('references/case-runtime.md');
const coordinatorIndex = read('references/coordinator.md');
const confirmRunPage = read('references/coordinator/methods/confirm-run.md');
assert.ok(Buffer.byteLength(caseIndex) <= 6 * 1024);
assert.ok(caseIndex.split('\n').length <= 160);
assert.ok(Buffer.byteLength(coordinatorIndex) <= 4 * 1024);
assert.ok(coordinatorIndex.split('\n').length <= 120);
assert.match(read('references/case-runtime/errors.md'), /<a id="error-action-not-available"><\/a>/);
assert.match(read('references/coordinator/errors.md'), /<a id="error-environment-not-ready"><\/a>/);
assert.doesNotMatch(caseIndex, /retryWith|nextCall|capability cards/i);
assert.ok(Buffer.byteLength(read('references/commands.md')) <= 4 * 1024);
assert.doesNotMatch(read('references/commands.md'), /--workspace|--batch-id/);
assert.doesNotMatch(read('references/commands.md'), /commands\/knowledge\.md/);
assert.match(read('references/commands/execution.md'), /<skill-root>\/scripts\/batch\.js/);
assert.match(confirmRunPage, /decision: "USE_CURRENT"/);
assert.match(confirmRunPage, /decision: "SELECT_PLATFORM"/);
assert.match(confirmRunPage, /decision: "CONFIRM_BINDING"/);
assert.match(confirmRunPage, /## 调用分支/);
assert.match(confirmRunPage, /userInstruction.*用户/);
for (const [role, directory] of [['case-executor', 'case-runtime'], ['batch-coordinator', 'coordinator']]) {
  assert.ok(roleResources(role).includes(`references/${directory}/resources.md`));
  assert.ok(roleResources(role).includes(`references/${directory}/methods/read.md`));
  const index = read(`references/${directory}.md`);
  assert.match(index, /operation.*input/);
  assert.match(index, /data.*resources/);
  assert.match(index, /read/);
  assert.doesNotMatch(index, /requestPath|commands\.confirm/);
}
assert.match(read('references/commands/execution.md'), /--targets-json '\[{"caseNo":"004"}\]'/);
assert.match(read('references/commands/execution.md'), /--workspace '<workspace>'/);
assert.match(read('references/commands/transports.md'), /原样执行/);
assert.match(read('references/commands/transports.md'), /prepareCommand/);
assert.throws(() => assertLinks(root, new Map([
  ['references/source.md', '[missing](target.md#missing-anchor)'],
  ['references/target.md', '# Present'],
])), /broken anchor/);
assert.strictEqual(caseDocumentationRefFor('ACTION_NOT_AVAILABLE'), 'references/case-runtime/errors/scene-action.md#error-action-not-available');
assert.strictEqual(coordinatorDocumentationRefFor('ENVIRONMENT_NOT_READY'), 'references/coordinator/errors/environment.md#error-environment-not-ready');
assert.ok(roleResources('case-executor').includes('references/case-runtime/errors/scene-action.md'));
assert.ok(roleResources('batch-coordinator').includes('references/coordinator/errors/environment.md'));

const inputResponse = coordinatorCliErrorResponse(
  coordinatorContractError('unknown option: --workspcae'),
  'scripts/batch.js',
  'status',
);
assert.strictEqual(inputResponse.status, 'REQUEST_INVALID');
assert.match(inputResponse.documentationRef, /references\/commands\/execution\.md#batch-status$/);

const domainError = new Error('cached artifact metadata conflicts');
domainError.code = 'APP_INSTALL_ARTIFACT_CONFLICT';
domainError.errorKind = 'DOMAIN';
const domainResponse = coordinatorCliErrorResponse(domainError, 'scripts/app-artifact.js', 'register');
assert.strictEqual(domainResponse.status, 'FAILED');
assert.strictEqual(domainResponse.code, 'APP_INSTALL_ARTIFACT_CONFLICT');
assert.match(domainResponse.documentationRef, /references\/commands\/errors\/app-artifact\.md#domain$/);

const implementationMismatch = new Error('batch belongs to a different runtimeSha');
implementationMismatch.code = 'BATCH_IMPLEMENTATION_MISMATCH';
implementationMismatch.errorKind = 'DOMAIN';
const implementationMismatchResponse = coordinatorCliErrorResponse(implementationMismatch, 'scripts/batch.js', 'reconcile');
assert.strictEqual(implementationMismatchResponse.retryable, false);
assert.match(implementationMismatchResponse.documentationRef, /references\/commands\/errors\/execution\.md#error-batch-implementation-mismatch$/);
assert.match(read('references/commands/errors/execution.md'), /## BATCH_IMPLEMENTATION_MISMATCH/);

const technicalResponse = coordinatorCliErrorResponse(new Error('unexpected disk failure'), 'scripts/batch.js', 'status');
assert.strictEqual(technicalResponse.status, 'TECHNICAL');
assert.match(technicalResponse.documentationRef, /references\/commands\/errors\/execution\.md#technical$/);
const systemError = new Error('missing file');
systemError.code = 'ENOENT';
assert.strictEqual(coordinatorCliErrorResponse(systemError, 'scripts/batch.js', 'status').status, 'TECHNICAL');

console.log('agent-facing generated docs passed');

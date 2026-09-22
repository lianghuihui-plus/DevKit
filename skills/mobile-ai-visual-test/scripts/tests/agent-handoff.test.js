#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { canonicalJson } = require('../lib/contract-utils');
const { loaderErrorResponse } = require('../case-agent-bootstrap');
const { createAgentHandoff, loadAgentHandoff, loadPreparedAgentHandoff } = require('../batch/agent-handoff');
const { assertActiveDispatch, claimDispatch, claimTokenFor } = require('../lib/dispatch-lease');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-handoff-'));
const loaderInputError = new Error('unknown option');
loaderInputError.errorKind = 'INPUT';
loaderInputError.issues = [{ fieldPath: 'unknown', code: 'UNKNOWN_ARGUMENT', expected: '--workspace' }];
const loaderInputResponse = loaderErrorResponse(loaderInputError);
assert.strictEqual(loaderInputResponse.status, 'REJECTED');
assert.match(loaderInputResponse.error.documentationRef, /errors\/transport\.md#error-agent-input-invalid$/);
const loaderBindingError = new Error('handoff digest mismatch');
loaderBindingError.code = 'HANDOFF_INTEGRITY_INVALID';
const loaderBindingResponse = loaderErrorResponse(loaderBindingError);
assert.strictEqual(loaderBindingResponse.status, 'REJECTED');
assert.strictEqual(loaderBindingResponse.error.code, 'BINDING_INVALID');
assert.match(loaderBindingResponse.error.documentationRef, /errors\/transport\.md#error-binding-invalid$/);
const common = {
  workspaceRoot,
  batchId: 'batch-20260910',
  executionId: 'exec-20260910-001',
  caseProtocolSha: 'agent-protocol-0123456789abcdef',
  casePrompt: 'Frozen Case Agent prompt',
  brief: { caseKey: 'ck-001', expectations: [{ id: 'E1', text: '目标内容可见' }] },
  now: '2026-09-10T08:00:00.000Z',
};
const boundExecutionDir = path.join(workspaceRoot, 'cases', 'case-001', 'platforms', 'harmony', 'executions', common.executionId);
fs.mkdirSync(boundExecutionDir, { recursive: true });
fs.writeFileSync(path.join(boundExecutionDir, 'execution.json'), JSON.stringify({
  schemaVersion: 14, runtime: 'case-runtime', executionId: common.executionId, batchId: common.batchId, finalized: false,
}));

try {
  const retryExecutionId = 'exec-preparation-retry';
  const retryExecDir = path.join(workspaceRoot, 'cases', 'case-retry', 'platforms', 'harmony', 'executions', retryExecutionId);
  fs.mkdirSync(retryExecDir, { recursive: true });
  fs.writeFileSync(path.join(retryExecDir, 'execution.json'), JSON.stringify({
    schemaVersion: 14, runtime: 'case-runtime', executionId: retryExecutionId, batchId: common.batchId, platform: 'harmony', finalized: false,
  }));
  const resourceStore = require('../case-runtime/agent-resource-store');
  const retryHandoff = createAgentHandoff({ ...common, executionId: retryExecutionId,
    brief: { sceneRef: resourceStore.resourceRef(retryExecDir, 'scene', 'scene-retry') } });
  const failedPreparation = spawnSync('/bin/sh', ['-c', retryHandoff.loaderCommand], { encoding: 'utf8' });
  assert.notStrictEqual(failedPreparation.status, 0);
  const retryStatePath = path.join(path.dirname(retryHandoff.path), 'dispatch-state.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(retryStatePath, 'utf8')).dispatches[retryHandoff.handoffId].status, 'PREPARED',
    'a Brief preparation failure must not consume the dispatch');
  require('../case-runtime/store').writeScene(retryExecDir, { sceneId: 'scene-retry', elements: [], capturedAt: common.now, generation: 1 });
  resourceStore.publishScene(retryExecDir, 'scene-retry');
  const successfulRetry = spawnSync('/bin/sh', ['-c', retryHandoff.loaderCommand], { encoding: 'utf8' });
  assert.strictEqual(successfulRetry.status, 0, successfulRetry.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(retryStatePath, 'utf8')).dispatches[retryHandoff.handoffId].status, 'CONSUMED');
  assert.strictEqual(resourceStore.readPublishedResource(retryExecDir, JSON.parse(successfulRetry.stdout).data.ref).data.type, 'caseBrief');

  const initial = createAgentHandoff(common);
  assert.deepStrictEqual(Object.keys(initial).sort(), ['handoffId', 'loaderCommand', 'path', 'schemaVersion', 'sha256']);
  assert.strictEqual(initial.schemaVersion, 1);
  assert.match(initial.handoffId, /^handoff-[a-f0-9]{16}$/);
  assert.ok(path.isAbsolute(initial.path));
  assert.strictEqual(initial.path.startsWith(path.join(fs.realpathSync(workspaceRoot), 'runs', common.batchId, 'handoffs', common.executionId) + path.sep), true);
  assert.match(path.basename(initial.path), /^1-[a-f0-9]{64}\.json$/);
  assert.strictEqual(initial.loaderCommand.includes(common.casePrompt), false);
  assert.strictEqual(initial.loaderCommand.includes(JSON.stringify(common.brief)), false);
  for (const option of ['--workspace', '--handoff', '--sha256', '--execution-id', '--case-protocol-sha', '--claim-token']) {
    assert.strictEqual(initial.loaderCommand.includes(option), true, `loaderCommand must include ${option}`);
  }
  assert.strictEqual(fs.statSync(initial.path).mode & 0o777, 0o600);

  const persistedBefore = fs.readFileSync(initial.path, 'utf8');
  const reused = createAgentHandoff(common);
  assert.deepStrictEqual(reused, initial);
  assert.strictEqual(fs.readFileSync(initial.path, 'utf8'), persistedBefore);

  const dispatchStatePath = path.join(path.dirname(initial.path), 'dispatch-state.json');
  fs.unlinkSync(dispatchStatePath);
  const recoveredDispatch = createAgentHandoff(common);
  assert.deepStrictEqual(recoveredDispatch, initial);
  assert.strictEqual(JSON.parse(fs.readFileSync(dispatchStatePath, 'utf8')).dispatches[initial.handoffId].status, 'PREPARED');

  const retried = createAgentHandoff({
    ...common,
    now: '2026-09-10T08:01:00.000Z',
    casePrompt: 'Prompt changed after first handoff',
  });
  assert.deepStrictEqual(retried, initial, 'same execution sequence must reuse the first frozen handoff');
  assert.strictEqual(fs.readFileSync(initial.path, 'utf8'), persistedBefore);

  const changedPromptInput = { ...common, casePrompt: 'Prompt changed after handoff creation' };
  const loaded = loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: initial.sha256,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
    claimToken: claimTokenFor(JSON.parse(persistedBefore)),
    now: common.now,
  });
  assert.deepStrictEqual(loaded, { casePrompt: common.casePrompt, brief: common.brief });
  const initialEnvelope = JSON.parse(persistedBefore);
  const repeatedClaim = claimDispatch(path.dirname(initial.path), initialEnvelope, {
    handoffSha: initial.sha256,
    claimToken: claimTokenFor(initialEnvelope),
    now: common.now,
  });
  assert.strictEqual(repeatedClaim.idempotent, true, 'same claim token retry must be idempotent even at the same timestamp');
  const claimedState = JSON.parse(fs.readFileSync(dispatchStatePath, 'utf8'));
  assert.strictEqual(claimedState.dispatches[initial.handoffId].status, 'CONSUMED');
  assert.ok(claimedState.dispatches[initial.handoffId].claimedAt);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(claimedState.dispatches[initial.handoffId], 'leaseUntil'), false);
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: initial.sha256,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
    claimToken: 'wrong-claim-token',
  }), 'HANDOFF_CLAIM_REJECTED');
  assert.notStrictEqual(loaded.casePrompt, changedPromptInput.casePrompt);

  const continuation = createAgentHandoff({
    ...common,
    mode: 'CONTINUATION',
    sequence: 2,
    continuationReason: 'native Agent handle was lost',
    brief: { ...common.brief, lastSceneId: 'scene-0004' },
    now: '2026-09-10T08:05:00.000Z',
  });
  assert.match(path.basename(continuation.path), /^2-[a-f0-9]{64}\.json$/);
  assert.notStrictEqual(continuation.sha256, initial.sha256);
  assert.deepStrictEqual(loadAgentHandoff({
    workspaceRoot,
    handoffPath: continuation.path,
    sha256: continuation.sha256,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
    claimToken: claimTokenFor(JSON.parse(fs.readFileSync(continuation.path, 'utf8'))),
  }).brief.lastSceneId, 'scene-0004');

  const cliWithoutClaim = spawnSync(process.execPath, [
    path.resolve(__dirname, '../case-agent-bootstrap.js'),
    '--workspace', workspaceRoot,
    '--handoff', continuation.path,
    '--sha256', continuation.sha256,
    '--execution-id', common.executionId,
    '--case-protocol-sha', common.caseProtocolSha,
  ], { encoding: 'utf8' });
  assert.strictEqual(cliWithoutClaim.status, 2);
  assert.strictEqual(JSON.parse(cliWithoutClaim.stderr).error.issues[0].field, 'claim-token');
  const cli = spawnSync(process.execPath, [
    path.resolve(__dirname, '../case-agent-bootstrap.js'),
    '--workspace', workspaceRoot,
    '--handoff', continuation.path,
    '--sha256', continuation.sha256,
    '--execution-id', common.executionId,
    '--case-protocol-sha', common.caseProtocolSha,
    '--claim-token', claimTokenFor(JSON.parse(fs.readFileSync(continuation.path, 'utf8'))),
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const bootstrap = JSON.parse(cli.stdout);
  assert.deepStrictEqual(Object.keys(bootstrap).sort(), ['data', 'operation', 'protocol', 'resources', 'result', 'status']);
  assert.strictEqual(bootstrap.status, 'SUCCEEDED');
  assert.strictEqual(bootstrap.operation, 'bootstrap');
  assert.strictEqual(bootstrap.result.outcome, 'CASE_BRIEF_READY');
  assert.deepStrictEqual(bootstrap.result, { outcome: 'CASE_BRIEF_READY', executionId: common.executionId,
    dispatchMode: 'CONTINUATION', dispatchSequence: 2 });
  assert.strictEqual(bootstrap.data.type, 'caseBrief');
  assert.strictEqual(bootstrap.data.content.lastSceneId, 'scene-0004');
  assert.strictEqual(bootstrap.data.content.casePrompt, common.casePrompt);
  assert.deepStrictEqual(require('../case-runtime/agent-resource-store').readPublishedResource(boundExecutionDir, bootstrap.data.ref).data.content,
    bootstrap.data.content);
  assert.strictEqual(fs.readFileSync(initial.path, 'utf8'), persistedBefore, 'bootstrap must be read-only');
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: initial.sha256,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
  }), 'HANDOFF_REPLACED');
  expectCode(() => assertActiveDispatch(path.dirname(initial.path), common.executionId, 999), 'HANDOFF_SEQUENCE_MISMATCH');
  expectCode(() => assertActiveDispatch(path.dirname(initial.path), common.executionId, 1), 'HANDOFF_REPLACED');
  assert.strictEqual(assertActiveDispatch(path.dirname(initial.path), common.executionId, 2).sequence, 2);

  const unclaimedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-handoff-unclaimed-'));
  try {
    const unclaimed = createAgentHandoff({ ...common, workspaceRoot: unclaimedRoot, executionId: 'exec-unclaimed' });
    expectCode(() => assertActiveDispatch(path.dirname(unclaimed.path), 'exec-unclaimed', 1), 'HANDOFF_NOT_CLAIMED');
  } finally {
    fs.rmSync(unclaimedRoot, { recursive: true, force: true });
  }

  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: '0'.repeat(64),
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
  }), 'HANDOFF_INTEGRITY_INVALID');
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: initial.sha256,
    executionId: 'exec-other',
    caseProtocolSha: common.caseProtocolSha,
  }), 'HANDOFF_BINDING_INVALID');
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: initial.sha256,
    executionId: common.executionId,
    caseProtocolSha: 'agent-protocol-other',
  }), 'HANDOFF_BINDING_INVALID');

  const escapedPath = path.join(os.tmpdir(), `escaped-${path.basename(initial.path)}`);
  fs.copyFileSync(initial.path, escapedPath);
  try {
    expectCode(() => loadAgentHandoff({
      workspaceRoot,
      handoffPath: escapedPath,
      sha256: initial.sha256,
      executionId: common.executionId,
      caseProtocolSha: common.caseProtocolSha,
    }), 'HANDOFF_PATH_INVALID');
  } finally {
    fs.unlinkSync(escapedPath);
  }

  const wrongName = path.join(path.dirname(initial.path), `9-${initial.sha256}.json`);
  fs.copyFileSync(initial.path, wrongName);
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: wrongName,
    sha256: initial.sha256,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
  }), 'HANDOFF_INTEGRITY_INVALID');

  const tampered = JSON.parse(persistedBefore);
  tampered.brief = { ...tampered.brief, injected: true };
  const tamperedSha = digest(tampered);
  const tamperedPath = path.join(path.dirname(initial.path), `1-${tamperedSha}.json`);
  fs.writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: tamperedPath,
    sha256: tamperedSha,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
  }), 'HANDOFF_INTEGRITY_INVALID');

  fs.writeFileSync(initial.path, '{"corrupted":true}\n', { mode: 0o600 });
  expectCode(() => createAgentHandoff(common), 'HANDOFF_INTEGRITY_INVALID');
  assert.strictEqual(fs.readFileSync(initial.path, 'utf8'), '{"corrupted":true}\n', 'immutable handoff must never be overwritten');

  expectCode(() => createAgentHandoff({ ...common, mode: 'INITIAL', sequence: 2 }), 'HANDOFF_INVALID');
  expectCode(() => createAgentHandoff({ ...common, mode: 'CONTINUATION', sequence: 1 }), 'HANDOFF_INVALID');

  const linkedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-handoff-linked-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-handoff-outside-'));
  try {
    fs.symlinkSync(outside, path.join(linkedWorkspace, 'runs'));
    expectCode(() => createAgentHandoff({ ...common, workspaceRoot: linkedWorkspace }), 'HANDOFF_PATH_INVALID');
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'handoff creation must not follow workspace symlinks');
  } finally {
    fs.rmSync(linkedWorkspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  const preparedLinkedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-prepared-handoff-linked-'));
  const preparedOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-prepared-handoff-outside-'));
  try {
    const outsideHandoff = createAgentHandoff({ ...common, workspaceRoot: preparedOutside });
    const linkedParent = path.join(preparedLinkedWorkspace, 'runs', common.batchId, 'handoffs');
    fs.mkdirSync(linkedParent, { recursive: true });
    fs.symlinkSync(path.dirname(outsideHandoff.path), path.join(linkedParent, common.executionId));
    expectCode(() => loadPreparedAgentHandoff({
      workspaceRoot: preparedLinkedWorkspace,
      batchId: common.batchId,
      executionId: common.executionId,
      caseProtocolSha: common.caseProtocolSha,
    }), 'HANDOFF_PATH_INVALID');
  } finally {
    fs.rmSync(preparedLinkedWorkspace, { recursive: true, force: true });
    fs.rmSync(preparedOutside, { recursive: true, force: true });
  }

  const preparedRootLinkedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-prepared-root-linked-'));
  const preparedRootOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-prepared-root-outside-'));
  try {
    const outsideHandoff = createAgentHandoff({ ...common, workspaceRoot: preparedRootOutside });
    fs.symlinkSync(path.join(preparedRootOutside, 'runs'), path.join(preparedRootLinkedWorkspace, 'runs'));
    expectCode(() => loadPreparedAgentHandoff({
      workspaceRoot: preparedRootLinkedWorkspace,
      batchId: common.batchId,
      executionId: common.executionId,
      caseProtocolSha: common.caseProtocolSha,
    }), 'HANDOFF_PATH_INVALID');
    expectCode(() => loadAgentHandoff({
      workspaceRoot: preparedRootLinkedWorkspace,
      handoffPath: path.join(
        preparedRootLinkedWorkspace,
        'runs', common.batchId, 'handoffs', common.executionId, path.basename(outsideHandoff.path),
      ),
      sha256: outsideHandoff.sha256,
      executionId: common.executionId,
      caseProtocolSha: common.caseProtocolSha,
    }), 'HANDOFF_PATH_INVALID');
  } finally {
    fs.rmSync(preparedRootLinkedWorkspace, { recursive: true, force: true });
    fs.rmSync(preparedRootOutside, { recursive: true, force: true });
  }

  console.log('agent handoff tests passed');
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

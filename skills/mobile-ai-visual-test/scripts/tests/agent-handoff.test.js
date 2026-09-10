#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { canonicalJson } = require('../lib/contract-utils');
const { createAgentHandoff, loadAgentHandoff } = require('../batch/agent-handoff');
const { claimDispatch, claimTokenFor } = require('../lib/dispatch-lease');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-handoff-'));
const common = {
  workspaceRoot,
  batchId: 'batch-20260910',
  executionId: 'exec-20260910-001',
  caseProtocolSha: 'agent-protocol-0123456789abcdef',
  casePrompt: 'Frozen Case Agent prompt v1',
  brief: { caseKey: 'ck-001', expectations: [{ id: 'E1', text: '目标内容可见' }] },
  now: '2026-09-10T08:00:00.000Z',
};

try {
  const initial = createAgentHandoff(common);
  assert.deepStrictEqual(Object.keys(initial).sort(), ['handoffId', 'loaderCommand', 'path', 'schemaVersion', 'sha256']);
  assert.strictEqual(initial.schemaVersion, 1);
  assert.match(initial.handoffId, /^handoff-[a-f0-9]{16}$/);
  assert.ok(path.isAbsolute(initial.path));
  assert.strictEqual(initial.path.startsWith(path.join(fs.realpathSync(workspaceRoot), 'runs', common.batchId, 'handoffs', common.executionId) + path.sep), true);
  assert.match(path.basename(initial.path), /^1-[a-f0-9]{64}\.json$/);
  assert.strictEqual(initial.loaderCommand.includes(common.casePrompt), false);
  assert.strictEqual(initial.loaderCommand.includes(JSON.stringify(common.brief)), false);
  for (const option of ['--workspace', '--handoff', '--sha256', '--execution-id', '--case-protocol-sha']) {
    assert.strictEqual(initial.loaderCommand.includes(option), true, `loaderCommand must include ${option}`);
  }
  assert.strictEqual(fs.statSync(initial.path).mode & 0o777, 0o600);

  const persistedBefore = fs.readFileSync(initial.path, 'utf8');
  const reused = createAgentHandoff(common);
  assert.deepStrictEqual(reused, initial);
  assert.strictEqual(fs.readFileSync(initial.path, 'utf8'), persistedBefore);

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
  const dispatchStatePath = path.join(path.dirname(initial.path), 'dispatch-state.json');
  const claimedState = JSON.parse(fs.readFileSync(dispatchStatePath, 'utf8'));
  assert.strictEqual(claimedState.dispatches[initial.handoffId].status, 'CONSUMED');
  assert.ok(claimedState.dispatches[initial.handoffId].claimedAt);
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
  }).brief.lastSceneId, 'scene-0004');

  const cli = spawnSync(process.execPath, [
    path.resolve(__dirname, '../case-agent-bootstrap.js'),
    '--workspace', workspaceRoot,
    '--handoff', continuation.path,
    '--sha256', continuation.sha256,
    '--execution-id', common.executionId,
    '--case-protocol-sha', common.caseProtocolSha,
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(JSON.parse(cli.stdout).brief.lastSceneId, 'scene-0004');
  assert.strictEqual(fs.readFileSync(initial.path, 'utf8'), persistedBefore, 'bootstrap must be read-only');
  expectCode(() => loadAgentHandoff({
    workspaceRoot,
    handoffPath: initial.path,
    sha256: initial.sha256,
    executionId: common.executionId,
    caseProtocolSha: common.caseProtocolSha,
  }), 'HANDOFF_REPLACED');

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

  console.log('agent handoff tests passed');
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

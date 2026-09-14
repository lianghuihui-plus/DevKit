#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  derivedOwnerKey,
  resolveManagedOwner,
} = require('../platform/adapters/ios/lib/runtime-ownership');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-owner-'));
const batchId = 'batch-owner-test';
const contractSha = 'contract-owner-test';
const batchDir = path.join(root, 'runs', batchId);
fs.mkdirSync(batchDir, { recursive: true });
fs.writeFileSync(path.join(batchDir, 'contract.json'), JSON.stringify({ contractSha }));
const ownerKey = derivedOwnerKey(root, batchId, contractSha);
const now = '2026-09-14T10:00:00.000Z';

function writeState(overrides = {}) {
  fs.writeFileSync(path.join(batchDir, 'batch.json'), JSON.stringify({
    batchId,
    contractSha,
    status: 'BLOCKING',
    cleanupDeadlineAt: '2026-09-14T09:59:00.000Z',
    cases: [{ status: 'SKIPPED' }],
    ...overrides,
  }));
}

writeState();
assert.strictEqual(resolveManagedOwner(ownerKey, { workspaceRoot: root, now }).status, 'RECLAIMABLE');
writeState({ cases: [{ status: 'RUNNING' }] });
assert.strictEqual(resolveManagedOwner(ownerKey, { workspaceRoot: root, now }).status, 'ACTIVE');
writeState({ cleanupDeadlineAt: '2026-09-14T10:01:00.000Z' });
assert.strictEqual(resolveManagedOwner(ownerKey, { workspaceRoot: root, now }).status, 'ACTIVE');
writeState({ status: 'BLOCKED' });
assert.strictEqual(resolveManagedOwner(ownerKey, { workspaceRoot: root, now }).status, 'TERMINAL');

fs.rmSync(root, { recursive: true, force: true });
console.log('ios-runtime-ownership passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inputEffectMetrics, timingMetrics } = require('../lib/execution-time-limit');

const effects = inputEffectMetrics([
  { deviceResult: { inputEffect: { status: 'MASKED', attempts: 1, settledMs: 120 } } },
  { deviceResult: { inputEffect: { status: 'VERIFIED', attempts: 2, settledMs: 240 } } },
  { deviceResult: { inputEffect: { status: 'MISMATCH', attempts: 3, settledMs: 360 } } },
]);
assert.deepStrictEqual(effects, {
  total: 3,
  statuses: { VERIFIED: 1, MASKED: 1, UNVERIFIABLE: 0, MISMATCH: 1 },
  attempts: 6,
  settledMs: 720,
});

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-metrics-'));
fs.mkdirSync(path.join(execDir, 'agent'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'agent', 'attempts.jsonl'), [
  { entrypoint: 'status', durationMs: 10, ok: true },
  { entrypoint: 'action', durationMs: 20, ok: true },
  { entrypoint: 'status', durationMs: 5, ok: false },
].map(JSON.stringify).join('\n'));
fs.writeFileSync(path.join(execDir, 'agent', 'operation-input.json'), JSON.stringify({
  timing: { adapterStartedAt: '2026-08-20T10:00:01.000Z', adapterCompletedAt: '2026-08-20T10:00:02.000Z' },
  deviceResult: { inputEffect: { status: 'MASKED', attempts: 1, settledMs: 120 } },
}));
const timing = timingMetrics(
  { startedAt: '2026-08-20T10:00:00.000Z' },
  [{ type: 'caseUnderstood', time: '2026-08-20T10:00:00.100Z', sourceRefs: ['src-001'] }, { type: 'planRevised', time: '2026-08-20T10:00:00.200Z' }],
  '2026-08-20T10:00:03.000Z',
  execDir,
);
assert.strictEqual(timing.statusReads, 2);
assert.strictEqual(timing.protocolAttempts, 3);
assert.strictEqual(timing.contractRejections, 1);
assert.strictEqual(timing.adapterActiveMs, 1000);
assert.strictEqual(timing.inputEffects.statuses.MASKED, 1);
fs.rmSync(execDir, { recursive: true, force: true });

console.log('execution-metrics passed');

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const store = require('../case-runtime/store');
const { requestFinalReview, sourceText } = require('../case-runtime/final-review');

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-final-review-'));
fs.mkdirSync(path.join(execDir, 'transactions'));
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
fs.writeFileSync(path.join(execDir, 'source.snapshot.md'), '# 原始用例\n\n验证完整业务目标');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 14,
  runtime: 'case-runtime',
  executionId: 'execution-final-review',
  status: 'RUNNING',
  finalized: false,
});

assert.strictEqual(sourceText(execDir), '# 原始用例\n\n验证完整业务目标');
assert.strictEqual(requestFinalReview(execDir, { now: '2026-09-24T06:00:00.000Z' }), true);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'caseFinalReviewRequired').length, 1);
assert.strictEqual(requestFinalReview(execDir, { now: '2026-09-24T06:00:01.000Z' }), false,
  'the final review gate must only issue once per execution');
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'caseFinalReviewRequired').length, 1);
fs.rmSync(execDir, { recursive: true, force: true });
console.log('final review gate passed');

'use strict';

const assert = require('assert');

const {
  MAX_SEQUENCE_DURATION_MS,
  MAX_SEQUENCE_STEPS,
  FINAL_SCENE_RESERVE_MS,
  SEQUENCE_STATUSES,
  SEQUENCE_STEP_TYPES,
  normalizeSequenceRequest,
  sequenceDurationMs,
  sequenceRequestKey,
  validateSequenceRequest,
} = require('../case-runtime/sequence-contract');

const base = {
  operation: 'runSequence',
  basedOnSceneId: 'scene-0001',
  purpose: '连续完成已确定操作',
  steps: [
    { id: 'open', type: 'act', capabilityId: 'filter:tap' },
    { id: 'settle', type: 'wait', ms: 500 },
    { id: 'evidence', type: 'capture', mode: 'SCREENSHOT_ONLY', purpose: '保留短暂提示' },
  ],
};

assert.strictEqual(MAX_SEQUENCE_STEPS, 12);
assert.strictEqual(MAX_SEQUENCE_DURATION_MS, 30000);
assert.strictEqual(FINAL_SCENE_RESERVE_MS, 4000);
assert.deepStrictEqual(SEQUENCE_STATUSES, ['SEQUENCE_COMPLETED', 'SEQUENCE_PARTIAL', 'SEQUENCE_INTERRUPTED']);
assert.deepStrictEqual(SEQUENCE_STEP_TYPES, ['act', 'wait', 'capture']);
assert.strictEqual(validateSequenceRequest(base), true);
assert.strictEqual(
  sequenceRequestKey({ ...base, decision: { purpose: 'first', expectationRefs: [] } }),
  sequenceRequestKey({ ...base, decision: { purpose: 'retry', expectationRefs: [] } }),
);
assert.deepStrictEqual(Object.keys(normalizeSequenceRequest(base)).sort(),
  ['basedOnSceneId', 'purpose', 'steps']);

const flowContextRequest = {
  ...base,
  purpose: '  连续完成已确定操作  ',
  flowContext: { selectedEdgeRef: ' L1 ', nodeRef: ' N1 ' },
};
assert.deepStrictEqual(normalizeSequenceRequest(flowContextRequest).flowContext,
  { nodeRef: 'N1', selectedEdgeRef: 'L1' });
assert.strictEqual(
  sequenceRequestKey(flowContextRequest),
  sequenceRequestKey({ ...base, flowContext: { nodeRef: 'N1', selectedEdgeRef: 'L1' } }),
);

function invalid(request) {
  assert.throws(() => validateSequenceRequest(request), (error) => error.code === 'SEQUENCE_INVALID');
}

invalid({ ...base, steps: [{ id: 'x', type: 'check' }] });
invalid({ ...base, submissionId: 'agent-owned' });
invalid({ ...base, steps: [{ id: 'x', type: 'wait', ms: 0 }, { id: 'x', type: 'wait', ms: 1 }] });
invalid({ ...base, steps: [{ id: '1bad', type: 'wait', ms: 1 }] });
invalid({ ...base, purpose: '   ' });
invalid({ ...base, unknown: true });
invalid({ ...base, steps: [] });
invalid({ ...base, steps: Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, type: 'wait', ms: 0 })) });
invalid({ ...base, steps: [{ id: 'bad', type: 'wait', ms: MAX_SEQUENCE_DURATION_MS + 1 }] });
invalid({ ...base, steps: [{ id: 'bad', type: 'act', capabilityId: 'tap', input: { unsupported: true } }] });
invalid({ ...base, steps: [{ id: 'bad', type: 'act', capabilityId: 'tap', visual: { gesture: 'tap', point: [0.5, 0.5] } }] });
invalid({ ...base, steps: [{ id: 'bad', type: 'act', input: { text: 'x' } }] });
invalid({ ...base, steps: [{ id: 'bad', type: 'capture', mode: 'NOPE', purpose: 'x' }] });
invalid({ ...base, steps: [{ id: 'bad', type: 'capture', mode: 'FULL_SCENE', purpose: '   ' }] });
invalid({ ...base, flowContext: { nodeRef: 'N1', unsupported: true } });

assert.strictEqual(validateSequenceRequest({
  ...base,
  steps: [
    { id: 'tap', type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } },
    { id: 'full', type: 'capture', mode: 'FULL_SCENE', purpose: '保留完整现场' },
  ],
}), true);
assert.strictEqual(sequenceDurationMs(undefined), 30000);
assert.strictEqual(sequenceDurationMs(0), 0);
assert.strictEqual(sequenceDurationMs(-1), 0);
assert.strictEqual(sequenceDurationMs(Number.NaN), 0);
assert.strictEqual(sequenceDurationMs(50000), 30000);

console.log('sequence-contract tests passed');

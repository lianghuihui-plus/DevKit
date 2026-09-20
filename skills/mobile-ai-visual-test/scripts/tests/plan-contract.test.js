#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  PLAN_CHECK_KINDS,
  PLAN_LOCATOR_KINDS,
  PLAN_STEP_TYPES,
  normalizePlanRequest,
  validatePlanRequest,
} = require('../case-runtime/plan-contract');

function validRequest() {
  return {
    operation: 'runPlan',
    submissionId: 'run-plan-033-attempt-01',
    basedOnSceneId: 'scene-0012',
    purpose: '唤起视频控制栏并解除童锁',
    maxDurationMs: 2500,
    onFailure: 'STOP',
    steps: [
      { id: 'reveal', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
      { id: 'settle', type: 'wait', ms: 300 },
      { id: 'controls', type: 'capture', mode: 'SCREENSHOT_ONLY' },
      { id: 'lock', type: 'locate', sourceRef: '$controls.sceneRef', locator: { kind: 'POINT', point: [0.098, 0.501] } },
      { id: 'unlock', type: 'act', actionRef: 'visual:tap', input: { pointRef: '$lock.point' } },
      { id: 'after', type: 'capture', mode: 'SCREENSHOT_ONLY' },
      { id: 'technical-check', type: 'check', sourceRef: '$after.sceneRef', predicate: { kind: 'CAPTURE_AVAILABLE' } },
    ],
    flowContext: { nodeRef: 'N5' },
  };
}

function expectInvalid(update, field) {
  const request = validRequest();
  update(request);
  assert.throws(() => validatePlanRequest(request, { remainingMs: 3000 }), (error) => {
    assert.strictEqual(error.code, 'PLAN_INVALID');
    assert.ok(error.issues.some((issue) => issue.fieldPath === field), JSON.stringify(error.issues));
    return true;
  });
}

assert.deepStrictEqual(PLAN_STEP_TYPES, ['act', 'wait', 'capture', 'locate', 'check', 'checkpoint']);
assert.deepStrictEqual(PLAN_LOCATOR_KINDS, ['ELEMENT_REF', 'POINT', 'REGION']);
assert.deepStrictEqual(PLAN_CHECK_KINDS, ['CAPTURE_AVAILABLE', 'ELEMENT_VISIBLE', 'ELEMENT_ENABLED', 'APP_IN_FOREGROUND', 'REFERENCE_EXISTS']);

assert.strictEqual(validatePlanRequest(validRequest(), { remainingMs: 3000 }), true);
const normalized = normalizePlanRequest(validRequest());
assert.strictEqual(normalized.steps[2].promote, false);
assert.strictEqual(normalized.steps[5].promote, false);
assert.deepStrictEqual(normalized, normalizePlanRequest(normalized), 'normalization must be stable');

const fullScene = validRequest();
fullScene.steps = [{ id: 'full', type: 'capture', mode: 'FULL_SCENE' }];
assert.strictEqual(normalizePlanRequest(fullScene).steps[0].promote, true);

expectInvalid((request) => { delete request.basedOnSceneId; }, 'basedOnSceneId');
expectInvalid((request) => { request.maxDurationMs = 0; }, 'maxDurationMs');
expectInvalid((request) => { request.maxDurationMs = 3001; }, 'maxDurationMs');
expectInvalid((request) => { request.steps[1].id = 'reveal'; }, 'steps[1].id');
expectInvalid((request) => { request.steps[1].type = 'loop'; }, 'steps[1].type');
expectInvalid((request) => { request.steps[3].sourceRef = '$after.sceneRef'; }, 'steps[3].sourceRef');
expectInvalid((request) => { request.steps[3].sourceRef = 'controls.sceneRef'; }, 'steps[3].sourceRef');
expectInvalid((request) => { request.steps[3].locator.kind = 'TEMPLATE'; }, 'steps[3].locator.kind');
expectInvalid((request) => { request.steps[6].predicate.kind = 'SCREEN_CHANGED'; }, 'steps[6].predicate.kind');
expectInvalid((request) => { request.steps[6].predicate.shell = 'test -f screenshot.png'; }, 'steps[6].predicate.shell');
expectInvalid((request) => { request.steps[6].predicate = { kind: 'ELEMENT_VISIBLE' }; }, 'steps[6].predicate.elementRef');
expectInvalid((request) => { request.steps[0].input = { point: [0.5, 0.5], shell: 'tap 1 2' }; }, 'steps[0].input.shell');
expectInvalid((request) => { request.steps[0].actionRef = 'visual:doubleTap'; }, 'steps[0].actionRef');
expectInvalid((request) => { request.steps[0].shell = 'tap 1 2'; }, 'steps[0].shell');
expectInvalid((request) => { request.steps = Array.from({ length: 13 }, (_, index) => ({ id: `wait-${index}`, type: 'wait', ms: 1 })); }, 'steps');

console.log('plan contract passed');

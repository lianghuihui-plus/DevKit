#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeAdapterActionResult, validateAdapterActionResult } = require('../lib/action-result');
const { updateScrollContexts } = require('../lib/scroll-context');
const { classifyRuntimeDisplay, startupDisplayRequirement } = require('../lib/startup-display');
const { buildCapabilities, resolveAction } = require('../case-runtime/capability-catalog');
const { validateLongPressTiming, validateRuntimeRequest } = require('../case-runtime/contract');
const { validateSearchAbsence } = require('../case-runtime/result-integrity');
const { actionAdapterArgs } = require('../platform/device-port');
const { sanitizeTransactionValue } = require('../case-runtime/transaction-manager');

const normalizedTap = normalizeAdapterActionResult({
  schemaVersion: 1,
  type: 'actionResult',
  action: 'tap',
  ok: true,
  executedPoint: { x: 120, y: 240 },
}, { platform: 'harmony', action: 'tap', deviceId: 'device-1', appId: 'com.example.app', transport: 'HDC_UITEST' });
validateAdapterActionResult(normalizedTap);
assert.strictEqual(normalizedTap.command.status, 'ACCEPTED');
assert.strictEqual(normalizedTap.deviceExecution.status, 'UNVERIFIED');
assert.strictEqual(normalizedTap.deviceExecution.verification, 'REQUEST_ECHO');
assert.deepStrictEqual(normalizedTap.deviceExecution.dispatchedPoint, { x: 120, y: 240 });
assert.strictEqual(normalizedTap.deviceExecution.actualTouchPoint, null);
assert.strictEqual(Object.hasOwn(normalizedTap, 'ok'), false);
assert.strictEqual(Object.hasOwn(normalizedTap, 'executedPoint'), false);
assert.strictEqual(normalizeAdapterActionResult({ type: 'actionResult' }, {
  platform: 'harmony', action: 'tap', deviceId: 'device-1', appId: 'com.example.app',
}).command.status, 'UNKNOWN');
const rejectedTap = normalizeAdapterActionResult({
  type: 'actionResult', action: 'tap', ok: false, failureCode: 'TOOL_ERROR', error: 'input rejected',
}, { platform: 'harmony', action: 'tap', deviceId: 'device-1', appId: 'com.example.app' });
assert.strictEqual(rejectedTap.command.status, 'REJECTED');
assert.strictEqual(rejectedTap.deviceExecution.status, 'NOT_EXECUTED');
const mismatchedInput = normalizeAdapterActionResult({
  type: 'actionResult', action: 'inputText', ok: false, failureCode: 'ACTION_EFFECT_MISMATCH',
  inputEffect: { status: 'MISMATCH' },
}, { platform: 'harmony', action: 'inputText', deviceId: 'device-1', appId: 'com.example.app' });
assert.strictEqual(mismatchedInput.command.status, 'ACCEPTED');
assert.strictEqual(mismatchedInput.deviceExecution.status, 'FAILED');
assert.strictEqual(mismatchedInput.deviceExecution.verification, 'INPUT_EFFECT');
assert.strictEqual(mismatchedInput.deviceExecution.failureCode, 'ACTION_EFFECT_MISMATCH');
const sanitizedInput = normalizeAdapterActionResult({
  type: 'actionResult', action: 'inputText', ok: true,
  inputEffect: { status: 'VERIFIED', expectedText: 'private-value', actualText: 'private-value' },
  preInputState: { text: 'previous-private-value' },
}, { platform: 'harmony', action: 'inputText', deviceId: 'device-1', appId: 'com.example.app' });
assert.strictEqual(JSON.stringify(sanitizedInput).includes('private-value'), false);
assert.strictEqual(sanitizedInput.inputEffect.expectedLength, 13);
assert.strictEqual(sanitizedInput.inputEffect.observedLength, 13);
const sanitizedTransaction = sanitizeTransactionValue({
  action: { type: 'inputText', text: 'transaction-private' },
  deviceResult: { inputEffect: { expectedText: 'transaction-private', actualText: 'transaction-private' } },
});
assert.strictEqual(JSON.stringify(sanitizedTransaction).includes('transaction-private'), false);

assert.strictEqual(classifyRuntimeDisplay(2232, 1008).displayClass, 'PHONE_LIKE');
assert.strictEqual(classifyRuntimeDisplay(1008, 2232).displayClass, 'PHONE_LIKE');
assert.strictEqual(classifyRuntimeDisplay(1600, 1200).displayClass, 'TABLET_LIKE');
assert.strictEqual(classifyRuntimeDisplay(1700, 1000).displayClass, 'PHONE_LIKE');
assert.strictEqual(classifyRuntimeDisplay(1699, 1000).displayClass, 'TABLET_LIKE');
assert.strictEqual(classifyRuntimeDisplay(null, 1200).displayClass, 'UNKNOWN');
assert.strictEqual(startupDisplayRequirement(undefined, 'triplefold', {
  platform: 'harmony', runtimeDisplayClass: 'PHONE_LIKE',
}).required, true);
assert.strictEqual(startupDisplayRequirement(undefined, 'phone', {
  platform: 'harmony', runtimeDisplayClass: 'TABLET_LIKE',
}).required, false);

const scene = {
  sceneId: 'scene-long-press',
  screenshot: { width: 1000, height: 2000, ref: 'screenshots/scene-long-press.png' },
  layoutRef: 'layouts/scene-long-press.json',
  signals: {},
  elements: [{
    id: 'message-button', text: '按住说话', role: 'Button', bounds: [400, 1700, 600, 1900],
    clickable: true, checkable: false, editable: false, enabled: true, visible: true,
  }],
};
scene.capabilities = buildCapabilities(scene, 'harmony');
const longPressCapability = scene.capabilities.find((item) => item.kind === 'longPress');
assert.deepStrictEqual(longPressCapability.input, { durationMs: 'positive-integer' });
assert.strictEqual(resolveAction(scene, {
  capabilityId: longPressCapability.id,
  input: { durationMs: 5000 },
  decision: { purpose: '验证按住态', expectationRefs: [] },
}, 'harmony').action.durationMs, 5000);
assert.strictEqual(resolveAction(scene, {
  visual: { gesture: 'longPress', point: [0.5, 0.9], durationMs: 5000 },
  decision: { purpose: '验证按住态', expectationRefs: [] },
}, 'harmony').action.durationMs, 5000);
assert.doesNotThrow(() => validateRuntimeRequest({
  operation: 'act',
  visual: { gesture: 'longPress', point: [0.5, 0.9], durationMs: 5000 },
  observationPolicy: { duringActionAtMs: 4000 },
  decision: { purpose: '验证按住态', expectationRefs: [] },
}));
assert.throws(() => validateRuntimeRequest({
  operation: 'act', visual: { gesture: 'longPress', point: [0.5, 0.9] },
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');
assert.throws(() => validateRuntimeRequest({
  operation: 'act', capabilityId: longPressCapability.id,
  visual: { gesture: 'longPress', point: [0.5, 0.9], durationMs: 5000 },
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID' && /mutually exclusive/.test(error.message));
assert.throws(() => validateLongPressTiming(5000, { duringActionAtMs: 5000 }),
  (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');
assert.doesNotThrow(() => validateRuntimeRequest({
  operation: 'inspectVisual',
  basedOnSceneId: 'scene-long-press',
  decision: {
    purpose: '记录长按截图视觉检查',
    expectationRefs: ['E1'],
    observation: '截图显示长按录音状态',
  },
}));
assert.throws(() => validateRuntimeRequest({
  operation: 'inspectVisual',
  basedOnSceneId: 'scene-long-press',
  decision: { purpose: '记录视觉检查', expectationRefs: ['E1'] },
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID' && /decision\.observation/.test(error.message));
assert.throws(() => validateRuntimeRequest({
  operation: 'inspectVisual',
  decision: { purpose: '记录视觉检查', expectationRefs: ['E1'], observation: '页面正常' },
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID' && /basedOnSceneId/.test(error.message));
const adapterArgs = actionAdapterArgs({
  platform: 'harmony', deviceId: 'device-1', appId: 'com.example.app', entry: 'EntryAbility',
}, { type: 'longPress', x: 500, y: 1800, durationMs: 5000 }, {
  captureOut: '/tmp/mavt-capture', captureLabel: 'action-0001-during', captureAtMs: 4000,
});
assert.deepStrictEqual(adapterArgs.slice(adapterArgs.indexOf('--duration-ms'), adapterArgs.indexOf('--duration-ms') + 2), ['--duration-ms', '5000']);
assert.deepStrictEqual(adapterArgs.slice(-6), [
  '--capture-out', '/tmp/mavt-capture', '--capture-label', 'action-0001-during', '--capture-at-ms', '4000',
]);

const bounds = [0, 0, 1000, 600];
const item = (anchorKey, top) => ({ anchorKey, bounds: [0, top, 1000, top + 100] });
const container = (items) => ({
  contextKey: 'works-selected', containerKey: 'works-list', bounds, axis: 'VERTICAL', items,
});
const swipe = (direction, effect) => ({
  action: direction === 'UP'
    ? { type: 'swipe', fromY: 200, toY: 500 }
    : { type: 'swipe', fromY: 500, toY: 200 },
  command: { status: 'ACCEPTED' },
  observedEffect: { status: effect },
});
function next(previousScene, items, previousAction, sceneId) {
  const scrollContainers = [container(items)];
  const scrollContexts = updateScrollContexts({
    previousScene, containers: scrollContainers, previousAction, sceneId, generation: 1,
  });
  return { sceneId, generation: 1, scrollContainers, scrollContexts };
}

let tracked = next(null, [item('B', 100), item('C', 200), item('D', 300)], null, 'scene-0001');
assert.deepStrictEqual(tracked.scrollContexts[0].unexploredDirections, ['UP', 'DOWN']);
tracked = next(tracked, [item('A', 100), item('B', 200), item('C', 300)], swipe('UP', 'CHANGED'), 'scene-0002');
assert.strictEqual(tracked.scrollContexts[0].searchedAbove, true);
tracked = next(tracked, [item('A', 100), item('B', 200), item('C', 300)], swipe('UP', 'UNCHANGED'), 'scene-0003');
assert.strictEqual(tracked.scrollContexts[0].reachedStart, 'PROBABLE');
tracked = next(tracked, [item('A', 100), item('B', 200), item('C', 300)], swipe('UP', 'UNCHANGED'), 'scene-0004');
assert.strictEqual(tracked.scrollContexts[0].reachedStart, 'CONFIRMED');
tracked = next(tracked, [item('B', 100), item('C', 200), item('D', 300)], swipe('DOWN', 'CHANGED'), 'scene-0005');
tracked = next(tracked, [item('C', 100), item('D', 200), item('E', 300)], swipe('DOWN', 'CHANGED'), 'scene-0006');
assert.strictEqual(tracked.scrollContexts[0].searchedBelow, true);
tracked = next(tracked, [item('C', 100), item('D', 200), item('E', 300)], swipe('DOWN', 'UNCHANGED'), 'scene-0007');
tracked = next(tracked, [item('C', 100), item('D', 200), item('E', 300)], swipe('DOWN', 'UNCHANGED'), 'scene-0008');
assert.strictEqual(tracked.scrollContexts[0].reachedEnd, 'CONFIRMED');
assert.strictEqual(tracked.scrollContexts[0].coverage, 'CONTIGUOUS');
assert.deepStrictEqual(tracked.scrollContexts[0].unexploredDirections, []);
assert.strictEqual(tracked.scrollContexts[0].absenceConclusionSupported, true);

let nonConsecutive = next(null, [item('B', 100), item('C', 200), item('D', 300)], null, 'scene-streak-1');
nonConsecutive = next(nonConsecutive, [item('B', 100), item('C', 200), item('D', 300)], swipe('UP', 'UNCHANGED'), 'scene-streak-2');
nonConsecutive = next(nonConsecutive, [item('C', 100), item('D', 200), item('E', 300)], swipe('DOWN', 'CHANGED'), 'scene-streak-3');
nonConsecutive = next(nonConsecutive, [item('C', 100), item('D', 200), item('E', 300)], swipe('UP', 'UNCHANGED'), 'scene-streak-4');
assert.strictEqual(nonConsecutive.scrollContexts[0].reachedStart, 'PROBABLE');

const gapped = next(
  next(null, [item('A', 100), item('B', 200)], null, 'scene-gap-1'),
  [item('X', 100), item('Y', 200)],
  swipe('DOWN', 'CHANGED'),
  'scene-gap-2',
);
assert.strictEqual(gapped.scrollContexts[0].coverage, 'GAPPED');
assert.strictEqual(gapped.scrollContexts[0].absenceConclusionSupported, false);

const confirmedBeforeRefresh = {
  ...tracked,
  scrollContexts: tracked.scrollContexts.map((context) => ({
    ...context, reachedStart: 'CONFIRMED', reachedEnd: 'CONFIRMED', absenceConclusionSupported: true,
  })),
};
const refreshed = next(
  confirmedBeforeRefresh,
  [item('NEW-1', 100), item('NEW-2', 200)],
  { action: { type: 'wait' }, command: { status: 'ACCEPTED' }, observedEffect: { status: 'CHANGED' } },
  'scene-refresh',
);
assert.strictEqual(refreshed.scrollContexts[0].reachedStart, 'UNKNOWN');
assert.strictEqual(refreshed.scrollContexts[0].reachedEnd, 'UNKNOWN');
assert.strictEqual(refreshed.scrollContexts[0].absenceConclusionSupported, false);

const integrityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-scroll-integrity-'));
const absenceResult = {
  checks: [{
    expectationRef: 'E1', status: 'FAIL', actual: '完整列表未发现目标',
    sceneRefs: ['scene-search-complete'],
    evidenceBasis: { type: 'SEARCH_ABSENCE', sceneRef: 'scene-search-complete', scrollContextRef: 'scroll-complete' },
  }],
};
const currentScene = {
  sceneId: 'scene-search-complete',
  scrollContexts: [{
    id: 'scroll-complete', generation: 3, trackingStatus: 'TRACKING', coverage: 'CONTIGUOUS',
    reachedStart: 'CONFIRMED', reachedEnd: 'CONFIRMED', absenceConclusionSupported: true,
  }],
};
fs.mkdirSync(path.join(integrityDir, 'scenes'));
fs.writeFileSync(path.join(integrityDir, 'scenes', 'scene-search-complete.json'), JSON.stringify(currentScene));
assert.deepStrictEqual(validateSearchAbsence(integrityDir, absenceResult, { warmSessionGeneration: 3 }), {
  searchAbsenceRefs: ['scroll-complete'],
});
assert.throws(() => validateSearchAbsence(integrityDir, {
  checks: [{ expectationRef: 'E1', status: 'FAIL', actual: '未发现目标', sceneRefs: ['scene-search-complete'] }],
}, { warmSessionGeneration: 3 }, {
  expectations: [{ id: 'E1', text: '目标存在', verificationKind: 'SEARCH_EXISTENCE' }],
}), (error) => error.code === 'CASE_RESULT_INCOMPLETE'
  && error.missing.some((entry) => entry.field === 'checks.E1.evidenceBasis'));
currentScene.scrollContexts[0].reachedStart = 'PROBABLE';
currentScene.scrollContexts[0].absenceConclusionSupported = false;
fs.writeFileSync(path.join(integrityDir, 'scenes', 'scene-search-complete.json'), JSON.stringify(currentScene));
assert.throws(() => validateSearchAbsence(integrityDir, absenceResult, { warmSessionGeneration: 3 }),
  (error) => error.code === 'CASE_RESULT_INCOMPLETE');

console.log('runtime enhancements passed');

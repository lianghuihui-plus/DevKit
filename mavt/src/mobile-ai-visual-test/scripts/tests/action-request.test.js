#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { resolveActionRequest } = require('../case-runtime/action-request');
const { buildCapabilities } = require('../case-runtime/capability-catalog');

const scene = {
  sceneId: 'scene-0001',
  screenshot: { ref: 'screenshots/scene-0001.png', width: 200, height: 400 },
  layoutRef: 'layouts/scene-0001.json',
  signals: {},
  scrollContexts: [],
  elements: [
    {
      id: 'submit', text: 'Submit', role: 'Button', bounds: [20, 40, 100, 100],
      clickable: true, checkable: false, editable: false, enabled: true, visible: true,
    },
    {
      id: 'account', text: 'Account', role: 'TextField', bounds: [20, 120, 180, 180],
      clickable: false, checkable: false, editable: true, enabled: true, visible: true,
    },
  ],
};
scene.capabilities = buildCapabilities(scene, 'harmony');

const visual = resolveActionRequest(scene, {
  visual: { gesture: 'tap', point: [0.5, 0.25] },
  decision: { purpose: 'Tap the visual target' },
}, 'harmony');
assert.strictEqual(visual.stale, false);
assert.deepStrictEqual({ type: visual.action.type, x: visual.action.x, y: visual.action.y }, {
  type: 'tap', x: 100, y: 100,
});

const inputCapability = scene.capabilities.find((capability) => capability.kind === 'inputText');
const input = resolveActionRequest(scene, {
  capabilityId: inputCapability.id,
  input: { text: 'account@example.test', mode: 'replace' },
}, 'harmony');
assert.strictEqual(input.action.type, 'inputText');
assert.strictEqual(input.action.text, 'account@example.test');

assert.deepStrictEqual(resolveActionRequest(scene, {
  capabilityId: 'scene-0001:tap:missing',
}, 'harmony'), { stale: true });

assert.throws(() => resolveActionRequest(scene, {
  capabilityId: inputCapability.id,
}, 'harmony'), (error) => error.code === 'ACTION_CONTRACT_INVALID' && error.field === 'text');

assert.throws(() => resolveActionRequest(scene, {
  visual: { gesture: 'tap', point: [1.5, 0.5] },
}, 'harmony'), (error) => error.code === 'CASE_RUNTIME_VISUAL_ACTION_INVALID');

assert.throws(() => resolveActionRequest(scene, {
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  observationPolicy: { duringActionAtMs: 100 },
}, 'harmony'), (error) => (
  error.code === 'CASE_RUNTIME_REQUEST_INVALID'
  && error.message === 'observationPolicy.duringActionAtMs is only supported for longPress'
));

assert.throws(() => resolveActionRequest(scene, {
  visual: { gesture: 'longPress', point: [0.5, 0.5], durationMs: 500 },
  observationPolicy: { duringActionAtMs: 500 },
}, 'harmony'), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');

const longPress = resolveActionRequest(scene, {
  visual: { gesture: 'longPress', point: [0.5, 0.5], durationMs: 500 },
  observationPolicy: { duringActionAtMs: 250 },
}, 'harmony');
assert.strictEqual(longPress.action.type, 'longPress');
assert.strictEqual(longPress.action.durationMs, 500);

console.log('shared action request validation passed');

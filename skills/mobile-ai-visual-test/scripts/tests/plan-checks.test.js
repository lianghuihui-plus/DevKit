#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('../case-runtime/plan-checks');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-plan-checks-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'checks' });
const scenePath = path.join(fixture.execDir, 'scenes', 'scene-0002.json');
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
scene.elements = [
  { id: 'enabled', visible: true, enabled: true },
  { id: 'hidden', visible: false, enabled: false },
];
fs.writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);
const context = { planId: 'plan-0001', sourceRef: 'scene-0002', references: new Set(['locator-plan-0001-lock.json']) };

function outcome(id, predicate) {
  return check(fixture.execDir, { id, type: 'check', sourceRef: '$shot.sceneRef', predicate }, context);
}

const capture = outcome('capture', { kind: 'CAPTURE_AVAILABLE' });
assert.strictEqual(capture.status, 'CHECKED');
assert.strictEqual(capture.result.status, 'SATISFIED');
assert.strictEqual(capture.result.value, true);
assert.strictEqual(capture.technicalFactRef, capture.result.checkRef);
assert.ok(fs.existsSync(path.join(fixture.execDir, capture.result.checkRef)));
assert.strictEqual(outcome('visible', { kind: 'ELEMENT_VISIBLE', elementRef: 'enabled' }).result.status, 'SATISFIED');
assert.strictEqual(outcome('hidden', { kind: 'ELEMENT_VISIBLE', elementRef: 'hidden' }).result.status, 'NOT_SATISFIED');
assert.strictEqual(outcome('missing', { kind: 'ELEMENT_ENABLED', elementRef: 'missing' }).result.status, 'UNAVAILABLE');
assert.strictEqual(outcome('enabled', { kind: 'ELEMENT_ENABLED', elementRef: 'enabled' }).result.status, 'SATISFIED');
assert.strictEqual(outcome('foreground', { kind: 'APP_IN_FOREGROUND' }).result.status, 'SATISFIED');
assert.strictEqual(outcome('exists', { kind: 'REFERENCE_EXISTS', reference: 'locator-plan-0001-lock.json' }).result.status, 'SATISFIED');
assert.strictEqual(outcome('absent', { kind: 'REFERENCE_EXISTS', reference: 'missing-ref' }).result.status, 'NOT_SATISFIED');
assert.throws(() => outcome('changed', { kind: 'SCREEN_CHANGED' }), (error) => error.code === 'PLAN_CHECK_FAILED');

console.log('plan checks passed');

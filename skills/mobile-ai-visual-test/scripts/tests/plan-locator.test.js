#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { locate } = require('../case-runtime/plan-locator');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-plan-locator-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'locator' });
const scenePath = path.join(fixture.execDir, 'scenes', 'scene-0002.json');
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
scene.screenshot.width = 1000;
scene.screenshot.height = 600;
scene.elements = [{ id: 'lock-button', bounds: [80, 240, 120, 300], visible: true, enabled: true }];
fs.writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);
const context = { planId: 'plan-0001', sourceRef: 'scene-0002' };

const point = locate(fixture.execDir, {
  id: 'point', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'POINT', point: [0.25, 0.5] },
}, context);
assert.strictEqual(point.status, 'LOCATED');
assert.deepStrictEqual(point.resolution.point, [250, 300]);
assert.strictEqual(point.resolution.provider, 'POINT');
assert.strictEqual(point.resolution.confidence, 'DECLARED');
assert.ok(fs.existsSync(path.join(fixture.execDir, point.locatorRef)));

const lowerRight = locate(fixture.execDir, {
  id: 'lower-right', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'POINT', point: [1, 1] },
}, context);
assert.deepStrictEqual(lowerRight.resolution.point, [999, 599]);

const region = locate(fixture.execDir, {
  id: 'region', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'REGION', region: [0.1, 0.2, 0.3, 0.4] },
}, context);
assert.deepStrictEqual(region.resolution.bounds, [100, 120, 300, 240]);
assert.deepStrictEqual(region.resolution.point, [200, 180]);

const element = locate(fixture.execDir, {
  id: 'element', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'ELEMENT_REF', elementRef: 'lock-button' },
}, context);
assert.deepStrictEqual(element.resolution.point, [100, 270]);
assert.strictEqual(element.resolution.confidence, 'STRUCTURAL');

assert.throws(() => locate(fixture.execDir, {
  id: 'missing', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'ELEMENT_REF', elementRef: 'missing' },
}, context), (error) => error.code === 'TARGET_NOT_FOUND');
assert.throws(() => locate(fixture.execDir, {
  id: 'template', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'TEMPLATE' },
}, context), (error) => error.code === 'LOCATOR_UNSUPPORTED');

console.log('plan locator passed');

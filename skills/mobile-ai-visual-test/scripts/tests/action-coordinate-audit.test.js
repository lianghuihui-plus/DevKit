#!/usr/bin/env node
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { buildCoordinateAudit } = require('../lib/action-coordinate-audit');

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-coordinate-audit-'));

function validated(action, operationId = 'action-audit') {
  return { action, request: { operationId } };
}

const point = buildCoordinateAudit(execDir, validated({
  type: 'tap', x: 120, y: 240, coordinateSource: 'layout',
}), {
  executedPoint: { x: 120, y: 240 },
});
assert.strictEqual(point.consistency, 'MATCHED');
assert.deepStrictEqual(point.executed.point, { x: 120, y: 240 });

const iosLayoutPoint = buildCoordinateAudit(execDir, validated({
  type: 'tap', x: 120, y: 240, coordinateSource: 'layout',
}), {
  platform: 'ios',
  executedPoint: { x: 120, y: 240, viewport: { width: 393, height: 852 } },
});
assert.deepStrictEqual(iosLayoutPoint.viewport, { width: 393, height: 852 });
assert.throws(() => buildCoordinateAudit(execDir, validated({
  type: 'tap', x: 120, y: 240, coordinateSource: 'layout',
}), {
  platform: 'ios',
  executedPoint: { x: 120, y: 240 },
}), (error) => error.code === 'DEVICE_ADAPTER_OUTPUT_INVALID');

const transformed = buildCoordinateAudit(execDir, validated({
  type: 'tap', x: 200, y: 400, coordinateSource: 'visual',
}), {
  executedPoint: {
    x: 100, y: 200,
    screenshot: { width: 1000, height: 2000 },
    viewport: { width: 500, height: 1000 },
  },
});
assert.deepStrictEqual(transformed.expectedExecuted.point, { x: 100, y: 200 });

assert.throws(() => buildCoordinateAudit(execDir, validated({
  type: 'tap', x: 200, y: 400, coordinateSource: 'visual',
}), {
  executedPoint: {
    x: 101, y: 200,
    screenshot: { width: 1000, height: 2000 },
    viewport: { width: 500, height: 1000 },
  },
}), (error) => error.code === 'DEVICE_EXECUTED_COORDINATE_MISMATCH');

assert.throws(() => buildCoordinateAudit(execDir, validated({
  type: 'tap', x: 200, y: 400, coordinateSource: 'visual',
}), {
  executedPoint: {
    x: 500, y: 200,
    screenshot: { width: 200, height: 400 },
    viewport: { width: 500, height: 1000 },
  },
}), (error) => error.code === 'DEVICE_EXECUTED_COORDINATE_OUT_OF_RANGE');

const swipe = buildCoordinateAudit(execDir, validated({
  type: 'swipe', fromX: 800, fromY: 500, toX: 200, toY: 500, coordinateSource: 'visual',
}), {
  executedFrom: {
    x: 400, y: 250,
    screenshot: { width: 1000, height: 1000 },
    viewport: { width: 500, height: 500 },
  },
  executedTo: { x: 100, y: 250 },
});
assert.deepStrictEqual(swipe.executed.to, { x: 100, y: 250 });

console.log('action-coordinate-audit passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { buildCoordinateAudit } = require('../lib/action-coordinate-audit');
const { validateCaseRuntimeEvidenceGraph } = require('../case-runtime/result-integrity');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-coordinate-audit-'));

function validated(action, operationId = 'action-audit') {
  return { action, operationId, request: {} };
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

const screenshotRef = 'screenshots/scene-0001.png';
fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(execDir, screenshotRef), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
fs.writeFileSync(path.join(execDir, 'current-scene.json'), JSON.stringify({ screenshot: { ref: screenshotRef } }));
const firstOverlay = buildCoordinateAudit(execDir, {
  ...validated({ type: 'tap', x: 0, y: 0, coordinateSource: 'visual' }, 'action-0001'),
  request: { basisObservationRef: screenshotRef },
}, { executedPoint: { x: 0, y: 0 } });
const secondOverlay = buildCoordinateAudit(execDir, {
  ...validated({ type: 'tap', x: 0, y: 0, coordinateSource: 'visual' }, 'action-0002'),
  request: { basisObservationRef: screenshotRef },
}, { executedPoint: { x: 0, y: 0 } });
assert.strictEqual(firstOverlay.overlayRef, 'coordinate-audits/action-0001.svg');
assert.strictEqual(secondOverlay.overlayRef, 'coordinate-audits/action-0002.svg');
assert.strictEqual(fs.existsSync(path.join(execDir, firstOverlay.overlayRef)), true);
assert.strictEqual(fs.existsSync(path.join(execDir, secondOverlay.overlayRef)), true);
assert.strictEqual(fs.existsSync(path.join(execDir, 'coordinate-audits', 'undefined.svg')), false);

assert.throws(() => buildCoordinateAudit(execDir, {
  action: { type: 'tap', x: 0, y: 0, coordinateSource: 'visual' },
  request: { basisObservationRef: screenshotRef },
}, { executedPoint: { x: 0, y: 0 } }), (error) => error.code === 'ACTION_COORDINATE_AUDIT_INVALID');

const graphRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-coordinate-graph-')), 'workspace');
createTestWorkspace(graphRoot);
const fixture = createCurrentFixture(graphRoot, { verdict: 'PASS', suffix: 'coordinate-graph' });
const eventsPath = path.join(fixture.execDir, 'events.jsonl');
const graphEvents = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const completed = graphEvents.find((event) => event.type === 'actionCompleted');
completed.coordinateAudit.overlayRef = 'coordinate-audits/wrong-action.svg';
fs.writeFileSync(eventsPath, `${graphEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
assert.throws(() => validateCaseRuntimeEvidenceGraph(fixture.execDir, fixture.result),
  (error) => error.code === 'ACTION_COORDINATE_AUDIT_INVALID');
completed.coordinateAudit.overlayRef = `coordinate-audits/${completed.operationId}.svg`;
fs.mkdirSync(path.join(fixture.execDir, 'coordinate-audits'), { recursive: true });
fs.writeFileSync(path.join(fixture.execDir, completed.coordinateAudit.overlayRef), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
fs.writeFileSync(eventsPath, `${graphEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
assert.ok(validateCaseRuntimeEvidenceGraph(fixture.execDir, fixture.result).files.includes(completed.coordinateAudit.overlayRef));

console.log('action-coordinate-audit passed');

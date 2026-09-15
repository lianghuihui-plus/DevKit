#!/usr/bin/env node
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  createActionSpatialEvidence,
  projectActionSpatialEvidence,
  readActionSpatialEvidence,
} = require('../lib/action-spatial-evidence');
const { inspectPng } = require('../lib/image-evidence');
const { validateCaseRuntimeEvidenceGraph } = require('../case-runtime/result-integrity');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';

function executionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-action-spatial-evidence-'));
}

function validated(action, operationId = 'action-0001') {
  return { action, operationId, request: {} };
}

function adapterResult(deviceExecution, platform = null) {
  return { ...(platform ? { platform } : {}), deviceExecution };
}

function create(execDir, request, result) {
  const ref = createActionSpatialEvidence(execDir, request, result);
  return { ref, evidence: readActionSpatialEvidence(execDir, ref) };
}

const point = create(executionDir(), validated({
  type: 'tap', x: 120, y: 240, coordinateSource: 'layout',
}), adapterResult({ dispatchedPoint: { x: 120, y: 240 }, actualTouchPoint: null }));
assert.strictEqual(point.evidence.consistency, 'MATCHED');
assert.strictEqual(point.evidence.certainty, 'DISPATCH_ONLY');
assert.deepStrictEqual(point.evidence.dispatched.point, { x: 120, y: 240 });

const actual = create(executionDir(), validated({
  type: 'longPress', x: 120, y: 240, coordinateSource: 'layout',
}), adapterResult({ dispatchedPoint: { x: 120, y: 240 }, actualTouchPoint: { x: 121, y: 241 } }));
assert.strictEqual(actual.evidence.certainty, 'DEVICE_CONFIRMED');
assert.deepStrictEqual(actual.evidence.actual.point, { x: 121, y: 241 });

const iosLayoutPoint = create(executionDir(), validated({
  type: 'tap', x: 120, y: 240, coordinateSource: 'layout',
}), adapterResult({ dispatchedPoint: { x: 120, y: 240, viewport: { width: 393, height: 852 } } }, 'ios'));
assert.deepStrictEqual(iosLayoutPoint.evidence.viewport, { width: 393, height: 852 });
assert.throws(() => createActionSpatialEvidence(executionDir(), validated({
  type: 'tap', x: 120, y: 240, coordinateSource: 'layout',
}), adapterResult({ dispatchedPoint: { x: 120, y: 240 } }, 'ios')), (error) => error.code === 'DEVICE_ADAPTER_OUTPUT_INVALID');

const transformed = create(executionDir(), validated({
  type: 'tap', x: 200, y: 400, coordinateSource: 'visual',
}), adapterResult({
  dispatchedPoint: {
    x: 100, y: 200,
    screenshot: { width: 1000, height: 2000 },
    viewport: { width: 500, height: 1000 },
  },
}));
assert.deepStrictEqual(transformed.evidence.expectedDispatched.point, { x: 100, y: 200 });

assert.throws(() => createActionSpatialEvidence(executionDir(), validated({
  type: 'tap', x: 200, y: 400, coordinateSource: 'visual',
}), adapterResult({
  dispatchedPoint: {
    x: 101, y: 200,
    screenshot: { width: 1000, height: 2000 },
    viewport: { width: 500, height: 1000 },
  },
})), (error) => error.code === 'DEVICE_DISPATCHED_COORDINATE_MISMATCH');

assert.throws(() => createActionSpatialEvidence(executionDir(), validated({
  type: 'tap', x: 200, y: 400, coordinateSource: 'visual',
}), adapterResult({
  dispatchedPoint: {
    x: 500, y: 200,
    screenshot: { width: 200, height: 400 },
    viewport: { width: 500, height: 1000 },
  },
})), (error) => error.code === 'DEVICE_DISPATCHED_COORDINATE_OUT_OF_RANGE');

const swipe = create(executionDir(), validated({
  type: 'swipe', fromX: 800, fromY: 500, toX: 200, toY: 500, coordinateSource: 'visual',
}), adapterResult({
  dispatchedFrom: {
    x: 400, y: 250,
    screenshot: { width: 1000, height: 1000 },
    viewport: { width: 500, height: 500 },
  },
  dispatchedTo: { x: 100, y: 250 },
}));
assert.deepStrictEqual(swipe.evidence.dispatched.to, { x: 100, y: 250 });

const annotatedDir = executionDir();
const screenshotRef = 'screenshots/scene-0001.png';
fs.mkdirSync(path.join(annotatedDir, 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(annotatedDir, screenshotRef), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const annotatedRef = createActionSpatialEvidence(annotatedDir, {
  ...validated({ type: 'tap', x: 0, y: 0, coordinateSource: 'visual' }),
  request: { basisObservationRef: screenshotRef },
}, adapterResult({ dispatchedPoint: { x: 0, y: 0 } }));
const annotated = readActionSpatialEvidence(annotatedDir, annotatedRef);
assert.strictEqual(annotatedRef, 'action-spatial-evidence/action-0001.json');
assert.strictEqual(annotated.annotatedScreenshotRef, 'action-spatial-evidence/action-0001.png');
assert.strictEqual(inspectPng(path.join(annotatedDir, annotated.annotatedScreenshotRef)).decodeStatus, 'VALID');
const projection = projectActionSpatialEvidence(annotatedDir, annotatedRef, { operationId: 'action-0001', actionType: 'tap' });
assert.strictEqual(projection.annotatedScreenshot.attachment.mediaType, 'image/png');
assert.strictEqual(projection.annotatedScreenshot.tool, 'view_image');
assert.strictEqual(fs.existsSync(projection.annotatedScreenshot.path), true);
assert.strictEqual(projection.coordinateTransform, 'MATCHED');
assert.strictEqual(projection.deviceActual, null);
assert.strictEqual(projection.consistency, undefined);
assert.strictEqual(projection.actual, undefined);

assert.throws(() => createActionSpatialEvidence(annotatedDir, {
  ...validated({ type: 'tap', x: 0, y: 0, coordinateSource: 'visual', targetBounds: [0, null, 1, 1] }, 'action-0002'),
  request: { basisObservationRef: screenshotRef },
}, adapterResult({ dispatchedPoint: { x: 0, y: 0 } })), (error) => error.code === 'ACTION_SPATIAL_EVIDENCE_INVALID');
assert.strictEqual(fs.existsSync(path.join(annotatedDir, 'action-spatial-evidence', 'action-0002.png')), false);

assert.throws(() => createActionSpatialEvidence(executionDir(), {
  action: { type: 'tap', x: 0, y: 0, coordinateSource: 'visual' },
  request: { basisObservationRef: screenshotRef },
}, adapterResult({ dispatchedPoint: { x: 0, y: 0 } })), (error) => error.code === 'ACTION_SPATIAL_EVIDENCE_INVALID');

const graphRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-spatial-graph-')), 'workspace');
createTestWorkspace(graphRoot);
const fixture = createCurrentFixture(graphRoot, { verdict: 'PASS', suffix: 'spatial-graph' });
const eventsPath = path.join(fixture.execDir, 'events.jsonl');
const graphEvents = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const completed = graphEvents.find((event) => event.type === 'actionCompleted');
completed.spatialEvidenceRef = 'action-spatial-evidence/wrong-action.json';
fs.writeFileSync(eventsPath, `${graphEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
assert.throws(() => validateCaseRuntimeEvidenceGraph(fixture.execDir, fixture.result),
  (error) => error.code === 'ACTION_SPATIAL_EVIDENCE_INVALID');
completed.spatialEvidenceRef = `action-spatial-evidence/${completed.operationId}.json`;
fs.writeFileSync(eventsPath, `${graphEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
const graph = validateCaseRuntimeEvidenceGraph(fixture.execDir, fixture.result);
assert.ok(graph.files.includes(completed.spatialEvidenceRef));
assert.ok(graph.files.includes(`action-spatial-evidence/${completed.operationId}.svg`));

console.log('action-spatial-evidence passed');

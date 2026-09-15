#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const { encodePngRgba, inspectPng, readPngRgba } = require('./image-evidence');
const { isSafeRelativeArtifact, resolveArtifact } = require('./execution-evidence');
const { atomicWrite, writeJsonAtomic } = require('./execution-lifecycle');

const EVIDENCE_DIR = 'action-spatial-evidence';
const POINT_ACTIONS = new Set(['tap', 'doubleTap', 'toggle', 'longPress', 'inputText']);

function finitePoint(value, field) {
  if (!value || value.x === null || value.x === undefined || value.x === ''
    || value.y === null || value.y === undefined || value.y === '') {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', `${field} must contain finite x and y coordinates`);
  }
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', `${field} must contain finite x and y coordinates`);
  }
  return { x, y };
}

function samePoint(left, right) {
  return left.x === right.x && left.y === right.y;
}

function executionViewport(value) {
  if (!value) return null;
  const viewport = { width: Number(value.width), height: Number(value.height) };
  if (![viewport.width, viewport.height].every((number) => Number.isFinite(number) && number > 0)) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'execution viewport must contain positive width and height');
  }
  return viewport;
}

function expectedDispatchedPoint(requested, source, dispatched) {
  if (source !== 'visual' || !dispatched.screenshot || !dispatched.viewport) return requested;
  const screenshot = {
    width: Number(dispatched.screenshot.width),
    height: Number(dispatched.screenshot.height),
  };
  const viewport = {
    width: Number(dispatched.viewport.width),
    height: Number(dispatched.viewport.height),
  };
  if (![screenshot.width, screenshot.height, viewport.width, viewport.height]
    .every((value) => Number.isFinite(value) && value > 0)) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'visual coordinate execution must identify valid screenshot and viewport sizes');
  }
  return {
    x: Math.round(requested.x * viewport.width / screenshot.width),
    y: Math.round(requested.y * viewport.height / screenshot.height),
  };
}

function assertInside(point, viewport, field) {
  if (!viewport) return;
  if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) {
    throw contractError('DEVICE_DISPATCHED_COORDINATE_OUT_OF_RANGE', `${field} is outside the execution viewport`, {
      dispatchedPoint: point,
      viewport,
    });
  }
}

function pointEvidence(action, adapterResult) {
  validateBounds(action.targetBounds);
  const requested = finitePoint({ x: action.x, y: action.y }, 'requested point');
  const source = adapterResult.deviceExecution?.dispatchedPoint;
  const dispatched = finitePoint(source, 'dispatchedPoint');
  const expected = expectedDispatchedPoint(requested, action.coordinateSource, source);
  const viewport = executionViewport(source?.viewport);
  assertInside(dispatched, viewport, 'dispatchedPoint');
  if (!samePoint(expected, dispatched)) {
    throw contractError('DEVICE_DISPATCHED_COORDINATE_MISMATCH', 'adapter dispatchedPoint does not match the required coordinate transformation', {
      requestedPoint: requested,
      expectedDispatchedPoint: expected,
      dispatchedPoint: dispatched,
    });
  }
  const actualPoint = adapterResult.deviceExecution?.actualTouchPoint
    ? finitePoint(adapterResult.deviceExecution.actualTouchPoint, 'actualTouchPoint')
    : null;
  if (actualPoint) assertInside(actualPoint, viewport, 'actualTouchPoint');
  return {
    kind: 'POINT',
    requested: { point: requested, ...(Array.isArray(action.targetBounds) ? { bounds: action.targetBounds.map(Number) } : {}) },
    expectedDispatched: { point: expected },
    dispatched: { point: dispatched },
    actual: actualPoint ? { point: actualPoint } : null,
    viewport,
  };
}

function gestureEvidence(action, adapterResult) {
  validateBounds(action.targetBounds);
  const requestedFrom = finitePoint({ x: action.fromX, y: action.fromY }, 'requested from point');
  const requestedTo = finitePoint({ x: action.toX, y: action.toY }, 'requested to point');
  const sourceFrom = adapterResult.deviceExecution?.dispatchedFrom;
  const sourceTo = adapterResult.deviceExecution?.dispatchedTo;
  const dispatchedFrom = finitePoint(sourceFrom, 'dispatchedFrom');
  const dispatchedTo = finitePoint(sourceTo, 'dispatchedTo');
  const expectedFrom = expectedDispatchedPoint(requestedFrom, action.coordinateSource, sourceFrom);
  const transformBasis = sourceFrom?.screenshot && sourceFrom?.viewport
    ? { screenshot: sourceFrom.screenshot, viewport: sourceFrom.viewport }
    : sourceTo;
  const expectedTo = expectedDispatchedPoint(requestedTo, action.coordinateSource, transformBasis || {});
  const viewport = executionViewport(sourceFrom?.viewport);
  assertInside(dispatchedFrom, viewport, 'dispatchedFrom');
  assertInside(dispatchedTo, viewport, 'dispatchedTo');
  if (!samePoint(expectedFrom, dispatchedFrom) || !samePoint(expectedTo, dispatchedTo)) {
    throw contractError('DEVICE_DISPATCHED_COORDINATE_MISMATCH', 'adapter swipe coordinates do not match the required coordinate transformation', {
      requestedFrom,
      requestedTo,
      expectedFrom,
      expectedTo,
      dispatchedFrom,
      dispatchedTo,
    });
  }
  return {
    kind: 'GESTURE',
    requested: {
      from: requestedFrom,
      to: requestedTo,
      ...(Array.isArray(action.targetBounds) ? { bounds: action.targetBounds.map(Number) } : {}),
    },
    expectedDispatched: { from: expectedFrom, to: expectedTo },
    dispatched: { from: dispatchedFrom, to: dispatchedTo },
    actual: null,
    viewport,
  };
}

function basisScreenshot(execDir, basisObservationRef) {
  if (!isSafeRelativeArtifact(basisObservationRef)) return null;
  const file = resolveArtifact(execDir, basisObservationRef);
  if (!fs.existsSync(file)) return null;
  const image = inspectPng(file);
  return image.decodeStatus === 'VALID'
    ? { ref: basisObservationRef, width: image.width, height: image.height }
    : null;
}

function screenshotPoint(point, evidence, screenshot) {
  const viewport = evidence.viewport;
  if (!viewport || (viewport.width === screenshot.width && viewport.height === screenshot.height)) return point;
  return {
    x: point.x * screenshot.width / viewport.width,
    y: point.y * screenshot.height / viewport.height,
  };
}

function markerPoints(value, kind) {
  if (!value) return [];
  return kind === 'POINT' ? [value.point] : [value.from, value.to];
}

function validateBounds(bounds) {
  if (bounds === undefined) return;
  if (!Array.isArray(bounds) || bounds.length !== 4
    || !bounds.every((number) => number !== null && number !== '' && Number.isFinite(Number(number)))) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'action spatial evidence bounds must contain four finite coordinates');
  }
  if (Number(bounds[2]) <= Number(bounds[0]) || Number(bounds[3]) <= Number(bounds[1])) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'action spatial evidence bounds must have positive width and height');
  }
}

const MARKER_COLORS = Object.freeze({
  requested: [37, 99, 235, 255],
  dispatched: [245, 158, 11, 255],
  actual: [22, 163, 74, 255],
});

function paintDisc(image, centerX, centerY, radius, color) {
  const x0 = Math.max(0, Math.floor(centerX - radius));
  const x1 = Math.min(image.width - 1, Math.ceil(centerX + radius));
  const y0 = Math.max(0, Math.floor(centerY - radius));
  const y1 = Math.min(image.height - 1, Math.ceil(centerY + radius));
  const squaredRadius = radius * radius;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > squaredRadius) continue;
      const offset = (y * image.width + x) * 4;
      image.pixels[offset] = color[0];
      image.pixels[offset + 1] = color[1];
      image.pixels[offset + 2] = color[2];
      image.pixels[offset + 3] = color[3];
    }
  }
}

function drawLine(image, from, to, stroke, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const brush = Math.max(1, stroke / 2);
  for (let index = 0; index <= steps; index++) {
    const progress = index / steps;
    paintDisc(image, from.x + dx * progress, from.y + dy * progress, brush, color);
  }
}

function drawDashedLine(image, from, to, stroke, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const dash = stroke * 3;
  const gap = stroke * 2;
  for (let offset = 0; offset < length; offset += dash + gap) {
    const end = Math.min(length, offset + dash);
    drawLine(image,
      { x: from.x + dx * offset / length, y: from.y + dy * offset / length },
      { x: from.x + dx * end / length, y: from.y + dy * end / length },
      stroke, color);
  }
}

function drawCircle(image, point, radius, stroke, color) {
  const segments = Math.max(48, Math.ceil(2 * Math.PI * radius));
  let prior = { x: point.x + radius, y: point.y };
  for (let index = 1; index <= segments; index++) {
    const angle = 2 * Math.PI * index / segments;
    const next = { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius };
    drawLine(image, prior, next, stroke, color);
    prior = next;
  }
}

function drawArrow(image, from, to, stroke, color) {
  drawLine(image, from, to, stroke, color);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.max(stroke * 5, 12);
  for (const side of [-1, 1]) {
    const arrowAngle = angle + Math.PI + side * Math.PI / 6;
    drawLine(image, to, {
      x: to.x + Math.cos(arrowAngle) * length,
      y: to.y + Math.sin(arrowAngle) * length,
    }, stroke, color);
  }
}

function drawBounds(image, bounds, stroke) {
  if (!bounds) return;
  const [left, top, right, bottom] = bounds;
  drawDashedLine(image, { x: left, y: top }, { x: right, y: top }, stroke, MARKER_COLORS.requested);
  drawDashedLine(image, { x: right, y: top }, { x: right, y: bottom }, stroke, MARKER_COLORS.requested);
  drawDashedLine(image, { x: right, y: bottom }, { x: left, y: bottom }, stroke, MARKER_COLORS.requested);
  drawDashedLine(image, { x: left, y: bottom }, { x: left, y: top }, stroke, MARKER_COLORS.requested);
}

function writeAnnotatedScreenshot(execDir, evidence) {
  const screenshot = evidence.screenshot;
  const ref = path.posix.join(EVIDENCE_DIR, `${evidence.operationId}.png`);
  const file = resolveArtifact(execDir, ref);
  const requestedRaw = markerPoints(evidence.requested, evidence.kind);
  const requested = evidence.source === 'visual'
    ? requestedRaw
    : requestedRaw.map((point) => screenshotPoint(point, evidence, screenshot));
  const dispatched = markerPoints(evidence.dispatched, evidence.kind)
    .map((point) => screenshotPoint(point, evidence, screenshot));
  const actual = markerPoints(evidence.actual, evidence.kind)
    .map((point) => screenshotPoint(point, evidence, screenshot));
  const radius = Math.max(8, Math.round(Math.min(screenshot.width, screenshot.height) * 0.012));
  const stroke = Math.max(3, Math.round(radius / 4));
  const image = readPngRgba(resolveArtifact(execDir, screenshot.ref));
  const bounds = evidence.requested.bounds && evidence.source !== 'visual'
    ? [
      screenshotPoint({ x: evidence.requested.bounds[0], y: evidence.requested.bounds[1] }, evidence, screenshot),
      screenshotPoint({ x: evidence.requested.bounds[2], y: evidence.requested.bounds[3] }, evidence, screenshot),
    ].flatMap((point) => [point.x, point.y])
    : evidence.requested.bounds;
  drawBounds(image, bounds, stroke);
  if (evidence.kind === 'GESTURE') {
    drawArrow(image, requested[0], requested[1], stroke, MARKER_COLORS.requested);
    drawArrow(image, dispatched[0], dispatched[1], stroke, MARKER_COLORS.dispatched);
  }
  for (const point of requested) drawCircle(image, point, radius, stroke, MARKER_COLORS.requested);
  for (const point of dispatched) {
    drawLine(image, { x: point.x - radius, y: point.y }, { x: point.x + radius, y: point.y }, stroke, MARKER_COLORS.dispatched);
    drawLine(image, { x: point.x, y: point.y - radius }, { x: point.x, y: point.y + radius }, stroke, MARKER_COLORS.dispatched);
  }
  for (const point of actual) {
    const extent = radius * 0.85;
    drawLine(image, { x: point.x, y: point.y - extent }, { x: point.x + extent, y: point.y }, stroke, MARKER_COLORS.actual);
    drawLine(image, { x: point.x + extent, y: point.y }, { x: point.x, y: point.y + extent }, stroke, MARKER_COLORS.actual);
    drawLine(image, { x: point.x, y: point.y + extent }, { x: point.x - extent, y: point.y }, stroke, MARKER_COLORS.actual);
    drawLine(image, { x: point.x - extent, y: point.y }, { x: point.x, y: point.y - extent }, stroke, MARKER_COLORS.actual);
  }
  atomicWrite(file, encodePngRgba(image));
  return ref;
}

function evidenceRef(operationId) {
  if (typeof operationId !== 'string' || !/^action-\d+$/.test(operationId)) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'action spatial evidence requires a valid action operationId');
  }
  return path.posix.join(EVIDENCE_DIR, `${operationId}.json`);
}

function createActionSpatialEvidence(execDir, validated, adapterResult) {
  const action = validated.action;
  const hasPoint = POINT_ACTIONS.has(action.type) && action.x !== undefined && action.y !== undefined;
  const hasGesture = action.type === 'swipe';
  if (!hasPoint && !hasGesture) return null;
  const detail = hasGesture ? gestureEvidence(action, adapterResult) : pointEvidence(action, adapterResult);
  if (adapterResult.platform === 'ios' && !detail.viewport) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'iOS coordinate execution must identify the Appium viewport');
  }
  const screenshot = basisScreenshot(execDir, validated.request?.basisObservationRef);
  if (screenshot && screenshot.width > 1 && screenshot.height > 1 && !detail.viewport) {
    detail.viewport = { width: screenshot.width, height: screenshot.height };
  }
  if (screenshot && action.coordinateSource === 'visual') {
    const adapterScreenshot = hasGesture
      ? adapterResult.deviceExecution?.dispatchedFrom?.screenshot
      : adapterResult.deviceExecution?.dispatchedPoint?.screenshot;
    if (adapterScreenshot && (Number(adapterScreenshot.width) !== screenshot.width
      || Number(adapterScreenshot.height) !== screenshot.height)) {
      throw contractError('DEVICE_DISPATCHED_COORDINATE_MISMATCH', 'adapter transformed coordinates from a different screenshot size than the frozen basis observation');
    }
  }
  if (detail.viewport) {
    for (const point of markerPoints(detail.dispatched, detail.kind)) assertInside(point, detail.viewport, 'dispatched coordinate');
    for (const point of markerPoints(detail.actual, detail.kind)) assertInside(point, detail.viewport, 'actual coordinate');
  }
  const ref = evidenceRef(validated.operationId);
  const file = resolveArtifact(execDir, ref);
  if (fs.existsSync(file)) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_EXISTS', `action spatial evidence already exists: ${ref}`);
  }
  const evidence = {
    schemaVersion: 1,
    type: 'actionSpatialEvidence',
    operationId: validated.operationId,
    actionType: action.type,
    source: action.coordinateSource,
    ...detail,
    certainty: detail.actual ? 'DEVICE_CONFIRMED' : 'DISPATCH_ONLY',
    ...(screenshot ? { screenshot } : {}),
    consistency: 'MATCHED',
    annotatedScreenshotRef: screenshot
      ? path.posix.join(EVIDENCE_DIR, `${validated.operationId}.png`)
      : null,
  };
  validateActionSpatialEvidence(evidence, { operationId: validated.operationId, actionType: action.type, ref });
  if (screenshot) writeAnnotatedScreenshot(execDir, evidence);
  writeJsonAtomic(file, evidence);
  return ref;
}

function validateActionSpatialEvidence(value, expected = {}) {
  if (!value || value.schemaVersion !== 1 || value.type !== 'actionSpatialEvidence'
    || !/^action-\d+$/.test(String(value.operationId || ''))
    || !['POINT', 'GESTURE'].includes(value.kind)
    || (value.kind === 'POINT' ? !POINT_ACTIONS.has(value.actionType) : value.actionType !== 'swipe')
    || !['layout', 'visual', 'pixel'].includes(value.source)
    || !['DISPATCH_ONLY', 'DEVICE_CONFIRMED'].includes(value.certainty)
    || value.consistency !== 'MATCHED') {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'action spatial evidence identity or state is invalid');
  }
  if (expected.operationId && value.operationId !== expected.operationId) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence does not match operation ${expected.operationId}`);
  }
  if (expected.actionType && value.actionType !== expected.actionType) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence action type does not match ${expected.actionType}`);
  }
  if (expected.ref && expected.ref !== evidenceRef(value.operationId)) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence reference does not match operation ${value.operationId}`);
  }
  const fields = value.kind === 'POINT' ? ['point'] : ['from', 'to'];
  for (const group of ['requested', 'expectedDispatched', 'dispatched']) {
    for (const field of fields) finitePoint(value[group]?.[field], `${group}.${field}`);
  }
  validateBounds(value.requested?.bounds);
  for (const field of fields) {
    if (!samePoint(finitePoint(value.expectedDispatched[field], `expectedDispatched.${field}`),
      finitePoint(value.dispatched[field], `dispatched.${field}`))) {
      throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'persisted dispatched coordinates do not match the validated expectation');
    }
  }
  if (value.actual) for (const field of fields) finitePoint(value.actual[field], `actual.${field}`);
  if ((value.actual && value.certainty !== 'DEVICE_CONFIRMED')
    || (!value.actual && value.certainty !== 'DISPATCH_ONLY')) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'action spatial evidence certainty does not match actual device feedback');
  }
  if (value.screenshot) {
    const supportedAnnotatedRefs = [
      path.posix.join(EVIDENCE_DIR, `${value.operationId}.png`),
      path.posix.join(EVIDENCE_DIR, `${value.operationId}.svg`),
    ];
    if (!isSafeRelativeArtifact(value.screenshot.ref)
      || ![value.screenshot.width, value.screenshot.height].every((number) => Number.isFinite(Number(number)) && Number(number) > 0)
      || !supportedAnnotatedRefs.includes(value.annotatedScreenshotRef)) {
      throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'action spatial evidence screenshot metadata is invalid');
    }
  } else if (value.annotatedScreenshotRef !== null) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', 'annotated screenshot requires a basis screenshot');
  }
  return value;
}

function readActionSpatialEvidence(execDir, ref, options = {}) {
  if (!isSafeRelativeArtifact(ref) || ref !== evidenceRef(options.operationId || path.basename(String(ref), '.json'))) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `invalid action spatial evidence reference: ${ref}`);
  }
  const file = resolveArtifact(execDir, ref);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_MISSING', `action spatial evidence is missing: ${ref}`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence is not valid JSON: ${ref}`);
  }
  validateActionSpatialEvidence(value, { ...options, ref });
  if (options.verifyArtifacts !== false) {
    for (const artifactRef of [value.screenshot?.ref, value.annotatedScreenshotRef].filter(Boolean)) {
      const artifact = resolveArtifact(execDir, artifactRef);
      if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
        throw contractError('ACTION_SPATIAL_EVIDENCE_MISSING', `action spatial evidence artifact is missing: ${artifactRef}`);
      }
    }
    if (value.screenshot && options.verifyContent === true) {
      const image = inspectPng(resolveArtifact(execDir, value.screenshot.ref));
      if (image.decodeStatus !== 'VALID' || image.width !== Number(value.screenshot.width)
        || image.height !== Number(value.screenshot.height)) {
        throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence screenshot metadata disagrees with ${value.screenshot.ref}`);
      }
      const annotatedPath = resolveArtifact(execDir, value.annotatedScreenshotRef);
      if (path.extname(value.annotatedScreenshotRef) === '.png') {
        const annotated = inspectPng(annotatedPath);
        if (annotated.decodeStatus !== 'VALID' || annotated.width !== Number(value.screenshot.width)
          || annotated.height !== Number(value.screenshot.height)) {
          throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `annotated action screenshot is invalid: ${value.annotatedScreenshotRef}`);
        }
      } else {
        const svg = fs.readFileSync(annotatedPath, 'utf8');
        if (!/^<svg\b/.test(svg) || !svg.includes('<image href="data:image/png;base64,')) {
          throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `annotated action screenshot is not self-contained: ${value.annotatedScreenshotRef}`);
        }
      }
    }
  }
  return value;
}

function projectActionSpatialEvidence(execDir, ref, options = {}) {
  if (!ref) return null;
  const value = readActionSpatialEvidence(execDir, ref, options);
  const annotatedScreenshot = value.annotatedScreenshotRef ? {
    ref: value.annotatedScreenshotRef,
    tool: 'view_image',
    path: resolveArtifact(execDir, value.annotatedScreenshotRef),
    attachment: {
      type: 'image',
      mediaType: path.extname(value.annotatedScreenshotRef) === '.png' ? 'image/png' : 'image/svg+xml',
      path: resolveArtifact(execDir, value.annotatedScreenshotRef),
    },
  } : null;
  return {
    schemaVersion: value.schemaVersion,
    type: value.type,
    ref,
    operationId: value.operationId,
    actionType: value.actionType,
    source: value.source,
    kind: value.kind,
    certainty: value.certainty,
    requested: value.requested,
    dispatched: value.dispatched,
    deviceActual: value.actual,
    screenshot: value.screenshot || null,
    viewport: value.viewport || null,
    coordinateTransform: value.consistency,
    annotatedScreenshot,
  };
}

module.exports = {
  EVIDENCE_DIR,
  createActionSpatialEvidence,
  evidenceRef,
  projectActionSpatialEvidence,
  readActionSpatialEvidence,
  validateActionSpatialEvidence,
};

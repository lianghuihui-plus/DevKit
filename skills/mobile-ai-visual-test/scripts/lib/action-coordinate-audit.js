'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const { inspectPng } = require('./image-evidence');
const { isSafeRelativeArtifact, resolveArtifact } = require('./execution-evidence');

const POINT_ACTIONS = new Set(['tap', 'toggle', 'longPress', 'inputText']);

function finitePoint(value, field) {
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

function expectedExecutedPoint(requested, source, executed) {
  if (source !== 'visual' || !executed.screenshot || !executed.viewport) return requested;
  const screenshot = {
    width: Number(executed.screenshot.width),
    height: Number(executed.screenshot.height),
  };
  const viewport = {
    width: Number(executed.viewport.width),
    height: Number(executed.viewport.height),
  };
  if (![screenshot.width, screenshot.height, viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0)) {
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
    throw contractError('DEVICE_EXECUTED_COORDINATE_OUT_OF_RANGE', `${field} is outside the execution viewport`, {
      executedPoint: point,
      viewport,
    });
  }
}

function auditPoint(action, adapterResult) {
  const requested = finitePoint({ x: action.x, y: action.y }, 'requested point');
  const executed = finitePoint(adapterResult.executedPoint, 'executedPoint');
  const expected = expectedExecutedPoint(requested, action.coordinateSource, adapterResult.executedPoint);
  const viewport = executionViewport(adapterResult.executedPoint?.viewport);
  assertInside(executed, viewport, 'executedPoint');
  if (!samePoint(expected, executed)) {
    throw contractError('DEVICE_EXECUTED_COORDINATE_MISMATCH', 'adapter executedPoint does not match the required coordinate transformation', {
      requestedPoint: requested,
      expectedExecutedPoint: expected,
      executedPoint: executed,
    });
  }
  return {
    kind: 'POINT',
    requested: { point: requested, ...(Array.isArray(action.targetBounds) ? { bounds: action.targetBounds.map(Number) } : {}) },
    executed: { point: executed },
    expectedExecuted: { point: expected },
    viewport,
  };
}

function auditSwipe(action, adapterResult) {
  const requestedFrom = finitePoint({ x: action.fromX, y: action.fromY }, 'requested from point');
  const requestedTo = finitePoint({ x: action.toX, y: action.toY }, 'requested to point');
  const executedFrom = finitePoint(adapterResult.executedFrom, 'executedFrom');
  const executedTo = finitePoint(adapterResult.executedTo, 'executedTo');
  const expectedFrom = expectedExecutedPoint(requestedFrom, action.coordinateSource, adapterResult.executedFrom);
  const transformBasis = adapterResult.executedFrom?.screenshot && adapterResult.executedFrom?.viewport
    ? { screenshot: adapterResult.executedFrom.screenshot, viewport: adapterResult.executedFrom.viewport }
    : adapterResult.executedTo;
  const expectedTo = expectedExecutedPoint(requestedTo, action.coordinateSource, transformBasis || {});
  const viewport = executionViewport(adapterResult.executedFrom?.viewport);
  assertInside(executedFrom, viewport, 'executedFrom');
  assertInside(executedTo, viewport, 'executedTo');
  if (!samePoint(expectedFrom, executedFrom) || !samePoint(expectedTo, executedTo)) {
    throw contractError('DEVICE_EXECUTED_COORDINATE_MISMATCH', 'adapter swipe coordinates do not match the required coordinate transformation', {
      requestedFrom,
      requestedTo,
      expectedFrom,
      expectedTo,
      executedFrom,
      executedTo,
    });
  }
  return {
    kind: 'GESTURE',
    requested: {
      from: requestedFrom,
      to: requestedTo,
      ...(Array.isArray(action.targetBounds) ? { bounds: action.targetBounds.map(Number) } : {}),
    },
    executed: { from: executedFrom, to: executedTo },
    expectedExecuted: { from: expectedFrom, to: expectedTo },
    viewport,
  };
}

function basisScreenshot(execDir, basisObservationRef) {
  if (!basisObservationRef) return null;
  const timeline = path.join(execDir, 'timeline.jsonl');
  if (!fs.existsSync(timeline)) return null;
  const observation = fs.readFileSync(timeline, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((event) => event.type === 'observation' && event.ref === basisObservationRef);
  const ref = observation?.artifacts?.screenshot || observation?.ref;
  if (!isSafeRelativeArtifact(ref)) return null;
  const file = resolveArtifact(execDir, ref);
  if (!fs.existsSync(file)) return null;
  const image = inspectPng(file);
  return image.decodeStatus === 'VALID' ? { ref, width: image.width, height: image.height } : null;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function sourcePoint(point, audit, screenshot) {
  const viewport = audit.viewport;
  if (!viewport || (viewport.width === screenshot.width && viewport.height === screenshot.height)) return point;
  return {
    x: point.x * screenshot.width / viewport.width,
    y: point.y * screenshot.height / viewport.height,
  };
}

function writeOverlay(execDir, operationId, screenshot, audit) {
  const dir = path.join(execDir, 'coordinate-audits');
  fs.mkdirSync(dir, { recursive: true });
  const ref = path.posix.join('coordinate-audits', `${operationId}.svg`);
  const file = resolveArtifact(execDir, ref);
  const screenshotFile = resolveArtifact(execDir, screenshot.ref);
  const href = path.relative(dir, screenshotFile).split(path.sep).join('/');
  const requestedRaw = audit.kind === 'POINT'
    ? [audit.requested.point]
    : [audit.requested.from, audit.requested.to];
  const requested = audit.source === 'visual'
    ? requestedRaw
    : requestedRaw.map((point) => sourcePoint(point, audit, screenshot));
  const executed = audit.kind === 'POINT'
    ? [sourcePoint(audit.executed.point, audit, screenshot)]
    : [sourcePoint(audit.executed.from, audit, screenshot), sourcePoint(audit.executed.to, audit, screenshot)];
  const radius = Math.max(8, Math.round(Math.min(screenshot.width, screenshot.height) * 0.012));
  const stroke = Math.max(3, Math.round(radius / 4));
  const bounds = audit.requested.bounds && audit.source !== 'visual'
    ? [
      sourcePoint({ x: audit.requested.bounds[0], y: audit.requested.bounds[1] }, audit, screenshot),
      sourcePoint({ x: audit.requested.bounds[2], y: audit.requested.bounds[3] }, audit, screenshot),
    ].flatMap((point) => [point.x, point.y])
    : audit.requested.bounds;
  const boundsSvg = bounds
    ? `<rect x="${bounds[0]}" y="${bounds[1]}" width="${bounds[2] - bounds[0]}" height="${bounds[3] - bounds[1]}" fill="none" stroke="#f59e0b" stroke-width="${stroke}" stroke-dasharray="${stroke * 3} ${stroke * 2}"/>`
    : '';
  const trajectory = audit.kind === 'GESTURE'
    ? `<line x1="${executed[0].x}" y1="${executed[0].y}" x2="${executed[1].x}" y2="${executed[1].y}" stroke="#ef4444" stroke-width="${stroke}" marker-end="url(#arrow)"/>`
    : '';
  const requestMarks = requested.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="none" stroke="#2563eb" stroke-width="${stroke}"/>`).join('');
  const executionMarks = executed.map((point) => `<g stroke="#ef4444" stroke-width="${stroke}"><line x1="${point.x - radius}" y1="${point.y}" x2="${point.x + radius}" y2="${point.y}"/><line x1="${point.x}" y1="${point.y - radius}" x2="${point.x}" y2="${point.y + radius}"/></g>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${screenshot.width}" height="${screenshot.height}" viewBox="0 0 ${screenshot.width} ${screenshot.height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ef4444"/></marker></defs><image href="${xml(href)}" width="${screenshot.width}" height="${screenshot.height}"/>${boundsSvg}${trajectory}${requestMarks}${executionMarks}</svg>`;
  fs.writeFileSync(file, svg);
  return ref;
}

function buildCoordinateAudit(execDir, validated, adapterResult) {
  const action = validated.action;
  const hasPoint = POINT_ACTIONS.has(action.type) && action.x !== undefined && action.y !== undefined;
  const hasSwipe = action.type === 'swipe';
  if (!hasPoint && !hasSwipe) return null;
  const detail = hasSwipe ? auditSwipe(action, adapterResult) : auditPoint(action, adapterResult);
  if (adapterResult.platform === 'ios' && !detail.viewport) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'iOS coordinate execution must identify the Appium viewport');
  }
  const screenshot = basisScreenshot(execDir, validated.request?.basisObservationRef);
  if (screenshot && screenshot.width > 1 && screenshot.height > 1 && !detail.viewport) {
    detail.viewport = { width: screenshot.width, height: screenshot.height };
  }
  if (screenshot && action.coordinateSource === 'visual') {
    const adapterScreenshot = hasSwipe ? adapterResult.executedFrom?.screenshot : adapterResult.executedPoint?.screenshot;
    if (adapterScreenshot && (Number(adapterScreenshot.width) !== screenshot.width || Number(adapterScreenshot.height) !== screenshot.height)) {
      throw contractError('DEVICE_EXECUTED_COORDINATE_MISMATCH', 'adapter transformed coordinates from a different screenshot size than the frozen basis observation');
    }
  }
  if (detail.viewport) {
    if (detail.kind === 'POINT') assertInside(detail.executed.point, detail.viewport, 'executedPoint');
    else {
      assertInside(detail.executed.from, detail.viewport, 'executedFrom');
      assertInside(detail.executed.to, detail.viewport, 'executedTo');
    }
  }
  const audit = {
    schemaVersion: 1,
    source: action.coordinateSource,
    ...detail,
    ...(screenshot ? { screenshot } : {}),
    consistency: 'MATCHED',
  };
  if (screenshot) audit.overlayRef = writeOverlay(execDir, validated.request.operationId, screenshot, audit);
  return audit;
}

module.exports = { buildCoordinateAudit };

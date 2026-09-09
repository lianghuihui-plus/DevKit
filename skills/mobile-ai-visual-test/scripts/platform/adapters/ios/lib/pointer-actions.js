'use strict';

const { swipeDurationMs } = require('../../../../lib/action-contract');
const appium = require('./appium-client');
const { pngSizeFromBase64, scaleVisualPoint } = require('./screen-space');

function optionValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function pointerAction(x, y, holdMs = 80) {
  return {
    actions: [{
      type: 'pointer',
      id: `finger-${Date.now()}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: Number(holdMs) },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function doubleTapAction(x, y, intervalMs = 100) {
  return {
    actions: [{
      type: 'pointer',
      id: `finger-${Date.now()}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
        { type: 'pause', duration: Number(intervalMs) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function pointerDownAction(x, y, pointerId) {
  return {
    actions: [{
      type: 'pointer',
      id: pointerId,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
      ],
    }],
  };
}

function pointerUpAction(pointerId) {
  return {
    actions: [{
      type: 'pointer',
      id: pointerId,
      parameters: { pointerType: 'touch' },
      actions: [{ type: 'pointerUp', button: 0 }],
    }],
  };
}

function swipeAction(fromX, fromY, toX, toY, durationMs = 350) {
  return {
    actions: [{
      type: 'pointer',
      id: `finger-${Date.now()}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(fromX), y: Number(fromY), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: Number(durationMs), x: Number(toX), y: Number(toY), origin: 'viewport' },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function resolveSwipeExecution(rest) {
  const action = {
    type: 'swipe',
    fromX: optionValue(rest, '--from-x'),
    fromY: optionValue(rest, '--from-y'),
    toX: optionValue(rest, '--to-x'),
    toY: optionValue(rest, '--to-y'),
    velocity: optionValue(rest, '--velocity', '600'),
  };
  return { ...action, velocity: Number(action.velocity), durationMs: swipeDurationMs(action) };
}

function resolveLongPressExecution(rest) {
  const x = optionValue(rest, '--x');
  const y = optionValue(rest, '--y');
  const durationValue = optionValue(rest, '--duration-ms');
  const durationMs = Number(durationValue);
  const coordinateSource = optionValue(rest, '--coordinate-source', 'layout');
  const captureOut = optionValue(rest, '--capture-out');
  const captureRef = optionValue(rest, '--capture-ref');
  const captureAtMs = Number(optionValue(rest, '--capture-at-ms', '0'));
  if (x === '' || y === '' || durationValue === '' || !Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('longPress 需要 --x、--y 和正整数 --duration-ms');
  }
  if (captureOut && (!captureRef || !Number.isInteger(captureAtMs) || captureAtMs < 20 || captureAtMs >= durationMs)) {
    throw new Error('longPress 过程截图需要有效的 --capture-ref，且 --capture-at-ms 必须位于按压时长内');
  }
  return { x, y, durationMs, coordinateSource, captureOut, captureRef, captureAtMs };
}

async function executablePoint(target, sessionId, point, coordinateSource) {
  const raw = { x: Number(point.x), y: Number(point.y) };
  const rectRequest = appium.request(target.appiumServer, 'GET', `/session/${sessionId}/window/rect`);
  if (coordinateSource !== 'visual') {
    const rect = await rectRequest;
    return {
      ...raw,
      viewport: { width: Number(rect.value?.width), height: Number(rect.value?.height) },
      coordinateSource,
    };
  }
  const [shot, rect] = await Promise.all([
    appium.request(target.appiumServer, 'GET', `/session/${sessionId}/screenshot`),
    rectRequest,
  ]);
  return { ...scaleVisualPoint(raw, pngSizeFromBase64(shot.value), rect.value), coordinateSource };
}

module.exports = {
  doubleTapAction,
  executablePoint,
  pointerAction,
  pointerDownAction,
  pointerUpAction,
  resolveLongPressExecution,
  resolveSwipeExecution,
  swipeAction,
};

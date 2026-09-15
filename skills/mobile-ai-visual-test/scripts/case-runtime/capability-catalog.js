'use strict';

const { contractError } = require('../lib/contract-utils');
const { validateActionExecution } = require('../lib/action-contract');

function capabilityId(sceneId, kind, target = 'screen') {
  return `${sceneId}:${kind}:${target}`;
}

function labelFor(kind, text) {
  const target = text || '当前控件';
  return {
    tap: `点击${target}`,
    toggle: `切换${target}`,
    doubleTap: `双击${target}`,
    longPress: `长按${target}`,
    inputText: `向${target}输入文本`,
  }[kind] || kind;
}

function buildCapabilities(scene, platform) {
  const values = [];
  for (const element of scene.elements || []) {
    if (!element.visible || !element.enabled || !Array.isArray(element.bounds)) continue;
    const kinds = [];
    if (element.clickable || element.checkable || element.editable) kinds.push('tap');
    if (element.checkable) kinds.push('toggle');
    if (element.clickable) kinds.push('doubleTap', 'longPress');
    if (element.editable && platform === 'harmony') kinds.push('inputText');
    for (const kind of kinds) {
      values.push({
        id: capabilityId(scene.sceneId, kind, element.id),
        kind,
        label: labelFor(kind, `“${element.text || element.role || element.id}”`),
        target: element.id,
        ...(kind === 'inputText' ? { input: 'text' } : {}),
        ...(kind === 'longPress' ? { input: { durationMs: 'positive-integer' } } : {}),
      });
    }
  }
  const globals = [
    ['swipeUp', '向上滚动'], ['swipeDown', '向下滚动'],
    ['back', '返回上一页'], ['home', '返回系统桌面'], ['wait', '等待页面稳定'],
  ];
  const horizontalContext = (scene.scrollContexts || []).find((entry) => entry.axis === 'HORIZONTAL'
    && entry.trackingStatus === 'TRACKING' && Array.isArray(entry.bounds));
  if (horizontalContext) globals.splice(2, 0, ['swipeLeft', '在已识别横向容器内向左滚动'], ['swipeRight', '在已识别横向容器内向右滚动']);
  if (platform === 'ios' && scene.signals?.keyboard?.shown) globals.push(['dismissKeyboard', '收起键盘']);
  if (platform !== 'harmony' && scene.signals?.focusedElement) globals.push(['inputText', '向当前焦点输入文本']);
  for (const [kind, label] of globals) {
    values.push({ id: capabilityId(scene.sceneId, kind), kind, label, ...(kind === 'inputText' ? { input: 'text' } : {}) });
  }
  return values;
}

function pixelPoint(bounds) {
  return {
    x: Math.round((Number(bounds[0]) + Number(bounds[2])) / 2),
    y: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
  };
}

function coordinateMetadata(scene, source, bounds, intent) {
  return {
    coordinateSource: source,
    coordinateArtifactRef: source === 'layout' ? scene.layoutRef : scene.screenshot.ref,
    coordinateEvidence: intent || `基于 ${scene.sceneId} 当前现场`,
    ...(bounds ? { targetBounds: bounds.map(Number) } : {}),
  };
}

function elementAction(scene, capability, input, intent, platform) {
  const element = (scene.elements || []).find((item) => item.id === capability.target);
  if (!element) throw contractError('CASE_RUNTIME_CAPABILITY_STALE', 'capability target is unavailable in the current scene');
  const point = pixelPoint(element.bounds);
  const base = {
    type: capability.kind,
    target: element.text || element.role || element.id,
    ...point,
    ...coordinateMetadata(scene, 'layout', element.bounds, intent),
    ...(intent ? { reason: intent } : {}),
  };
  if (capability.kind === 'longPress' && input?.durationMs !== undefined) {
    base.durationMs = Number(input.durationMs);
  }
  if (capability.kind === 'inputText') {
    base.text = String(input?.text ?? input ?? '');
    base.mode = input?.mode || 'replace';
    if (platform !== 'harmony') {
      delete base.x; delete base.y; delete base.coordinateSource;
      delete base.coordinateArtifactRef; delete base.coordinateEvidence; delete base.targetBounds;
    }
  }
  return base;
}

function globalAction(scene, capability, input, intent) {
  const { width, height } = scene.screenshot;
  const verticalContext = (scene.scrollContexts || []).find((entry) => entry.axis === 'VERTICAL'
    && entry.trackingStatus === 'TRACKING' && Array.isArray(entry.bounds));
  const horizontalContext = (scene.scrollContexts || []).find((entry) => entry.axis === 'HORIZONTAL'
    && entry.trackingStatus === 'TRACKING' && Array.isArray(entry.bounds));
  const verticalBounds = verticalContext?.bounds || [0, 0, width, height];
  const verticalCenterX = Math.round((verticalBounds[0] + verticalBounds[2]) / 2);
  const verticalCenterY = Math.round((verticalBounds[1] + verticalBounds[3]) / 2);
  const verticalDistance = Math.max(1, Math.min(
    Number(verticalContext?.suggestedSwipeDistance) || Math.round((verticalBounds[3] - verticalBounds[1]) * 0.5),
    Math.round((verticalBounds[3] - verticalBounds[1]) * 0.75),
  ));
  const horizontalBounds = horizontalContext?.bounds;
  const horizontalCenterX = horizontalBounds ? Math.round((horizontalBounds[0] + horizontalBounds[2]) / 2) : null;
  const horizontalCenterY = horizontalBounds ? Math.round((horizontalBounds[1] + horizontalBounds[3]) / 2) : null;
  const horizontalDistance = horizontalBounds ? Math.max(1, Math.min(
    Number(horizontalContext?.suggestedSwipeDistance) || Math.round((horizontalBounds[2] - horizontalBounds[0]) * 0.5),
    Math.round((horizontalBounds[2] - horizontalBounds[0]) * 0.75),
  )) : null;
  const swipe = {
    swipeUp: [verticalCenterX, verticalCenterY + Math.round(verticalDistance / 2), verticalCenterX, verticalCenterY - Math.round(verticalDistance / 2)],
    swipeDown: [verticalCenterX, verticalCenterY - Math.round(verticalDistance / 2), verticalCenterX, verticalCenterY + Math.round(verticalDistance / 2)],
    swipeLeft: horizontalBounds ? [horizontalCenterX + Math.round(horizontalDistance / 2), horizontalCenterY, horizontalCenterX - Math.round(horizontalDistance / 2), horizontalCenterY] : null,
    swipeRight: horizontalBounds ? [horizontalCenterX - Math.round(horizontalDistance / 2), horizontalCenterY, horizontalCenterX + Math.round(horizontalDistance / 2), horizontalCenterY] : null,
  }[capability.kind];
  if (swipe) return {
    type: 'swipe', fromX: swipe[0], fromY: swipe[1], toX: swipe[2], toY: swipe[3], velocity: 600,
    ...coordinateMetadata(scene, 'visual', ['swipeUp', 'swipeDown'].includes(capability.kind) ? verticalBounds : horizontalBounds, intent),
    ...(intent ? { reason: intent } : {}),
  };
  if (capability.kind === 'inputText') return {
    type: 'inputText', text: String(input?.text ?? input ?? ''), mode: input?.mode || 'replace',
    ...(intent ? { reason: intent } : {}),
  };
  if (capability.kind === 'wait') return { type: 'wait', ms: Number(input?.ms || 1000), ...(intent ? { reason: intent } : {}) };
  return { type: capability.kind, ...(intent ? { reason: intent } : {}) };
}

function visualAction(scene, visual, intent) {
  const width = Number(scene.screenshot.width); const height = Number(scene.screenshot.height);
  const point = (value, label) => {
    if (!Array.isArray(value) || value.length !== 2 || value.some((item) => !Number.isFinite(Number(item)) || Number(item) < 0 || Number(item) > 1)) {
      throw contractError('CASE_RUNTIME_VISUAL_ACTION_INVALID', `${label} must be [x,y] values from 0 to 1`);
    }
    return [Math.round(Number(value[0]) * (width - 1)), Math.round(Number(value[1]) * (height - 1))];
  };
  if (visual.gesture === 'swipe') {
    const from = point(visual.from, 'visual.from'); const to = point(visual.to, 'visual.to');
    return {
      type: 'swipe', fromX: from[0], fromY: from[1], toX: to[0], toY: to[1], velocity: 600,
      ...coordinateMetadata(scene, 'visual', [0, 0, width, height], intent), ...(intent ? { reason: intent } : {}),
    };
  }
  if (!['tap', 'doubleTap', 'longPress'].includes(visual.gesture)) {
    throw contractError('CASE_RUNTIME_VISUAL_ACTION_INVALID', 'visual gesture must be tap, doubleTap, longPress, or swipe');
  }
  const at = point(visual.point, 'visual.point');
  return {
    type: visual.gesture, x: at[0], y: at[1],
    ...(visual.gesture === 'longPress' && visual.durationMs !== undefined ? { durationMs: Number(visual.durationMs) } : {}),
    ...coordinateMetadata(scene, 'visual', [0, 0, width, height], intent), ...(intent ? { reason: intent } : {}),
  };
}

function resolveAction(scene, request, platform) {
  let action;
  if (request.visual) action = visualAction(scene, request.visual, request.decision?.purpose);
  else {
    const capability = (scene.capabilities || []).find((item) => item.id === request.capabilityId);
    if (!capability) return { stale: true };
    action = capability.target
      ? elementAction(scene, capability, request.input, request.decision?.purpose, platform)
      : globalAction(scene, capability, request.input, request.decision?.purpose);
  }
  validateActionExecution(action, { platform, scope: 'case-business', context: 'Case Runtime action' });
  return { action, stale: false };
}

module.exports = { buildCapabilities, capabilityId, resolveAction };

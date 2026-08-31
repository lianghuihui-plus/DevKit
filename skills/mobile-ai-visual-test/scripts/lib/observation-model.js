'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const { inspectPng } = require('./image-evidence');
const { resolveArtifact } = require('./execution-evidence');
const { parseBounds, parseLayout, projectLayout } = require('./layout-observation');
const { classifyActionEffect, compareObservationViews } = require('./observation-consistency');

function timelineEvents(execDir) {
  const file = path.join(execDir, 'timeline.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function missingLayoutDiagnostic(observation) {
  const capture = observation.technicalSignals?.layoutCapture;
  if (capture?.status !== 'UNAVAILABLE') {
    return { code: 'LAYOUT_ARTIFACT_MISSING', severity: 'WARN', message: '本次观察没有控件树产物' };
  }
  const messages = {
    ANDROID_LAYOUT_NOT_IDLE: '页面持续变化，本次未取得稳定控件树，已使用截图继续执行',
    ANDROID_LAYOUT_TIMEOUT: '控件树采集超过平台时限，已使用截图继续执行',
    ANDROID_LAYOUT_OUTPUT_MISSING: '平台未生成本次控件树文件，已使用截图继续执行',
    ANDROID_LAYOUT_PULL_FAILED: '控件树文件拉取失败，已使用截图继续执行',
    ANDROID_LAYOUT_INVALID: '平台返回的控件树文件无效，已使用截图继续执行',
    ANDROID_LAYOUT_CAPTURE_FAILED: '本次控件树采集失败，已使用截图继续执行',
  };
  return {
    code: capture.code || 'ANDROID_LAYOUT_CAPTURE_FAILED',
    severity: 'WARN',
    message: messages[capture.code] || capture.message || '本次控件树不可用，已使用截图继续执行',
    durationMs: Number.isFinite(Number(capture.durationMs)) ? Number(capture.durationMs) : null,
    fallback: capture.fallback || 'SCREENSHOT',
  };
}

function layoutProjection(execDir, observation, screenshot) {
  const layoutRef = observation.artifacts?.layout || null;
  if (!layoutRef) {
    return {
      layoutRef,
      parsed: { usable: false, format: 'none', diagnostics: [missingLayoutDiagnostic(observation)] },
      projected: projectLayout(null, observation.ref, screenshot, observation.technicalSignals || {}),
    };
  }
  const layoutPath = resolveArtifact(execDir, layoutRef);
  if (!fs.existsSync(layoutPath)) {
    const parsed = { usable: false, format: path.extname(layoutPath).slice(1) || 'unknown', diagnostics: [{ code: 'LAYOUT_ARTIFACT_MISSING', severity: 'ERROR', message: '控件树产物不存在' }] };
    return { layoutRef, parsed, projected: projectLayout(parsed, observation.ref, screenshot, observation.technicalSignals || {}) };
  }
  const parsed = parseLayout(fs.readFileSync(layoutPath, 'utf8'), path.extname(layoutPath).slice(1));
  return {
    layoutRef,
    parsed,
    projected: projectLayout(parsed, observation.ref, screenshot, observation.technicalSignals || {}),
  };
}

function baseObservationView(execDir, observation, cache = null) {
  if (cache?.has(observation.ref)) return cache.get(observation.ref);
  const screenshotPath = resolveArtifact(execDir, observation.ref);
  const image = inspectPng(screenshotPath);
  const screenshot = { ref: observation.ref, sha256: observation.sha256 || null, width: image.width, height: image.height };
  const { layoutRef, parsed, projected } = layoutProjection(execDir, observation, screenshot);
  const view = {
    schemaVersion: 2,
    observationRef: observation.ref,
    operationId: observation.operationId,
    scope: observation.scope,
    usable: observation.usable === true,
    screenshot,
    layoutRef,
    layout: {
      usable: parsed.usable === true,
      format: parsed.format,
      diagnostics: [...(parsed.diagnostics || []), ...(projected.diagnostics || [])],
    },
    signals: projected.signals,
    actionEffect: null,
    stateChanges: [],
    conflicts: [],
    elements: projected.elements,
  };
  Object.defineProperty(view, '_states', { value: projected.states, enumerable: false });
  if (cache) cache.set(observation.ref, view);
  return view;
}

function buildObservationView(execDir, observation, options = {}) {
  if (!observation?.ref) return null;
  const base = baseObservationView(execDir, observation, options.cache || null);
  const view = { ...base, actionEffect: null, stateChanges: [], conflicts: [] };
  Object.defineProperty(view, '_states', { value: base._states, enumerable: false });
  if (options.includeConsistency === false) return view;
  const events = options.events || timelineEvents(execDir);
  const action = observation.relatedOperationId
    ? events.find((entry) => entry.type === 'actionResult' && entry.operationId === observation.relatedOperationId)
    : null;
  const beforeObservation = action?.basisObservationRef
    ? events.find((entry) => entry.type === 'observation' && entry.ref === action.basisObservationRef)
    : null;
  const before = beforeObservation ? baseObservationView(execDir, beforeObservation, options.cache || null) : null;
  const consistency = compareObservationViews(before, view, action?.requestedAction || {});
  view.actionEffect = action
    ? classifyActionEffect(before, view, action.operationId)
    : null;
  view.stateChanges = consistency.stateChanges;
  view.conflicts = consistency.conflicts;
  if (view.actionEffect?.status === 'NO_VISIBLE_CHANGE'
    && action?.requestedAction?.coordinateSource === 'visual') {
    const point = action.requestedAction.type === 'swipe'
      ? [action.requestedAction.fromX, action.requestedAction.fromY, action.requestedAction.toX, action.requestedAction.toY]
      : [action.requestedAction.x, action.requestedAction.y];
    const priorActions = events.filter((entry) => entry.type === 'actionResult'
      && entry.operationId !== action.operationId
      && entry.requestedAction?.type === action.requestedAction.type
      && entry.requestedAction?.coordinateSource === 'visual');
    const repeated = priorActions.some((priorAction) => {
      const priorPoint = priorAction.requestedAction.type === 'swipe'
        ? [priorAction.requestedAction.fromX, priorAction.requestedAction.fromY, priorAction.requestedAction.toX, priorAction.requestedAction.toY]
        : [priorAction.requestedAction.x, priorAction.requestedAction.y];
      const tolerance = Math.max(12, Math.min(view.screenshot.width, view.screenshot.height) * 0.03);
      if (point.length !== priorPoint.length || point.some((value, index) => Math.abs(Number(value) - Number(priorPoint[index])) > tolerance)) return false;
      const priorAfter = events.find((entry) => entry.type === 'observation' && entry.relatedOperationId === priorAction.operationId);
      const priorBefore = events.find((entry) => entry.type === 'observation' && entry.ref === priorAction.basisObservationRef);
      return Boolean(priorAfter?.sha256 && priorAfter.sha256 === priorBefore?.sha256);
    });
    if (repeated) {
      view.conflicts.push({
        code: 'REPEATED_VISUAL_ACTION_NO_EFFECT',
        severity: 'WARN',
        message: '相近视觉坐标已重复执行且截图仍无变化，请重新核对目标位置或改用其他定位依据',
        actionType: action.requestedAction.type,
        resolved: false,
      });
    }
  }
  return view;
}

function collectElements(layout, observationRef, screenshot = {}) {
  const parsed = { usable: true, format: 'json', root: layout, diagnostics: [] };
  return projectLayout(parsed, observationRef, screenshot).elements;
}

function findElement(view, ref) {
  const element = view?.elements?.find((entry) => entry.ref === ref);
  if (!element) {
    throw contractError('TARGET_ELEMENT_INVALID', `targetRef is not available in the current observation: ${ref}`, {
      fieldPath: 'action.targetRef', expected: 'element ref from the latest observation view', received: ref,
    });
  }
  return element;
}

module.exports = {
  buildObservationView,
  collectElements,
  findElement,
  parseBounds,
};

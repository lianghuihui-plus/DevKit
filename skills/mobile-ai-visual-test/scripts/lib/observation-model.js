'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const { inspectPng } = require('./image-evidence');
const { resolveArtifact } = require('./execution-evidence');
const { parseBounds, parseLayout, projectLayout } = require('./layout-observation');

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
  const screenshot = {
    ref: observation.ref,
    sha256: observation.sha256 || null,
    width: image.width,
    height: image.height,
    absolutePath: screenshotPath,
    attachment: {
      type: 'image',
      mediaType: 'image/png',
      path: screenshotPath,
      sha256: observation.sha256 || null,
    },
  };
  const { layoutRef, parsed, projected } = layoutProjection(execDir, observation, screenshot);
  const view = {
    schemaVersion: 2,
    observationRef: observation.ref,
    operationId: observation.operationId,
    scope: observation.scope,
    observationPurpose: observation.observationPurpose || null,
    usable: observation.usable === true,
    screenshot,
    app: observation.app || null,
    evidenceChannels: {
      visual: { available: true, ref: observation.ref, attachment: screenshot.attachment },
      layout: { available: parsed.usable === true, ref: layoutRef, diagnostics: parsed.diagnostics || [] },
      policy: 'COMBINE_VISUAL_AND_LAYOUT',
      conflictRule: 'REOBSERVE_OR_REVIEW',
    },
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
    scrollContainers: projected.scrollContainers || [],
  };
  if (cache) cache.set(observation.ref, view);
  return view;
}

function buildObservationView(execDir, observation, options = {}) {
  if (!observation?.ref) return null;
  return baseObservationView(execDir, observation, options.cache || null);
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
  const [left, top, right, bottom] = element.bounds || [];
  const { width, height } = view.screenshot || {};
  if (![left, top, right, bottom, width, height].every(Number.isFinite)
    || left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) {
    throw contractError('TARGET_ELEMENT_BOUNDS_INVALID', `targetRef bounds are outside the current screenshot: ${ref}`, {
      fieldPath: 'action.targetRef',
      received: element.bounds || null,
      allowed: { x: [0, Math.max(0, Number(width) - 1)], y: [0, Math.max(0, Number(height) - 1)] },
      screenshot: { width, height },
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

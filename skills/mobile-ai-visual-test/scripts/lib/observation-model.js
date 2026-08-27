'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const { inspectPng } = require('./image-evidence');
const { resolveArtifact } = require('./execution-evidence');
const { parseBounds, parseLayout, projectLayout } = require('./layout-observation');
const { compareObservationViews } = require('./observation-consistency');

function timelineEvents(execDir) {
  const file = path.join(execDir, 'timeline.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function layoutProjection(execDir, observation, screenshot) {
  const layoutRef = observation.artifacts?.layout || null;
  if (!layoutRef) {
    return {
      layoutRef,
      parsed: { usable: false, format: 'none', diagnostics: [{ code: 'LAYOUT_ARTIFACT_MISSING', severity: 'WARN', message: '本次观察没有控件树产物' }] },
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
  const screenshot = { ref: observation.ref, width: image.width, height: image.height };
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
  const view = { ...base, stateChanges: [], conflicts: [] };
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
  view.stateChanges = consistency.stateChanges;
  view.conflicts = consistency.conflicts;
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

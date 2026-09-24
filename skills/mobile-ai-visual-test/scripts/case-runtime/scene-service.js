'use strict';

const { buildObservationView } = require('../lib/observation-model');
const { contractError } = require('../lib/contract-utils');
const { updateScrollContexts } = require('../lib/scroll-context');
const { invokeDeviceOperation } = require('../platform/device-port');
const { buildCapabilities } = require('./capability-catalog');
const store = require('./store');

const SEQUENCE_CAPTURE_ORIGINS = Object.freeze(['AGENT_REQUESTED', 'ACTION_POST', 'SEQUENCE_FINAL']);

function normalizedCaptureMetadata(options = {}) {
  const captureOrigins = options.captureOrigins === undefined ? [] : options.captureOrigins;
  if (!Array.isArray(captureOrigins) || captureOrigins.some((origin) => !SEQUENCE_CAPTURE_ORIGINS.includes(origin))) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'captureOrigins must contain only known Sequence capture origins');
  }
  const normalizedOrigins = SEQUENCE_CAPTURE_ORIGINS.filter((origin) => captureOrigins.includes(origin));
  if (options.sequenceId && options.relatedOperationId && !normalizedOrigins.includes('ACTION_POST')) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'a Sequence relatedOperationId requires ACTION_POST capture origin');
  }
  return {
    captureOrigins: normalizedOrigins,
    relatedOperationId: options.relatedOperationId || null,
    sequenceId: options.sequenceId || null,
    stepId: options.stepId || null,
  };
}

function sceneFromObservation(execDir, observation, execution, previousAction = null, previousScene = null) {
  const view = buildObservationView(execDir, observation);
  const sceneId = `scene-${String(store.events(execDir).filter((event) => event.type === 'sceneObserved').length + 1).padStart(4, '0')}`;
  const normalizedPreviousAction = previousAction && previousScene ? {
    ...previousAction,
    evidence: {
      sceneRefs: {
        before: previousAction.evidence?.sceneRefs?.before || previousScene.sceneId,
        after: sceneId,
      },
      screenshotRefs: [...new Set([
        ...(previousAction.evidence?.screenshotRefs || [previousScene.screenshot.ref]),
        view.screenshot.ref,
      ])],
    },
  } : previousAction;
  const scene = {
    schemaVersion: 2,
    sceneId,
    captureMode: 'FULL_SCENE',
    generation: execution.warmSessionGeneration,
    warmSessionRef: {
      sessionId: execution.warmSessionId,
      epoch: execution.warmSessionEpoch,
      generation: execution.warmSessionGeneration,
    },
    capturedAt: observation.time,
    screenshot: {
      ref: view.screenshot.ref,
      path: view.screenshot.absolutePath,
      sha256: view.screenshot.sha256,
      width: view.screenshot.width,
      height: view.screenshot.height,
    },
    evidenceChannels: {
      visual: {
        ...view.evidenceChannels.visual,
        inspection: { tool: 'view_image', recordOperation: 'inspectVisual', order: 'VIEW_THEN_RECORD' },
      },
      layout: { ...view.evidenceChannels.layout, inline: true },
      policy: view.evidenceChannels.policy,
      conflictRule: view.evidenceChannels.conflictRule,
    },
    layoutRef: view.layoutRef,
    layout: view.layout,
    captureTiming: view.captureTiming,
    app: view.app,
    signals: view.signals,
    conflicts: view.conflicts || [],
    elements: (view.elements || []).map((element) => ({
      id: element.ref,
      text: element.text,
      role: element.role,
      bounds: element.bounds,
      clickable: element.clickable,
      checkable: element.checkable,
      editable: element.editable,
      enabled: element.enabled,
      visible: element.visible,
      focused: element.focused,
      secure: element.secure,
      maskedLength: element.maskedLength,
    })),
    capabilities: [],
    scrollContainers: view.scrollContainers || [],
    scrollContexts: [],
    visual: { gestures: ['tap', 'doubleTap', 'longPress', 'swipe'], coordinates: 'normalized-0-to-1' },
    previousAction: normalizedPreviousAction,
    captureOrigins: observation.captureOrigins || [],
    relatedOperationId: observation.relatedOperationId || null,
    sequenceId: observation.sequenceId || null,
    stepId: observation.stepId || null,
    source: {
      operation: optionsSource(previousAction, observation),
      planId: observation.planId || null,
      stepId: observation.stepId || null,
      operationId: observation.operationId,
    },
  };
  scene.scrollContexts = updateScrollContexts({
    previousScene,
    containers: scene.scrollContainers,
    previousAction: normalizedPreviousAction,
    sceneId,
    generation: execution.warmSessionGeneration,
  });
  scene.capabilities = buildCapabilities(scene, execution.platform);
  return scene;
}

function optionsSource(previousAction, observation) {
  if (observation.planId) return 'runPlan';
  return previousAction ? 'act' : 'observe';
}

function countByKind(values) {
  return values.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] || 0) + 1 }), {});
}

function projectSceneSummary(scene) {
  if (!scene) return null;
  const interactive = (scene.elements || []).filter((element) => element.clickable || element.checkable || element.editable);
  return {
    schemaVersion: 3,
    sceneId: scene.sceneId,
    generation: scene.generation,
    warmSessionRef: scene.warmSessionRef,
    capturedAt: scene.capturedAt,
    captureTiming: scene.captureTiming || null,
    screenshot: scene.screenshot,
    evidenceChannels: {
      ...scene.evidenceChannels,
      layout: { ...scene.evidenceChannels?.layout, inline: false, inspectOperation: 'inspectScene' },
    },
    app: scene.app,
    signals: scene.signals,
    conflicts: scene.conflicts || [],
    elementSummary: {
      total: (scene.elements || []).length,
      interactive: interactive.length,
      visibleInteractiveLabels: interactive.slice(0, 8).map((element) => element.text || element.role || element.id),
    },
    capabilitySummary: { total: (scene.capabilities || []).length, byKind: countByKind(scene.capabilities || []) },
    scrollSummary: {
      containers: (scene.scrollContainers || []).length,
      contexts: (scene.scrollContexts || []).map(({ id, axis, trackingStatus, coverage, reachedStart, reachedEnd }) => ({ id, axis, trackingStatus, coverage, reachedStart, reachedEnd })),
    },
    visual: scene.visual,
    previousAction: scene.previousAction,
    captureOrigins: scene.captureOrigins || [],
    relatedOperationId: scene.relatedOperationId || null,
    sequenceId: scene.sequenceId || null,
    stepId: scene.stepId || null,
    inspectScene: { operation: 'inspectScene' },
  };
}

function observe(execDir, options = {}) {
  const metadata = normalizedCaptureMetadata(options);
  const promote = options.promote !== false;
  const execution = store.loadExecution(execDir, { allowFinalized: options.allowFinalized === true });
  const previousScene = store.readCurrentScene(execDir);
  const operationId = store.nextId(execDir, 'observation');
  const invoked = (options.invokeDeviceOperation || invokeDeviceOperation)(execDir, {
    context: { execution },
    operationId,
    request: { purpose: options.purpose || 'CURRENT_SCENE' },
  }, 'OBSERVE', {
    now: options.now,
    runner: options.runner,
    preAdapterDelayMs: options.preAdapterDelayMs || 0,
    onAdapterSpan: options.onAdapterSpan,
    timeoutMs: options.timeoutMs,
  });
  const result = invoked.adapterResult;
  const observation = {
    operationId,
    ref: invoked.evidence.ref,
    sha256: invoked.evidence.sha256,
    usable: invoked.evidence.usable,
    scope: 'case',
    observationPurpose: options.purpose || 'CURRENT_SCENE',
    warmSessionGeneration: execution.warmSessionGeneration,
    artifacts: result.artifacts || { screenshot: invoked.evidence.ref, layout: null, logs: [] },
    app: result.app || null,
    technicalSignals: result.technicalSignals || null,
    time: options.now || result.time || new Date().toISOString(),
    captureOrigins: metadata.captureOrigins,
    relatedOperationId: metadata.relatedOperationId,
    sequenceId: metadata.sequenceId,
    stepId: metadata.stepId,
    ...(options.planId ? { planId: options.planId, stepId: options.stepId || null } : {}),
  };
  const scene = sceneFromObservation(execDir, observation, execution, options.previousAction || null, previousScene);
  store.writeScene(execDir, scene, { promote });
  store.appendEvent(execDir, 'sceneObserved', {
    sceneId: scene.sceneId,
    generation: scene.generation,
    warmSessionRef: scene.warmSessionRef,
    operationId,
    purpose: observation.observationPurpose,
    captureOrigins: metadata.captureOrigins,
    relatedOperationId: metadata.relatedOperationId,
    decisionId: options.decisionId || null,
    screenshotRef: scene.screenshot.ref,
    screenshotSha256: scene.screenshot.sha256,
    layoutRef: scene.layoutRef,
    app: scene.app,
    technicalSignals: observation.technicalSignals,
    captureMode: scene.captureMode,
    promoted: promote,
    planId: options.planId || null,
    sequenceId: metadata.sequenceId,
    stepId: metadata.stepId,
  }, { now: observation.time, allowFinalized: options.allowFinalized === true });
  return { status: 'SCENE', scene: projectSceneSummary(scene) };
}

module.exports = { observe, projectSceneSummary, sceneFromObservation };

'use strict';

const { buildObservationView } = require('../lib/observation-model');
const { classifyActionEffect } = require('../lib/observation-consistency');
const { updateScrollContexts } = require('../lib/scroll-context');
const { invokeDeviceOperation } = require('../platform/device-port');
const { buildCapabilities } = require('./capability-catalog');
const store = require('./store');

function sceneFromObservation(execDir, observation, execution, previousAction = null, previousScene = null) {
  const view = buildObservationView(execDir, observation);
  const sceneId = `scene-${String(store.events(execDir).filter((event) => event.type === 'sceneObserved').length + 1).padStart(4, '0')}`;
  const normalizedPreviousAction = previousAction && previousScene ? {
    ...previousAction,
    observedEffect: {
      ...classifyActionEffect(previousScene, view, previousAction.operationId),
      beforeSceneRef: previousScene.sceneId,
      afterSceneRef: sceneId,
    },
  } : previousAction;
  const scene = {
    schemaVersion: 2,
    sceneId,
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
    inspectScene: { operation: 'inspectScene', views: ['ELEMENTS', 'CAPABILITIES', 'LAYOUT'] },
  };
}

function observe(execDir, options = {}) {
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
    ...(options.relatedOperationId ? { relatedOperationId: options.relatedOperationId } : {}),
  };
  const scene = sceneFromObservation(execDir, observation, execution, options.previousAction || null, previousScene);
  store.writeScene(execDir, scene);
  store.appendEvent(execDir, 'sceneObserved', {
    sceneId: scene.sceneId,
    generation: scene.generation,
    warmSessionRef: scene.warmSessionRef,
    operationId,
    purpose: observation.observationPurpose,
    relatedOperationId: options.relatedOperationId || null,
    decisionId: options.decisionId || null,
    screenshotRef: scene.screenshot.ref,
    screenshotSha256: scene.screenshot.sha256,
    layoutRef: scene.layoutRef,
    app: scene.app,
    technicalSignals: observation.technicalSignals,
  }, { now: observation.time, allowFinalized: options.allowFinalized === true });
  return { status: 'SCENE', scene: projectSceneSummary(scene) };
}

module.exports = { observe, projectSceneSummary, sceneFromObservation };

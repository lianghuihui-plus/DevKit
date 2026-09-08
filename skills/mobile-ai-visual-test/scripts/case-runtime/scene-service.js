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
    capturedAt: observation.time,
    screenshot: {
      ref: view.screenshot.ref,
      path: view.screenshot.absolutePath,
      sha256: view.screenshot.sha256,
      width: view.screenshot.width,
      height: view.screenshot.height,
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
  return { status: 'SCENE', scene };
}

module.exports = { observe, sceneFromObservation };

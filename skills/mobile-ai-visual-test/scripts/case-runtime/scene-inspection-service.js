'use strict';

const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { readJson } = require('../lib/execution-lifecycle');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const store = require('./store');

function includesText(value, expected) {
  return String(value || '').toLocaleLowerCase().includes(String(expected || '').toLocaleLowerCase());
}

function inspectScene(execDir, request, options = {}) {
  const scene = readJson(path.join(store.paths(execDir).scenes, `${request.basedOnSceneId}.json`), null);
  if (!scene || scene.sceneId !== request.basedOnSceneId) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', `inspectScene references unknown Scene: ${request.basedOnSceneId}`);
  }
  const filter = request.filter || {};
  if (request.view === 'ACTION') {
    const previousAction = scene.previousAction;
    const spatialRef = previousAction?.spatialEvidence?.ref || previousAction?.spatialEvidenceRef || null;
    if (!previousAction?.operationId || !spatialRef) {
      throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'current Scene has no previous action spatial evidence');
    }
    const spatialEvidence = projectActionSpatialEvidence(execDir, spatialRef, {
      operationId: previousAction.operationId,
      actionType: previousAction.action?.type,
    });
    const event = store.appendEvent(execDir, 'actionSpatialInspected', {
      operationId: previousAction.operationId,
      sceneId: scene.sceneId,
      spatialEvidenceRef: spatialRef,
      annotatedScreenshotRef: spatialEvidence.annotatedScreenshot?.ref || null,
      observation: request.observation,
      expectationRefs: request.expectationRefs || [],
    }, options);
    return {
      status: 'ACTION_SPATIAL_INSPECTED',
      sceneId: scene.sceneId,
      operationId: previousAction.operationId,
      observation: event.observation,
      spatialEvidence,
    };
  }
  let items = [];
  let layout;
  if (request.view === 'ELEMENTS') {
    items = (scene.elements || []).filter((element) => {
      if (filter.interactiveOnly && !(element.clickable || element.checkable || element.editable)) return false;
      if (filter.textContains && !includesText(element.text, filter.textContains)) return false;
      if (filter.role && element.role !== filter.role) return false;
      return true;
    });
  } else if (request.view === 'CAPABILITIES') {
    items = (scene.capabilities || []).filter((capability) => {
      if (filter.actionType && capability.kind !== filter.actionType) return false;
      if (filter.elementRef && capability.target !== filter.elementRef) return false;
      return true;
    });
  } else {
    layout = scene.layout;
  }
  return {
    status: 'SCENE_INSPECTION',
    sceneId: scene.sceneId,
    generation: scene.generation,
    view: request.view,
    evidence: { screenshotSha256: scene.screenshot?.sha256 || null, layoutRef: scene.layoutRef || null },
    ...(request.view === 'LAYOUT' ? { layout } : { items, total: items.length }),
  };
}

module.exports = { inspectScene };

'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { resolveArtifact, sha256File } = require('../lib/execution-evidence');
const { inspectPng } = require('../lib/image-evidence');
const { readJson } = require('../lib/execution-lifecycle');
const store = require('./store');
const { projectSceneSummary } = require('./scene-service');

function inspectVisual(execDir, request, options = {}) {
  const currentScene = store.readCurrentScene(execDir);
  const scene = readJson(path.join(store.paths(execDir).scenes, `${request.basedOnSceneId}.json`), null);
  if (!scene || scene.sceneId !== request.basedOnSceneId) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', `inspectVisual references unknown Scene: ${request.basedOnSceneId}`);
  }
  const visual = scene?.evidenceChannels?.visual;
  const screenshot = scene?.screenshot;
  if (!scene || visual?.available !== true || !visual.attachment?.path || !screenshot?.ref) {
    throw contractError('VISUAL_EVIDENCE_UNAVAILABLE', `Scene ${request.basedOnSceneId} has no visual attachment`);
  }
  const screenshotPath = resolveArtifact(execDir, screenshot.ref);
  if (visual.ref !== screenshot.ref || visual.attachment.mediaType !== 'image/png'
    || path.resolve(visual.attachment.path) !== path.resolve(screenshotPath)
    || visual.attachment.sha256 !== screenshot.sha256) {
    throw contractError('VISUAL_EVIDENCE_INVALID', `Scene ${scene.sceneId} visual attachment does not match its screenshot evidence`);
  }
  if (!fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) {
    throw contractError('OBSERVATION_SCREENSHOT_MISSING', `Scene screenshot is missing: ${screenshot.ref}`);
  }
  const png = inspectPng(screenshotPath);
  if (png.decodeStatus !== 'VALID') {
    throw contractError('OBSERVATION_SCREENSHOT_INVALID', `Scene screenshot is not a valid PNG: ${screenshot.ref}`);
  }
  if (screenshot.sha256 && sha256File(screenshotPath) !== screenshot.sha256) {
    throw contractError('EXECUTION_ARTIFACT_CHANGED', `Scene screenshot digest changed: ${screenshot.ref}`);
  }
  const existing = store.events(execDir).find((event) => event.type === 'visualInspected'
    && event.sceneId === scene.sceneId && event.screenshotSha256 === screenshot.sha256);
  const projection = (event) => ({
    inspectionId: event.inspectionId,
    sceneId: event.sceneId,
    screenshotRef: event.screenshotRef,
    screenshotSha256: event.screenshotSha256,
    observation: event.observation,
    expectationRefs: event.expectationRefs || [],
  });
  if (existing) {
    return { status: 'VISUAL_INSPECTED', scene: projectSceneSummary(currentScene), visualInspection: projection(existing), idempotent: true };
  }
  const event = store.appendEvent(execDir, 'visualInspected', {
    inspectionId: store.nextId(execDir, 'inspection'),
    sceneId: scene.sceneId,
    screenshotRef: screenshot.ref,
    screenshotSha256: screenshot.sha256,
    decisionId: request.decisionId || null,
    expectationRefs: request.decision.expectationRefs,
    observation: request.decision.observation,
  }, options);
  return { status: 'VISUAL_INSPECTED', scene: projectSceneSummary(currentScene), visualInspection: projection(event) };
}

module.exports = { inspectVisual };

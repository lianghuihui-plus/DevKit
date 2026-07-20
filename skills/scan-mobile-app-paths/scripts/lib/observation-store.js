'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, sha256, fail } = require('./common');
const { buildFingerprint, observationVisual } = require('./fingerprint');
const { flattenLayout } = require('./semantic-fingerprint');

function observationDir(scanDir, observationId) {
  return path.join(scanDir, 'evidence', 'observations', observationId);
}

function observationJsonPath(scanDir, observationId) {
  return path.join(observationDir(scanDir, observationId), 'observation.json');
}

function resolveRelative(scanDir, relativeOrAbsolute, fallback) {
  if (!relativeOrAbsolute) return fallback;
  return path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(scanDir, relativeOrAbsolute);
}

function loadObservationBundle(scanDir, observationId, options = {}) {
  const dir = observationDir(scanDir, observationId);
  const observation = readJson(path.join(dir, 'observation.json'));
  const layoutPath = resolveRelative(scanDir, observation.layoutPath, path.join(dir, 'layout.json'));
  const screenshotPath = resolveRelative(scanDir, observation.screenshotPath, path.join(dir, 'screenshot.png'));

  if (options.contextId && observation.contextId !== options.contextId) {
    fail(`Observation ${observationId} belongs to ${observation.contextId || '<unknown>'}, expected ${options.contextId}`, options.contextErrorCode || 'CONTEXT_EVIDENCE_INVALID');
  }
  if (options.requireComplete && observation.captureStatus !== 'COMPLETE') {
    fail(`Observation ${observationId} is incomplete`, options.incompleteErrorCode || 'EVIDENCE_INCOMPLETE');
  }
  if (options.requireFiles && (!fs.existsSync(path.join(dir, 'observation.json')) || !fs.existsSync(layoutPath) || !fs.existsSync(screenshotPath))) {
    fail(`Observation ${observationId} is missing evidence files`, options.incompleteErrorCode || 'EVIDENCE_INCOMPLETE');
  }

  const layout = readJson(layoutPath);
  const fingerprint = options.fingerprint === false ? null : buildFingerprint(layout, observation.foreground, observationVisual(observation));
  const bundle = {
    observation,
    layout,
    fingerprint,
    observationPath: path.join(dir, 'observation.json'),
    layoutPath,
    screenshotPath,
    contextId: observation.contextId || null
  };
  if (options.includeNodes) bundle.nodes = flattenLayout(layout);
  if (options.includeScreenshotSha256 && fs.existsSync(screenshotPath)) bundle.screenshotSha256 = sha256(fs.readFileSync(screenshotPath));
  return bundle;
}

function requireObservationBundle(scanDir, observationId, contextId, options = {}) {
  return loadObservationBundle(scanDir, observationId, {
    ...options,
    contextId,
    requireComplete: options.requireComplete !== false,
    requireFiles: options.requireFiles !== false
  });
}

module.exports = {
  observationDir,
  observationJsonPath,
  loadObservationBundle,
  requireObservationBundle
};

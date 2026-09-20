'use strict';

const { contractError } = require('../lib/contract-utils');
const { readScene, recordPlanEvidence } = require('./plan-evidence');

function pixel(value, size) {
  return Math.round(Number(value) * (Number(size) - 1));
}

function locate(execDir, step, context = {}) {
  const sourceRef = context.sourceRef || step.sourceRef;
  const scene = readScene(execDir, sourceRef);
  const width = Number(scene.screenshot?.width);
  const height = Number(scene.screenshot?.height);
  if (!(width > 0 && height > 0)) throw contractError('TARGET_NOT_FOUND', `source Scene has no usable screenshot dimensions: ${sourceRef}`);
  const locator = step.locator || {};
  let resolution;
  if (locator.kind === 'POINT') {
    const point = locator.point;
    if (!Array.isArray(point) || point.length !== 2 || point.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw contractError('TARGET_NOT_FOUND', 'POINT locator must contain a normalized point');
    }
    resolution = {
      point: [pixel(point[0], width), pixel(point[1], height)], bounds: null,
      provider: 'POINT', confidence: 'DECLARED', basis: { sourceSceneRef: sourceRef, normalizedPoint: point },
    };
  } else if (locator.kind === 'REGION') {
    const region = locator.region;
    if (!Array.isArray(region) || region.length !== 4 || region.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
      || region[0] >= region[2] || region[1] >= region[3]) {
      throw contractError('TARGET_NOT_FOUND', 'REGION locator must contain normalized bounds');
    }
    const bounds = [pixel(region[0], width), pixel(region[1], height), pixel(region[2], width), pixel(region[3], height)];
    resolution = {
      point: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
      bounds, provider: 'REGION', confidence: 'DECLARED', basis: { sourceSceneRef: sourceRef, normalizedRegion: region },
    };
  } else if (locator.kind === 'ELEMENT_REF') {
    const element = (scene.elements || []).find((item) => item.id === locator.elementRef);
    if (!element || !Array.isArray(element.bounds) || element.bounds.length !== 4) {
      throw contractError('TARGET_NOT_FOUND', `element is not available in source Scene: ${locator.elementRef}`);
    }
    const bounds = element.bounds.map(Number);
    resolution = {
      point: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
      bounds, provider: 'ELEMENT_REF', confidence: 'STRUCTURAL',
      basis: { sourceSceneRef: sourceRef, elementRef: locator.elementRef, layoutRef: scene.layoutRef || null },
    };
  } else {
    throw contractError('LOCATOR_UNSUPPORTED', `unsupported locator provider: ${locator.kind || 'missing'}`);
  }
  const locatorRef = recordPlanEvidence(execDir, 'locator', step.id, {
    sourceRefs: [sourceRef], locator, resolution,
  }, context);
  return { status: 'LOCATED', resolution, locatorRef };
}

module.exports = { locate };

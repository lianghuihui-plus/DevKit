'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('../lib/contract-utils');
const { inspectPng } = require('../lib/image-evidence');
const { resolveArtifact } = require('../lib/execution-evidence');

function attribute(node, name) {
  return node?.attributes?.[name];
}

function isTrue(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function parseBounds(value) {
  const match = String(value || '').match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return null;
  const bounds = match.slice(1).map(Number);
  return bounds[2] > bounds[0] && bounds[3] > bounds[1] ? bounds : null;
}

function compactText(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].join(' / ').slice(0, 160);
}

function elementRef(observationRef, node, index) {
  const identity = {
    observationRef,
    hierarchy: attribute(node, 'hierarchy') || null,
    accessibilityId: attribute(node, 'accessibilityId') || null,
    bounds: attribute(node, 'bounds') || null,
    index,
  };
  return sha256(canonicalJson(identity), 'element', 16);
}

function collectElements(layout, observationRef) {
  const values = [];
  let index = 0;
  function visit(node, depth = 0) {
    const childLabels = (node?.children || []).flatMap((child) => visit(child, depth + 1));
    const ownLabels = [attribute(node, 'text'), attribute(node, 'originalText'), attribute(node, 'description'), attribute(node, 'hint')];
    const labels = [...ownLabels, ...childLabels].filter(Boolean);
    const text = compactText(labels);
    const bounds = parseBounds(attribute(node, 'bounds'));
    const type = String(attribute(node, 'type') || 'unknown');
    const clickable = isTrue(attribute(node, 'clickable'));
    const checkable = isTrue(attribute(node, 'checkable'));
    const editable = /input|textfield|textarea|edittext/i.test(type);
    const visible = attribute(node, 'visible') === undefined || isTrue(attribute(node, 'visible'));
    if (visible && bounds && (clickable || checkable || editable || compactText(ownLabels))) {
      values.push({
        ref: elementRef(observationRef, node, index++),
        text: text || type,
        role: type,
        bounds,
        clickable,
        checkable,
        editable,
        enabled: attribute(node, 'enabled') === undefined || isTrue(attribute(node, 'enabled')),
        depth,
      });
    }
    return labels;
  }
  visit(layout);
  return values
    .sort((left, right) => Number(right.clickable || right.checkable || right.editable) - Number(left.clickable || left.checkable || left.editable)
      || left.depth - right.depth)
    .slice(0, 240);
}

function buildObservationView(execDir, observation) {
  if (!observation?.ref) return null;
  const screenshotPath = resolveArtifact(execDir, observation.ref);
  const image = inspectPng(screenshotPath);
  const layoutRef = observation.artifacts?.layout || null;
  let elements = [];
  if (layoutRef) {
    const layoutPath = resolveArtifact(execDir, layoutRef);
    if (fs.existsSync(layoutPath)) {
      try { elements = collectElements(JSON.parse(fs.readFileSync(layoutPath, 'utf8')), observation.ref); } catch { elements = []; }
    }
  }
  return {
    schemaVersion: 1,
    observationRef: observation.ref,
    operationId: observation.operationId,
    scope: observation.scope,
    usable: observation.usable === true,
    screenshot: {
      ref: observation.ref,
      width: image.width,
      height: image.height,
    },
    layoutRef,
    elements,
  };
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

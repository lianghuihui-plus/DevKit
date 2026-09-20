'use strict';

const fs = require('fs');
const { contractError } = require('../lib/contract-utils');
const { resolveArtifact, sha256File } = require('../lib/execution-evidence');
const { readScene, recordPlanEvidence } = require('./plan-evidence');

function referenceExists(reference, context) {
  if (context.references instanceof Set) return context.references.has(reference);
  if (Array.isArray(context.references)) return context.references.includes(reference);
  return Boolean(context.references && Object.prototype.hasOwnProperty.call(context.references, reference));
}

function check(execDir, step, context = {}) {
  const sourceRef = context.sourceRef || step.sourceRef;
  const scene = readScene(execDir, sourceRef);
  const predicate = step.predicate || {};
  let status;
  let value;
  if (predicate.kind === 'CAPTURE_AVAILABLE') {
    const screenshot = scene.screenshot;
    let available = false;
    if (screenshot?.ref) {
      try {
        const file = resolveArtifact(execDir, screenshot.ref);
        available = fs.existsSync(file) && (!screenshot.sha256 || sha256File(file) === screenshot.sha256);
      } catch {
        available = false;
      }
    }
    status = available ? 'SATISFIED' : 'UNAVAILABLE';
    value = available;
  } else if (['ELEMENT_VISIBLE', 'ELEMENT_ENABLED'].includes(predicate.kind)) {
    const element = (scene.elements || []).find((item) => item.id === predicate.elementRef);
    if (!element) {
      status = 'UNAVAILABLE';
      value = null;
    } else {
      value = predicate.kind === 'ELEMENT_VISIBLE' ? element.visible === true : element.enabled === true;
      status = value ? 'SATISFIED' : 'NOT_SATISFIED';
    }
  } else if (predicate.kind === 'APP_IN_FOREGROUND') {
    value = typeof scene.app?.inTargetApp === 'boolean' ? scene.app.inTargetApp : null;
    status = value === null ? 'UNAVAILABLE' : value ? 'SATISFIED' : 'NOT_SATISFIED';
  } else if (predicate.kind === 'REFERENCE_EXISTS') {
    value = referenceExists(predicate.reference, context);
    status = value ? 'SATISFIED' : 'NOT_SATISFIED';
  } else {
    throw contractError('PLAN_CHECK_FAILED', `unsupported technical check: ${predicate.kind || 'missing'}`);
  }
  const sourceRefs = [sourceRef];
  const result = { checkRef: null, predicate, sourceRefs, status, value };
  const checkRef = recordPlanEvidence(execDir, 'check', step.id, { result: { ...result, checkRef: undefined } }, context);
  result.checkRef = checkRef;
  return { status: 'CHECKED', result, technicalFactRef: checkRef };
}

module.exports = { check };

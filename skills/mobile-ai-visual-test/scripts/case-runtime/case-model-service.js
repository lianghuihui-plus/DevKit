'use strict';

const { contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');
const store = require('./store');

function strings(value, label) {
  return ensureArray(value, label, 'CASE_MODEL_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_MODEL_INVALID').trim());
}

function history(execDir) {
  return store.events(execDir).filter((event) => event.type === 'caseModelRevised');
}

function current(execDir) {
  return history(execDir).at(-1) || null;
}

function nextVerificationRef(events) {
  const highest = events.flatMap((event) => event.verificationPoints || [])
    .map((item) => Number(String(item.ref || '').match(/^E(\d+)$/)?.[1] || 0))
    .reduce((max, value) => Math.max(max, value), 0);
  return `E${highest + 1}`;
}

function normalizeVerificationPoints(value, previous, events) {
  const supplied = ensureArray(value, 'verificationPoints', 'CASE_MODEL_INVALID');
  if (!supplied.length) {
    throw contractError('CASE_MODEL_INVALID', 'verificationPoints must contain at least one item');
  }
  const active = new Map((previous?.verificationPoints || []).map((item) => [item.ref, item]));
  const retired = new Set(events.flatMap((event) => event.retiredVerificationRefs || []));
  const resolved = [];
  for (const [index, valueItem] of supplied.entries()) {
    const item = ensureObject(valueItem, `verificationPoints[${index}]`, 'CASE_MODEL_INVALID');
    const unsupported = Object.keys(item).filter((field) => !['ref', 'text'].includes(field));
    if (unsupported.length) {
      throw contractError('CASE_MODEL_INVALID', `verificationPoints[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
    }
    const text = ensureString(item.text, `verificationPoints[${index}].text`, 'CASE_MODEL_INVALID').trim();
    let ref = item.ref === undefined ? null : ensureString(item.ref, `verificationPoints[${index}].ref`, 'CASE_MODEL_INVALID').trim();
    if (ref && (!active.has(ref) || retired.has(ref))) {
      throw contractError('CASE_MODEL_VERIFICATION_REF_INVALID', `verification point ${ref} is not active in the current Case Model`);
    }
    if (!ref) ref = nextVerificationRef([...events, { verificationPoints: resolved }]);
    if (resolved.some((entry) => entry.ref === ref)) {
      throw contractError('CASE_MODEL_VERIFICATION_REF_INVALID', `verification point ${ref} is duplicated`);
    }
    resolved.push({ ref, text, status: 'ACTIVE' });
  }
  return resolved;
}

function revise(execDir, value, options = {}) {
  const input = ensureObject(value, 'caseModel', 'CASE_MODEL_INVALID');
  const allowed = new Set(['understanding', 'preconditions', 'verificationPoints', 'items', 'uncertainties', 'reason']);
  const unsupported = Object.keys(input).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('CASE_MODEL_INVALID', `caseModel contains unsupported fields: ${unsupported.join(', ')}`);
  const events = history(execDir);
  const previous = events.at(-1) || null;
  if (previous && !String(input.reason || '').trim()) {
    throw contractError('CASE_MODEL_REASON_REQUIRED', 'reason is required when revising the current Case Model');
  }
  const verificationPoints = normalizeVerificationPoints(input.verificationPoints, previous, events);
  const items = strings(input.items, 'items');
  if (!items.length) throw contractError('CASE_MODEL_INVALID', 'items must contain at least one item');
  const activeRefs = new Set(verificationPoints.map((item) => item.ref));
  const newlyRetired = (previous?.verificationPoints || []).map((item) => item.ref).filter((ref) => !activeRefs.has(ref));
  const event = store.appendEvent(execDir, 'caseModelRevised', {
    revision: events.length + 1,
    reason: previous ? String(input.reason).trim() : 'INITIAL_UNDERSTANDING',
    basedOnSceneRef: store.readCurrentScene(execDir)?.sceneId || null,
    understanding: ensureString(input.understanding, 'understanding', 'CASE_MODEL_INVALID').trim(),
    preconditions: strings(input.preconditions, 'preconditions'),
    verificationPoints,
    retiredVerificationRefs: [...new Set([...(previous?.retiredVerificationRefs || []), ...newlyRetired])],
    items,
    uncertainties: strings(input.uncertainties, 'uncertainties'),
  }, options);
  return { status: 'CASE_MODEL_RECORDED', caseModel: event };
}

function currentRevision(execDir) {
  return current(execDir)?.revision || null;
}

module.exports = { current, currentRevision, history, revise };

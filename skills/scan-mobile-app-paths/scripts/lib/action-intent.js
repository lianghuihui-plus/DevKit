'use strict';

const { fail, hashObject } = require('./common');
const { flattenLayout, normalizeBounds, normalizeText, boundsOverlap } = require('./semantic-fingerprint');

const SYSTEM_KEYS = new Set(['BACK', 'HOME']);

function trim(value) {
  const text = String(value || '').trim();
  return text || null;
}

function selectorFromAction(action = {}) {
  const selector = {
    text: trim(action.selector?.text || action.target || action.text),
    accessibilityLabel: trim(action.selector?.accessibilityLabel),
    resourceId: trim(action.selector?.resourceId || action.selector?.id || action.resourceId),
    role: trim(action.selector?.role || action.role)
  };
  return Object.fromEntries(Object.entries(selector).filter(([, value]) => value));
}

function intentFromAction(action = {}) {
  if (!action || typeof action !== 'object') fail('action must be an object', 'ACTION_INVALID');
  const type = action.type;
  const selector = selectorFromAction(action);
  const intent = {
    schemaVersion: 1,
    type,
    target: trim(action.target || selector.text || selector.accessibilityLabel || selector.resourceId),
    selector,
    routeTransition: action.routeTransition === true
  };
  if (type === 'keyEvent') intent.key = String(action.key || '').toUpperCase();
  if (type === 'inputText') intent.text = String(action.text ?? action.value ?? '');
  if (type === 'swipe') {
    intent.direction = action.direction || inferSwipeDirection(action);
    intent.gesture = 'swipe';
  }
  return Object.fromEntries(Object.entries(intent).filter(([, value]) => value !== null && value !== undefined && !(typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)));
}

function inferSwipeDirection(action = {}) {
  const dx = Number(action.toX) - Number(action.fromX);
  const dy = Number(action.toY) - Number(action.fromY);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

function canonicalIntentIdentity(intent = {}) {
  return {
    type: intent.type || null,
    target: trim(intent.target),
    selector: {
      text: trim(intent.selector?.text),
      accessibilityLabel: trim(intent.selector?.accessibilityLabel),
      resourceId: trim(intent.selector?.resourceId),
      role: trim(intent.selector?.role)
    },
    key: intent.key || null,
    text: intent.type === 'inputText' ? String(intent.text ?? '') : null,
    direction: intent.type === 'swipe' ? intent.direction || null : null,
    routeTransition: intent.routeTransition === true
  };
}

function intentKey(intent) {
  return hashObject(canonicalIntentIdentity(intent));
}

function hasSemanticLocator(intent = {}) {
  return Boolean(trim(intent.target) || trim(intent.selector?.text) || trim(intent.selector?.accessibilityLabel) || trim(intent.selector?.resourceId) || trim(intent.selector?.role) || SYSTEM_KEYS.has(String(intent.key || '').toUpperCase()));
}

function hasCoordinateLocator(action = {}) {
  return Boolean(normalizeBounds(action.fallbackBounds) || Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y)) || ['fromX', 'fromY', 'toX', 'toY'].every(key => Number.isFinite(Number(action[key]))));
}

function locatorQualityFor(action = {}, intent = intentFromAction(action), matchedNode = null) {
  if (intent.type === 'keyEvent' && SYSTEM_KEYS.has(String(intent.key || '').toUpperCase())) return 'SEMANTIC_PORTABLE';
  if (intent.type === 'swipe' && !hasSemanticLocator(intent)) return 'DEVICE_BOUND';
  const semantic = hasSemanticLocator(intent);
  const coordinate = hasCoordinateLocator(action);
  if (semantic && matchedNode && coordinate) return 'SEMANTIC_WITH_FALLBACK';
  if (semantic && matchedNode) return 'SEMANTIC_PORTABLE';
  if (semantic) return 'UNRESOLVED';
  if (coordinate) return 'DEVICE_BOUND';
  return 'UNRESOLVED';
}

function nodeTextMatches(node, value) {
  const expected = normalizeText(value);
  if (!expected || !node.text) return false;
  return node.text === expected || node.text.includes(expected) || expected.includes(node.text);
}

function findNodeForIntent(layout, intent = {}) {
  if (!layout || !hasSemanticLocator(intent)) return null;
  const nodes = flattenLayout(layout);
  const resourceId = trim(intent.selector?.resourceId);
  const labels = [intent.selector?.text, intent.selector?.accessibilityLabel, intent.target].filter(Boolean);
  const role = trim(intent.selector?.role);
  const byId = resourceId ? nodes.find(node => node.id === resourceId) : null;
  if (byId) return byId;
  const byText = nodes.find(node => labels.some(label => nodeTextMatches(node, label)) && (!role || String(node.role || '').toLowerCase().includes(role.toLowerCase())));
  if (byText) return byText;
  return labels.length ? nodes.find(node => labels.some(label => nodeTextMatches(node, label))) || null : null;
}

function center(bounds) {
  const normalized = normalizeBounds(bounds);
  return normalized ? { x: Math.round((normalized[0] + normalized[2]) / 2), y: Math.round((normalized[1] + normalized[3]) / 2) } : {};
}

function locatorEvidenceFor({ action = {}, intent = intentFromAction(action), observation = null, layout = null, deviceProfile = null } = {}) {
  const matchedNode = findNodeForIntent(layout, intent);
  const fallbackBounds = normalizeBounds(action.fallbackBounds);
  const matchedBounds = normalizeBounds(matchedNode?.bounds);
  const actionPoint = Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y)) ? { x: Number(action.x), y: Number(action.y) } : center(fallbackBounds);
  const quality = locatorQualityFor(action, intent, matchedNode);
  const systemKey = intent.type === 'keyEvent' && SYSTEM_KEYS.has(String(intent.key || '').toUpperCase());
  return {
    schemaVersion: 1,
    resolution: systemKey ? 'SYSTEM_KEY' : matchedNode ? (fallbackBounds || actionPoint.x != null ? 'SEMANTIC_WITH_BOUNDS_FALLBACK' : 'SEMANTIC') : quality === 'DEVICE_BOUND' ? 'COORDINATE_ONLY' : 'UNRESOLVED',
    locatorQuality: quality,
    deviceProfileId: deviceProfile?.profileId || null,
    observationId: observation?.observationId || null,
    matchedNode: matchedNode ? {
      text: matchedNode.text || null,
      id: matchedNode.id || null,
      role: matchedNode.role || null,
      bounds: matchedBounds
    } : null,
    fallbackBounds,
    tapPoint: actionPoint.x != null && actionPoint.y != null ? actionPoint : null,
    boundsMatched: Boolean(fallbackBounds && matchedBounds && boundsOverlap(fallbackBounds, matchedBounds) >= 0.6)
  };
}

function executableActionFromIntent({ intent, layout, previousEvidence = null } = {}) {
  if (!intent) fail('Path replay edge is missing action intent', 'LOCATOR_UNRESOLVED');
  if (intent.type === 'keyEvent') return { type: 'keyEvent', key: intent.key };
  const matchedNode = findNodeForIntent(layout, intent);
  const bounds = normalizeBounds(matchedNode?.bounds);
  if (!bounds) fail('Cannot resolve semantic locator on current device', 'LOCATOR_UNRESOLVED');
  const point = center(bounds);
  if (intent.type === 'inputText') return { type: 'inputText', target: intent.target, fallbackBounds: bounds, ...point, value: String(intent.text || '') };
  if (intent.type === 'longPress') return { type: 'longPress', target: intent.target, fallbackBounds: bounds, ...point };
  if (intent.type === 'tap' || !intent.type) return { type: 'tap', target: intent.target, fallbackBounds: bounds, ...point, routeTransition: intent.routeTransition === true };
  if (intent.type === 'swipe') fail('Swipe intent requires a semantic resolver and cannot replay from stored coordinates', 'LOCATOR_UNRESOLVED');
  if (previousEvidence?.locatorQuality === 'DEVICE_BOUND') fail('Device-bound locator cannot be replayed across devices', 'LOCATOR_DEVICE_BOUND');
  fail(`Unsupported action intent type: ${intent.type}`, 'ACTION_UNSUPPORTED');
}

module.exports = {
  intentFromAction,
  canonicalIntentIdentity,
  intentKey,
  hasSemanticLocator,
  locatorQualityFor,
  locatorEvidenceFor,
  executableActionFromIntent,
  findNodeForIntent
};

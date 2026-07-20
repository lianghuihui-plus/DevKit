'use strict';

const { hashObject } = require('./common');
const { normalizeText, extractSemanticFingerprint } = require('./semantic-fingerprint');

function walk(value, output) {
  if (!value) return;
  if (Array.isArray(value)) return value.forEach(item => walk(item, output));
  if (typeof value !== 'object') return;
  const id = value.resourceId || value.id || value.key;
  const text = normalizeText(value.text || value.content || value.label || value.accessibilityLabel);
  if (id) output.ids.add(String(id));
  if (text) output.texts.add(text);
  const bounds = value.bounds || value.rect || null;
  output.shape.push({ role: value.type || value.role || value.className || 'node', id: id || null, text: text || null, bounds });
  for (const key of ['children', 'nodes', 'components']) walk(value[key], output);
}

function buildFingerprint(layout, foreground = {}, visual = {}) {
  const output = { ids: new Set(), texts: new Set(), shape: [] };
  walk(layout, output);
  const semantic = extractSemanticFingerprint(layout);
  return {
    schemaVersion: 2,
    app: foreground.bundleName || null,
    ability: foreground.ability || null,
    stableIds: [...output.ids].sort(),
    stableTexts: [...output.texts].sort(),
    stableRoles: [...new Set(output.shape.map(item => item.role).filter(Boolean))].sort(),
    semantic,
    layoutHash: hashObject(output.shape),
    screenshotSha256: visual.screenshotSha256 || null
  };
}

function compareFingerprint(a, b) {
  if (!a || !b) return 'UNCERTAIN';
  if (a.app !== b.app || a.ability !== b.ability) return 'UNCERTAIN';
  if (a.layoutHash === b.layoutHash) {
    const leftScreenshot = a.screenshotSha256 || a.screenshotPHash || null;
    const rightScreenshot = b.screenshotSha256 || b.screenshotPHash || null;
    if (leftScreenshot && rightScreenshot && leftScreenshot === rightScreenshot) return 'EXACT';
    // A layout-only match is never strong enough for NO_STATE_CHANGE. This is
    // intentionally conservative for canvas/image/video states and legacy Runs.
    return 'PROBABLE';
  }
  const left = new Set([...(a.stableIds || []), ...(a.stableTexts || [])]);
  const right = new Set([...(b.stableIds || []), ...(b.stableTexts || [])]);
  const union = new Set([...left, ...right]);
  const intersection = [...left].filter(x => right.has(x));
  return union.size && intersection.length / union.size >= 0.75 ? 'PROBABLE' : 'UNCERTAIN';
}

function observationVisual(observation = {}) {
  return {
    screenshotSha256: observation.stability?.finalScreenshotSha256 || null
  };
}

module.exports = { normalizeText, buildFingerprint, compareFingerprint, observationVisual };

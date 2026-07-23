'use strict';

const { hashObject, slug } = require('./common');
const { flattenLayout, normalizeBounds, normalizeText } = require('./semantic-fingerprint');

const ACTION_ROLE = /button|btn|tab|imagebutton|listitem|menuitem|checkbox|radio/i;
const LOW_VALUE_TEXT = /^(收起|展开|更多|返回|取消|关闭|知道了|我知道了|稍后|跳过)$|^\d{1,2}[-/.]\d{1,2}|^\d{1,2}:\d{2}|周[一二三四五六日天]$/;
const PRIMARY_TEXT = /(进入|查看|详情|播放|开始|继续|课程|回看|学习|创作|我的|首页|中心|全部|列表|更多)/;

function boolish(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function nodeValue(value = {}) {
  return { ...(value.attributes || {}), ...value };
}

function rawNodes(value, out = [], depth = 0) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(item => rawNodes(item, out, depth));
    return out;
  }
  if (typeof value !== 'object') return out;
  const node = nodeValue(value);
  out.push({ node, depth });
  for (const key of ['children', 'nodes', 'components']) rawNodes(value[key], out, depth + 1);
  return out;
}

function textOf(node = {}) {
  return normalizeText(node.text || node.content || node.label || node.accessibilityLabel || node.description || node.originalText);
}

function boundsOf(node = {}) {
  return normalizeBounds(node.bounds || node.rect || node.origBounds);
}

function roleOf(node = {}) {
  return String(node.type || node.role || node.className || '');
}

function selected(node = {}, role = '') {
  return /tab|radio|checkbox/i.test(role) && (boolish(node.selected) || boolish(node.checked) || String(node.state || '').toLowerCase() === 'selected');
}

function usefulBounds(bounds) {
  if (!bounds) return false;
  const width = Math.abs(Number(bounds[2]) - Number(bounds[0]));
  const height = Math.abs(Number(bounds[3]) - Number(bounds[1]));
  return width >= 24 && height >= 24;
}

function candidateKey(reachableState, text, bounds, source) {
  return `${slug(reachableState.visualStateId || reachableState.id, 'state')}/${slug(text, 'candidate')}-${hashObject({ bounds, source }).slice(-8)}`;
}

function priorityFor(source) {
  if (source === 'SEMANTIC_PRIMARY_ACTION') return { entryRank: 0, selectorRank: 0 };
  if (source === 'SEMANTIC_TAB') return { entryRank: 1, selectorRank: 1 };
  if (source === 'LAYOUT_CLICKABLE') return { entryRank: 2, selectorRank: 2 };
  if (source === 'SCROLL') return { entryRank: 9, selectorRank: 9 };
  return { entryRank: 5, selectorRank: 5 };
}

function buildSuggestion({ reachableState, visualState, observationId, text, bounds, source, confidence }) {
  return {
    reachableStateId: reachableState.id,
    visualStateId: visualState.id,
    observationId,
    candidateGroupKey: candidateKey(reachableState, text, bounds, source),
    candidate: { type: 'tap', target: text, fallbackBounds: bounds },
    source,
    confidence,
    priority: priorityFor(source)
  };
}

function extractCandidates({ reachableState, visualState, observationId, layout, existingKeys = new Set(), limit = 12 } = {}) {
  const suggestions = [];
  const seen = new Set(existingKeys);
  const nodes = rawNodes(layout);
  const flat = flattenLayout(layout);
  const add = suggestion => {
    if (!suggestion?.candidate?.target || !suggestion.candidate.fallbackBounds) return;
    if (LOW_VALUE_TEXT.test(suggestion.candidate.target)) return;
    if (!usefulBounds(suggestion.candidate.fallbackBounds)) return;
    if (seen.has(suggestion.candidateGroupKey)) return;
    seen.add(suggestion.candidateGroupKey);
    suggestions.push(suggestion);
  };

  for (const { node } of nodes) {
    const text = textOf(node);
    const bounds = boundsOf(node);
    const role = roleOf(node);
    const clickable = boolish(node.clickable) || boolish(node.longClickable) || ACTION_ROLE.test(role);
    if (!text || !bounds || !clickable || selected(node, role)) continue;
    const source = /tab/i.test(role) ? 'SEMANTIC_TAB' : 'LAYOUT_CLICKABLE';
    add(buildSuggestion({ reachableState, visualState, observationId, text, bounds, source, confidence: PRIMARY_TEXT.test(text) ? 0.9 : 0.72 }));
  }

  const semantic = visualState?.fingerprint?.semantic || {};
  const semanticTexts = [
    ...(semantic.primaryActions || []).map(text => ['SEMANTIC_PRIMARY_ACTION', text]),
    ...(semantic.tabs || []).map(text => ['SEMANTIC_TAB', text])
  ];
  for (const [source, text] of semanticTexts) {
    if (!text || LOW_VALUE_TEXT.test(text)) continue;
    const node = flat.find(item => item.text === text && item.bounds) || flat.find(item => item.text && (item.text.includes(text) || text.includes(item.text)) && item.bounds);
    if (!node?.bounds) continue;
    add(buildSuggestion({ reachableState, visualState, observationId, text, bounds: node.bounds, source, confidence: source === 'SEMANTIC_PRIMARY_ACTION' ? 0.78 : 0.68 }));
  }

  const scrollable = nodes.find(({ node }) => boolish(node.scrollable));
  if (scrollable) {
    const bounds = boundsOf(scrollable.node) || [100, 900, 1100, 2100];
    const text = '向上滑动';
    const group = `${slug(reachableState.visualStateId || reachableState.id, 'state')}/scroll-${hashObject(bounds).slice(-8)}`;
    if (!seen.has(group)) {
      seen.add(group);
      suggestions.push({
        reachableStateId: reachableState.id,
        visualStateId: visualState.id,
        observationId,
        candidateGroupKey: group,
        candidate: { type: 'swipe', target: text, fromX: Math.round((bounds[0] + bounds[2]) / 2), fromY: Math.round(bounds[3] * 0.82), toX: Math.round((bounds[0] + bounds[2]) / 2), toY: Math.round(bounds[1] + (bounds[3] - bounds[1]) * 0.28) },
        source: 'SCROLL',
        confidence: 0.55,
        priority: priorityFor('SCROLL')
      });
    }
  }

  return suggestions.sort((a, b) => (a.priority.entryRank ?? 9) - (b.priority.entryRank ?? 9) || b.confidence - a.confidence || a.candidateGroupKey.localeCompare(b.candidateGroupKey)).slice(0, limit);
}

module.exports = { extractCandidates };

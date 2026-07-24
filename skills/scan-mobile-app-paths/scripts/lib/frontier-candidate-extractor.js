'use strict';

const { hashObject, slug } = require('./common');
const { flattenLayout, normalizeBounds, normalizeText } = require('./semantic-fingerprint');
const { walkNodes, tapBoundsForEntry, classifyCandidate } = require('./candidate-classifier');

const ACTION_ROLE = /button|btn|tab|imagebutton|listitem|menuitem|checkbox|radio/i;
const LOW_VALUE_TEXT = /^(更多|返回|取消|关闭|知道了|我知道了|稍后|跳过)$|^\d{1,2}[-/.]\d{1,2}|^\d{1,2}:\d{2}|周[一二三四五六日天]$/;
const PRIMARY_TEXT = /(进入|查看|详情|播放|开始|继续|课程|回看|学习|创作|我的|首页|中心|全部|列表|更多)/;
const DATA_SKIP_CLASSES = new Set(['DYNAMIC_DATA_ITEM', 'BUSINESS_DATA_ITEM']);

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
  if (source === 'SEMANTIC_NAV_ENTRY' || source === 'SEMANTIC_SECTION_ENTRY' || source === 'SEMANTIC_BOTTOM_TAB') return { entryRank: 0, selectorRank: 0 };
  if (source === 'SEMANTIC_FILTER_ENTRY') return { entryRank: 1, selectorRank: 0 };
  if (source === 'SEMANTIC_COLLAPSE_TOGGLE') return { entryRank: 3, selectorRank: 1 };
  if (source === 'VISUAL_CARD_GROUP' || source === 'VISUAL_BANNER' || source === 'VISUAL_ICON_BUTTON') return { entryRank: 0, selectorRank: 1 };
  if (source === 'VISUAL_HORIZONTAL_SCROLL') return { entryRank: 1, selectorRank: 2 };
  if (source === 'SEMANTIC_TAB') return { entryRank: 1, selectorRank: 1 };
  if (source === 'STRUCTURAL_STABLE_ENTRY') return { entryRank: 1, selectorRank: 1 };
  if (source === 'LAYOUT_CLICKABLE') return { entryRank: 2, selectorRank: 2 };
  if (source === 'LAYOUT_TEXT_IN_CLICKABLE') return { entryRank: 4, selectorRank: 3 };
  if (source === 'SCROLL') return { entryRank: 9, selectorRank: 9 };
  return { entryRank: 5, selectorRank: 5 };
}

function buildSuggestion({ reachableState, visualState, observationId, text, bounds, source, confidence, candidateClass = null, classification = null, status = null, reasonCode = null }) {
  return {
    reachableStateId: reachableState.id,
    visualStateId: visualState.id,
    observationId,
    candidateGroupKey: candidateKey(reachableState, text, bounds, source),
    candidate: { type: 'tap', target: text, fallbackBounds: bounds },
    source,
    confidence,
    priority: priorityFor(source),
    candidateClass,
    classification,
    defaultStatus: status,
    reasonCode
  };
}

function suggestionStatusFor(classification) {
  if (DATA_SKIP_CLASSES.has(classification?.candidateClass)) return { status: 'SKIPPED', reasonCode: 'DYNAMIC_DATA_ITEM' };
  return { status: null, reasonCode: null };
}

function entryForNode(enrichedNodes, node, text, bounds) {
  return enrichedNodes.find(item => item.node === node) || enrichedNodes.find(item => item.text === text && item.bounds && normalizeBounds(item.bounds).join(',') === bounds.join(','));
}

function hasClickableContext(entry) {
  return Boolean(entry && (ACTION_ROLE.test(entry.role) || boolish(entry.node.clickable) || boolish(entry.node.longClickable) || entry.ancestors.some(item => ACTION_ROLE.test(item.role) || boolish(item.node.clickable) || boolish(item.node.longClickable))));
}

function dynamicAuditLimit(candidateRules = null) {
  const value = Number(candidateRules?.dynamicData?.maxAuditItemsPerState ?? 8);
  return Number.isFinite(value) && value >= 0 ? value : 8;
}

function extractCandidates({ reachableState, visualState, observationId, layout, existingKeys = new Set(), existingCandidateHashes = new Set(), limit = 12, candidateRules = null } = {}) {
  const suggestions = [];
  const seen = new Set(existingKeys);
  const seenCandidates = new Set(existingCandidateHashes);
  const nodes = rawNodes(layout);
  const enrichedNodes = walkNodes(layout);
  const flat = flattenLayout(layout);
  const add = suggestion => {
    if (!suggestion?.candidate?.target || !suggestion.candidate.fallbackBounds) return;
    if (LOW_VALUE_TEXT.test(suggestion.candidate.target)) return;
    if (!usefulBounds(suggestion.candidate.fallbackBounds)) return;
    const dedupe = hashObject(suggestion.candidate);
    if (seenCandidates.has(dedupe)) return;
    if (seen.has(suggestion.candidateGroupKey)) return;
    seen.add(suggestion.candidateGroupKey);
    seenCandidates.add(dedupe);
    suggestions.push(suggestion);
  };

  for (const { node } of nodes) {
    const text = textOf(node);
    const bounds = boundsOf(node);
    const role = roleOf(node);
    const clickable = boolish(node.clickable) || boolish(node.longClickable) || ACTION_ROLE.test(role);
    if (!text || !bounds || !clickable || selected(node, role)) continue;
    const source = /tab/i.test(role) ? 'SEMANTIC_TAB' : 'LAYOUT_CLICKABLE';
    const entry = entryForNode(enrichedNodes, node, text, bounds);
    const classification = classifyCandidate({ source, candidate: { type: 'tap', target: text, fallbackBounds: bounds }, entry, nodes: enrichedNodes, rules: candidateRules });
    const { status, reasonCode } = suggestionStatusFor(classification);
    add(buildSuggestion({ reachableState, visualState, observationId, text, bounds, source, confidence: PRIMARY_TEXT.test(text) ? 0.9 : 0.72, candidateClass: classification.candidateClass, classification, status, reasonCode }));
  }

  const semantic = visualState?.fingerprint?.semantic || {};
  const semanticTexts = [
    ...(semantic.primaryActions || []).map(text => ['SEMANTIC_PRIMARY_ACTION', text]),
    ...(semantic.tabs || []).map(text => ['SEMANTIC_TAB', text]),
    ...(semantic.navItems || []).map(text => ['SEMANTIC_NAV_ENTRY', text])
  ];
  for (const [source, text] of semanticTexts) {
    if (!text || LOW_VALUE_TEXT.test(text)) continue;
    const node = flat.find(item => item.text === text && item.bounds) || flat.find(item => item.text && (item.text.includes(text) || text.includes(item.text)) && item.bounds);
    if (!node?.bounds) continue;
    const entry = enrichedNodes.find(item => item.text === node.text && item.bounds && item.bounds.join(',') === node.bounds.join(','));
    const bounds = entry ? tapBoundsForEntry(entry, candidateRules) : node.bounds;
    const classification = classifyCandidate({ source, candidate: { type: 'tap', target: text, fallbackBounds: bounds }, entry, nodes: enrichedNodes, rules: candidateRules });
    const { status, reasonCode } = suggestionStatusFor(classification);
    add(buildSuggestion({ reachableState, visualState, observationId, text, bounds, source, confidence: source === 'SEMANTIC_PRIMARY_ACTION' ? 0.78 : 0.68, candidateClass: classification.candidateClass, classification, status, reasonCode }));
  }

  for (const entry of enrichedNodes) {
    const text = entry.text;
    if (!text || !entry.bounds || !hasClickableContext(entry)) continue;
    const bounds = tapBoundsForEntry(entry, candidateRules);
    const source = 'LAYOUT_TEXT_IN_CLICKABLE';
    const classification = classifyCandidate({ source, candidate: { type: 'tap', target: text, fallbackBounds: bounds }, entry, nodes: enrichedNodes, rules: candidateRules });
    const { status, reasonCode } = suggestionStatusFor(classification);
    if (classification.candidateClass === 'UNKNOWN_REVIEW_REQUIRED' || classification.candidateClass === 'STABLE_ENTRY' || DATA_SKIP_CLASSES.has(classification.candidateClass)) {
      add(buildSuggestion({ reachableState, visualState, observationId, text, bounds, source: classification.candidateClass === 'STABLE_ENTRY' ? 'STRUCTURAL_STABLE_ENTRY' : source, confidence: classification.confidence, candidateClass: classification.candidateClass, classification, status, reasonCode }));
    }
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
        priority: priorityFor('SCROLL'),
        candidateClass: 'SCROLL',
        classification: { candidateClass: 'SCROLL', reasonCodes: ['SCROLL_EXPLORATION'], confidence: 0.7 }
      });
    }
  }

  const autoOrReview = suggestions.filter(item => item.defaultStatus !== 'SKIPPED');
  const suppressed = suggestions.filter(item => item.defaultStatus === 'SKIPPED');
  const auditLimit = dynamicAuditLimit(candidateRules);
  const emittedSuppressed = suppressed.slice(0, auditLimit);
  const suppressedRemainder = suppressed.slice(auditLimit);
  const result = [
    ...autoOrReview.sort((a, b) => (a.priority.entryRank ?? 9) - (b.priority.entryRank ?? 9) || b.confidence - a.confidence || a.candidateGroupKey.localeCompare(b.candidateGroupKey)).slice(0, limit),
    ...emittedSuppressed
  ];
  result.dynamicAudit = {
    reasonCode: 'DYNAMIC_DATA_ITEMS_SUPPRESSED',
    totalCount: suppressed.length,
    emittedCount: emittedSuppressed.length,
    suppressedCount: suppressedRemainder.length,
    sampleCandidateGroupKeys: suppressedRemainder.slice(0, 8).map(item => item.candidateGroupKey).filter(Boolean)
  };
  return result;
}

module.exports = { extractCandidates, priorityFor };

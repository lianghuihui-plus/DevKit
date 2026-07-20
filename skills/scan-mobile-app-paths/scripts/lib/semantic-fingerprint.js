'use strict';

const { hashObject } = require('./common');

const DYNAMIC_TEXT = /^(\d+|\d{1,2}:\d{2}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\+?\d[\d\s-]{6,}|[¥￥$]\s*\d|\d+%|\d+\s*(秒|分|小时|天|条|个))$/;
const TITLE_ROLES = /title|header|toolbar|navigation/i;
const ACTION_ROLES = /button|btn|tab|switch|checkbox|radio|imagebutton/i;
const NAV_ROLES = /tab|navigation|bottom|menu|toolbar/i;

function normalizeText(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text || DYNAMIC_TEXT.test(text)) return null;
  return text.replace(/\d{4,}/g, '#');
}

function rawText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeBounds(bounds) {
  if (Array.isArray(bounds) && bounds.length === 4) {
    const values = bounds.map(Number);
    if (values.every(Number.isFinite) && values[2] > values[0] && values[3] > values[1]) return values;
  }
  if (bounds && typeof bounds === 'object') {
    const left = Number(bounds.left ?? bounds.x);
    const top = Number(bounds.top ?? bounds.y);
    const right = Number(bounds.right ?? (bounds.x != null && bounds.width != null ? Number(bounds.x) + Number(bounds.width) : NaN));
    const bottom = Number(bounds.bottom ?? (bounds.y != null && bounds.height != null ? Number(bounds.y) + Number(bounds.height) : NaN));
    if ([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top) return [left, top, right, bottom];
  }
  return null;
}

function roleOf(value = {}) {
  return String(value.type || value.role || value.className || 'node');
}

function flattenLayout(value, out = [], depth = 0, indexPath = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenLayout(item, out, depth, [...indexPath, index]));
    return out;
  }
  if (typeof value !== 'object') return out;
  const id = value.resourceId || value.id || value.key || null;
  const sourceText = rawText(value.text || value.content || value.label || value.accessibilityLabel);
  const text = normalizeText(sourceText);
  const role = roleOf(value);
  const bounds = normalizeBounds(value.bounds || value.rect || null);
  out.push({
    id: id ? String(id) : null,
    text,
    rawText: sourceText || null,
    role,
    bounds,
    depth,
    indexPath: indexPath.join('.')
  });
  for (const key of ['children', 'nodes', 'components']) flattenLayout(value[key], out, depth + 1, [...indexPath, key]);
  return out;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function overlapScore(left = [], right = []) {
  const a = new Set(left.filter(Boolean));
  const b = new Set(right.filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(item => b.has(item)).length;
  return intersection / Math.min(a.size, b.size);
}

function topTexts(nodes, predicate, limit) {
  return uniqueSorted(nodes.filter(predicate).map(node => node.text)).slice(0, limit);
}

function roleSkeleton(nodes) {
  return nodes.map(node => ({
    role: node.role,
    id: node.id || null,
    text: node.text || null,
    depth: node.depth,
    bounds: node.bounds
  }));
}

function coarseRoleSkeleton(nodes) {
  return nodes.map(node => ({ role: node.role, depth: node.depth }));
}

function extractSemanticFingerprint(layout) {
  const nodes = flattenLayout(layout);
  const stableTexts = uniqueSorted(nodes.map(node => node.text));
  const stableIds = uniqueSorted(nodes.map(node => node.id));
  const stableRoles = uniqueSorted(nodes.map(node => node.role));
  const dynamicTexts = uniqueSorted(nodes.map(node => (node.rawText && !node.text ? node.rawText : null)));
  const titles = topTexts(nodes, node => node.depth <= 2 && node.text && (TITLE_ROLES.test(node.role) || (node.bounds && node.bounds[1] < 260)), 12);
  const tabs = topTexts(nodes, node => node.text && (NAV_ROLES.test(node.role) || (node.bounds && node.bounds[3] > 900)), 16);
  const navItems = topTexts(nodes, node => node.text && (NAV_ROLES.test(node.role) || /首页|学习|课程|我的|创作|消息|发现|社区/.test(node.text)), 20);
  const primaryActions = topTexts(nodes, node => node.text && (ACTION_ROLES.test(node.role) || /确定|完成|下一步|继续|保存|关闭|取消|免费|全部|搜索|发布/.test(node.text)), 20);
  return {
    schemaVersion: 1,
    stableTexts,
    stableIds,
    stableRoles,
    titles,
    tabs,
    navItems,
    primaryActions,
    dynamicTexts,
    nodeCount: nodes.length,
    roleSkeletonHash: hashObject(roleSkeleton(nodes)),
    coarseRoleSkeletonHash: hashObject(coarseRoleSkeleton(nodes))
  };
}

function containsText(nodes, text) {
  const needle = normalizeText(text);
  if (!needle) return false;
  return nodes.some(node => node.text && (node.text === needle || node.text.includes(needle) || needle.includes(node.text)));
}

function boundsOverlap(left, right) {
  const a = normalizeBounds(left);
  const b = normalizeBounds(right);
  if (!a || !b) return 0;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!intersection) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return intersection / Math.min(areaA, areaB);
}

function candidateControlMatch(nodes, candidate = {}) {
  const labels = [candidate.target, candidate.text, candidate.selector?.text, candidate.selector?.accessibilityLabel].filter(Boolean);
  const textMatched = labels.some(label => containsText(nodes, label));
  const idNeedle = String(candidate.selector?.id || candidate.resourceId || '').trim();
  const idMatched = Boolean(idNeedle) && nodes.some(node => node.id && node.id === idNeedle);
  const candidateBounds = normalizeBounds(candidate.fallbackBounds);
  const boundsMatched = Boolean(candidateBounds) && nodes.some(node => boundsOverlap(candidateBounds, node.bounds) >= 0.6);
  return { matched: textMatched || idMatched || ((textMatched || idMatched) && boundsMatched), textMatched, idMatched, boundsMatched };
}

module.exports = {
  normalizeText,
  normalizeBounds,
  flattenLayout,
  extractSemanticFingerprint,
  overlapScore,
  containsText,
  boundsOverlap,
  candidateControlMatch
};

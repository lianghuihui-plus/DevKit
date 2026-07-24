'use strict';

const { normalizeBounds, normalizeText, boundsOverlap } = require('./semantic-fingerprint');

const AUTO_APPLY_CLASSES = new Set(['STABLE_ENTRY', 'FIXED_ENTRY', 'STRUCTURE_CONTROL', 'SCROLL']);

const BUSINESS_ACTION_TEXT = /^(去上课|去回看|继续学习|播放|查看详情|进入课程|开始学习)$/;
const BUSINESS_CONTENT_TEXT = /(KN\d+|课包|课程|作品|订单|活动|直播课|视频讲解|已提交|待开营|开营|评分|星级)/;
const BUSINESS_TIME_TEXT = /(\d{1,2}[-/.]\d{1,2}|周[一二三四五六日天]|\d{1,2}:\d{2})/;
const BUSINESS_STATUS_TEXT = /(已提交|待开营|已点评|已结束|进行中|未开始|观众|老师|讲师|开营|去上课|去回看)/;
const LOW_VALUE_TEXT = /^(更多|返回|取消|关闭|知道了|我知道了|稍后|跳过)$|^\d{1,2}[-/.]\d{1,2}|^\d{1,2}:\d{2}|周[一二三四五六日天]$/;
const FUNCTION_ENTRY_TEXT = /^(全部|我的|个人|设置|登录|注册|消息|通知|客服|帮助|反馈|搜索|扫一扫|首页|学习|创作|作品|工具|源码|课程|测评|直播|商城|活动|任务|成就|收藏|历史|订单|会员|账号|安全|隐私|关于|退出)/;
const FUNCTION_SUFFIX_TEXT = /(中心|入口|广场|工具|编辑器|列表|分类|专区|管理|设置|登录|注册|反馈|详情|首页|课程|作品|我的)$/;
const ID_LIKE_TEXT = /([A-Z]{1,6}\d{1,}|#[0-9]+|\d{4,}|[0-9a-f]{8,})/i;
const LIST_ROLE = /list|listitem|lazy|scroll|waterfall|grid/i;
const CONTAINER_ROLE = /listitem|row|column|stack|flex|common/i;
const ACTION_ROLE = /button|btn|tab|imagebutton|menuitem|checkbox|radio/i;
const NAV_ROLE = /tab|navigation|navbar|bottom|menu/i;

function boolish(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function roleOf(node = {}) {
  return String(node.type || node.role || node.className || '');
}

function textOf(node = {}) {
  return normalizeText(node.text || node.content || node.label || node.accessibilityLabel || node.description || node.originalText);
}

function boundsOf(node = {}) {
  return normalizeBounds(node.bounds || node.rect || node.origBounds);
}

function area(bounds) {
  return bounds ? Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1]) : 0;
}

function height(bounds) {
  return bounds ? Math.max(0, bounds[3] - bounds[1]) : 0;
}

function screenBoundsFromNodes(nodes = []) {
  const bounds = nodes.map(item => item.bounds).filter(Boolean);
  if (!bounds.length) return null;
  return [Math.min(...bounds.map(item => item[0])), Math.min(...bounds.map(item => item[1])), Math.max(...bounds.map(item => item[2])), Math.max(...bounds.map(item => item[3]))];
}

function isStructureControlText(text) {
  return ['收起', '展开'].includes(normalizeText(text));
}

function isAutoApplyCandidate(suggestion = {}) {
  return AUTO_APPLY_CLASSES.has(suggestion.candidateClass || suggestion.classification?.candidateClass);
}

function nodeValue(value = {}) {
  return { ...(value.attributes || {}), ...value };
}

function walkNodes(value, out = [], depth = 0, ancestors = [], indexPath = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNodes(item, out, depth, ancestors, [...indexPath, index]));
    return out;
  }
  if (typeof value !== 'object') return out;
  const node = nodeValue(value);
  const entry = { node, depth, ancestors, indexPath: indexPath.join('.'), text: textOf(node), role: roleOf(node), bounds: boundsOf(node) };
  out.push(entry);
  const nextAncestors = [...ancestors, entry];
  for (const key of ['children', 'nodes', 'components']) walkNodes(value[key], out, depth + 1, nextAncestors, [...indexPath, key]);
  return out;
}

function textsWithin(nodes, bounds) {
  return nodes
    .filter(item => item.text && item.bounds && boundsOverlap(item.bounds, bounds) >= 0.95)
    .map(item => item.text);
}

function textEntriesWithin(nodes, bounds) {
  return nodes.filter(item => item.text && item.bounds && boundsOverlap(item.bounds, bounds) >= 0.95);
}

function nearestContainer(entry, { minHeight = 56, maxHeight = 520, maxAreaRatio = 32 } = {}) {
  const own = entry.bounds;
  if (!own) return null;
  const ownArea = Math.max(1, area(own));
  const candidates = [...entry.ancestors].reverse().filter(item => {
    const bounds = item.bounds;
    if (!bounds) return false;
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];
    if (height < minHeight || height > maxHeight || width < 48) return false;
    if (area(bounds) > ownArea * maxAreaRatio && height > 180) return false;
    return CONTAINER_ROLE.test(item.role) || boolish(item.node.clickable) || boolish(item.node.longClickable);
  });
  return candidates[0] || null;
}

function nearestClickableContainer(entry, options = {}) {
  return nearestContainer(entry, options) || (entry.bounds && (ACTION_ROLE.test(entry.role) || boolish(entry.node.clickable) || boolish(entry.node.longClickable)) ? entry : null);
}

function tapBoundsForEntry(entry, rules = null) {
  const container = nearestClickableContainer(entry, { minHeight: 46, maxHeight: 260, maxAreaRatio: 80 });
  return container?.bounds || entry.bounds;
}

function hasClickableContext(entry) {
  return Boolean(entry && (ACTION_ROLE.test(entry.role) || boolish(entry.node.clickable) || boolish(entry.node.longClickable) || entry.ancestors.some(item => ACTION_ROLE.test(item.role) || boolish(item.node.clickable) || boolish(item.node.longClickable))));
}

function isShortEntryText(text, rules = null) {
  const value = normalizeText(text);
  const maxTextLength = Number(rules?.stableEntry?.maxTextLength || 14);
  if (!value || value.length > maxTextLength || LOW_VALUE_TEXT.test(value)) return false;
  if (ID_LIKE_TEXT.test(value) && value.length > 8) return false;
  return true;
}

function dataTextCount(contextTexts) {
  return contextTexts.filter(value => BUSINESS_CONTENT_TEXT.test(value) || BUSINESS_TIME_TEXT.test(value) || BUSINESS_STATUS_TEXT.test(value) || ID_LIKE_TEXT.test(value)).length;
}

function dynamicDataSignalsFor(entry, nodes, rules = null) {
  const bounds = entry.bounds;
  if (!bounds) return { isDynamicDataItem: false, isBusinessDataItem: false, reasonCodes: [] };
  const ancestorList = entry.ancestors.filter(item => LIST_ROLE.test(item.role));
  const container = nearestContainer(entry, { minHeight: 96, maxHeight: 520, maxAreaRatio: 120 }) || entry;
  const contextTexts = textsWithin(nodes, container.bounds || bounds);
  const text = entry.text || '';
  const reasonCodes = [];
  if (ancestorList.length) reasonCodes.push('INSIDE_LIST_CONTAINER');
  if (BUSINESS_ACTION_TEXT.test(text)) reasonCodes.push('DATA_ITEM_ACTION_TEXT');
  if (BUSINESS_CONTENT_TEXT.test(text)) reasonCodes.push('BUSINESS_OBJECT_TEXT');
  if (ID_LIKE_TEXT.test(text)) reasonCodes.push('DATA_ID_TEXT');
  if (contextTexts.some(value => BUSINESS_TIME_TEXT.test(value))) reasonCodes.push('DATA_TIME_TEXT_NEARBY');
  if (contextTexts.some(value => BUSINESS_STATUS_TEXT.test(value))) reasonCodes.push('DATA_STATUS_TEXT_NEARBY');
  const count = dataTextCount(contextTexts);
  if (count >= 2) reasonCodes.push('DATA_CARD_TEXT_CLUSTER');
  const minCluster = Number(rules?.dynamicData?.minClusterTextCount || 2);
  const isDynamicDataItem = (reasonCodes.includes('DATA_ITEM_ACTION_TEXT') && count >= 1) || (reasonCodes.includes('INSIDE_LIST_CONTAINER') && count >= minCluster) || count >= Math.max(3, minCluster + 1);
  return { isDynamicDataItem, isBusinessDataItem: isDynamicDataItem, reasonCodes: [...new Set(reasonCodes)], containerRole: container.role || null, containerBounds: container.bounds || null, contextTexts };
}

function businessSignalsFor(entry, nodes, rules = null) {
  return dynamicDataSignalsFor(entry, nodes, rules);
}

function stableEntrySignalsFor(entry, nodes, { source = null, rules = null } = {}) {
  const text = normalizeText(entry?.text);
  const bounds = entry?.bounds;
  if (!entry || !bounds || !isShortEntryText(text, rules)) return { isStableEntry: false, reasonCodes: [] };
  const reasonCodes = [];
  const screen = screenBoundsFromNodes(nodes);
  const semanticSource = Boolean(source && String(source).startsWith('SEMANTIC_'));
  const clickableContext = hasClickableContext(entry) || semanticSource;
  const ownInteractive = ACTION_ROLE.test(entry.role) || boolish(entry.node.clickable) || boolish(entry.node.longClickable);
  const navContext = NAV_ROLE.test(entry.role) || entry.ancestors.some(item => NAV_ROLE.test(item.role));
  if (ownInteractive) reasonCodes.push('INTERACTIVE_NODE');
  if (clickableContext && !ownInteractive) reasonCodes.push('INTERACTIVE_ANCESTOR');
  if (navContext) reasonCodes.push('NAV_OR_TAB_CONTEXT');
  if (semanticSource) reasonCodes.push(source);
  if (FUNCTION_ENTRY_TEXT.test(text) || FUNCTION_SUFFIX_TEXT.test(text)) reasonCodes.push('FUNCTION_ENTRY_TEXT');
  if (screen) {
    const yCenter = (bounds[1] + bounds[3]) / 2;
    const screenHeight = Math.max(1, screen[3] - screen[1]);
    if (yCenter >= screen[1] + screenHeight * 0.78 || yCenter <= screen[1] + screenHeight * 0.22) reasonCodes.push('STABLE_SCREEN_REGION');
  }
  const container = nearestContainer(entry, { minHeight: 40, maxHeight: 280, maxAreaRatio: 90 }) || entry;
  const contextEntries = textEntriesWithin(nodes, container.bounds || bounds);
  const contextTexts = contextEntries.map(item => item.text);
  const count = dataTextCount(contextTexts);
  if (count >= Number(rules?.dynamicData?.minClusterTextCount || 2)) reasonCodes.push('DATA_CONTEXT_NEARBY');
  if (BUSINESS_ACTION_TEXT.test(text) && count >= 1) reasonCodes.push('ACTION_IN_DATA_CONTEXT');
  const conciseGroup = contextEntries.length > 0 && contextEntries.length <= Number(rules?.stableEntry?.maxGroupTextCount || 12);
  if (conciseGroup && clickableContext && height(container.bounds || bounds) <= 280) reasonCodes.push('CONCISE_INTERACTIVE_GROUP');
  const stableReasonCount = reasonCodes.filter(code => !['DATA_CONTEXT_NEARBY', 'ACTION_IN_DATA_CONTEXT'].includes(code)).length;
  const ambiguousListText = ancestorListLike(entry) && !ownInteractive && BUSINESS_CONTENT_TEXT.test(text);
  const isStableEntry = clickableContext && stableReasonCount >= 2 && !ambiguousListText && !reasonCodes.includes('ACTION_IN_DATA_CONTEXT') && !(reasonCodes.includes('DATA_CONTEXT_NEARBY') && ancestorListLike(entry));
  return { isStableEntry, reasonCodes: [...new Set(reasonCodes)], containerRole: container.role || null, containerBounds: container.bounds || null, contextTextCount: contextTexts.length };
}

function ancestorListLike(entry) {
  return Boolean(entry?.ancestors?.some(item => LIST_ROLE.test(item.role)));
}

function classifyCandidate({ source, candidate, entry = null, nodes = [], rules = null } = {}) {
  const text = normalizeText(candidate?.target || entry?.text) || String(candidate?.target || entry?.text || '').trim();
  if (candidate?.type === 'swipe' || source === 'SCROLL') {
    return { candidateClass: 'SCROLL', reasonCodes: ['SCROLL_EXPLORATION'], confidence: 0.7 };
  }
  if (isStructureControlText(text)) {
    return { candidateClass: 'STRUCTURE_CONTROL', reasonCodes: ['STRUCTURE_CONTROL_TEXT'], confidence: 0.9 };
  }
  const dynamic = entry ? dynamicDataSignalsFor(entry, nodes, rules) : { isDynamicDataItem: false, reasonCodes: [] };
  if (dynamic.isDynamicDataItem) {
    return { candidateClass: 'DYNAMIC_DATA_ITEM', reasonCodes: dynamic.reasonCodes, containerRole: dynamic.containerRole, containerBounds: dynamic.containerBounds, confidence: 0.86 };
  }
  const stable = entry ? stableEntrySignalsFor(entry, nodes, { source, rules }) : { isStableEntry: false, reasonCodes: [] };
  if (stable.isStableEntry) {
    return { candidateClass: 'STABLE_ENTRY', reasonCodes: stable.reasonCodes, containerRole: stable.containerRole, containerBounds: stable.containerBounds, confidence: stable.reasonCodes.includes('NAV_OR_TAB_CONTEXT') || stable.reasonCodes.includes('FUNCTION_ENTRY_TEXT') ? 0.86 : 0.74 };
  }
  return { candidateClass: 'UNKNOWN_REVIEW_REQUIRED', reasonCodes: ['UNCLASSIFIED_INTERACTIVE_TEXT'], confidence: 0.5 };
}

module.exports = {
  AUTO_APPLY_CLASSES,
  walkNodes,
  isAutoApplyCandidate,
  tapBoundsForEntry,
  businessSignalsFor,
  dynamicDataSignalsFor,
  stableEntrySignalsFor,
  classifyCandidate
};

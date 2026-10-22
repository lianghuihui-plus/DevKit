'use strict';

const { canonicalJson, sha256 } = require('./contract-utils');

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source))) attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  return attributes;
}

function parseXml(source) {
  const document = { tag: '#document', attributes: {}, children: [] };
  const stack = [document];
  const tokens = String(source || '').match(/<[^>]+>/g) || [];
  for (const token of tokens) {
    if (/^<\?(?:.|\n)*\?>$/.test(token) || /^<!/.test(token)) continue;
    if (/^<\//.test(token)) {
      const name = token.slice(2, -1).trim();
      if (stack.length === 1 || stack[stack.length - 1].tag !== name) throw new Error(`mismatched closing tag: ${name}`);
      stack.pop();
      continue;
    }
    const selfClosing = /\/\s*>$/.test(token);
    const body = token.slice(1, selfClosing ? token.lastIndexOf('/') : -1).trim();
    const separator = body.search(/\s/);
    const tag = separator < 0 ? body : body.slice(0, separator);
    if (!tag) throw new Error('empty XML tag');
    const node = {
      tag,
      attributes: parseXmlAttributes(separator < 0 ? '' : body.slice(separator + 1)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`unclosed XML tag: ${stack[stack.length - 1].tag}`);
  if (document.children.length !== 1) throw new Error('XML layout requires one root element');
  return document.children[0];
}

function normalizeJsonNode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON layout root must be an object');
  const attributes = value.attributes && typeof value.attributes === 'object' && !Array.isArray(value.attributes)
    ? { ...value.attributes }
    : Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== 'children' && (typeof item !== 'object' || item === null)));
  return {
    tag: String(value.tag || attributes.type || attributes.class || 'node'),
    attributes,
    children: Array.isArray(value.children) ? value.children.map(normalizeJsonNode) : [],
  };
}

function parseLayout(source, hint = '') {
  const text = String(source || '').trim();
  const format = text.startsWith('<') ? 'xml' : text.startsWith('{') || text.startsWith('[') ? 'json' : String(hint || '').toLowerCase();
  try {
    if (!text) throw new Error('layout artifact is empty');
    if (format === 'xml') return { usable: true, format, root: parseXml(text), diagnostics: [] };
    if (format === 'json') return { usable: true, format, root: normalizeJsonNode(JSON.parse(text)), diagnostics: [] };
    throw new Error('layout format is not recognized');
  } catch (error) {
    return {
      usable: false,
      format: ['xml', 'json'].includes(format) ? format : 'unknown',
      root: null,
      diagnostics: [{ code: 'LAYOUT_PARSE_FAILED', severity: 'ERROR', message: error.message }],
    };
  }
}

function boolAttribute(attributes, names, fallback = false) {
  for (const name of names) {
    if (attributes[name] === undefined) continue;
    return attributes[name] === true || String(attributes[name]).toLowerCase() === 'true';
  }
  return fallback;
}

function numeric(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
}

function parseBounds(attributes = {}) {
  const match = String(attributes.bounds || '').match(/^\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]$/);
  if (match) {
    const bounds = match.slice(1).map(Number);
    return bounds[2] > bounds[0] && bounds[3] > bounds[1] ? bounds : null;
  }
  const x = numeric(attributes.x);
  const y = numeric(attributes.y);
  const width = numeric(attributes.width);
  const height = numeric(attributes.height);
  if ([x, y, width, height].every((value) => value !== null) && width > 0 && height > 0) return [x, y, x + width, y + height];
  return null;
}

function compactText(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].join(' / ').slice(0, 160);
}

function roleFor(node) {
  return String(node.attributes.type || node.attributes.class || node.tag || 'unknown');
}

function isDescendant(entry, container) {
  return entry.path.length > container.path.length
    && container.path.every((part, index) => entry.path[index] === part);
}

function isScrollContainer(entry) {
  if (!entry.visible || !entry.bounds) return false;
  if (/^XCUIElementType(?:Table|CollectionView|ScrollView)$/i.test(entry.role)) return true;
  return entry.scrollable && /list/i.test(entry.role);
}

function scrollItemsFor(states, container) {
  const descendants = states.filter((entry) => entry.visible && entry.bounds && isDescendant(entry, container));
  const directItems = descendants.filter((entry) => entry.path.length === container.path.length + 1
    && (/listitem/i.test(entry.role) || /XCUIElementTypeCell$/i.test(entry.role)));
  if (!/^XCUIElementType/i.test(container.role) || directItems.length > 1) return directItems;

  // Some iOS apps expose a whole viewport as one Cell. Its labelled descendants
  // are the stable anchors that remain comparable across consecutive snapshots.
  const contentRoots = directItems.length ? directItems : [container];
  const semanticItems = descendants.filter((entry) => entry.hasOwnText
    && contentRoots.some((root) => entry === root || isDescendant(entry, root))
    && !/XCUIElementType(?:Image|Other)$/i.test(entry.role));
  return semanticItems.length ? semanticItems : directItems;
}

function secureLength(value) {
  const text = String(value || '');
  if (!text) return 0;
  if (/^[•●·*]+$/u.test(text)) return Array.from(text).length;
  return null;
}

function stableStateKey(node, path) {
  const attributes = node.attributes;
  const identity = {
    role: roleFor(node),
    resourceId: attributes['resource-id'] || attributes.resourceId || null,
    accessibilityId: attributes.accessibilityId || null,
    name: attributes.name || null,
    label: attributes.label || null,
    placeholder: attributes.placeholderValue || attributes.hint || null,
    path,
  };
  return sha256(canonicalJson(identity), 'state', 20);
}

function stableAnchorKey(state) {
  return sha256(canonicalJson({
    role: state.role,
    resourceId: state.resourceId,
    accessibilityId: state.accessibilityId,
    name: state.name,
    label: state.label,
    text: state.text,
  }), 'scroll-anchor', 20);
}

function elementRef(observationRef, stateKey) {
  return sha256(canonicalJson({ observationRef, stateKey }), 'element', 16);
}

function viewportFrom(states) {
  const windows = states.filter((entry) => /window/i.test(entry.role) && entry.visible && entry.bounds);
  const candidates = windows.length ? windows : states.filter((entry) => entry.visible && entry.bounds && !entry.systemWindow);
  const largest = [...candidates].sort((left, right) => {
    const area = (entry) => (entry.bounds[2] - entry.bounds[0]) * (entry.bounds[3] - entry.bounds[1]);
    return area(right) - area(left);
  })[0];
  return largest ? { width: largest.bounds[2] - largest.bounds[0], height: largest.bounds[3] - largest.bounds[1] } : null;
}

function sameOrientation(left, right) {
  if (!left || !right || !left.width || !left.height || !right.width || !right.height) return true;
  return (left.width >= left.height) === (right.width >= right.height);
}

function projectLayout(parsed, observationRef, screenshot = {}, adapterSignals = {}) {
  if (!parsed?.usable || !parsed.root) {
    return {
      elements: [], states: [],
      signals: {
        keyboard: { shown: adapterSignals.keyboardShown === true, bounds: null, coordinateSpace: 'UNKNOWN', signalAgreement: 'UNKNOWN', source: adapterSignals.keyboardShown === undefined ? 'unavailable' : 'adapter' },
        focusedElement: null,
        coordinateConsistency: 'UNKNOWN',
      },
      diagnostics: [],
    };
  }
  const states = [];
  function visit(node, path, inheritedSystemWindow = false) {
    const attributes = node.attributes || {};
    const role = roleFor(node);
    const systemWindow = inheritedSystemWindow || /keyboard|inputmethod/i.test(role)
      || /inputmethod/i.test(String(attributes.package || ''));
    const visible = attributes.visible === undefined || boolAttribute(attributes, ['visible'], true);
    const secure = /securetextfield|password/i.test(role) || boolAttribute(attributes, ['password', 'secure']);
    const ownLabels = [attributes.text, attributes.originalText, attributes.description, attributes['content-desc'], attributes.label, attributes.name, attributes.hint, attributes.placeholderValue];
    const childLabels = node.children.flatMap((child, index) => visit(child, [...path, index], systemWindow));
    const safeOwnLabels = secure
      ? [attributes.label, attributes.name, attributes.hint, attributes.placeholderValue]
      : ownLabels;
    const displayText = compactText([...safeOwnLabels, ...childLabels]);
    const state = {
      stateKey: stableStateKey(node, path),
      role,
      text: displayText || role,
      bounds: parseBounds(attributes),
      clickable: boolAttribute(attributes, ['clickable']) || /button|key/i.test(role),
      checkable: boolAttribute(attributes, ['checkable']),
      editable: /input|textfield|textarea|edittext/i.test(role),
      enabled: attributes.enabled === undefined || boolAttribute(attributes, ['enabled'], true),
      visible,
      focused: boolAttribute(attributes, ['focused', 'hasFocus']),
      selected: boolAttribute(attributes, ['selected']),
      scrollable: boolAttribute(attributes, ['scrollable']),
      resourceId: attributes['resource-id'] || attributes.resourceId || attributes.id || null,
      accessibilityId: attributes.accessibilityId || null,
      name: attributes.name || null,
      label: attributes.label || null,
      secure,
      maskedLength: secure ? secureLength(attributes.value ?? attributes.text) : null,
      systemWindow,
      hasOwnText: Boolean(compactText(safeOwnLabels)),
      depth: path.length - 1,
      path,
    };
    states.push(state);
    return [...safeOwnLabels, ...childLabels].filter(Boolean);
  }
  visit(parsed.root, [0]);
  const keyboardState = states.find((entry) => /keyboard/i.test(entry.role) && entry.visible) || null;
  const keyboardShown = adapterSignals.keyboardShown === true || Boolean(keyboardState);
  const keyboardSignalDisagreement = adapterSignals.keyboardShown !== undefined
    && (adapterSignals.keyboardShown === true) !== Boolean(keyboardState);
  const viewport = viewportFrom(states);
  const screenshotSize = numeric(screenshot.width) && numeric(screenshot.height)
    ? { width: Number(screenshot.width), height: Number(screenshot.height) } : null;
  const keyboardOutsideViewport = Boolean(keyboardState?.bounds && viewport
    && (keyboardState.bounds[0] < -2 || keyboardState.bounds[1] < -2
      || keyboardState.bounds[2] > viewport.width + 2 || keyboardState.bounds[3] > viewport.height + 2));
  const coordinateMismatch = !sameOrientation(viewport, screenshotSize)
    || (keyboardShown && (keyboardOutsideViewport || keyboardSignalDisagreement));
  const focused = states.find((entry) => entry.focused && entry.visible) || null;
  const elements = states
    .filter((entry) => !entry.systemWindow && entry.visible && entry.bounds
      && (entry.clickable || entry.checkable || entry.editable || entry.hasOwnText))
    .sort((left, right) => Number(right.clickable || right.checkable || right.editable) - Number(left.clickable || left.checkable || left.editable)
      || left.depth - right.depth)
    .map((entry) => ({
      ref: elementRef(observationRef, entry.stateKey),
      text: entry.text,
      role: entry.role,
      bounds: entry.bounds,
      clickable: entry.clickable,
      checkable: entry.checkable,
      editable: entry.editable,
      enabled: entry.enabled,
      visible: entry.visible,
      focused: entry.focused,
      secure: entry.secure,
      maskedLength: entry.maskedLength,
      stateKey: entry.stateKey,
      depth: entry.depth,
    }));
  const scrollContainerStates = states.filter(isScrollContainer);
  const scrollContainers = scrollContainerStates
    .filter((container) => !scrollContainerStates.some((candidate) => candidate !== container && isDescendant(candidate, container)))
    .map((container) => {
      const items = scrollItemsFor(states, container);
      if (!items.length) return null;
      const exteriorSelection = states.filter((entry) => entry.selected
        && !container.path.every((part, index) => entry.path[index] === part))
        .map((entry) => ({ role: entry.role, text: entry.text, stateKey: entry.stateKey }));
      const contextKey = sha256(canonicalJson({
        stateKey: container.stateKey,
        bounds: container.bounds,
        exteriorSelection,
      }), 'scroll-context', 20);
      return {
        containerKey: container.stateKey,
        contextKey,
        role: container.role,
        bounds: container.bounds,
        axis: 'VERTICAL',
        items: items.sort((left, right) => left.bounds[1] - right.bounds[1]).map((item) => ({
          anchorKey: stableAnchorKey(item),
          textHash: sha256(item.text, 'scroll-text', 16),
          role: item.role,
          bounds: item.bounds,
          boundaryHint: /到底|没有更多|no more|end of (?:list|content)/i.test(item.text) ? 'END' : null,
        })),
      };
    })
    .filter(Boolean);
  return {
    elements,
    scrollContainers,
    states,
    signals: {
      keyboard: {
        shown: keyboardShown,
        bounds: keyboardState?.bounds || null,
        coordinateSpace: keyboardOutsideViewport ? 'OUTSIDE_LAYOUT_VIEWPORT' : keyboardState ? 'LAYOUT_VIEWPORT' : 'UNKNOWN',
        signalAgreement: keyboardSignalDisagreement ? 'MISMATCH' : adapterSignals.keyboardShown === undefined ? 'LAYOUT_ONLY' : 'CONSISTENT',
        source: adapterSignals.keyboardShown !== undefined ? 'adapter+layout' : keyboardState ? 'layout' : 'layout',
      },
      focusedElement: focused ? { stateKey: focused.stateKey, role: focused.role, text: focused.text, secure: focused.secure } : null,
      layoutViewport: viewport,
      adapterWindowRect: adapterSignals.windowRect || null,
      coordinateConsistency: coordinateMismatch ? 'MISMATCH' : viewport && screenshotSize ? 'CONSISTENT' : 'UNKNOWN',
    },
    diagnostics: [],
  };
}

module.exports = {
  parseBounds,
  parseLayout,
  parseXml,
  projectLayout,
};

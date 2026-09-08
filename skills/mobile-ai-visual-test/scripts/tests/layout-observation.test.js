#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { parseLayout, projectLayout } = require('../lib/layout-observation');

const harmony = parseLayout(JSON.stringify({
  attributes: { type: 'Root', bounds: '[0,0][100,200]', visible: 'true' },
  children: [{ attributes: { type: 'Button', text: '继续', bounds: '[10,20][60,70]', clickable: 'true', visible: 'true' }, children: [] }],
}));
assert.strictEqual(harmony.usable, true);
assert.strictEqual(harmony.format, 'json');
assert.strictEqual(projectLayout(harmony, 'harmony-observation', { width: 100, height: 200 }).elements[0].text, '继续');

const listLayout = parseLayout(JSON.stringify({
  attributes: { type: 'Root', bounds: '[0,0][1000,2000]', visible: 'true' },
  children: [
    { attributes: { type: 'Tab', text: '我的作品', selected: 'true', bounds: '[0,0][300,100]' }, children: [] },
    {
      attributes: { type: 'List', scrollable: 'true', bounds: '[0,100][1000,1900]', visible: 'true' },
      children: [
        { attributes: { type: 'ListItem', text: '作品 A', bounds: '[0,100][1000,500]', visible: 'true' }, children: [] },
        { attributes: { type: 'ListItem', text: '作品 B', bounds: '[0,500][1000,900]', visible: 'true' }, children: [] },
      ],
    },
  ],
}));
const listProjection = projectLayout(listLayout, 'list-observation', { width: 1000, height: 2000 });
assert.strictEqual(listProjection.scrollContainers.length, 1);
assert.strictEqual(listProjection.scrollContainers[0].axis, 'VERTICAL');
assert.strictEqual(listProjection.scrollContainers[0].items.length, 2);
assert.notStrictEqual(listProjection.scrollContainers[0].items[0].anchorKey, listProjection.scrollContainers[0].items[1].anchorKey);

const android = parseLayout(`<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" visible="true"><node class="android.widget.EditText" resource-id="account" text="abc" bounds="[20,40][500,120]" focused="true" enabled="true"/></node></hierarchy>`);
const androidView = projectLayout(android, 'android-observation', { width: 1080, height: 2400 });
assert.strictEqual(android.usable, true);
assert.strictEqual(androidView.elements[0].editable, true);
assert.strictEqual(androidView.signals.focusedElement.text, 'abc');

function iosSource(mask) {
  return `<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication width="834" height="1194"><XCUIElementTypeWindow visible="true" x="0" y="0" width="1194" height="834"><XCUIElementTypeSecureTextField value="${mask}" placeholderValue="密码" visible="true" enabled="true" x="440" y="322" width="314" height="48"/><XCUIElementTypeKeyboard visible="true" x="3" y="0" width="370" height="1194"><XCUIElementTypeKey name="q" visible="true" x="284" y="124" width="79" height="95"/></XCUIElementTypeKeyboard></XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`;
}

const iosBeforeProjection = projectLayout(parseLayout(iosSource('••••••')), 'ios-before', { width: 2388, height: 1668 });
const iosAfterProjection = projectLayout(parseLayout(iosSource('•••••••')), 'ios-after', { width: 2388, height: 1668 });
assert.strictEqual(iosBeforeProjection.signals.keyboard.shown, true);
assert.strictEqual(iosBeforeProjection.signals.coordinateConsistency, 'MISMATCH');
const adapterOnlyKeyboard = projectLayout(android, 'adapter-keyboard', { width: 1080, height: 2400 }, { keyboardShown: true });
assert.strictEqual(adapterOnlyKeyboard.signals.keyboard.signalAgreement, 'MISMATCH');
assert.strictEqual(adapterOnlyKeyboard.signals.coordinateConsistency, 'MISMATCH');
assert.strictEqual(iosBeforeProjection.elements.some((entry) => /Key/.test(entry.role)), false);
assert.strictEqual(iosBeforeProjection.elements.find((entry) => entry.secure).maskedLength, 6);

const malformed = parseLayout('<hierarchy><node></hierarchy>');
assert.strictEqual(malformed.usable, false);
assert.strictEqual(malformed.diagnostics[0].code, 'LAYOUT_PARSE_FAILED');

console.log('layout-observation passed');

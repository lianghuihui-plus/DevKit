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

const iosTable = parseLayout(`<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication width="834" height="1194"><XCUIElementTypeWindow visible="true" x="0" y="0" width="1194" height="834"><XCUIElementTypeTable visible="true" x="80" y="0" width="1114" height="834"><XCUIElementTypeOther name="体验课" visible="true" x="80" y="238" width="1114" height="54"><XCUIElementTypeStaticText value="体验课" name="体验课" label="体验课" visible="true" x="134" y="253" width="48" height="24"/></XCUIElementTypeOther><XCUIElementTypeCell visible="true" x="80" y="292" width="1114" height="542"><XCUIElementTypeStaticText value="自动化测试课包" name="自动化测试课包" label="自动化测试课包" visible="true" x="164" y="307" width="112" height="24"/><XCUIElementTypeStaticText value="自动化专用课程" name="自动化专用课程" label="自动化专用课程" visible="true" x="782" y="387" width="323" height="26"/></XCUIElementTypeCell></XCUIElementTypeTable></XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`);
const iosTableProjection = projectLayout(iosTable, 'ios-table-observation', { width: 1194, height: 834 });
assert.strictEqual(iosTableProjection.scrollContainers.length, 1);
assert.strictEqual(iosTableProjection.scrollContainers[0].role, 'XCUIElementTypeTable');
assert.ok(iosTableProjection.scrollContainers[0].items.length >= 2);
assert.ok(iosTableProjection.scrollContainers[0].items.some((item) => item.role === 'XCUIElementTypeStaticText'));

const iosCollection = parseLayout(`<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication><XCUIElementTypeWindow visible="true" x="0" y="0" width="390" height="844"><XCUIElementTypeCollectionView visible="true" x="0" y="100" width="390" height="600"><XCUIElementTypeCell visible="true" x="0" y="100" width="390" height="120"/><XCUIElementTypeCell visible="true" x="0" y="220" width="390" height="120"/></XCUIElementTypeCollectionView></XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`);
assert.strictEqual(projectLayout(iosCollection, 'ios-collection', { width: 390, height: 844 }).scrollContainers.length, 1);

const iosScrollView = parseLayout(`<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication><XCUIElementTypeWindow visible="true" x="0" y="0" width="390" height="844"><XCUIElementTypeScrollView visible="true" x="0" y="100" width="390" height="600"><XCUIElementTypeStaticText value="唯一内容" name="唯一内容" label="唯一内容" visible="true" x="20" y="120" width="100" height="30"/></XCUIElementTypeScrollView></XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`);
assert.strictEqual(projectLayout(iosScrollView, 'ios-scroll-view', { width: 390, height: 844 }).scrollContainers.length, 1);

const nestedIosScroll = parseLayout(`<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication><XCUIElementTypeWindow visible="true" x="0" y="0" width="390" height="844"><XCUIElementTypeScrollView visible="true" x="0" y="100" width="390" height="600"><XCUIElementTypeTable visible="true" x="0" y="100" width="390" height="600"><XCUIElementTypeCell visible="true" x="0" y="100" width="390" height="120"><XCUIElementTypeStaticText value="课程 A" name="课程 A" label="课程 A" visible="true" x="20" y="120" width="100" height="30"/></XCUIElementTypeCell></XCUIElementTypeTable></XCUIElementTypeScrollView></XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`);
const nestedIosProjection = projectLayout(nestedIosScroll, 'nested-ios-scroll', { width: 390, height: 844 });
assert.deepStrictEqual(nestedIosProjection.scrollContainers.map((item) => item.role), ['XCUIElementTypeTable']);

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

const largeLayout = parseLayout(JSON.stringify({
  attributes: { type: 'Root', bounds: '[0,0][1000,2000]', visible: 'true' },
  children: Array.from({ length: 260 }, (_, index) => ({
    attributes: {
      type: 'Button', text: `控件 ${index}`, bounds: `[0,${index}][100,${index + 1}]`,
      clickable: 'true', visible: 'true',
    },
    children: [],
  })),
}));
assert.strictEqual(projectLayout(largeLayout, 'large-observation', { width: 1000, height: 2000 }).elements.length, 260);

const malformed = parseLayout('<hierarchy><node></hierarchy>');
assert.strictEqual(malformed.usable, false);
assert.strictEqual(malformed.diagnostics[0].code, 'LAYOUT_PARSE_FAILED');

console.log('layout-observation passed');

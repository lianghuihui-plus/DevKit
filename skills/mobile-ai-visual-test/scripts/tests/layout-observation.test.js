#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { parseLayout, projectLayout } = require('../lib/layout-observation');
const { compareObservationViews, coordinateActionConflict, unresolvedEvidenceConflicts } = require('../lib/observation-consistency');

const harmony = parseLayout(JSON.stringify({
  attributes: { type: 'Root', bounds: '[0,0][100,200]', visible: 'true' },
  children: [{ attributes: { type: 'Button', text: '继续', bounds: '[10,20][60,70]', clickable: 'true', visible: 'true' }, children: [] }],
}));
assert.strictEqual(harmony.usable, true);
assert.strictEqual(harmony.format, 'json');
assert.strictEqual(projectLayout(harmony, 'harmony-observation', { width: 100, height: 200 }).elements[0].text, '继续');

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

const before = { _states: iosBeforeProjection.states, signals: iosBeforeProjection.signals };
const after = { _states: iosAfterProjection.states, signals: iosAfterProjection.signals };
const changed = compareObservationViews(before, after, { type: 'tap' });
assert.deepStrictEqual(changed.stateChanges.map((entry) => [entry.before, entry.after, entry.unexpected]), [[6, 7, true]]);
assert.ok(changed.conflicts.some((entry) => entry.code === 'UNEXPECTED_SECURE_INPUT_MUTATION' && entry.severity === 'CRITICAL'));
assert.ok(changed.conflicts.some((entry) => entry.code === 'KEYBOARD_COORDINATE_SPACE_MISMATCH' && entry.severity === 'ACTION_BLOCKING'));
assert.strictEqual(coordinateActionConflict({ conflicts: changed.conflicts }, 'ios', 'tap').code, 'KEYBOARD_COORDINATE_SPACE_MISMATCH');
assert.strictEqual(coordinateActionConflict({ conflicts: changed.conflicts }, 'android', 'tap'), null);
assert.strictEqual(coordinateActionConflict({ conflicts: changed.conflicts }, 'ios', 'dismissKeyboard'), null);

const malformed = parseLayout('<hierarchy><node></hierarchy>');
assert.strictEqual(malformed.usable, false);
assert.strictEqual(malformed.diagnostics[0].code, 'LAYOUT_PARSE_FAILED');

const events = [
  { type: 'actionResult', operationId: 'tap-1', requestedAction: { type: 'tap' }, ok: true },
  { type: 'observation', ref: 'after-tap', relatedOperationId: 'tap-1' },
  { type: 'actionResult', operationId: 'input-1', requestedAction: { type: 'inputText' }, ok: true, deviceResult: { inputEffect: { status: 'MASKED' } } },
  { type: 'observation', ref: 'after-input', relatedOperationId: 'input-1' },
];
const views = {
  'after-tap': { conflicts: changed.conflicts, signals: iosAfterProjection.signals },
  'after-input': { conflicts: [], _states: iosAfterProjection.states, signals: { keyboard: { shown: false }, coordinateConsistency: 'CONSISTENT' } },
};
assert.deepStrictEqual(unresolvedEvidenceConflicts('/unused', events, (_dir, event) => views[event.ref]), []);
assert.strictEqual(unresolvedEvidenceConflicts('/unused', events.slice(0, 2), (_dir, event) => views[event.ref])[0].code, 'UNEXPECTED_SECURE_INPUT_MUTATION');
const priorGenerationEvents = events.slice(0, 2).map((entry) => ({ ...entry, warmSessionGeneration: 1 }));
assert.deepStrictEqual(unresolvedEvidenceConflicts('/unused', priorGenerationEvents, (_dir, event) => views[event.ref], { warmSessionGeneration: 2 }), []);

console.log('layout-observation passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  chooseEditorPoint,
  layoutContainsText,
  parseArgs,
  parseBounds,
  percentile,
  prepareSettings,
  summarizeSamples,
  validateObservationArtifacts,
} = require('./android-helper-device-smoke');

assert.deepStrictEqual(parseArgs(['--device', 'serial-1', '--backend', 'helper']), {
  device: 'serial-1', backend: 'helper', mode: 'smoke', iterations: 10, warmups: 2,
});
assert.deepStrictEqual(parseArgs([
  '--device', 'serial-1', '--backend', 'auto', '--mode', 'benchmark',
  '--iterations', '4', '--warmups', '1',
]), {
  device: 'serial-1', backend: 'auto', mode: 'benchmark', iterations: 4, warmups: 1,
});
assert.throws(() => parseArgs(['--backend', 'helper']), /--device/);
assert.throws(() => parseArgs(['--device', 'serial-1', '--backend', 'invalid']), /--backend/);
assert.throws(() => parseArgs(['--device', 'serial-1', '--mode', 'benchmark', '--iterations', '0']), /--iterations/);

assert.deepStrictEqual(parseBounds('[10,20][110,220]'), {
  left: 10, top: 20, right: 110, bottom: 220, x: 60, y: 120,
});
assert.strictEqual(parseBounds('invalid'), null);
assert.strictEqual(percentile([9, 1, 7, 3, 5], 0.5), 5);
assert.strictEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);

const summary = summarizeSamples([
  { adapterElapsedMs: 12, deviceElapsedMs: 5, pngBytes: 100 },
  { adapterElapsedMs: 18, deviceElapsedMs: 7, pngBytes: 120 },
]);
assert.deepStrictEqual(summary, {
  count: 2,
  adapterElapsedMs: { p50: 12, p90: 18, max: 18 },
  deviceElapsedMs: { p50: 5, p90: 7, max: 7 },
  pngBytes: { p50: 100, p90: 120, max: 120 },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-helper-smoke-unit-'));
const png = path.join(root, 'screen.png');
const xml = path.join(root, 'layout.xml');
fs.writeFileSync(png, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]));
fs.writeFileSync(xml, '<?xml version="1.0"?><hierarchy><node bounds="[1,2][3,4]" /></hierarchy>');
assert.deepStrictEqual(validateObservationArtifacts(root, {
  artifacts: { screenshot: 'screen.png', layout: 'layout.xml' },
}), { screenshotPath: png, layoutPath: xml, pngBytes: 40, xmlBytes: 72 });
fs.writeFileSync(png, Buffer.from('not-png'));
assert.throws(() => validateObservationArtifacts(root, {
  artifacts: { screenshot: 'screen.png', layout: 'layout.xml' },
}), /PNG/);
fs.writeFileSync(xml, `<?xml version="1.0"?><hierarchy>
  <node resource-id="com.android.settings.intelligence:id/search_panel" class="android.widget.LinearLayout" bounds="[0,67][1080,1325]" />
  <node resource-id="com.android.settings.intelligence:id/search_src_text" class="android.widget.AutoCompleteTextView" bounds="[137,153][927,233]" />
</hierarchy>`);
assert.deepStrictEqual(chooseEditorPoint(xml, { width: 1080, height: 2316 }), {
  left: 137, top: 153, right: 927, bottom: 233, x: 532, y: 193,
});
assert.strictEqual(layoutContainsText(xml, 'mavt-append'), false);
fs.writeFileSync(xml, '<?xml version="1.0"?><hierarchy><node text="mavt-append" bounds="[1,2][3,4]" /></hierarchy>');
assert.strictEqual(layoutContainsText(xml, 'mavt-append'), true);
fs.rmSync(root, { recursive: true, force: true });

const prepareCalls = [];
prepareSettings({ device: 'serial-1' }, 'android.settings.APPLICATION_SETTINGS', {
  adb: (device, args) => prepareCalls.push([device, ...args]),
});
assert.deepStrictEqual(prepareCalls, [
  ['serial-1', 'shell', 'input', 'keyevent', 'WAKEUP'],
  ['serial-1', 'shell', 'wm', 'dismiss-keyguard'],
  ['serial-1', 'shell', 'am', 'start', '-W', '-a', 'android.settings.APPLICATION_SETTINGS'],
  ['serial-1', 'shell', 'sleep', '0.5'],
]);

console.log('android helper device smoke unit passed');

'use strict';

const assert = require('assert');
const {
  actionRefFor,
  buildCapabilities,
  parseActionRef,
  resolveAction,
  resolveActionRef,
} = require('../case-runtime/capability-catalog');

const scene = {
  sceneId: 'scene-0001',
  screenshot: { ref: 'screenshots/scene-0001.png', width: 1080, height: 1920 },
  layoutRef: 'layouts/scene-0001.json',
  app: { appId: 'com.example', inTargetApp: true },
  signals: { keyboard: { shown: true } },
  scrollContexts: [
    { id: 'vertical-list', axis: 'VERTICAL', trackingStatus: 'TRACKING', bounds: [0, 100, 1080, 1800] },
    { id: 'horizontal-list', axis: 'HORIZONTAL', trackingStatus: 'TRACKING', bounds: [100, 400, 980, 800] },
  ],
  elements: [
    {
      id: 'record-button', text: '录音', role: 'Button', bounds: [10, 20, 110, 120],
      clickable: true, checkable: true, editable: false, enabled: true, visible: true,
    },
    {
      id: 'message-input', text: '消息', role: 'TextField', bounds: [20, 140, 600, 220],
      clickable: false, checkable: false, editable: true, enabled: true, visible: true,
    },
  ],
  capabilities: [],
};

assert.deepStrictEqual(parseActionRef('record-button:longPress'), {
  elementRef: 'record-button',
  kind: 'longPress',
});
assert.deepStrictEqual(parseActionRef('screen:wait'), { elementRef: null, kind: 'wait' });
assert.throws(() => parseActionRef('record:button:tap'), (error) => error.code === 'ACTION_REF_INVALID');
assert.throws(() => actionRefFor({ target: 'record:button', kind: 'tap' }), (error) => error.code === 'ACTION_REF_INVALID');

for (const platform of ['android', 'harmony', 'ios']) {
  const capabilities = buildCapabilities(scene, platform);
  const inputFor = (kind) => ({
    longPress: { durationMs: 1200 },
    inputText: { text: '测试输入', mode: 'replace' },
    wait: { ms: 750 },
  })[kind];
  for (const capability of capabilities) {
    const actionRef = actionRefFor(capability);
    const rebuilt = resolveActionRef(scene, actionRef, platform);
    assert.ok(rebuilt, `${platform} must resolve ${actionRef}`);
    assert.strictEqual(rebuilt.id, capability.id);
    assert.strictEqual(rebuilt.kind, capability.kind);
    assert.strictEqual(rebuilt.target, capability.target);

    const request = {
      capabilityId: capability.id,
      ...(inputFor(capability.kind) ? { input: inputFor(capability.kind) } : {}),
      decision: { purpose: `验证 ${actionRef}` },
    };
    const direct = resolveAction({ ...scene, capabilities }, request, platform);
    const mapped = resolveAction({ ...scene, capabilities }, { ...request, capabilityId: rebuilt.id }, platform);
    assert.deepStrictEqual(mapped, direct, `${platform} ${actionRef} must preserve the device action`);
  }
  assert.strictEqual(scene.capabilities.length, 0, 'resolution must rebuild from complete Scene facts');
  assert.strictEqual(resolveActionRef(scene, 'missing:tap', platform), null);
}

console.log('action-ref mapping passed');

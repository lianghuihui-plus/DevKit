#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  describeActionConstraints,
  normalizeActionProposal,
  validateActionExecution,
} = require('../lib/action-contract');
const { run, runAllowFailure } = require('./helpers');

const platforms = ['harmony', 'android', 'ios'];
const commonActions = ['launchApp', 'restartApp', 'tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait'];

for (const platform of platforms) {
  const constraints = describeActionConstraints(platform, 'formal-execution');
  assert.strictEqual(constraints.schemaVersion, 1, `${platform}: action contract schema`);
  assert.deepStrictEqual(constraints.actionTypes, commonActions, `${platform}: common action types`);
  assert.deepStrictEqual(constraints.inputText.modes, ['replace', 'append'], `${platform}: input modes`);

  const waitResult = JSON.parse(run(`./scripts/platform/adapters/${platform}/action.sh`, ['--device', `${platform}-device`, '--app', `com.example.${platform}`, '--type', 'wait', '--ms', '0']));
  assert.strictEqual(waitResult.schemaVersion, 1, `${platform}: action result schema`);
  assert.strictEqual(waitResult.type, 'actionResult', `${platform}: action result type`);
  assert.strictEqual(waitResult.platform, platform, `${platform}: action result platform`);
  assert.strictEqual(waitResult.action, 'wait', `${platform}: wait action`);
  assert.strictEqual(waitResult.ok, true, `${platform}: wait result`);
  assert.strictEqual(waitResult.device.id, `${platform}-device`, `${platform}: action result device binding`);
  assert.strictEqual(waitResult.app.appId, `com.example.${platform}`, `${platform}: action result App binding`);
  assert.match(waitResult.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, `${platform}: local timestamp`);

  for (const script of ['probe-env.sh', 'platform/action.sh', 'platform/observe.sh']) {
    const result = runAllowFailure(`./scripts/${script}`, ['--platform', platform, '--definitely-unknown', 'value']);
    const expectedStatus = platform === 'ios' && script === 'platform/action.sh' ? 64 : 2;
    assert.strictEqual(result.status, expectedStatus, `${platform}: ${script} rejects unknown arguments`);
    assert.match(result.stderr, /未知参数|不支持的动作/, `${platform}: ${script} explains unknown argument`);
  }
}

assert.strictEqual(describeActionConstraints('harmony').inputText.coordinates, 'required');
assert.strictEqual(describeActionConstraints('android').inputText.coordinates, 'forbidden');
assert.strictEqual(describeActionConstraints('ios').inputText.focusedFieldRequired, true);
assert.strictEqual(normalizeActionProposal({ type: 'inputText', text: 'x', mode: 'addition' }).action.mode, 'append');
assert.strictEqual(normalizeActionProposal({ type: 'inputText', text: 'x' }).action.mode, 'replace');
assert.throws(() => validateActionExecution({
  type: 'tap', x: 10, y: 20, coordinateSource: 'layout',
}, { platform: 'android', scope: 'case-business' }), /coordinateEvidence is required/);
assert.throws(() => validateActionExecution({
  type: 'restartApp', reason: 'business navigation',
}, { platform: 'harmony', scope: 'case-business' }), /restartApp is not allowed for case-business/);

console.log('platform-contract passed');

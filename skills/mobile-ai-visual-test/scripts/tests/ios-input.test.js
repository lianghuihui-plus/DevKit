#!/usr/bin/env node
'use strict';

const assert = require('assert');
const appium = require('../platform/adapters/ios/lib/appium-client');
const {
  findEditableElement,
  inputEffectFor,
  inputTextWithFallback,
  normalizedInputValue,
} = require('../platform/adapters/ios/lib/ios-driver');

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const target = { appiumServer: 'http://appium.invalid' };

async function main() {
  assert.strictEqual(normalizedInputValue('Account placeholder', 'Account placeholder'), '');
  assert.deepStrictEqual(
    inputEffectFor({ className: 'XCUIElementTypeSecureTextField' }, '123456', '******', 'Password placeholder'),
    { status: 'MASKED', expectedLength: 6, observedLength: 6 },
  );
  assert.strictEqual(
    inputEffectFor({ className: 'XCUIElementTypeSecureTextField' }, '123456', '**', 'Password placeholder').status,
    'MISMATCH',
  );

  const originalRequest = appium.request;
  let currentValue = 'Account placeholder';
  const calls = [];
  appium.request = async (server, method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint.endsWith('/element/active')) return { value: { [ELEMENT_KEY]: 'account-field' } };
    if (method === 'POST' && endpoint.endsWith('/elements')) {
      if (body.value === 'XCUIElementTypeTextField') return { value: [{ [ELEMENT_KEY]: 'account-field' }] };
      if (body.value === 'XCUIElementTypeSecureTextField') return { value: [{ [ELEMENT_KEY]: 'password-field' }] };
      return { value: [] };
    }
    if (endpoint.includes('/attribute/')) {
      const name = endpoint.slice(endpoint.lastIndexOf('/') + 1);
      if (name === 'enabled' || name === 'visible') return { value: true };
      if (name === 'focused') return { value: false };
      if (name === 'placeholderValue') return { value: 'Account placeholder' };
      if (name === 'value') return { value: currentValue };
    }
    if (endpoint.endsWith('/clear')) {
      currentValue = '';
      return { value: null };
    }
    if (endpoint.endsWith('/element/account-field/value')) {
      throw new Error('WDA element value rejected');
    }
    if (endpoint.endsWith('/keys')) {
      currentValue = body.text;
      return { value: null };
    }
    throw new Error(`unexpected Appium request: ${method} ${endpoint}`);
  };

  try {
    const editable = await findEditableElement(target, 'session-1');
    assert.deepStrictEqual(editable, {
      elementId: 'account-field', className: 'XCUIElementTypeTextField', selection: 'active-element',
    });
    const result = await inputTextWithFallback(target, 'session-1', editable, '13223222360', 'replace');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.inputMethod, 'wda-session-keys');
    assert.strictEqual(result.inputEffect.status, 'VERIFIED');
    assert.strictEqual(result.inputEffect.attempts, 2);
    assert.deepStrictEqual(result.inputAttempts.map((attempt) => attempt.method), ['wda-element-value', 'wda-session-keys']);
    assert.strictEqual(calls.filter((call) => call.endpoint.endsWith('/keys')).length, 1);
  } finally {
    appium.request = originalRequest;
  }

  console.log('ios-input passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

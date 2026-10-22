#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  evaluateInputEffect,
  isMaskedValue,
  isSecureInput,
} = require('../platform/adapters/harmony/lib/input-effect');

function layout(attributes = {}) {
  return {
    attributes: { type: 'root', bounds: '[0,0][400,800]' },
    children: [{
      attributes: {
        type: 'TextInput',
        bounds: '[20,100][380,180]',
        text: '',
        ...attributes,
      },
      children: [],
    }],
  };
}

function evaluate(attributes, expectedText = '123456', mode = 'replace') {
  return evaluateInputEffect(layout(attributes), { x: 200, y: 140, expectedText, mode });
}

assert.strictEqual(evaluate({ text: '123456' }).status, 'VERIFIED');
assert.strictEqual(evaluate({ text: '******' }).status, 'MASKED');
assert.strictEqual(evaluate({ text: '\u2022\u2022\u2022\u2022\u2022\u2022' }).status, 'MASKED');
assert.strictEqual(evaluate({ text: '******' }).expectedText, undefined);
assert.strictEqual(evaluate({ text: '654321' }).status, 'MISMATCH');
assert.strictEqual(evaluate({ text: '654321', inputType: 'Password' }).status, 'MISMATCH');
assert.strictEqual(evaluate({ text: undefined, inputType: 'Password' }).status, 'UNVERIFIABLE');
assert.strictEqual(evaluate({ text: '123456' }, '123456', 'append').status, 'UNVERIFIABLE');
assert.strictEqual(evaluateInputEffect(layout(), { x: 500, y: 500, expectedText: 'x' }).status, 'UNVERIFIABLE');
assert.strictEqual(isMaskedValue('******', '123456'), true);
assert.strictEqual(isMaskedValue('123456', '123456'), false);
assert.strictEqual(isSecureInput({ secureTextEntry: true }), true);
assert.strictEqual(isSecureInput({ inputType: 'Password' }), true);
assert.strictEqual(isSecureInput({ type: 'TextInput' }), false);

console.log('harmony-input-effect passed');

'use strict';

const appium = require('./appium-client');

function truthyAttribute(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function falseyAttribute(value) {
  return value === false || String(value).toLowerCase() === 'false' || String(value) === '0';
}

function appiumElementId(value) {
  return value?.['element-6066-11e4-a52e-4f735466cecf'] || value?.ELEMENT || null;
}

async function getElementAttribute(target, sessionId, elementId, name) {
  try {
    const response = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/element/${elementId}/attribute/${name}`);
    return response.value;
  } catch {
    return null;
  }
}

async function findEditableElement(target, sessionId) {
  let activeElementId = null;
  try {
    const active = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/element/active`);
    activeElementId = appiumElementId(active.value);
  } catch {
    activeElementId = null;
  }
  const candidates = [];
  for (const cls of ['XCUIElementTypeTextField', 'XCUIElementTypeSearchField', 'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextView']) {
    const response = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/elements`, { using: 'class name', value: cls });
    for (const element of response.value || []) {
      const elementId = appiumElementId(element);
      if (!elementId) continue;
      candidates.push({
        elementId,
        className: cls,
        focused: await getElementAttribute(target, sessionId, elementId, 'focused'),
        visible: await getElementAttribute(target, sessionId, elementId, 'visible'),
        enabled: await getElementAttribute(target, sessionId, elementId, 'enabled'),
      });
    }
  }
  if (!candidates.length) throw new Error('No editable XCUI element found. Tap/focus an input field before inputText.');
  const active = candidates.filter((item) => item.elementId === activeElementId && !falseyAttribute(item.enabled));
  if (active.length === 1) return { elementId: active[0].elementId, className: active[0].className, selection: 'active-element' };
  const focused = candidates.filter((item) => truthyAttribute(item.focused) && !falseyAttribute(item.enabled));
  if (focused.length === 1) return { elementId: focused[0].elementId, className: focused[0].className, selection: 'focused' };
  const visible = candidates.filter((item) => !falseyAttribute(item.visible) && !falseyAttribute(item.enabled));
  if (visible.length === 1) return { elementId: visible[0].elementId, className: visible[0].className, selection: 'single-visible-editable' };
  if (candidates.length === 1) return { elementId: candidates[0].elementId, className: candidates[0].className, selection: 'single-editable' };
  throw new Error(`Multiple editable XCUI elements found (${candidates.length}). Tap/focus the target input before inputText.`);
}

function conciseError(error) {
  return String(error?.message || error || 'unknown input error').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function normalizedInputValue(value, placeholder) {
  if (value === null || value === undefined) return null;
  return placeholder !== null && placeholder !== undefined && String(value) === String(placeholder) ? '' : String(value);
}

function inputEffectFor(editable, expectedText, actualValue, placeholder) {
  const actualText = normalizedInputValue(actualValue, placeholder);
  if (editable.className === 'XCUIElementTypeSecureTextField') {
    if (actualText === null) return { status: 'UNVERIFIABLE', expectedLength: expectedText.length, reason: 'secure field value is unavailable' };
    if (actualText.length === 0) return { status: 'MISMATCH', expectedLength: expectedText.length, observedLength: 0, reason: 'secure field is still empty' };
    if (actualText.length !== expectedText.length) {
      return {
        status: 'MISMATCH', expectedLength: expectedText.length, observedLength: actualText.length,
        reason: 'secure field mask length does not match the requested text length',
      };
    }
    return { status: 'MASKED', expectedLength: expectedText.length, observedLength: actualText.length };
  }
  if (actualText === null) return { status: 'UNVERIFIABLE', expectedText, reason: 'field value is unavailable' };
  return { status: actualText === expectedText ? 'VERIFIED' : 'MISMATCH', expectedText, actualText };
}

async function readInputEffect(target, sessionId, editable, expectedText, placeholder) {
  const actualValue = await getElementAttribute(target, sessionId, editable.elementId, 'value');
  return inputEffectFor(editable, expectedText, actualValue, placeholder);
}

function inputEffectSucceeded(effect) {
  return ['VERIFIED', 'MASKED', 'UNVERIFIABLE'].includes(effect?.status);
}

async function inputTextWithFallback(target, sessionId, editable, text, mode) {
  const startedAt = Date.now();
  const placeholder = await getElementAttribute(target, sessionId, editable.elementId, 'placeholderValue');
  const beforeValue = await getElementAttribute(target, sessionId, editable.elementId, 'value');
  const beforeText = normalizedInputValue(beforeValue, placeholder);
  const expectedText = mode === 'append' && beforeText !== null ? `${beforeText}${text}` : text;
  const attempts = [];
  const methods = [
    {
      name: 'wda-element-value',
      send: () => appium.request(target.appiumServer, 'POST', `/session/${sessionId}/element/${editable.elementId}/value`, {
        text: expectedText,
        value: Array.from(expectedText),
      }),
    },
    {
      name: 'wda-session-keys',
      send: () => appium.request(target.appiumServer, 'POST', `/session/${sessionId}/keys`, {
        text: expectedText,
        value: Array.from(expectedText),
      }),
    },
  ];
  let lastEffect = null;
  for (const method of methods) {
    const attempt = { method: method.name, ok: false };
    try {
      if (mode === 'replace' || beforeText !== null) {
        try {
          await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/element/${editable.elementId}/clear`, {});
        } catch (error) {
          attempt.clearError = conciseError(error);
        }
      }
      await method.send();
      lastEffect = await readInputEffect(target, sessionId, editable, expectedText, placeholder);
      attempt.effectStatus = lastEffect.status;
      attempt.ok = inputEffectSucceeded(lastEffect);
      attempts.push(attempt);
      if (attempt.ok) {
        return {
          ok: true,
          inputMethod: method.name,
          inputMode: mode,
          inputTarget: editable.selection,
          inputAttempts: attempts,
          inputEffect: { ...lastEffect, attempts: attempts.length, settledMs: Date.now() - startedAt },
        };
      }
    } catch (error) {
      attempt.error = conciseError(error);
      try {
        lastEffect = await readInputEffect(target, sessionId, editable, expectedText, placeholder);
        attempt.effectStatus = lastEffect.status;
        if (['VERIFIED', 'MASKED'].includes(lastEffect.status)) {
          attempt.ok = true;
          attempts.push(attempt);
          return {
            ok: true,
            inputMethod: method.name,
            inputMode: mode,
            inputTarget: editable.selection,
            inputAttempts: attempts,
            inputEffect: { ...lastEffect, attempts: attempts.length, settledMs: Date.now() - startedAt },
          };
        }
      } catch (verificationError) {
        attempt.verificationError = conciseError(verificationError);
      }
      attempts.push(attempt);
    }
  }
  return {
    ok: false,
    failureCode: 'IOS_INPUT_TEXT_FAILED',
    message: 'iOS whole-string input failed after bounded adapter fallback',
    inputMethod: 'bounded-fallback-exhausted',
    inputMode: mode,
    inputTarget: editable.selection,
    inputAttempts: attempts,
    inputEffect: {
      ...(lastEffect || { status: 'UNVERIFIABLE', reason: 'input effect could not be read' }),
      attempts: attempts.length,
      settledMs: Date.now() - startedAt,
    },
  };
}

module.exports = {
  appiumElementId,
  conciseError,
  findEditableElement,
  inputEffectFor,
  inputTextWithFallback,
  normalizedInputValue,
};

'use strict';

const { fail } = require('./common');
const { validateAction } = require('./schema');
const { assessAction } = require('./safety');

const POPUP_DISPOSITIONS = Object.freeze(['PAGE', 'BUSINESS_MODAL', 'NO_STATE_CHANGE', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN']);
const SAFE_DISMISS = /(关闭|取消|稍后|暂不|我知道了|知道了|以后再说|不再提示|close|cancel|not\s*now|got\s*it|dismiss|^[x×]$)/i;
const UNSAFE_DISMISS = /(确定|确认|同意|允许|继续|提交|保存|删除|支付|购买|发送|ok|confirm|allow|agree|continue|submit|save|delete|pay|buy|send)/i;

function actionSemantic(action) {
  return [action.target, action.text, action.selector?.text, action.selector?.accessibilityLabel, action.selector?.resourceId].filter(Boolean).join(' ').trim();
}

function validatePopupDisposition(value) {
  const disposition = String(value || '').toUpperCase();
  if (!POPUP_DISPOSITIONS.includes(disposition)) fail(`popup disposition must be one of: ${POPUP_DISPOSITIONS.join(', ')}`, 'POPUP_DISPOSITION_INVALID');
  return disposition;
}

function validateDismissAction(input, target) {
  const action = validateAction(input);
  if (!['tap', 'keyEvent'].includes(action.type)) fail('Popup dismissal only allows tap or BACK keyEvent', 'POPUP_DISMISS_UNSAFE');
  if (action.type === 'keyEvent') {
    if (String(action.key).toUpperCase() !== 'BACK') fail('Popup dismissal only allows the BACK key', 'POPUP_DISMISS_UNSAFE');
  } else {
    const semantic = actionSemantic(action);
    if (!semantic || UNSAFE_DISMISS.test(semantic) || !SAFE_DISMISS.test(semantic)) fail('Popup dismissal target must have explicit weak-dismiss semantics', 'POPUP_DISMISS_UNSAFE');
  }
  const safety = assessAction(action, target); if (!safety.allowed) fail(`Popup dismissal blocked: ${safety.reasonCode}`, 'POPUP_DISMISS_UNSAFE');
  return { action, safety: { ...safety, role: 'POPUP_DISMISSAL' } };
}

module.exports = { POPUP_DISPOSITIONS, validatePopupDisposition, validateDismissAction };

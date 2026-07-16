'use strict';

const { hasSyntheticSpec } = require('./synthetic-data');

const HARD_BLOCK = /(支付|付款|购买|充值|转账|注销账号|删除账号|永久删除|发布|发送给|提交审核|密码|验证码|银行卡|身份证|pay|purchase|delete account|publish|password|otp)/i;
const TEST_WRITE = /(保存|提交|创建|新增|修改|上传|send|save|submit|create|update)/i;

function assessAction(action, target = {}) {
  const semantic = [action.target, action.text, action.value, action.selector?.text, action.selector?.accessibilityLabel].filter(Boolean).join(' ');
  if (HARD_BLOCK.test(semantic)) return { allowed: false, risk: 'PROHIBITED', reasonCode: 'SAFETY_HARD_BLOCK' };
  if (action.type === 'inputText' || TEST_WRITE.test(semantic)) {
    if (target.environment !== 'test') return { allowed: false, risk: 'WRITE', reasonCode: 'TEST_ENV_REQUIRED' };
    return { allowed: true, risk: 'LOW_RISK_FORM', sideEffect: 'TEST_DATA_WRITE', replayPolicy: !action.nonrepeatable && hasSyntheticSpec(action) ? 'REGENERATE_SYNTHETIC' : 'NONREPEATABLE' };
  }
  return { allowed: true, risk: 'SAFE', sideEffect: 'NONE', replayPolicy: 'AS_RECORDED' };
}

module.exports = { assessAction };

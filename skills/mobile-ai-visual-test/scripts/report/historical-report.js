'use strict';

const PRECONDITION_STATUS_LABELS = Object.freeze({
  READY: '可执行', CONFIRM: '需确认', NEEDS_SETUP: '需准备', UNKNOWN: '待判断', UNSUPPORTED: '不支持',
});

function normalizePreconditionText(value) {
  return String(value || '').trim().replace(/[。；;，,\s]+$/g, '').replace(/\s+/g, ' ');
}

function classifyPrecondition(item) {
  const text = normalizePreconditionText(item.text || item);
  const checkMode = String(item.checkMode || '');
  if (/真实支付|支付完成|真实扣款|清数据|卸载|删除|发布|修改真实|线上|生产|删除资料/.test(text) || checkMode === 'unsupported') {
    return { category: 'unsupported', status: 'UNSUPPORTED', defaultResolution: 'skip_or_user_handles_outside_execution' };
  }
  if (/短信|审核|第三方|风控|推送|邮件|支付/.test(text)) return { category: 'external_dependency', status: 'UNKNOWN', defaultResolution: 'external_setup' };
  if (/已登录|未登录|登录|账号|手机号|验证码|密码|会员|权限|角色|灰度/.test(text) || checkMode === 'auto_prepare') {
    return { category: 'account', status: 'CONFIRM', defaultResolution: 'confirm' };
  }
  if (/订单|草稿|余额|数据|商品|活动|资源|记录|内容|作品|列表.*有|已有/.test(text)) {
    return { category: 'business_data', status: 'NEEDS_SETUP', defaultResolution: 'setup_required' };
  }
  if (/App\s*已安装|已安装|设备已连接|截图|控件树/.test(text) || checkMode === 'auto_check') {
    return { category: 'platform', status: 'READY', defaultResolution: 'framework_checked' };
  }
  return { category: 'manual', status: 'CONFIRM', defaultResolution: 'confirm' };
}

function displayPreconditionStatus(status) {
  return PRECONDITION_STATUS_LABELS[status] || status || '-';
}

module.exports = { classifyPrecondition, displayPreconditionStatus, normalizePreconditionText };

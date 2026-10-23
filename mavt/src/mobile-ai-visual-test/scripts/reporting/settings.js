'use strict';
const { createRepository } = require('./repository');
const { reportingError, requireInput } = require('./errors');
const DEFAULT_SERVER_URL = 'https://mobile-backend.codemao.cn/mavtdashboard/';
function normalizeServerUrl(input) {
  if (typeof input !== 'string' || input !== input.trim() || /[\u0000-\u0020\u007f?#\\]/.test(input) || /^[a-z]+:\/\/[^/]*@/i.test(input)) throw reportingError('REPORTING_URL_INVALID', 'Invalid reporting destination');
  let url;
  try { url = new URL(input); } catch { throw reportingError('REPORTING_URL_INVALID', 'Invalid reporting destination'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback) || url.username || url.password) throw reportingError('REPORTING_URL_INVALID', 'Reporting requires HTTPS or explicit loopback HTTP');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}
function createSettings(options = {}) {
  const repository = options.repository || createRepository(options);
  const credentials = require('./credentials').createCredentials({repository});
  function raw() {
    const value = repository.readConfig('reporting.json') || {};
    if (value.serverUrl !== undefined) normalizeServerUrl(value.serverUrl);
    if (value.autoUpload !== undefined && typeof value.autoUpload !== 'boolean') throw reportingError('REPORTING_STATE_CORRUPT');
    return value;
  }
  function read() {
    const value = raw(), serverUrl = normalizeServerUrl(value.serverUrl || DEFAULT_SERVER_URL);
    return {serverUrl, autoUpload:value.autoUpload ?? true, configured:credentials.status(serverUrl).configured, noticeAcknowledged:value.notices?.[serverUrl] === true};
  }
  function update(input) {
    requireInput(input && typeof input === 'object' && !Array.isArray(input));
    requireInput(Object.keys(input).every(k => ['serverUrl', 'autoUpload', 'acknowledgeNotice'].includes(k)), 'Only non-secret settings may be updated');
    if (input.autoUpload !== undefined) requireInput(typeof input.autoUpload === 'boolean');
    if (input.acknowledgeNotice !== undefined) requireInput(typeof input.acknowledgeNotice === 'boolean');
    const serverUrl = input.serverUrl === undefined ? undefined : normalizeServerUrl(input.serverUrl);
    return repository.withConfigLock(() => {
      const previous = raw(), target = serverUrl || previous.serverUrl || DEFAULT_SERVER_URL;
      const notices = {...previous.notices};
      if (input.acknowledgeNotice !== undefined) notices[target] = input.acknowledgeNotice;
      repository.writeConfig('reporting.json', {...previous,serverUrl:target,autoUpload:input.autoUpload ?? previous.autoUpload ?? true,notices});
      return read();
    });
  }
  return {read, update};
}
module.exports = { createSettings, normalizeServerUrl, DEFAULT_SERVER_URL };

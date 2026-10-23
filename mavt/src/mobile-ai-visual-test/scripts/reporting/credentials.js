'use strict';
const crypto = require('node:crypto');
const { createRepository } = require('./repository');
const { normalizeServerUrl } = require('./settings');
const { reportingError } = require('./errors');
function createCredentials(options = {}) {
  const repository = options.repository || createRepository(options);
  function raw() {
    const record = repository.readConfig('credentials.json', {private:true});
    if (record && (!record.targets || typeof record.targets !== 'object' || Array.isArray(record.targets))) throw reportingError('REPORTING_STATE_CORRUPT');
    return record || {targets:{}};
  }
  function tokenAt(url) {
    const value = raw().targets[url];
    if (value === undefined) return '';
    if (!value || typeof value !== 'object' || typeof value.token !== 'string' || /[\r\n]/.test(value.token)) throw reportingError('REPORTING_CREDENTIALS_INVALID', 'Invalid local credential entry');
    return value.token.trim();
  }
  function status(serverUrl) {
    const url = normalizeServerUrl(serverUrl), token = tokenAt(url);
    return {configured:!!token,generation:token ? crypto.createHash('sha256').update(`${url}\0${token}`).digest('hex') : null};
  }
  function prepare(serverUrl) {
    const url = normalizeServerUrl(serverUrl);
    return repository.withConfigLock(() => {
      const value = raw();
      if (!Object.hasOwn(value.targets, url)) repository.writeConfig('credentials.json', {...value, targets:{...value.targets,[url]:{token:''}}});
      return {credentialPath:repository.credentialPath(),configured:status(url).configured};
    });
  }
  // Internal transport boundary only. Never return this value from an MCP View.
  function readForTransport(serverUrl) { return tokenAt(normalizeServerUrl(serverUrl)); }
  return {prepare, status, readForTransport};
}
module.exports = { createCredentials };

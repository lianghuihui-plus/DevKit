'use strict';
const crypto = require('node:crypto');
const SECRET = /^(authorization|proxy-authorization|token|access[_-]?token|refresh[_-]?token|password|passwd|cookie|set-cookie|secret|account|username|email|expectedText|actualText)$/i;
const DEVICE = /^(deviceId|udid|serial|serialNumber|advertisingId|androidId)$/i;
function createRedactor(salt) {
  const anon = value => 'device-' + crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 24);
  function text(value) {
    return value.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b(authorization|token|access_token|refresh_token|password|cookie|set-cookie|secret|account|username|email)(["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi, '$1$2[REDACTED]')
      .replace(/\b(deviceId|udid|serial|serialNumber|advertisingId|androidId)(["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi, (_match, key, separator, value) => key + separator + anon(value))
      .replace(/(?:\/(?:Users|home|private|tmp|var|opt|Applications|usr|Library|Volumes|fixtures)\/[^\s"'<>]*)|(?:[A-Za-z]:\\[^\s"'<>]*)/g, '[LOCAL_PATH]');
  }
  function redact(value, key = '') {
    if (SECRET.test(key))
      return '[REDACTED]';
    if (DEVICE.test(key) && value != null)
      return anon(value);
    if (typeof value === 'string')
      return text(value);
    if (Array.isArray(value))
      return value.map(child => redact(child));
    if (value && typeof value === 'object') {
      const copy = {};
      for (const [name, child] of Object.entries(value))
        copy[name] = redact(child, name);
      if (copy.type === 'inputText' && Object.hasOwn(copy, 'text'))
        copy.text = '[REDACTED]';
      if (copy.type === 'act' && copy.input && Object.hasOwn(copy.input, 'text'))
        copy.input.text = '[REDACTED]';
      return copy;
    }
    return value;
  }
  return {
    redact,
    text,
    anon
  };
}
module.exports = {
  createRedactor
};

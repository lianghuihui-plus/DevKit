'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { TextDecoder } = require('node:util');
const { normalizeServerUrl } = require('./settings');
const { createCredentials } = require('./credentials');
const { reportingError, ReportingError } = require('./errors');
const { LIMITS, validateCapabilities } = require('./contracts');
const RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUTS = Object.freeze({ ordinary: 15000, file: 180000, commit: 360000 });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function protocol(condition) {
  if (!condition) throw reportingError('REPORTING_PROTOCOL_INVALID');
}
function checkedTimeout(value) {
  protocol(Number.isFinite(value) && value > 0);
  return Math.max(1, Math.ceil(value));
}
function validateCapabilityResponse(value) {
  try {
    protocol(value && typeof value === 'object' && !Array.isArray(value));
    protocol(Object.keys(LIMITS).every(k => Number.isSafeInteger(value.limits?.[k]) && value.limits[k] > 0));
    protocol(value.chunkedUpload === false && Number.isSafeInteger(value.sessionTtlSeconds) && value.sessionTtlSeconds > 0);
    protocol(value.mediaTypes?.upload === 'opaque-attachment' && Array.isArray(value.encodings));
    validateCapabilities(value);
    return value;
  } catch { throw reportingError('REPORTING_PROTOCOL_INVALID'); }
}
function retryDelay(value, now) {
  if (typeof value !== 'string') return null;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 86400000)) : null;
}
function httpFailure(status, retryAfterMs) {
  const code = status === 401 || status === 403 ? 'REPORTING_NEEDS_CREDENTIAL'
    : status === 410 ? 'REPORTING_SESSION_EXPIRED'
      : status === 404 ? 'REPORTING_SESSION_NOT_FOUND'
        : status === 409 ? 'REPORTING_REMOTE_CONFLICT'
          : status === 429 || status === 503 ? 'REPORTING_RETRY_LATER' : 'REPORTING_HTTP_FAILED';
  const error = reportingError(code);
  error.status = status;
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}
/** A transport is permanently bound to one target and one accepted credential generation. */
function createTransport(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const credentials = options.credentials || createCredentials(options);
  const credentialGeneration = options.credentialGeneration;
  const clock = options.clock || Date.now;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  Object.values(timeouts).forEach(checkedTimeout);
  const base = new URL('api/v2/reporting/', serverUrl);
  function token() {
    // Hash the same secret used by the request; separate status/read operations
    // would allow a credential-file replacement between generation check and use.
    const secret = credentials.readForTransport(serverUrl);
    const generation = secret ? crypto.createHash('sha256').update(`${serverUrl}\0${secret}`).digest('hex') : null;
    if (!secret || !/^[\x21-\x7e]+$/.test(secret) || !credentialGeneration || generation !== credentialGeneration) throw reportingError('REPORTING_NEEDS_CREDENTIAL');
    return secret;
  }
  function request(method, relative, { body, headers = {}, timeout = timeouts.ordinary, accepted = [200] } = {}) {
    const secret = token();
    const url = new URL(relative, base);
    // All relative routes originate here; never follow a remote Location/header.
    protocol(url.origin === base.origin && url.pathname.startsWith(base.pathname));
    return new Promise((resolve, reject) => {
      let done = false, response, timer, responseValue, requestFinished = false;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (body && typeof body.destroy === 'function') body.destroy();
        if (error) { req.destroy(); response?.destroy(); reject(error); }
        else resolve(value);
      };
      const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers: {
        accept: 'application/json', authorization: `Bearer ${secret}`, ...headers
      } }, res => {
        response = res;
        const status = res.statusCode;
        if (status >= 300 && status < 400) return finish(reportingError('REPORTING_REDIRECT_REFUSED'));
        if (!accepted.includes(status)) return finish(httpFailure(status, retryDelay(res.headers['retry-after'], clock())));
        if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] || '') || res.headers['content-encoding']) {
          return finish(reportingError('REPORTING_PROTOCOL_INVALID'));
        }
        const length = res.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > RESPONSE_BYTES)) return finish(reportingError('REPORTING_RESPONSE_TOO_LARGE'));
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > RESPONSE_BYTES) return finish(reportingError('REPORTING_RESPONSE_TOO_LARGE'));
          chunks.push(chunk);
        });
        res.on('error', () => finish(reportingError('REPORTING_NETWORK_ERROR')));
        res.on('aborted', () => finish(reportingError('REPORTING_NETWORK_ERROR')));
        res.on('end', () => {
          if (done) return;
          try {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
            protocol(value && typeof value === 'object' && !Array.isArray(value));
            responseValue = value;
            if (requestFinished) finish(null, value);
          } catch { finish(reportingError('REPORTING_PROTOCOL_INVALID')); }
        });
      });
      req.on('finish', () => {
        requestFinished = true;
        if (responseValue) finish(null, responseValue);
      });
      req.on('error', () => finish(reportingError('REPORTING_NETWORK_ERROR')));
      timer = setTimeout(() => finish(reportingError('REPORTING_TIMEOUT')), checkedTimeout(timeout));
      if (body && typeof body.pipe === 'function') {
        body.on('error', error => finish(error instanceof ReportingError ? error : reportingError('REPORTING_UPLOAD_ERROR')));
        body.pipe(req);
      } else req.end(body);
    }).catch(error => {
      if (error instanceof ReportingError) throw error;
      throw reportingError('REPORTING_NETWORK_ERROR');
    });
  }
  const sessionRoute = id => { protocol(validId(id)); return `sessions/${id}`; };
  async function capabilities(requestOptions = {}) {
    return validateCapabilityResponse(await request('GET', 'capabilities', requestOptions));
  }
  async function upload(id, file, requestOptions = {}) {
    protocol(validId(file?.id) && ['identity', 'gzip'].includes(file.encoding));
    protocol(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^sha256:[a-f0-9]{64}$/.test(file.sha256));
    protocol(typeof file.mediaType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(file.mediaType));
    const limits = requestOptions.limits || LIMITS;
    protocol(file.bytes <= limits.fileBytes);
    token();
    const started = clock(), timeout = checkedTimeout(requestOptions.timeout || timeouts.file);
    let rawBytes = 0, wireBytes = 0;
    const hash = crypto.createHash('sha256');
    const verify = new Transform({ transform(chunk, encoding, callback) {
      rawBytes += chunk.length;
      if (rawBytes > file.bytes) return callback(reportingError('REPORTING_PACKAGE_CORRUPT'));
      hash.update(chunk); callback(null, chunk);
    } });
    const counter = new Writable({ write(chunk, encoding, callback) { wireBytes += chunk.length; callback(); } });
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeout);
    const stream = () => fs.createReadStream(file.path, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, highWaterMark: 64 * 1024 });
    try {
      const stages = [stream(), verify];
      if (file.encoding === 'gzip') stages.push(zlib.createGzip());
      await pipeline(...stages, counter, { signal: abort.signal });
      if (rawBytes !== file.bytes || `sha256:${hash.digest('hex')}` !== file.sha256) throw reportingError('REPORTING_PACKAGE_CORRUPT');
      if (file.encoding === 'gzip' && rawBytes > wireBytes * limits.gzipRatio) throw reportingError('REPORTING_GZIP_RATIO_EXCEEDED');
    } catch (error) {
      if (error instanceof ReportingError) throw error;
      throw reportingError(abort.signal.aborted ? 'REPORTING_TIMEOUT' : 'REPORTING_UPLOAD_ERROR');
    } finally { clearTimeout(timer); }
    const remaining = timeout - (clock() - started);
    if (remaining <= 0) throw reportingError('REPORTING_TIMEOUT');
    // The prepass only measures the wire representation. The filesystem can
    // change before or during this read, so enforce raw and wire bounds on the
    // actual transmitting pipeline and withhold its end on any mismatch.
    const source = stream(), sentHash = crypto.createHash('sha256');
    let sentRawBytes = 0, sentWireBytes = 0, pending;
    const verifySending = new Transform({
      transform(chunk, encoding, callback) {
        sentRawBytes += chunk.length;
        if (sentRawBytes > file.bytes) return callback(reportingError('REPORTING_PACKAGE_CORRUPT'));
        sentHash.update(chunk);
        if (pending) this.push(pending);
        pending = chunk;
        callback();
      },
      flush(callback) {
        const matches = sentRawBytes === file.bytes && `sha256:${sentHash.digest('hex')}` === file.sha256;
        if (!matches) return callback(reportingError('REPORTING_PACKAGE_CORRUPT'));
        // Keep the final bounded raw chunk until EOF verification. Otherwise a
        // grown file's valid-size prefix could finish the remote request first.
        if (pending) this.push(pending);
        pending = null;
        callback();
      }
    });
    const body = new Transform({
      transform(chunk, encoding, callback) {
        sentWireBytes += chunk.length;
        if (sentWireBytes > wireBytes) return callback(reportingError('REPORTING_PACKAGE_CORRUPT'));
        callback(null, chunk);
      },
      flush(callback) {
        callback(sentWireBytes === wireBytes ? null : reportingError('REPORTING_PACKAGE_CORRUPT'));
      }
    });
    const stages = [source, verifySending];
    if (file.encoding === 'gzip') stages.push(zlib.createGzip());
    // Observe rejection immediately: the HTTP request and filesystem pipeline
    // run together, and either failure must tear down all participating streams.
    const sending = pipeline(...stages, body).catch(error => error);
    let result;
    try {
      result = await request('PUT', `${sessionRoute(id)}/files/${file.id}`, {
        body, timeout: remaining, headers: { 'content-type': file.mediaType, 'content-length': wireBytes,
          ...(file.encoding === 'gzip' ? { 'content-encoding': 'gzip' } : {}) }
      });
      const error = await sending;
      if (error) throw error instanceof ReportingError ? error : reportingError('REPORTING_UPLOAD_ERROR');
    } finally {
      source.destroy(); body.destroy();
      await sending;
    }
    protocol(result.status === 'AVAILABLE');
    return { rawBytes, wireBytes };
  }
  return Object.freeze({ serverUrl, credentialGeneration, timeouts: Object.freeze(timeouts), capabilities,
    prepare: (raw, key, requestOptions = {}) => {
      protocol(typeof raw === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key));
      return request('POST', 'sessions', { ...requestOptions, body: raw, accepted: [200, 201], headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'idempotency-key': key
      } });
    },
    status: (id, requestOptions = {}) => request('GET', sessionRoute(id), requestOptions),
    commit: (id, requestOptions = {}) => request('POST', `${sessionRoute(id)}/commit`, { timeout: timeouts.commit,
      ...requestOptions, body: '{}', headers: { 'content-type': 'application/json', 'content-length': 2 } }),
    upload
  });
}
module.exports = { createTransport, DEFAULT_TIMEOUTS, RESPONSE_BYTES, validateCapabilityResponse, validId };

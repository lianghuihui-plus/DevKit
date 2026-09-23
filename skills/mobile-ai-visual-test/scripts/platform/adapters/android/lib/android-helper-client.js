'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

class AndroidHelperError extends Error {
  constructor(message, { code, phase, statusCode = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.phase = phase;
    if (statusCode !== null) this.statusCode = statusCode;
  }
}

class HelperUnavailableBeforeDispatch extends AndroidHelperError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ANDROID_HELPER_UNAVAILABLE_BEFORE_DISPATCH',
      phase: 'BEFORE_DISPATCH',
      ...options,
    });
  }
}

class HelperAuthenticationRejected extends AndroidHelperError {
  constructor(message = 'Android Helper rejected authentication', options = {}) {
    super(message, {
      code: 'ANDROID_HELPER_AUTHENTICATION_REJECTED',
      phase: 'AUTH_REJECTED',
      statusCode: 401,
      ...options,
    });
  }
}

class HelperActionOutcomeUnknown extends AndroidHelperError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN',
      phase: 'POST_DISPATCH_UNKNOWN',
      ...options,
    });
  }
}

function helperError(message, options) {
  return options.kind === 'ACTION' && options.connected
    ? new HelperActionOutcomeUnknown(message, options)
    : new HelperUnavailableBeforeDispatch(message, options);
}

function safeRemoteMessage(value, fallback) {
  const message = typeof value?.error === 'string' ? value.error.trim() : '';
  return (message || fallback).slice(0, 1000);
}

function httpJson({ host = '127.0.0.1', port, method = 'GET', requestPath, headers = {}, body, timeoutMs, kind = 'READ_ONLY' }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    const encodedBody = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host,
      port,
      method,
      path: requestPath,
      headers: {
        accept: 'application/json',
        ...headers,
        ...(encodedBody ? {
          'content-type': 'application/json',
          'content-length': encodedBody.length,
        } : {}),
      },
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    request.on('socket', (socket) => {
      if (socket.connecting) socket.once('connect', () => { connected = true; });
      else connected = true;
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Android Helper request timed out after ${timeoutMs}ms`));
    });
    request.on('error', (error) => {
      finish(reject, helperError(error.message || 'Android Helper request failed', { kind, connected }));
    });
    request.on('response', (response) => {
      connected = true;
      const declared = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        response.destroy();
        finish(reject, helperError('Android Helper response body exceeds 64 MiB', { kind, connected }));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(reject, helperError('Android Helper response body exceeds 64 MiB', { kind, connected }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) => {
        finish(reject, helperError(error.message || 'Android Helper response failed', { kind, connected }));
      });
      response.on('aborted', () => {
        finish(reject, helperError('Android Helper response was truncated', { kind, connected }));
      });
      response.on('end', () => {
        if (settled) return;
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          finish(reject, helperError('Android Helper returned invalid JSON', { kind, connected }));
          return;
        }
        if (response.statusCode === 401) {
          finish(reject, new HelperAuthenticationRejected(undefined, { statusCode: 401 }));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(reject, helperError(
            safeRemoteMessage(value, `Android Helper returned HTTP ${response.statusCode}`),
            { kind, connected, statusCode: response.statusCode },
          ));
          return;
        }
        finish(resolve, { value, statusCode: response.statusCode });
      });
    });
    if (encodedBody) request.write(encodedBody);
    request.end();
  });
}

function requestJson(session, request) {
  if (!session || !Number.isInteger(Number(session.localPort)) || !String(session.token || '')) {
    return Promise.reject(new HelperUnavailableBeforeDispatch('Android Helper session is incomplete'));
  }
  return httpJson({
    host: '127.0.0.1',
    port: Number(session.localPort),
    method: request.method || 'GET',
    requestPath: request.path,
    headers: { 'X-Artemis-Token': session.token },
    body: request.body,
    timeoutMs: request.timeoutMs,
    kind: request.kind || 'READ_ONLY',
  }).then((result) => result.value);
}

async function ping(session, options = {}) {
  return requestJson(session, {
    path: '/ping',
    timeoutMs: Number(options.timeoutMs || 1000),
    kind: 'READ_ONLY',
  });
}

async function performAction(session, command, params = {}, options = {}) {
  return requestJson(session, {
    method: 'POST',
    path: '/action',
    body: { cmd: command, ...params },
    timeoutMs: Number(options.timeoutMs || 3000),
    kind: 'ACTION',
  });
}

async function removeFile(file) {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isDirectory()) await fs.promises.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function stagingPath(file) {
  return `${file}.mavt-helper-stage`;
}

function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || value.success !== true) {
    throw new HelperUnavailableBeforeDispatch(safeRemoteMessage(value, 'Android Helper snapshot failed'));
  }
  if (value.has_screenshot !== true) throw new HelperUnavailableBeforeDispatch('Android Helper snapshot has_screenshot must be true');
  if (value.screenshot_format !== 'png') throw new HelperUnavailableBeforeDispatch('Android Helper screenshot_format must be png');
  if (value.screenshot_media_type !== 'image/png') throw new HelperUnavailableBeforeDispatch('Android Helper screenshot_media_type must be image/png');
  const png = Buffer.from(String(value.screenshot_base64 || ''), 'base64');
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new HelperUnavailableBeforeDispatch('Android Helper snapshot has an invalid PNG signature');
  }
  const xml = String(value.xml || '');
  if (!xml.trim()) throw new HelperUnavailableBeforeDispatch('Android Helper snapshot must contain non-empty XML');
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new HelperUnavailableBeforeDispatch('Android Helper snapshot dimensions are invalid');
  }
  return { png, xml, width, height };
}

async function snapshotToFiles(session, options) {
  const screenshotPath = path.resolve(options.screenshotPath);
  const layoutPath = path.resolve(options.layoutPath);
  const screenshotStage = stagingPath(screenshotPath);
  const layoutStage = stagingPath(layoutPath);
  const cleanup = async () => {
    await Promise.all([screenshotStage, layoutStage, screenshotPath, layoutPath].map((file) => removeFile(file).catch(() => {})));
  };
  await cleanup();
  const startedAt = Date.now();
  try {
    const value = await requestJson(session, {
      path: '/snapshot?fields=xml&format=png',
      timeoutMs: Number(options.timeoutMs || 15000),
      kind: 'READ_ONLY',
    });
    const validated = validateSnapshot(value);
    await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.promises.writeFile(screenshotStage, validated.png, { mode: 0o600 });
    await fs.promises.mkdir(path.dirname(layoutPath), { recursive: true });
    await fs.promises.writeFile(layoutStage, validated.xml, { mode: 0o600 });
    await fs.promises.rename(layoutStage, layoutPath);
    await fs.promises.rename(screenshotStage, screenshotPath);
    return {
      ok: true,
      backend: 'helper',
      width: validated.width,
      height: validated.height,
      atomicElapsedMs: Number(value.atomic_elapsed_ms || 0),
      layoutElapsedMs: Number(value.elapsed_ms || 0),
      requestElapsedMs: Math.max(0, Date.now() - startedAt),
      protocolVersion: Number(session.protocolVersion || session.protocol_version || 0),
      versionCode: Number(session.versionCode || session.version_code || 0),
      helperVersion: session.helperVersion || session.versionName || null,
      nodeCount: Number(value.node_count || 0),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {
  AndroidHelperError,
  HelperActionOutcomeUnknown,
  HelperAuthenticationRejected,
  HelperUnavailableBeforeDispatch,
  MAX_RESPONSE_BYTES,
  httpJson,
  performAction,
  ping,
  requestJson,
  snapshotToFiles,
  validateSnapshot,
};

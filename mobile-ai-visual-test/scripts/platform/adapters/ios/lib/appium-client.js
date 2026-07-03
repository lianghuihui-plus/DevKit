#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

function normalizeServer(server) {
  return String(server || process.env.MAVT_IOS_APPIUM_SERVER || 'http://127.0.0.1:4723').replace(/\/+$/, '');
}

function request(server, method, endpoint, body, timeoutMs = 120000) {
  const base = normalizeServer(server);
  const url = new URL(endpoint, base);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers: data ? {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
      } : {},
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (res.statusCode >= 400) {
          const error = new Error(`${method} ${endpoint} -> ${res.statusCode}: ${text.slice(0, 1000)}`);
          error.statusCode = res.statusCode;
          error.response = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${endpoint} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function status(server, timeoutMs = 5000) {
  return request(server, 'GET', '/status', undefined, timeoutMs);
}

async function createSession(target, options = {}) {
  const alwaysMatch = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:noReset': true,
    'appium:newCommandTimeout': Number(options.newCommandTimeout || 120),
  };
  if (target.device) alwaysMatch['appium:udid'] = target.device;
  if (target.appId) alwaysMatch['appium:bundleId'] = target.appId;
  if (target.wdaLocalPort) alwaysMatch['appium:wdaLocalPort'] = Number(target.wdaLocalPort);
  if (target.webDriverAgentUrl) alwaysMatch['appium:webDriverAgentUrl'] = target.webDriverAgentUrl;
  if (target.xcodeOrgId) alwaysMatch['appium:xcodeOrgId'] = target.xcodeOrgId;
  if (target.xcodeSigningId) alwaysMatch['appium:xcodeSigningId'] = target.xcodeSigningId;
  if (target.updatedWDABundleId) alwaysMatch['appium:updatedWDABundleId'] = target.updatedWDABundleId;
  const response = await request(target.appiumServer, 'POST', '/session', { capabilities: { alwaysMatch } }, options.timeoutMs || 180000);
  const sessionId = response.value?.sessionId || response.sessionId;
  if (!sessionId) throw new Error(`Appium did not return a session id: ${JSON.stringify(response).slice(0, 500)}`);
  return { sessionId, capabilities: response.value?.capabilities || response.capabilities || {} };
}

async function deleteSession(server, sessionId) {
  if (!sessionId) return;
  await request(server, 'DELETE', `/session/${sessionId}`, {}, 30000);
}

async function withSession(target, fn, options = {}) {
  const session = await createSession(target, options);
  try {
    return await fn(session);
  } finally {
    try {
      await deleteSession(target.appiumServer, session.sessionId);
    } catch {
      // Best-effort cleanup; the action/observe result should reflect the original command.
    }
  }
}

module.exports = {
  createSession,
  deleteSession,
  normalizeServer,
  request,
  status,
  withSession,
};

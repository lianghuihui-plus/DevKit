#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const wdaBuild = require('./wda-build');

function normalizeServer(server) {
  return String(server || process.env.MAVT_IOS_APPIUM_SERVER || 'http://127.0.0.1:4723').replace(/\/+$/, '');
}

function isInvalidSessionError(error) {
  const text = [
    error?.message,
    error?.response?.value?.error,
    error?.response?.value?.message,
  ].filter(Boolean).join('\n');
  return /invalid session id|session (?:is )?(?:either )?terminated|session[^\n]{0,80}not started/i.test(text);
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

function sessionCapabilities(target, options = {}) {
  const alwaysMatch = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:noReset': true,
    // Appium defaults to 60 seconds when omitted; zero keeps the framework-owned session alive.
    'appium:newCommandTimeout': 0,
  };
  if (options.autoLaunch !== undefined) alwaysMatch['appium:autoLaunch'] = options.autoLaunch === true;
  if (target.device) alwaysMatch['appium:udid'] = target.device;
  if (target.appId) alwaysMatch['appium:bundleId'] = target.appId;
  if (target.wdaLocalPort) alwaysMatch['appium:wdaLocalPort'] = Number(target.wdaLocalPort);
  if (target.webDriverAgentUrl) alwaysMatch['appium:webDriverAgentUrl'] = target.webDriverAgentUrl;
  if (!target.webDriverAgentUrl && target.wdaBuildPrepared) alwaysMatch['appium:usePrebuiltWDA'] = true;
  if (target.platformVersion) alwaysMatch['appium:platformVersion'] = target.platformVersion;
  if (target.xcodeOrgId) alwaysMatch['appium:xcodeOrgId'] = target.xcodeOrgId;
  if (target.xcodeSigningId) alwaysMatch['appium:xcodeSigningId'] = target.xcodeSigningId;
  if (target.updatedWDABundleId) alwaysMatch['appium:updatedWDABundleId'] = target.updatedWDABundleId;
  alwaysMatch['appium:showXcodeLog'] = target.showXcodeLog ?? true;
  if (target.useNewWDA !== undefined) alwaysMatch['appium:useNewWDA'] = target.useNewWDA;
  if (target.allowProvisioningDeviceRegistration !== undefined) {
    alwaysMatch['appium:allowProvisioningDeviceRegistration'] = target.allowProvisioningDeviceRegistration;
  }
  if (target.wdaLaunchTimeout !== undefined) alwaysMatch['appium:wdaLaunchTimeout'] = Number(target.wdaLaunchTimeout);
  if (target.derivedDataPath) alwaysMatch['appium:derivedDataPath'] = target.derivedDataPath;
  return alwaysMatch;
}

async function createSession(target, options = {}) {
  const appiumLogPath = options.appiumLogPath || process.env.MAVT_IOS_APPIUM_LOG || path.join(os.tmpdir(), 'mavt-ios-appium.log');
  const logOffset = wdaBuild.logOffset(appiumLogPath);
  const deadline = Date.now() + (options.timeoutMs || 180000);
  try {
    target = await (options.buildTarget || wdaBuild.prepareBuildTarget)(target, { ...options, deadline });
    const alwaysMatch = sessionCapabilities(target, options);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw Object.assign(new Error('WDA preparation exceeded the session startup deadline'), { code: 'IOS_WDA_STARTUP_TIMEOUT' });
    const response = await request(target.appiumServer, 'POST', '/session', { capabilities: { alwaysMatch } }, remainingMs);
    const sessionId = response.value?.sessionId || response.sessionId;
    if (!sessionId) throw new Error(`Appium did not return a session id: ${JSON.stringify(response).slice(0, 500)}`);
    return { sessionId, capabilities: response.value?.capabilities || response.capabilities || {},
      wdaBuild: { derivedDataPath: target.derivedDataPath, platformVersion: target.platformVersion, buildLogPath: target.buildLogPath } };
  } catch (error) {
    throw wdaBuild.recordFailure(error, target, { ...options, appiumLogPath, logOffset });
  }
}

async function deleteSession(server, sessionId) {
  if (!sessionId) return;
  try {
    await request(server, 'DELETE', `/session/${sessionId}`, {}, 30000);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
}

async function withSession(target, fn, options = {}) {
  if (target.appiumSessionId) {
    return fn({ sessionId: target.appiumSessionId, capabilities: target.appiumSessionCapabilities || {} });
  }
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
  isInvalidSessionError,
  normalizeServer,
  request,
  sessionCapabilities,
  status,
  withSession,
};

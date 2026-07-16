'use strict';

const fs = require('fs');
const path = require('path');
const { bridge } = require('./runtime-client');
const { buildFingerprint } = require('./fingerprint');
const { now, readJson, sha256 } = require('./common');

const TRIGGERS = new Set(['COLD_START', 'ACTION', 'RESTORE_COLD_START', 'RESTORE_ACTION', 'POPUP_DISMISSAL', 'RECHECK', 'MANUAL']);

const DEFAULTS = {
  COLD_START: { initialDelayMs: 1200, sampleIntervalMs: 450, timeoutMs: 12000, visualFallbackMs: 4500 },
  ACTION: { initialDelayMs: 700, sampleIntervalMs: 400, timeoutMs: 10000, visualFallbackMs: 3200 },
  RESTORE_COLD_START: { initialDelayMs: 1000, sampleIntervalMs: 400, timeoutMs: 12000, visualFallbackMs: 4000 },
  RESTORE_ACTION: { initialDelayMs: 500, sampleIntervalMs: 350, timeoutMs: 9000, visualFallbackMs: 2800 },
  POPUP_DISMISSAL: { initialDelayMs: 500, sampleIntervalMs: 350, timeoutMs: 9000, visualFallbackMs: 2800 },
  RECHECK: { initialDelayMs: 700, sampleIntervalMs: 400, timeoutMs: 10000, visualFallbackMs: 3200 },
  MANUAL: { initialDelayMs: 500, sampleIntervalMs: 400, timeoutMs: 10000, visualFallbackMs: 3200 }
};

const LOADING_TEXT = /(加载中|正在加载(?:数据|内容)?|请稍候|请稍等|刷新中|处理中|loading|please wait)/i;
const LOADING_STRUCTURE = /(loading|progress|skeleton|refresh|spinner|进度|骨架)/i;

function wait(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function integer(value, fallback, name, { min = 0, max = 60000 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${name} must be an integer between ${min} and ${max}`); error.code = 'OBSERVATION_POLICY_INVALID'; throw error;
  }
  return parsed;
}

function override(args, argName, envName, fallback, range) {
  return integer(args[argName] ?? process.env[envName], fallback, argName, range);
}

function resolvePolicy(triggerValue, args = {}) {
  const trigger = String(triggerValue || 'MANUAL').toUpperCase();
  if (!TRIGGERS.has(trigger)) { const error = new Error(`Unsupported observation trigger: ${trigger}`); error.code = 'OBSERVATION_TRIGGER_INVALID'; throw error; }
  const base = DEFAULTS[trigger];
  const policy = {
    trigger,
    initialDelayMs: override(args, 'initialDelayMs', 'SMAP_OBSERVATION_INITIAL_DELAY_MS', base.initialDelayMs),
    sampleIntervalMs: override(args, 'sampleIntervalMs', 'SMAP_OBSERVATION_SAMPLE_INTERVAL_MS', base.sampleIntervalMs),
    timeoutMs: override(args, 'stabilityTimeoutMs', 'SMAP_OBSERVATION_TIMEOUT_MS', base.timeoutMs, { min: 1000, max: 60000 }),
    requiredStableSamples: override(args, 'requiredStableSamples', 'SMAP_OBSERVATION_REQUIRED_STABLE_SAMPLES', 2, { min: 2, max: 5 }),
    layoutFallbackSamples: override(args, 'layoutFallbackSamples', 'SMAP_OBSERVATION_LAYOUT_FALLBACK_SAMPLES', 3, { min: 3, max: 8 }),
    visualFallbackMs: override(args, 'visualFallbackMs', 'SMAP_OBSERVATION_VISUAL_FALLBACK_MS', base.visualFallbackMs)
  };
  if (policy.timeoutMs <= policy.initialDelayMs) { const error = new Error('Observation timeout must exceed the initial delay'); error.code = 'OBSERVATION_POLICY_INVALID'; throw error; }
  return policy;
}

function loadingSignals(fingerprint) {
  const texts = (fingerprint.stableTexts || []).filter(text => LOADING_TEXT.test(String(text).replace(/[.。…·\s]/g, ''))).map(value => `text:${value}`);
  const ids = (fingerprint.stableIds || []).filter(value => LOADING_STRUCTURE.test(String(value))).map(value => `id:${value}`);
  const roles = (fingerprint.stableRoles || []).filter(value => LOADING_STRUCTURE.test(String(value))).map(value => `role:${value}`);
  return [...new Set([...texts, ...ids, ...roles])];
}

function foregroundKey(foreground = {}) {
  return `${foreground.bundleName || ''}\u0000${foreground.ability || ''}`;
}

function sample({ scan, observationId, workingDir, index }) {
  const sampleDir = path.join(workingDir, `sample-${String(index).padStart(2, '0')}`);
  fs.mkdirSync(sampleDir, { recursive: true });
  const result = bridge('observe', {
    device: scan.target.deviceId,
    bundleName: scan.target.bundleName,
    outDir: sampleDir,
    remoteToken: `${scan.scanId}-${observationId}-s${index}`
  });
  const layout = readJson(path.join(sampleDir, 'layout.json'));
  const fingerprint = buildFingerprint(layout, result.foreground);
  return {
    sampleDir,
    result,
    record: {
      index,
      capturedAt: now(),
      foreground: result.foreground,
      foregroundKey: foregroundKey(result.foreground),
      layoutHash: fingerprint.layoutHash,
      screenshotSha256: sha256(fs.readFileSync(path.join(sampleDir, 'screenshot.png'))),
      captureCoherent: result.capture?.coherent !== false,
      captureDurationMs: result.capture?.durationMs ?? null,
      loadingSignals: loadingSignals(fingerprint)
    }
  };
}

function captureStableObservation({ scan, observationId, workingDir, trigger, policyArgs = {} }) {
  const policy = resolvePolicy(trigger, policyArgs); const startedAt = now(); const startedMs = Date.now(); const records = [];
  let previous = null; let stableRun = 0; let layoutRun = 0; let accepted = null; let acceptanceStatus = null;
  fs.mkdirSync(workingDir, { recursive: true }); wait(policy.initialDelayMs);
  for (let index = 1; ; index += 1) {
    const current = sample({ scan, observationId, workingDir, index }); const record = current.record; const elapsedMs = Date.now() - startedMs;
    const sameForeground = previous?.record.foregroundKey === record.foregroundKey;
    const sameLayout = Boolean(previous && sameForeground && previous.record.layoutHash === record.layoutHash);
    const sameVisual = Boolean(sameLayout && previous.record.screenshotSha256 === record.screenshotSha256);
    stableRun = sameVisual ? stableRun + 1 : 1;
    layoutRun = sameLayout ? layoutRun + 1 : 1;
    record.elapsedMs = elapsedMs; record.sameLayoutAsPrevious = sameLayout; record.sameScreenshotAsPrevious = sameVisual; record.stableRun = stableRun; record.layoutRun = layoutRun;
    records.push(record);
    const noLoadingSignal = record.loadingSignals.length === 0; const coherentCapture = record.captureCoherent !== false;
    if (stableRun >= policy.requiredStableSamples && noLoadingSignal && coherentCapture) { accepted = current; acceptanceStatus = 'STABLE'; }
    else if (layoutRun >= policy.layoutFallbackSamples && elapsedMs >= policy.visualFallbackMs && noLoadingSignal && coherentCapture) { accepted = current; acceptanceStatus = 'LAYOUT_STABLE_VISUAL_DYNAMIC'; }
    if (accepted) break;
    if (elapsedMs >= policy.timeoutMs) {
      const error = new Error(`Page did not stabilize within ${policy.timeoutMs} ms`); error.code = 'OBSERVATION_STABILITY_TIMEOUT';
      error.diagnostic = { schemaVersion: 1, observationId, startedAt, failedAt: now(), elapsedMs, policy, samples: records };
      throw error;
    }
    previous = current; wait(policy.sampleIntervalMs);
  }
  const finishedAt = now(); const elapsedMs = Date.now() - startedMs;
  return {
    acceptedSampleDir: accepted.sampleDir,
    bridgeResult: accepted.result,
    stability: {
      schemaVersion: 1,
      accepted: true,
      status: acceptanceStatus,
      trigger: policy.trigger,
      startedAt,
      stabilizedAt: finishedAt,
      elapsedMs,
      sampleCount: records.length,
      finalScreenshotSha256: accepted.record.screenshotSha256,
      finalLayoutHash: accepted.record.layoutHash,
      policy,
      samples: records
    }
  };
}

module.exports = { TRIGGERS, resolvePolicy, captureStableObservation };

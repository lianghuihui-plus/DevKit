'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { contractError, ensureObject, ensureString } = require('./contract-utils');
const { inspectPng } = require('./image-evidence');

const EVIDENCE_PHASES = new Set(['case-prepare', 'case-business']);

function normalizeArtifactPath(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function isSafeRelativeArtifact(value) {
  const normalized = normalizeArtifactPath(value);
  return Boolean(normalized) && !path.isAbsolute(normalized) && !normalized.split('/').includes('..');
}

function resolveArtifact(execDir, value) {
  if (!isSafeRelativeArtifact(value)) throw contractError('EVIDENCE_PATH_INVALID', `unsafe artifact path: ${value}`);
  const resolvedRoot = path.resolve(execDir);
  const resolved = path.resolve(execDir, normalizeArtifactPath(value));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw contractError('EVIDENCE_PATH_INVALID', `artifact escapes execution directory: ${value}`);
  }
  return resolved;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function artifactPaths(event) {
  const artifacts = (event?.observation || event)?.artifacts || {};
  return [
    artifacts.screenshot,
    artifacts.layout,
    ...(Array.isArray(artifacts.logs) ? artifacts.logs : []),
  ].filter(Boolean);
}

function validateArtifactFilesExist(execDir, event) {
  if (!event || event.type !== 'observation') return;
  for (const item of artifactPaths(event)) {
    const file = resolveArtifact(execDir, item);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw contractError('OBSERVATION_ARTIFACT_MISSING', `observation artifact does not exist: ${item}`);
    }
  }
}

function validateEvidenceRecord(value, options = {}) {
  ensureObject(value, 'evidence', 'EVIDENCE_INVALID');
  ensureString(value.ref, 'evidence.ref', 'EVIDENCE_INVALID');
  ensureString(value.executionId, 'evidence.executionId', 'EVIDENCE_INVALID');
  if (options.executionId && value.executionId !== options.executionId) throw contractError('EVIDENCE_BINDING_MISMATCH', 'evidence belongs to another execution');
  if (!EVIDENCE_PHASES.has(value.phase)) throw contractError('EVIDENCE_INVALID', 'evidence phase is invalid');
  if (value.writer !== 'observe.sh') throw contractError('EVIDENCE_WRITER_INVALID', 'evidence must be written by observe.sh');
  if (!/^[0-9a-f]{64}$/.test(value.sha256 || '')) throw contractError('EVIDENCE_INVALID', 'evidence requires a capture-time SHA-256');
  const file = resolveArtifact(options.execDir, value.ref);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw contractError('EVIDENCE_MISSING', `evidence file does not exist: ${value.ref}`);
  const actualSha256 = sha256File(file);
  if (value.sha256 !== actualSha256) throw contractError('EVIDENCE_CHANGED', `evidence SHA-256 changed: ${value.ref}`);
  const metadata = path.extname(file).toLowerCase() === '.png' ? inspectPng(file) : null;
  if (metadata && metadata.decodeStatus !== 'VALID') throw contractError('EVIDENCE_PNG_INVALID', `evidence PNG is not valid: ${value.ref}`);
  return {
    ...value,
    sha256: actualSha256,
    usable: value.usable !== false,
    ...(Number.isInteger(value.warmSessionGeneration) ? { warmSessionGeneration: value.warmSessionGeneration } : {}),
    ...(metadata ? { width: metadata.width, height: metadata.height, format: 'png' } : {}),
  };
}

function collectEvidence(events, options = {}) {
  return events.filter((event) => event.type === 'observation').map((event) => validateEvidenceRecord({
    ref: event.ref,
    executionId: event.executionId,
    phase: event.scope,
    writer: event.writer,
    sha256: event.sha256,
    usable: event.usable,
    warmSessionGeneration: event.warmSessionGeneration,
  }, options));
}

module.exports = {
  EVIDENCE_PHASES,
  artifactPaths,
  collectEvidence,
  isSafeRelativeArtifact,
  normalizeArtifactPath,
  resolveArtifact,
  sha256File,
  validateArtifactFilesExist,
  validateEvidenceRecord,
};

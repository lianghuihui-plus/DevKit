'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('./contract-utils');
const { readJson, writeJsonAtomic } = require('./execution-lifecycle');
const { sha256File } = require('./execution-evidence');
const { validateExecutionEvidenceGraph } = require('./execution-evidence-graph');

const MANIFEST_FILE = 'artifact-manifest.json';
const CURRENT_ROOT_FILES = new Set([
  'execution.json',
  'binding.snapshot.json',
  'case.snapshot.json',
  'source.snapshot.md',
  'events.jsonl',
  'result.json',
  'metrics.json',
]);
const EVIDENCE_DIRS = new Set(['screenshots', 'layouts', 'logs', 'knowledge', 'action-spatial-evidence', 'coordinate-audits', 'scenes', 'operations', 'telemetry']);

function manifestPath(execDir) {
  return path.join(execDir, MANIFEST_FILE);
}

function walkFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative.replace(/\\/g, '/')];
  return fs.readdirSync(absolute).sort().flatMap((name) => walkFiles(root, path.join(relative, name)));
}

function executionArtifactFiles(execDir) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution?.schemaVersion !== 7) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  }
  return walkFiles(execDir).filter((relative) => {
    if (CURRENT_ROOT_FILES.has(relative)) return true;
    const first = relative.split('/')[0];
    if (EVIDENCE_DIRS.has(first)) return true;
    return false;
  }).sort();
}

function requiredArtifactFiles(execution) {
  if (execution?.schemaVersion !== 7) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  }
  return [...CURRENT_ROOT_FILES];
}

function assertRequiredArtifacts(execDir, execution) {
  for (const relative of requiredArtifactFiles(execution)) {
    const file = path.join(execDir, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw contractError('EXECUTION_ARTIFACT_MISSING', `required artifact is missing: ${relative}`);
    }
  }
}

function buildExecutionArtifactManifest(execDir, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (!execution?.finalized) throw contractError('EXECUTION_NOT_FINALIZED', 'artifact manifest requires a finalized execution');
  const unsettledDrafts = walkFiles(execDir).filter((relative) => relative.endsWith('.draft.json'));
  if (unsettledDrafts.length) {
    throw contractError('EXECUTION_TRANSACTION_UNSETTLED', `artifact manifest requires transaction recovery: ${unsettledDrafts.join(', ')}`);
  }
  if (fs.existsSync(manifestPath(execDir))) return validateExecutionArtifactManifest(execDir, null, options);
  assertRequiredArtifacts(execDir, execution);
  const hashCache = new Map();
  const rawHashFile = options.hashFile || sha256File;
  const hashFile = (file) => {
    const absolute = path.resolve(file);
    if (!hashCache.has(absolute)) hashCache.set(absolute, rawHashFile(absolute));
    return hashCache.get(absolute);
  };
  validateExecutionEvidenceGraph(execDir, { hashFile });
  const files = executionArtifactFiles(execDir).map((relative) => {
    const file = path.join(execDir, relative);
    return { path: relative, bytes: fs.statSync(file).size, sha256: hashFile(file) };
  });
  if (!files.length) throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'artifact manifest cannot be empty');
  const value = {
    schemaVersion: 1,
    executionId: execution.executionId,
    generatedAt: options.now || new Date().toISOString(),
    files,
  };
  value.contentSha = sha256(canonicalJson({ schemaVersion: value.schemaVersion, executionId: value.executionId, files }), 'execution-artifacts', 24);
  writeJsonAtomic(manifestPath(execDir), value);
  return value;
}

function validateExecutionArtifactManifest(execDir, expectedFileSha = null, options = {}) {
  const hashCache = new Map();
  const rawHashFile = options.hashFile || sha256File;
  const hashFile = (target) => {
    const absolute = path.resolve(target);
    if (!hashCache.has(absolute)) hashCache.set(absolute, rawHashFile(absolute));
    return hashCache.get(absolute);
  };
  const file = manifestPath(execDir);
  if (!fs.existsSync(file)) throw contractError('EXECUTION_ARTIFACT_MANIFEST_MISSING', 'published execution artifact manifest is missing');
  if (expectedFileSha && hashFile(file) !== expectedFileSha) {
    throw contractError('EXECUTION_ARTIFACT_MANIFEST_CHANGED', 'execution artifact manifest changed after publication');
  }
  const value = readJson(file, null);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (value?.schemaVersion !== 1 || value.executionId !== execution?.executionId || !Array.isArray(value.files) || !value.files.length) {
    throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'execution artifact manifest binding is invalid');
  }
  const expectedContentSha = sha256(canonicalJson({ schemaVersion: value.schemaVersion, executionId: value.executionId, files: value.files }), 'execution-artifacts', 24);
  if (value.contentSha !== expectedContentSha) throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'execution artifact manifest digest is invalid');
  const graph = validateExecutionEvidenceGraph(execDir, { hashFile });
  const listedPaths = value.files.map((entry) => entry.path).sort();
  const actualPaths = executionArtifactFiles(execDir);
  if (canonicalJson(listedPaths) !== canonicalJson(actualPaths)) {
    throw contractError('EXECUTION_ARTIFACT_SET_CHANGED', 'published execution artifact set changed after publication');
  }
  for (const required of [...requiredArtifactFiles(execution), ...graph.files]) {
    if (!listedPaths.includes(required)) {
      throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', `required or referenced artifact is absent from manifest: ${required}`);
    }
  }
  for (const entry of value.files) {
    if (!entry?.path || path.isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
      throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'execution artifact manifest contains an unsafe path');
    }
    const artifact = path.join(execDir, entry.path);
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw contractError('EXECUTION_ARTIFACT_MISSING', `published execution artifact is missing: ${entry.path}`);
    }
    if (fs.statSync(artifact).size !== entry.bytes || hashFile(artifact) !== entry.sha256) {
      throw contractError('EXECUTION_ARTIFACT_CHANGED', `published execution artifact changed: ${entry.path}`);
    }
  }
  return value;
}

module.exports = {
  MANIFEST_FILE,
  buildExecutionArtifactManifest,
  executionArtifactFiles,
  manifestPath,
  requiredArtifactFiles,
  validateExecutionArtifactManifest,
};

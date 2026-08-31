'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('./contract-utils');
const { readJson, writeJsonAtomic } = require('./execution-lifecycle');
const { sha256File } = require('./execution-evidence');

const MANIFEST_FILE = 'artifact-manifest.json';
const ROOT_FILES = new Set([
  'execution.json',
  'case.snapshot.json',
  'source.snapshot.md',
  'understanding.json',
  'plan.json',
  'timeline.jsonl',
  'result.json',
  'metrics.json',
]);
const EVIDENCE_DIRS = new Set(['screenshots', 'layouts', 'logs', 'knowledge', 'coordinate-audits']);

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

function includeAgentFile(relative) {
  if (!relative.startsWith('agent/')) return false;
  const name = relative.slice('agent/'.length);
  if (name === 'runtime.json' || name === CONTROL_FILE || name.endsWith('.draft.json') || name.endsWith('.lock')) return false;
  return name === 'contract.json' || name === 'request.json' || name === 'attempts.jsonl'
    || /^request-generation-.+\.json$/.test(name)
    || /^operation-.+\.json$/.test(name)
    || /^steps\/.+\.json$/.test(name)
    || /^turns\/.+\.json$/.test(name);
}

const CONTROL_FILE = 'control-request.json';

function executionArtifactFiles(execDir) {
  return walkFiles(execDir).filter((relative) => {
    if (ROOT_FILES.has(relative)) return true;
    const first = relative.split('/')[0];
    if (EVIDENCE_DIRS.has(first)) return true;
    return includeAgentFile(relative);
  }).sort();
}

function buildExecutionArtifactManifest(execDir, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (!execution?.finalized) throw contractError('EXECUTION_NOT_FINALIZED', 'artifact manifest requires a finalized execution');
  if (fs.existsSync(path.join(execDir, 'agent', 'attempt.current.json'))) {
    throw contractError('EXECUTION_ATTEMPT_UNSETTLED', 'artifact manifest requires every Agent entrypoint attempt to be settled');
  }
  if (fs.existsSync(manifestPath(execDir))) return validateExecutionArtifactManifest(execDir);
  const files = executionArtifactFiles(execDir).map((relative) => {
    const file = path.join(execDir, relative);
    return { path: relative, bytes: fs.statSync(file).size, sha256: sha256File(file) };
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

function validateExecutionArtifactManifest(execDir, expectedFileSha = null) {
  const file = manifestPath(execDir);
  if (!fs.existsSync(file)) throw contractError('EXECUTION_ARTIFACT_MANIFEST_MISSING', 'published execution artifact manifest is missing');
  if (expectedFileSha && sha256File(file) !== expectedFileSha) {
    throw contractError('EXECUTION_ARTIFACT_MANIFEST_CHANGED', 'execution artifact manifest changed after publication');
  }
  const value = readJson(file, null);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (value?.schemaVersion !== 1 || value.executionId !== execution?.executionId || !Array.isArray(value.files) || !value.files.length) {
    throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'execution artifact manifest binding is invalid');
  }
  const expectedContentSha = sha256(canonicalJson({ schemaVersion: value.schemaVersion, executionId: value.executionId, files: value.files }), 'execution-artifacts', 24);
  if (value.contentSha !== expectedContentSha) throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'execution artifact manifest digest is invalid');
  const listedPaths = value.files.map((entry) => entry.path).sort();
  const actualPaths = executionArtifactFiles(execDir);
  if (canonicalJson(listedPaths) !== canonicalJson(actualPaths)) {
    throw contractError('EXECUTION_ARTIFACT_SET_CHANGED', 'published execution artifact set changed after publication');
  }
  for (const entry of value.files) {
    if (!entry?.path || path.isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
      throw contractError('EXECUTION_ARTIFACT_MANIFEST_INVALID', 'execution artifact manifest contains an unsafe path');
    }
    const artifact = path.join(execDir, entry.path);
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw contractError('EXECUTION_ARTIFACT_MISSING', `published execution artifact is missing: ${entry.path}`);
    }
    if (fs.statSync(artifact).size !== entry.bytes || sha256File(artifact) !== entry.sha256) {
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
  validateExecutionArtifactManifest,
};

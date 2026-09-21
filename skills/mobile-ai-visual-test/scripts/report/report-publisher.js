'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function textSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reportError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function pathEscapes(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function dependencyTarget(workspaceRoot, relativePath) {
  if (!workspaceRoot || path.isAbsolute(relativePath || '')) {
    throw reportError('REPORT_DEPENDENCY_PATH_INVALID', 'workspace root and a relative dependency path are required');
  }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw reportError('REPORT_DEPENDENCY_PATH_INVALID', `dependency path escapes workspace: ${relativePath}`);
  }
  let existingAncestor = target;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonicalAncestor = fs.realpathSync(existingAncestor);
    if (pathEscapes(canonicalRoot, canonicalAncestor)) {
      throw reportError('REPORT_DEPENDENCY_PATH_INVALID', `dependency path escapes workspace through a symbolic link: ${relativePath}`);
    }
  } catch (error) {
    if (error?.code === 'REPORT_DEPENDENCY_PATH_INVALID') throw error;
    throw reportError('REPORT_DEPENDENCY_PATH_INVALID', `dependency path cannot be canonicalized: ${relativePath}`);
  }
  return target;
}

function publishDependencies(workspaceRoot, dependencies = []) {
  const published = {};
  for (const dependency of dependencies) {
    const sourcePath = path.resolve(dependency.sourcePath || '');
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw reportError('REPORT_DEPENDENCY_MISSING', `dependency source is missing: ${sourcePath}`);
    }
    const content = fs.readFileSync(sourcePath);
    const expected = { sha256: textSha256(content), bytes: content.length };
    const relativePath = String(dependency.workspaceRelativePath || '').replace(/\\/g, '/');
    const target = dependencyTarget(workspaceRoot, relativePath);
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (existing.length !== expected.bytes || textSha256(existing) !== expected.sha256) {
        throw reportError('REPORT_DEPENDENCY_CHANGED', `content-addressed dependency changed: ${relativePath}`);
      }
    } else {
      atomicWrite(target, content);
    }
    published[relativePath] = expected;
  }
  return published;
}

function validatePublishedReportBundle(rootDir, options = {}) {
  const draftPath = path.join(rootDir, 'report-publication.draft.json');
  if (fs.existsSync(draftPath)) throw new Error(`REPORT_PUBLICATION_INCOMPLETE: ${draftPath}`);
  const metadataPath = path.join(rootDir, 'report-metadata.json');
  if (!fs.existsSync(metadataPath)) throw new Error(`REPORT_METADATA_MISSING: ${metadataPath}`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  for (const [name, expected] of Object.entries(metadata.artifacts || {})) {
    const file = path.join(rootDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`REPORT_ARTIFACT_MISSING: ${file}`);
    const content = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(content).digest('hex') !== expected.sha256 || content.length !== expected.bytes) {
      throw new Error(`REPORT_ARTIFACT_CHANGED: ${file}`);
    }
  }
  const dependencies = metadata.dependencies || {};
  if (Object.keys(dependencies).length && !options.workspaceRoot) {
    throw reportError('REPORT_DEPENDENCY_ROOT_REQUIRED', 'workspaceRoot is required to validate report dependencies');
  }
  for (const [relativePath, expected] of Object.entries(dependencies)) {
    const file = dependencyTarget(options.workspaceRoot, relativePath);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw reportError('REPORT_DEPENDENCY_MISSING', `published dependency is missing: ${relativePath}`);
    }
    const content = fs.readFileSync(file);
    if (content.length !== expected.bytes || textSha256(content) !== expected.sha256) {
      throw reportError('REPORT_DEPENDENCY_CHANGED', `published dependency changed: ${relativePath}`);
    }
  }
  return metadata;
}

function publishReportBundle(rootDir, files, metadata, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const dependencies = publishDependencies(options.workspaceRoot, options.dependencies || []);
  const artifacts = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, {
    sha256: textSha256(content), bytes: Buffer.byteLength(content),
  }]));
  const draftPath = path.join(rootDir, 'report-publication.draft.json');
  atomicWrite(draftPath, `${JSON.stringify({ schemaVersion: 1, generatedAt, artifacts, dependencies }, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) atomicWrite(path.join(rootDir, name), content);
  atomicWrite(path.join(rootDir, 'report-metadata.json'), `${JSON.stringify({ ...metadata, generatedAt, artifacts, dependencies }, null, 2)}\n`);
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  validatePublishedReportBundle(rootDir, { workspaceRoot: options.workspaceRoot });
  return artifacts;
}

module.exports = {
  atomicWrite,
  publishDependencies,
  publishReportBundle,
  textSha256,
  validatePublishedReportBundle,
};

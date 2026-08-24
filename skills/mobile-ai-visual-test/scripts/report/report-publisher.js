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

function validatePublishedReportBundle(rootDir) {
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
  return metadata;
}

function publishReportBundle(rootDir, files, metadata, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const artifacts = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, {
    sha256: textSha256(content), bytes: Buffer.byteLength(content),
  }]));
  const draftPath = path.join(rootDir, 'report-publication.draft.json');
  atomicWrite(draftPath, `${JSON.stringify({ schemaVersion: 1, generatedAt, artifacts }, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) atomicWrite(path.join(rootDir, name), content);
  atomicWrite(path.join(rootDir, 'report-metadata.json'), `${JSON.stringify({ ...metadata, generatedAt, artifacts }, null, 2)}\n`);
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  validatePublishedReportBundle(rootDir);
  return artifacts;
}

module.exports = { atomicWrite, publishReportBundle, textSha256, validatePublishedReportBundle };

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWrite } = require('./execution-lifecycle');
const { inspectPng } = require('./image-evidence');

const CACHE_VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_ROOT = path.join(os.tmpdir(), `mavt-visual-view-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
let cleaned = false;

function ensureCacheRoot(now = Date.now()) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true, mode: 0o700 });
  if (cleaned) return;
  cleaned = true;
  for (const entry of fs.readdirSync(CACHE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(CACHE_ROOT, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function cachedPng(namespace, key, render) {
  ensureCacheRoot();
  const digest = crypto.createHash('sha256')
    .update(`${CACHE_VERSION}\0${namespace}\0${key}`)
    .digest('hex');
  const file = path.join(CACHE_ROOT, `${namespace}-${digest}.png`);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    const valid = stat.isFile() && !stat.isSymbolicLink() && inspectPng(file).decodeStatus === 'VALID';
    if (!valid) fs.unlinkSync(file);
  }
  if (!fs.existsSync(file)) {
    const bytes = render();
    atomicWrite(file, bytes);
    fs.chmodSync(file, 0o600);
  }
  const bytes = fs.readFileSync(file);
  return {
    path: file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

module.exports = { cachedPng };

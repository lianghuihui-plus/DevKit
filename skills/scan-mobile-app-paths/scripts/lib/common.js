#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL_STATUSES = new Set(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED']);
const MUTABLE_STATUSES = new Set(['CREATED', 'PLAN_CONFIRMED', 'CONTEXT_READY', 'SCANNING', 'PAUSED']);

function fail(message, code = 'SMAP_ERROR', exitCode = 2, details = null) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  if (details) error.details = details;
  throw error;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value = eq >= 0 ? token.slice(eq + 1) : true;
    if (eq < 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function required(args, key, label = `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) {
  if (args[key] === undefined || args[key] === true || String(args[key]).trim() === '') fail(`${label} is required`, 'ARG_REQUIRED');
  return String(args[key]);
}

function requiredId(args, key, label = `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) {
  const value = required(args, key, label);
  if (['undefined', 'null', 'none', '[object Object]'].includes(value.trim().toLowerCase())) fail(`${label} must be a concrete id value`, `${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}_INVALID`);
  return value;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  fail(`Invalid boolean: ${value}`, 'ARG_INVALID');
}

function number(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${name || 'value'} must be a non-negative number`, 'ARG_INVALID');
  return parsed;
}

function jsonArg(value, fallback = null, name = 'JSON') {
  if (value === undefined) return fallback;
  try { return JSON.parse(String(value)); } catch (error) { fail(`Invalid ${name}: ${error.message}`, 'ARG_INVALID'); }
}

function localTimeParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`Invalid date: ${value}`, 'TIME_INVALID');
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
  return {
    year: String(date.getFullYear()).padStart(4, '0'),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0'),
    second: String(date.getSeconds()).padStart(2, '0'),
    millisecond: String(date.getMilliseconds()).padStart(3, '0'),
    offset: `${offsetSign}${offsetHours}:${offsetRemainder}`
  };
}

function now(value = new Date()) {
  const part = localTimeParts(value);
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}.${part.millisecond}${part.offset}`;
}

function compactLocalTimestamp(value = new Date(), { milliseconds = false } = {}) {
  const part = localTimeParts(value);
  return `${part.year}${part.month}${part.day}${part.hour}${part.minute}${part.second}${milliseconds ? part.millisecond : ''}`;
}

function compareTimestamps(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
  return String(left || '').localeCompare(String(right || ''));
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function exists(file) { return fs.existsSync(file); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    fail(`Cannot read JSON ${file}: ${error.message}`, 'JSON_READ_FAILED');
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function writeTextAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, value, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function sha256(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hashObject(value) { return sha256(stableStringify(value)); }
function slug(value, fallback = 'item') {
  const result = String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return result || fallback;
}

function safeSegment(value, label = 'path segment') {
  const text = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(text) || text === '.' || text === '..') fail(`${label} must be a safe single path segment`, 'PATH_SEGMENT_INVALID');
  return text;
}

function assertAbsolute(dir, label) {
  if (!path.isAbsolute(dir)) fail(`${label} must be an absolute path`, 'PATH_NOT_ABSOLUTE');
  return path.resolve(dir);
}

function appMapRootNameForBundle(bundleName) {
  const cleaned = String(bundleName || '').normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return `app-map-${safeSegment(cleaned || 'app', 'bundleName')}`;
}

function looksLikeAppMapRoot(dir) {
  return exists(path.join(dir, 'app.json'));
}

function discoverAppMapRootFromCwd(cwd = process.cwd()) {
  const base = path.resolve(cwd);
  if (looksLikeAppMapRoot(base)) return base;
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => path.join(base, item.name))
    .filter(looksLikeAppMapRoot)
    .sort();
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) fail(`No app map root found under current directory: ${base}. Run init-app-root with --bundle-name first, or pass --app-map-root explicitly.`, 'APP_MAP_ROOT_NOT_FOUND');
  fail(`Multiple app map roots found under current directory: ${candidates.join(', ')}. Pass --app-map-root explicitly.`, 'APP_MAP_ROOT_AMBIGUOUS');
}

function resolveAppMapRoot(args = {}, { bundleName = null, requireExisting = true } = {}) {
  let root;
  if (args.appMapRoot !== undefined && args.appMapRoot !== true && String(args.appMapRoot).trim() !== '') {
    const raw = String(args.appMapRoot);
    root = path.resolve(process.cwd(), raw);
  } else if (bundleName) {
    root = path.join(process.cwd(), appMapRootNameForBundle(bundleName));
  } else {
    root = discoverAppMapRootFromCwd(process.cwd());
  }
  root = path.resolve(root);
  if (requireExisting && !looksLikeAppMapRoot(root)) fail(`Missing app.json in ${root}`, 'APP_ROOT_INVALID');
  return root;
}

function resolveScanDir(scanDirArg) {
  const scanDir = assertAbsolute(scanDirArg, '--scan-dir');
  const runsDir = path.dirname(scanDir);
  if (path.basename(runsDir) !== 'runs') fail('--scan-dir must be an immediate child of <app-map-root>/runs', 'SCAN_DIR_INVALID');
  safeSegment(path.basename(scanDir), 'scanId');
  const appRoot = path.dirname(runsDir);
  if (!exists(path.join(appRoot, 'app.json'))) fail(`Missing app.json in ${appRoot}`, 'APP_ROOT_INVALID');
  return { scanDir, appRoot };
}

function timelineEvents(scanDir) {
  const file = path.join(scanDir, 'timeline.jsonl');
  if (!exists(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { fail(`Invalid timeline line ${index + 1}: ${error.message}`, 'TIMELINE_INVALID'); }
  });
}

function nextEventNumber(scanDir) {
  return require('./event-store').repairHead(scanDir).lastEventSeq + 1;
}

function withFileLock(lock, fn) {
  const deadline = Date.now() + 5000; let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') fail('Cannot acquire Run lock', 'RUN_LOCKED');
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmSync(lock, { force: true }); continue; } } catch (statError) { if (statError.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) fail('Run is locked by another writer', 'RUN_LOCKED');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

function withRunLock(scanDir, fn) { return withFileLock(path.join(scanDir, '.write.lock'), fn); }

function loadScan(scanDir, { mutable = false } = {}) {
  const scan = require('./schema').validateRun(readJson(path.join(scanDir, 'scan.json')));
  if (Number(scan.eventProtocolVersion || 1) >= 2) {
    const head = require('./event-store').readHead(scanDir);
    if (head.lastEventType === 'scanFinalized' && TERMINAL_STATUSES.has(head.lastEventTo)) scan.status = head.lastEventTo;
  } else {
    const terminal = timelineEvents(scanDir).filter(item => item.type === 'scanFinalized' && TERMINAL_STATUSES.has(item.to)).at(-1);
    if (terminal) scan.status = terminal.to;
  }
  if (mutable && TERMINAL_STATUSES.has(scan.status)) fail(`Run ${scan.scanId} is finalized and immutable`, 'RUN_IMMUTABLE');
  const lockFile = path.join(scanDir, '.write.lock');
  if (mutable && !TERMINAL_STATUSES.has(scan.status) && !exists(lockFile)) withRunLock(scanDir, () => require('./recovery').recoverCommittedEvents(scanDir));
  return scan;
}

function saveScan(scanDir, scan) { writeJsonAtomic(path.join(scanDir, 'scan.json'), scan); }

function event(scanDir, type, data = {}) {
  return withRunLock(scanDir, () => {
    const scan = loadScan(scanDir, { mutable: true }); scan.updatedAt = now();
    const appended = require('./event-store').append(scanDir, { type, at: scan.updatedAt, scanId: scan.scanId, ...data, projectionOps: [{ path: 'scan.json', op: 'REPLACE', value: scan }] });
    const ops = appended.record.projectionOps || []; require('./event-store').applyProjectionOps(scanDir, ops); require('./event-store').markApplied(scanDir, appended.head, ops);
    return appended.record;
  });
}

function commitEventLocked(scanDir, type, data = {}, projectionOps = []) {
  const scan = loadScan(scanDir, { mutable: true }); const at = now(); const hasScanProjection = projectionOps.some(op => op.path === 'scan.json' && op.op === 'REPLACE');
  const opsForEvent = hasScanProjection ? projectionOps : [...projectionOps, { path: 'scan.json', op: 'REPLACE', value: { ...scan, updatedAt: at } }];
  const appended = require('./event-store').append(scanDir, { type, at, scanId: scan.scanId, ...data, projectionOps: opsForEvent });
  const ops = appended.record.projectionOps || []; require('./event-store').applyProjectionOps(scanDir, ops); require('./event-store').markApplied(scanDir, appended.head, ops);
  return appended.record;
}
function commitEvent(scanDir, type, data = {}, projectionOps = []) { return withRunLock(scanDir, () => commitEventLocked(scanDir, type, data, projectionOps)); }

function nextIdLocked(scanDir, type, prefix) {
  const scan = loadScan(scanDir, { mutable: true });
  const allocatedAt = now();
  scan.counters = { ...(scan.counters || {}) };
  scan.counters[type] = (scan.counters[type] || 0) + 1;
  scan.updatedAt = allocatedAt;
  const id = `${prefix}-${String(scan.counters[type]).padStart(4, '0')}`;
  const appended = require('./event-store').append(scanDir, { type: 'idAllocated', at: allocatedAt, scanId: scan.scanId, idType: type, idPrefix: prefix, allocatedId: id, counterValue: scan.counters[type], projectionOps: [{ path: 'scan.json', op: 'REPLACE', value: scan }] });
  const ops = appended.record.projectionOps || [];
  require('./event-store').applyProjectionOps(scanDir, ops);
  require('./event-store').markApplied(scanDir, appended.head, ops);
  return id;
}
function nextId(scanDir, type, prefix) { return withRunLock(scanDir, () => nextIdLocked(scanDir, type, prefix)); }

function contextDir(scanDir, contextId) {
  if (!['guest', 'authenticated'].includes(contextId)) fail('contextId must be guest or authenticated', 'CONTEXT_INVALID');
  return path.join(scanDir, 'contexts', contextId);
}

function loadGraph(scanDir, contextId) {
  return readJson(path.join(contextDir(scanDir, contextId), 'graph.json'), emptyGraph(contextId));
}
function saveGraph(scanDir, contextId, graph) { writeJsonAtomic(path.join(contextDir(scanDir, contextId), 'graph.json'), graph); }
function loadFrontier(scanDir, contextId) {
  return readJson(path.join(contextDir(scanDir, contextId), 'frontier.json'), { schemaVersion: 1, contextId, items: [] });
}
function saveFrontier(scanDir, contextId, frontier) { writeJsonAtomic(path.join(contextDir(scanDir, contextId), 'frontier.json'), frontier); }

function emptyGraph(contextId) {
  return { schemaVersion: 2, contextId, logicalScreens: [], visualStates: [], reachableStates: [], edges: [], paths: [] };
}

function transition(scanDir, to, reasonCode = null) {
  const lockFile = path.join(scanDir, '.write.lock');
  if (!exists(lockFile)) withRunLock(scanDir, () => require('./recovery').recoverCommittedEvents(scanDir));
  return withRunLock(scanDir, () => transitionLocked(scanDir, to, reasonCode, null, {}, []));
}

function transitionWithOps(scanDir, to, reasonCode = null, eventType = null, data = {}, extraOps = []) {
  const lockFile = path.join(scanDir, '.write.lock');
  if (!exists(lockFile)) withRunLock(scanDir, () => require('./recovery').recoverCommittedEvents(scanDir));
  return withRunLock(scanDir, () => transitionLocked(scanDir, to, reasonCode, eventType, data, extraOps));
}

function transitionWithOpsLocked(scanDir, to, reasonCode = null, eventType = null, data = {}, extraOps = []) {
  return transitionLocked(scanDir, to, reasonCode, eventType, data, extraOps);
}

function transitionLocked(scanDir, to, reasonCode = null, eventType = null, data = {}, extraOps = []) {
  const scan = loadScan(scanDir, { mutable: true });
  const allowed = {
    CREATED: ['PLAN_CONFIRMED', 'PAUSED', 'BLOCKED', 'FAILED'],
    PLAN_CONFIRMED: ['CONTEXT_READY', 'PAUSED', 'BLOCKED', 'FAILED'],
    CONTEXT_READY: ['SCANNING', 'PAUSED', 'BLOCKED', 'FAILED'],
    SCANNING: ['PAUSED', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'],
    PAUSED: ['SCANNING', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED']
  };
  if (!(allowed[scan.status] || []).includes(to)) fail(`Invalid Run transition ${scan.status} -> ${to}`, 'RUN_TRANSITION_INVALID');
  const from = scan.status;
  const transitionedAt = now();
  const activeContext = require('./run-protocol').activeContextId(scan);
  let projectedMetrics = null; let projectedMetricsFile = null;
  if (from === 'SCANNING' && to !== 'SCANNING' && activeContext) {
    const metricsFile = path.join(contextDir(scanDir, activeContext), 'metrics.json'); const metrics = readJson(metricsFile, {});
    if (metrics.activeStartedAt) metrics.activeDurationMs = (metrics.activeDurationMs || 0) + Math.max(0, Date.parse(transitionedAt) - Date.parse(metrics.activeStartedAt));
    metrics.activeStartedAt = null; projectedMetrics = metrics; projectedMetricsFile = metricsFile;
  }
  if (from !== 'SCANNING' && to === 'SCANNING' && activeContext) {
    const metricsFile = path.join(contextDir(scanDir, activeContext), 'metrics.json'); const metrics = readJson(metricsFile, {});
    metrics.activeStartedAt = transitionedAt; metrics.activeDurationMs ||= 0; projectedMetrics = metrics; projectedMetricsFile = metricsFile;
  }
  scan.status = to;
  scan.reasonCode = reasonCode;
  scan.updatedAt = transitionedAt;
  if (to === 'PAUSED') scan.pausedAt = scan.updatedAt;
  if (from === 'PAUSED' && to === 'SCANNING') {
    scan.pausedDurationMs = (scan.pausedDurationMs || 0) + Math.max(0, Date.parse(scan.updatedAt) - Date.parse(scan.pausedAt));
    scan.pausedAt = null;
  }
  if (TERMINAL_STATUSES.has(to)) scan.finalizedAt = scan.updatedAt;
  const type = TERMINAL_STATUSES.has(to) ? 'scanFinalized' : to === 'PAUSED' ? 'scanPaused' : to === 'SCANNING' && from === 'PAUSED' ? 'scanResumed' : 'scanStatusChanged';
  const projectionOps = [...extraOps, { path: 'scan.json', op: 'REPLACE', value: scan }]; if (projectedMetrics && projectedMetricsFile) projectionOps.push({ path: relativeInside(scanDir, projectedMetricsFile), op: 'REPLACE', value: projectedMetrics });
  const appended = require('./event-store').append(scanDir, { type: eventType || type, at: scan.updatedAt, scanId: scan.scanId, from, to, reasonCode, ...data, projectionOps }); const ops = appended.record.projectionOps || []; require('./event-store').applyProjectionOps(scanDir, ops); require('./event-store').markApplied(scanDir, appended.head, ops);
  return scan;
}

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function main(fn) {
  Promise.resolve().then(fn).catch(error => {
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: error.code || 'SMAP_ERROR', message: error.message, ...(error.details || {}) } })}\n`);
    process.exitCode = error.exitCode || 2;
  });
}

function versionKey(target = {}) {
  if (target.buildVersion) return `build:${target.buildVersion}`;
  if (target.appVersion) return `app:${target.appVersion}`;
  return null;
}

function relativeInside(base, file) {
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`${file} must be inside ${base}`, 'PATH_OUTSIDE_ROOT');
  return rel.split(path.sep).join('/');
}

module.exports = {
  TERMINAL_STATUSES, MUTABLE_STATUSES, fail, parseArgs, required, requiredId, bool, number, jsonArg, now, compactLocalTimestamp, compareTimestamps,
  ensureDir, exists, readJson, writeJsonAtomic, writeTextAtomic, appendJsonl, sha256, stableStringify,
  hashObject, slug, safeSegment, assertAbsolute, resolveAppMapRoot, appMapRootNameForBundle, resolveScanDir, timelineEvents, withFileLock, withRunLock, loadScan, saveScan, event, commitEvent, commitEventLocked, nextId, nextIdLocked, contextDir,
  loadGraph, saveGraph, loadFrontier, saveFrontier, emptyGraph, transition, transitionWithOps, transitionWithOpsLocked, output, main, versionKey,
  relativeInside
};

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENT_PROTOCOL_VERSION = 2;
const PROJECTION_PROTOCOL_VERSION = 2;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (fallback !== undefined && error.code === 'ENOENT') return fallback; throw error; }
}
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function sha256(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function documentHash(file) { return fs.existsSync(file) ? sha256(stableStringify(readJson(file))) : null; }
function trackedProjectionPath(relative) { return /^(scan\.json|target\.json|plan\.json|continuation\.json|contexts\/[^/]+\/(context|graph|frontier|metrics|live-cursor|verification-queue|back-capabilities)\.json|attempts\/[^/]+\.json|operations\/[^/]+\.json|evidence\/navigations\/[^/]+\.json)$/.test(relative); }
function timelineFile(scanDir) { return path.join(scanDir, 'timeline.jsonl'); }
function headFile(scanDir) { return path.join(scanDir, 'event-head.json'); }
function projectionStateFile(scanDir) { return path.join(scanDir, 'projection-state.json'); }

function parseRecords(buffer, baseOffset = 0) {
  const text = buffer.toString('utf8'); const records = []; let offset = baseOffset; let cursor = 0;
  while (cursor < text.length) {
    const end = text.indexOf('\n', cursor); if (end < 0) break;
    const line = text.slice(cursor, end); const byteLength = Buffer.byteLength(text.slice(cursor, end + 1));
    offset += byteLength; cursor = end + 1;
    if (!line.trim()) continue;
    records.push({ record: JSON.parse(line), endOffset: offset });
  }
  return records;
}

function sequenceOf(record) {
  const match = String(record?.eventId || '').match(/^evt-(\d+)$/); return match ? Number(match[1]) : 0;
}

function projectionOpsForEvent(record, sequence) {
  if (!Array.isArray(record.projectionOps)) return [];
  return record.projectionOps.map(op => {
    if (op?.path !== 'scan.json' || op.op !== 'REPLACE' || !op.value) return op;
    return {
      ...op,
      value: {
        ...op.value,
        counters: { ...(op.value.counters || {}), event: sequence },
        updatedAt: op.value.updatedAt || record.at || new Date().toISOString()
      }
    };
  });
}

function deriveHead(scanDir) {
  const file = timelineFile(scanDir); const buffer = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0); const parsed = parseRecords(buffer, 0); const last = parsed.at(-1);
  return { schemaVersion: 1, eventProtocolVersion: EVENT_PROTOCOL_VERSION, lastEventSeq: last ? sequenceOf(last.record) : 0, timelineOffset: last?.endOffset || 0, lastEventSha256: last ? sha256(JSON.stringify(last.record)) : null, lastEventType: last?.record?.type || null, lastEventTo: last?.record?.to || null, updatedAt: new Date().toISOString() };
}
function readHead(scanDir) { return readJson(headFile(scanDir), null) || deriveHead(scanDir); }

function repairHead(scanDir) {
  const file = timelineFile(scanDir); const size = fs.existsSync(file) ? fs.statSync(file).size : 0; let head = readJson(headFile(scanDir), null); let changed = false;
  if (!head || !Number.isInteger(head.lastEventSeq) || !Number.isInteger(head.timelineOffset) || head.timelineOffset < 0 || head.timelineOffset > size) { head = deriveHead(scanDir); changed = true; }
  else if (head.timelineOffset < size) {
    const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(size - head.timelineOffset); fs.readSync(fd, buffer, 0, buffer.length, head.timelineOffset); fs.closeSync(fd);
    const parsed = parseRecords(buffer, head.timelineOffset); for (const item of parsed) {
      const seq = sequenceOf(item.record); if (seq <= head.lastEventSeq) throw new Error(`Non-monotonic event sequence at ${item.record.eventId}`);
      head.lastEventSeq = seq; head.timelineOffset = item.endOffset; head.lastEventSha256 = sha256(JSON.stringify(item.record)); head.lastEventType = item.record.type || null; head.lastEventTo = item.record.to || null;
      changed = true;
    }
  }
  if (head.timelineOffset < size) { fs.truncateSync(file, head.timelineOffset); changed = true; }
  if (head.eventProtocolVersion !== EVENT_PROTOCOL_VERSION) { head.eventProtocolVersion = EVENT_PROTOCOL_VERSION; changed = true; }
  if (changed) { head.updatedAt = new Date().toISOString(); writeJsonAtomic(headFile(scanDir), head); }
  return head;
}

function initialize(scanDir, lastEventSeq = null) {
  const head = repairHead(scanDir); if (lastEventSeq != null && Number(lastEventSeq) !== head.lastEventSeq) throw new Error('Initial event sequence does not match timeline');
  writeJsonAtomic(projectionStateFile(scanDir), { schemaVersion: 1, projectionProtocolVersion: PROJECTION_PROTOCOL_VERSION, reducerVersion: 2, lastAppliedEventSeq: head.lastEventSeq, timelineOffset: head.timelineOffset, projectionHashes: {}, updatedAt: new Date().toISOString() });
  return head;
}

function append(scanDir, record) {
  const head = repairHead(scanDir); const sequence = head.lastEventSeq + 1; const projectionOps = projectionOpsForEvent(record, sequence); const eventRecord = { schemaVersion: 1, eventProtocolVersion: EVENT_PROTOCOL_VERSION, eventId: `evt-${String(sequence).padStart(6, '0')}`, ...record, projectionOps };
  const line = `${JSON.stringify(eventRecord)}\n`; const file = timelineFile(scanDir); ensureDir(path.dirname(file)); const fd = fs.openSync(file, 'a', 0o600); const buffer = Buffer.from(line); let written = 0;
  try { while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const nextHead = { schemaVersion: 1, eventProtocolVersion: EVENT_PROTOCOL_VERSION, lastEventSeq: sequence, timelineOffset: head.timelineOffset + Buffer.byteLength(line), lastEventSha256: sha256(JSON.stringify(eventRecord)), lastEventType: eventRecord.type || null, lastEventTo: eventRecord.to || null, updatedAt: eventRecord.at };
  writeJsonAtomic(headFile(scanDir), nextHead); return { record: eventRecord, head: nextHead };
}

function safeProjectionPath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error('Projection path must be relative');
  const target = path.resolve(root, relative); const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Projection path escapes Run: ${relative}`);
  return target;
}

function identity(value, keys) { return keys.map(key => JSON.stringify(value?.[key])).join('|'); }

function applyProjectionOps(root, ops = []) {
  const documents = new Map(); const metadata = new Map();
  for (const op of ops) {
    const file = safeProjectionPath(root, op.path); let document = documents.get(file);
    if (document === undefined) document = readJson(file, op.fallback ?? (op.op === 'REPLACE' ? null : {}));
    if (op.op === 'REPLACE') document = op.value;
    else if (op.op === 'MERGE') document = { ...(document || {}), ...(op.value || {}) };
    else if (op.op === 'UPSERT') {
      const collection = op.collection; const keys = op.keyFields || ['id']; document ||= {}; document[collection] ||= [];
      const key = identity(op.value, keys); const index = document[collection].findIndex(item => identity(item, keys) === key);
      if (index >= 0) document[collection][index] = op.value; else document[collection].push(op.value);
    } else if (op.op === 'REMOVE') {
      const keys = op.keyFields || ['id']; document ||= {}; document[op.collection] ||= []; const key = identity(op.value, keys); document[op.collection] = document[op.collection].filter(item => identity(item, keys) !== key);
    } else throw new Error(`Unknown projection op: ${op.op}`);
    documents.set(file, document); if (op.recompute) metadata.set(file, op.recompute);
  }
  for (const [file, document] of documents) {
    if (metadata.get(file) === 'GRAPH') {
      const { updateCanonicalPaths } = require('./graph-store');
      for (const logical of document.logicalScreens || []) logical.visualStateIds = (document.visualStates || []).filter(item => item.logicalScreenKey === logical.id).map(item => item.id);
      for (const state of document.reachableStates || []) state.incomingEdgeIds = (document.edges || []).filter(item => item.toReachableStateId === state.id).map(item => item.id);
      updateCanonicalPaths(document);
    }
    writeJsonAtomic(file, document);
  }
}

function markApplied(scanDir, head, ops = []) {
  const previous = readJson(projectionStateFile(scanDir), {}); const projectionHashes = { ...(previous.projectionHashes || {}) };
  for (const relative of new Set(ops.map(op => op.path).filter(trackedProjectionPath))) projectionHashes[relative] = documentHash(safeProjectionPath(scanDir, relative));
  writeJsonAtomic(projectionStateFile(scanDir), { schemaVersion: 1, projectionProtocolVersion: PROJECTION_PROTOCOL_VERSION, reducerVersion: 2, lastAppliedEventSeq: head.lastEventSeq, timelineOffset: head.timelineOffset, projectionHashes, updatedAt: head.updatedAt });
}

function repairProjectionIntegrity(scanDir, state) {
  const mismatches = Object.entries(state.projectionHashes || {}).filter(([relative, expected]) => documentHash(safeProjectionPath(scanDir, relative)) !== expected).map(([relative]) => relative);
  if (!mismatches.length) return 0;
  const temp = path.join(scanDir, `.projection-recovery-${process.pid}-${crypto.randomBytes(4).toString('hex')}`); ensureDir(temp);
  try {
    const records = parseRecords(fs.readFileSync(timelineFile(scanDir)), 0); for (const item of records) applyProjectionOps(temp, item.record.projectionOps || []);
    for (const relative of mismatches) {
      const rebuilt = safeProjectionPath(temp, relative); if (!fs.existsSync(rebuilt)) throw new Error(`Projection ${relative} cannot be rebuilt from timeline`);
      writeJsonAtomic(safeProjectionPath(scanDir, relative), readJson(rebuilt)); state.projectionHashes[relative] = documentHash(safeProjectionPath(scanDir, relative));
    }
    writeJsonAtomic(projectionStateFile(scanDir), state); return mismatches.length;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function recover(scanDir) {
  const head = repairHead(scanDir); let state = readJson(projectionStateFile(scanDir), null);
  if (!state) { markApplied(scanDir, head); return { recovered: 0, initializedBaseline: true, head }; }
  if (state.lastAppliedEventSeq >= head.lastEventSeq && state.timelineOffset >= head.timelineOffset) return { recovered: repairProjectionIntegrity(scanDir, state), head };
  const file = timelineFile(scanDir); const size = fs.statSync(file).size; const start = Number(state.timelineOffset || 0); const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start); fs.closeSync(fd); let recovered = 0;
  for (const item of parseRecords(buffer, start)) {
    const seq = sequenceOf(item.record); if (seq <= Number(state.lastAppliedEventSeq || 0)) continue;
    const ops = item.record.projectionOps || []; applyProjectionOps(scanDir, ops); const projectionHashes = { ...(state.projectionHashes || {}) }; for (const relative of new Set(ops.map(op => op.path).filter(trackedProjectionPath))) projectionHashes[relative] = documentHash(safeProjectionPath(scanDir, relative)); state = { schemaVersion: 1, projectionProtocolVersion: PROJECTION_PROTOCOL_VERSION, reducerVersion: 2, lastAppliedEventSeq: seq, timelineOffset: item.endOffset, projectionHashes, updatedAt: item.record.at }; writeJsonAtomic(projectionStateFile(scanDir), state); recovered += 1;
  }
  recovered += repairProjectionIntegrity(scanDir, state); return { recovered, head };
}

module.exports = { EVENT_PROTOCOL_VERSION, PROJECTION_PROTOCOL_VERSION, timelineFile, headFile, projectionStateFile, parseRecords, sequenceOf, deriveHead, readHead, repairHead, initialize, append, applyProjectionOps, markApplied, recover, repairProjectionIntegrity };

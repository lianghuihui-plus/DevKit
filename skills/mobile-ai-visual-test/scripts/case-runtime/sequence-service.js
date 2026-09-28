'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { SEQUENCE_STATUSES, sequenceRequestKey } = require('./sequence-contract');
const store = require('./store');

const SEQUENCE_ID_PATTERN = /^sequence-[0-9]+$/;

function sequenceDirectory(execDir) {
  return path.join(store.paths(execDir).operations, 'sequences');
}

function validSequenceId(sequenceId) {
  if (typeof sequenceId !== 'string' || !SEQUENCE_ID_PATTERN.test(sequenceId)) {
    throw contractError('SEQUENCE_RECORD_INCOMPLETE', 'sequence record has an invalid sequenceId');
  }
  return sequenceId;
}

function sequencePath(execDir, sequenceId) {
  return path.join(sequenceDirectory(execDir), `${validSequenceId(sequenceId)}.json`);
}

function unsignedRecord(record) {
  const { integrity, ...unsigned } = record;
  return unsigned;
}

function recordDigest(record) {
  return crypto.createHash('sha256').update(canonicalJson(unsignedRecord(record))).digest('hex');
}

function writeSequenceRecord(execDir, record) {
  validSequenceId(record?.sequenceId);
  fs.mkdirSync(sequenceDirectory(execDir), { recursive: true });
  const value = {
    ...unsignedRecord(record),
    integrity: { recordSha256: recordDigest(record) },
  };
  writeJsonAtomic(sequencePath(execDir, value.sequenceId), value);
  return value;
}

function readSequences(execDir) {
  const directory = sequenceDirectory(execDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(directory, name), null))
    .filter(Boolean);
}

function incomplete(message) {
  return contractError('SEQUENCE_RECORD_INCOMPLETE', message);
}

function assertSequenceIntegrity(execDir, record) {
  if (!record || record.schemaVersion !== 1) throw incomplete('sequence record schema is invalid');
  validSequenceId(record.sequenceId);
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  if (record.executionId !== execution.executionId) throw incomplete('sequence record execution binding is invalid');
  const expectedRef = path.relative(path.resolve(execDir), sequencePath(execDir, record.sequenceId));
  if (record.sequenceRecordRef !== expectedRef) throw incomplete('sequence record reference is invalid');
  if (typeof record.requestKey !== 'string' || !record.requestKey.startsWith('sequence-request-')) {
    throw incomplete('sequence record request key is invalid');
  }
  if (!record.integrity?.recordSha256 || record.integrity.recordSha256 !== recordDigest(record)) {
    throw incomplete(`sequence record integrity is invalid: ${record.sequenceId}`);
  }
  return record;
}

function findTerminalSequence(execDir, request) {
  const requestKey = sequenceRequestKey(request);
  const matches = readSequences(execDir).filter((record) => record.requestKey === requestKey);
  if (!matches.length) return null;
  if (matches.length !== 1) throw incomplete('multiple sequence records share the same request key');
  const record = assertSequenceIntegrity(execDir, matches[0]);
  if (record.terminal !== true || !SEQUENCE_STATUSES.includes(record.status)) {
    throw incomplete(`sequence record has no terminal result: ${record.sequenceId}`);
  }
  return record;
}

function responseFromSequenceRecord(record, options = {}) {
  return {
    status: record.status,
    outcomeKnown: record.outcomeKnown !== false,
    ...(record.failure?.code ? { code: record.failure.code } : {}),
    sequenceId: record.sequenceId,
    sequenceRecordRef: record.sequenceRecordRef,
    steps: record.steps || [],
    evidence: record.evidence || { sceneRefs: [], screenshotRefs: [] },
    finalSceneRef: record.finalSceneRef || null,
    remainingMs: Number(record.remainingMs) || 0,
    idempotent: options.idempotent === true,
  };
}

module.exports = {
  assertSequenceIntegrity,
  findTerminalSequence,
  readSequences,
  responseFromSequenceRecord,
  sequencePath,
  writeSequenceRecord,
};

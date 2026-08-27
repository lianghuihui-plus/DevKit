'use strict';

const {
  canonicalJson,
  contractError,
  ensureObject,
  ensureString,
  sha256,
} = require('../../lib/contract-utils');

const CASE_SCHEMA_VERSION = 2;
const SOURCE_SHA_PATTERN = /^source-[0-9a-f]{64}$/;
const CASE_KEY_PATTERN = /^ck-[0-9a-f]{12,64}$/;
const CASE_NO_PATTERN = /^\d{3,}$/;
const FORBIDDEN_BUSINESS_FIELDS = ['preconditions', 'steps', 'globalRules'];

function normalizeSourceText(value) {
  ensureString(value, 'source text', 'CASE_INPUT_INVALID', { allowEmpty: true });
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function validateSourceText(value) {
  const normalized = normalizeSourceText(value);
  if (!normalized.trim()) throw contractError('CASE_INPUT_EMPTY', 'source text must contain at least one non-whitespace character');
  return normalized;
}

function sourceSha(value) {
  return sha256(validateSourceText(value), 'source');
}

function caseContractSha(value) {
  const unsigned = { ...value };
  delete unsigned.contractSha;
  return sha256(canonicalJson(unsigned), 'case-contract', 24);
}

function validateCaseContract(value) {
  ensureObject(value, 'case contract', 'CASE_CONTRACT_INVALID');
  if (value.schemaVersion !== CASE_SCHEMA_VERSION) throw contractError('CASE_SCHEMA_UNSUPPORTED', `schemaVersion must be ${CASE_SCHEMA_VERSION}`);
  for (const field of FORBIDDEN_BUSINESS_FIELDS) {
    if (value[field] !== undefined) throw contractError('CASE_CONTRACT_INVALID', `${field} is not part of the current case identity contract`);
  }
  const identity = ensureObject(value.identity, 'identity', 'CASE_CONTRACT_INVALID');
  if (!CASE_KEY_PATTERN.test(identity.caseKey || '')) throw contractError('CASE_CONTRACT_INVALID', 'identity.caseKey is invalid');
  if (identity.caseNo !== undefined && !CASE_NO_PATTERN.test(identity.caseNo)) {
    throw contractError('CASE_CONTRACT_INVALID', 'identity.caseNo must contain at least three digits');
  }
  ensureString(identity.title, 'identity.title', 'CASE_CONTRACT_INVALID');
  if (!SOURCE_SHA_PATTERN.test(identity.sourceSha || '')) throw contractError('CASE_CONTRACT_INVALID', 'identity.sourceSha is invalid');
  const importSource = ensureObject(identity.importSource, 'identity.importSource', 'CASE_CONTRACT_INVALID');
  ensureString(importSource.path, 'identity.importSource.path', 'CASE_CONTRACT_INVALID');
  if (importSource.kind !== 'file') throw contractError('CASE_CONTRACT_INVALID', 'identity.importSource.kind must be file');
  if (value.contractSha !== undefined && value.contractSha !== caseContractSha(value)) {
    throw contractError('CASE_CONTRACT_INVALID', 'contractSha does not match case content');
  }
  return value;
}

function createCaseContract({ caseKey, caseNo, title, sourceText, importPath }) {
  const value = {
    schemaVersion: CASE_SCHEMA_VERSION,
    identity: {
      caseKey,
      ...(caseNo ? { caseNo } : {}),
      title: String(title || '').trim() || 'Untitled case',
      sourceSha: sourceSha(sourceText),
      importSource: { kind: 'file', path: importPath },
    },
  };
  value.contractSha = caseContractSha(value);
  return validateCaseContract(value);
}

module.exports = {
  CASE_SCHEMA_VERSION,
  CASE_NO_PATTERN,
  SOURCE_SHA_PATTERN,
  caseContractSha,
  createCaseContract,
  normalizeSourceText,
  sourceSha,
  validateCaseContract,
  validateSourceText,
};

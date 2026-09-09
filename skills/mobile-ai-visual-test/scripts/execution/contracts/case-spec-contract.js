'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureObject,
  ensureString,
  sha256,
} = require('../../lib/contract-utils');
const { sourceSha } = require('./case-contract');

const CASE_SPEC_SCHEMA_VERSION = 1;
const VERIFICATION_KINDS = new Set(['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE']);

function caseSpecIdentity(value) {
  return sha256(canonicalJson({
    schemaVersion: value.schemaVersion,
    summary: value.summary,
    preconditions: value.preconditions,
    expectations: value.expectations,
    ambiguities: value.ambiguities,
    sourceSha: value.sourceSha,
  }), 'case-spec', 20);
}

function caseSpecSha(value) {
  const unsigned = { ...value };
  delete unsigned.specSha;
  return sha256(canonicalJson(unsigned), 'case-spec', 24);
}

function stringList(value, label) {
  return ensureArray(value, label, 'CASE_SPEC_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_SPEC_INVALID').trim());
}

function validateCaseSpec(value, options = {}) {
  ensureObject(value, 'CaseSpec', 'CASE_SPEC_INVALID');
  const allowed = new Set([
    'schemaVersion', 'specId', 'summary', 'preconditions', 'expectations', 'ambiguities', 'sourceSha', 'specSha',
  ]);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('CASE_SPEC_INVALID', `CaseSpec contains unsupported fields: ${unsupported.join(', ')}`);
  if (value.schemaVersion !== CASE_SPEC_SCHEMA_VERSION) {
    throw contractError('CASE_SPEC_SCHEMA_UNSUPPORTED', `CaseSpec.schemaVersion must be ${CASE_SPEC_SCHEMA_VERSION}`);
  }
  ensureString(value.specId, 'CaseSpec.specId', 'CASE_SPEC_INVALID');
  ensureString(value.summary, 'CaseSpec.summary', 'CASE_SPEC_INVALID');
  stringList(value.preconditions, 'CaseSpec.preconditions');
  stringList(value.ambiguities, 'CaseSpec.ambiguities');
  ensureString(value.sourceSha, 'CaseSpec.sourceSha', 'CASE_SPEC_INVALID');
  ensureString(value.specSha, 'CaseSpec.specSha', 'CASE_SPEC_INVALID');
  const expectations = ensureArray(value.expectations, 'CaseSpec.expectations', 'CASE_SPEC_INVALID');
  if (!expectations.length) throw contractError('CASE_SPEC_INVALID', 'CaseSpec.expectations must contain at least one item');
  const ids = new Set();
  for (const [index, item] of expectations.entries()) {
    const expectation = ensureObject(item, `CaseSpec.expectations[${index}]`, 'CASE_SPEC_INVALID');
    const expectationFields = new Set(['id', 'text', 'verificationKind', 'sourceEvidence']);
    const extra = Object.keys(expectation).filter((field) => !expectationFields.has(field));
    if (extra.length) throw contractError('CASE_SPEC_INVALID', `CaseSpec.expectations[${index}] contains unsupported fields: ${extra.join(', ')}`);
    if (expectation.id !== `E${index + 1}` || ids.has(expectation.id)) {
      throw contractError('CASE_SPEC_INVALID', `CaseSpec.expectations[${index}].id must be E${index + 1}`);
    }
    ids.add(expectation.id);
    ensureString(expectation.text, `CaseSpec.expectations[${index}].text`, 'CASE_SPEC_INVALID');
    if (!VERIFICATION_KINDS.has(expectation.verificationKind)) {
      throw contractError('CASE_SPEC_INVALID', `CaseSpec.expectations[${index}].verificationKind is invalid`);
    }
    const evidence = ensureArray(expectation.sourceEvidence, `CaseSpec.expectations[${index}].sourceEvidence`, 'CASE_SPEC_INVALID');
    if (!evidence.length) throw contractError('CASE_SPEC_INVALID', `CaseSpec.expectations[${index}].sourceEvidence must not be empty`);
    for (const [evidenceIndex, source] of evidence.entries()) {
      const sourceItem = ensureObject(source, `CaseSpec.expectations[${index}].sourceEvidence[${evidenceIndex}]`, 'CASE_SPEC_INVALID');
      if (Object.keys(sourceItem).some((field) => field !== 'quote')) {
        throw contractError('CASE_SPEC_INVALID', `CaseSpec.expectations[${index}].sourceEvidence[${evidenceIndex}] contains unsupported fields`);
      }
      const quote = ensureString(sourceItem.quote, `CaseSpec.expectations[${index}].sourceEvidence[${evidenceIndex}].quote`, 'CASE_SPEC_INVALID');
      if (options.sourceText !== undefined && !String(options.sourceText).includes(quote)) {
        throw contractError('CASE_SPEC_SOURCE_MISMATCH', `CaseSpec expectation ${expectation.id} cites text that is absent from source.md`);
      }
    }
  }
  if (options.sourceText !== undefined && value.sourceSha !== sourceSha(options.sourceText)) {
    throw contractError('CASE_SPEC_SOURCE_MISMATCH', 'CaseSpec.sourceSha does not match source.md');
  }
  if (options.sourceSha && value.sourceSha !== options.sourceSha) {
    throw contractError('CASE_SPEC_SOURCE_MISMATCH', 'CaseSpec.sourceSha does not match the frozen target');
  }
  if (value.specId !== caseSpecIdentity(value)) throw contractError('CASE_SPEC_INVALID', 'CaseSpec.specId does not match its content');
  if (value.specSha !== caseSpecSha(value)) throw contractError('CASE_SPEC_INVALID', 'CaseSpec.specSha does not match its content');
  return value;
}

function createCaseSpec({ sourceText, spec }) {
  ensureObject(spec, 'caseSpec', 'CASE_SPEC_REQUIRED');
  const summary = ensureString(spec.summary, 'caseSpec.summary', 'CASE_SPEC_INVALID').trim();
  const preconditions = stringList(spec.preconditions || [], 'caseSpec.preconditions');
  const ambiguities = stringList(spec.ambiguities || [], 'caseSpec.ambiguities');
  const expectations = ensureArray(spec.expectations, 'caseSpec.expectations', 'CASE_SPEC_INVALID').map((item, index) => {
    const input = typeof item === 'string' ? { text: item } : ensureObject(item, `caseSpec.expectations[${index}]`, 'CASE_SPEC_INVALID');
    const sourceEvidence = ensureArray(input.sourceEvidence, `caseSpec.expectations[${index}].sourceEvidence`, 'CASE_SPEC_INVALID')
      .map((source, sourceIndex) => ({
        quote: ensureString(ensureObject(source, `caseSpec.expectations[${index}].sourceEvidence[${sourceIndex}]`, 'CASE_SPEC_INVALID').quote,
          `caseSpec.expectations[${index}].sourceEvidence[${sourceIndex}].quote`, 'CASE_SPEC_INVALID').trim(),
      }));
    return {
      id: `E${index + 1}`,
      text: ensureString(input.text, `caseSpec.expectations[${index}].text`, 'CASE_SPEC_INVALID').trim(),
      verificationKind: input.verificationKind || 'DIRECT_OBSERVATION',
      sourceEvidence,
    };
  });
  const value = {
    schemaVersion: CASE_SPEC_SCHEMA_VERSION,
    specId: '',
    summary,
    preconditions,
    expectations,
    ambiguities,
    sourceSha: sourceSha(sourceText),
  };
  value.specId = caseSpecIdentity(value);
  value.specSha = caseSpecSha(value);
  return validateCaseSpec(value, { sourceText });
}

module.exports = {
  CASE_SPEC_SCHEMA_VERSION,
  VERIFICATION_KINDS,
  caseSpecIdentity,
  caseSpecSha,
  createCaseSpec,
  validateCaseSpec,
};

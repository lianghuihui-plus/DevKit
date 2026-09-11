'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureObject,
  ensureString,
  sha256,
} = require('../../lib/contract-utils');
const { INITIAL_STATE_TARGETS } = require('../../lib/app-provisioning');
const { sourceSha } = require('./case-contract');
const { VERIFICATION_KINDS } = require('./case-spec-contract');

const CASE_DEFINITION_SCHEMA_VERSION = 1;

function caseDefinitionCandidateContract(sourceText) {
  const quote = String(sourceText).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || String(sourceText).trim();
  const sourceEvidence = {
    type: 'array', minItems: 1,
    items: {
      type: 'object', required: ['quote'], additionalProperties: false,
      properties: { quote: { type: 'string', minLength: 1 } },
    },
  };
  return {
    schemaVersion: 1,
    schema: {
      type: 'object',
      required: ['summary', 'expectations', 'initialStateIntent'],
      additionalProperties: false,
      properties: {
        summary: { type: 'string', minLength: 1 },
        preconditions: { type: 'array', items: { type: 'string', minLength: 1 } },
        expectations: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['text', 'sourceEvidence'], additionalProperties: false,
            properties: {
              text: { type: 'string', minLength: 1 },
              verificationKind: { enum: [...VERIFICATION_KINDS] },
              sourceEvidence,
            },
          },
        },
        ambiguities: { type: 'array', items: { type: 'string', minLength: 1 } },
        initialStateIntent: {
          type: 'object', required: ['targetState', 'rationale'], additionalProperties: false,
          properties: {
            targetState: { enum: [...INITIAL_STATE_TARGETS] },
            rationale: { type: 'string', minLength: 1 },
            sourceEvidence,
          },
        },
      },
    },
    constraints: [
      'Every sourceEvidence.quote must be an exact continuous substring of source.',
      'A non-default initialStateIntent.targetState requires at least one sourceEvidence item.',
      'Do not provide generated ids, hashes, schemaVersion, compilerProfileSha, or publishedAt.',
    ],
    example: {
      summary: '验证原始用例描述的预期结果',
      preconditions: [],
      expectations: [{
        text: quote,
        verificationKind: 'DIRECT_OBSERVATION',
        sourceEvidence: [{ quote }],
      }],
      ambiguities: [],
      initialStateIntent: {
        targetState: 'KEEP_EXISTING',
        rationale: '原文没有要求重置 App 本地状态',
        sourceEvidence: [],
      },
    },
  };
}

function stringList(value, label) {
  return ensureArray(value, label, 'CASE_DEFINITION_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_DEFINITION_INVALID').trim());
}

function normalizedEvidence(value, label, sourceText) {
  return ensureArray(value, label, 'CASE_DEFINITION_INVALID').map((item, index) => {
    const evidence = ensureObject(item, `${label}[${index}]`, 'CASE_DEFINITION_INVALID');
    if (Object.keys(evidence).some((field) => field !== 'quote')) {
      throw contractError('CASE_DEFINITION_INVALID', `${label}[${index}] contains unsupported fields`);
    }
    const quote = ensureString(evidence.quote, `${label}[${index}].quote`, 'CASE_DEFINITION_INVALID').trim();
    if (sourceText !== undefined && !String(sourceText).includes(quote)) {
      throw contractError('CASE_DEFINITION_SOURCE_MISMATCH', `${label}[${index}] cites text absent from source.md`);
    }
    return { quote };
  });
}

function definitionIdentity(value) {
  return sha256(canonicalJson({
    schemaVersion: value.schemaVersion,
    caseKey: value.caseKey,
    sourceSha: value.sourceSha,
    summary: value.summary,
    preconditions: value.preconditions,
    expectations: value.expectations,
    ambiguities: value.ambiguities,
    initialStateIntent: value.initialStateIntent,
    compilerProfileSha: value.compilerProfileSha,
  }), 'definition', 20);
}

function caseDefinitionSha(value) {
  const unsigned = { ...value };
  delete unsigned.definitionSha;
  return sha256(canonicalJson(unsigned), 'case-definition', 24);
}

function validateCaseDefinition(value, options = {}) {
  ensureObject(value, 'CaseDefinition', 'CASE_DEFINITION_INVALID');
  if (value.schemaVersion !== CASE_DEFINITION_SCHEMA_VERSION) {
    throw contractError('CASE_DEFINITION_SCHEMA_UNSUPPORTED', `unsupported CaseDefinition schema: ${value.schemaVersion ?? 'missing'}`);
  }
  ensureId(value.definitionId, 'CaseDefinition.definitionId', 'CASE_DEFINITION_INVALID');
  ensureId(value.caseKey, 'CaseDefinition.caseKey', 'CASE_DEFINITION_INVALID');
  ensureString(value.sourceSha, 'CaseDefinition.sourceSha', 'CASE_DEFINITION_INVALID');
  ensureString(value.summary, 'CaseDefinition.summary', 'CASE_DEFINITION_INVALID');
  stringList(value.preconditions, 'CaseDefinition.preconditions');
  stringList(value.ambiguities, 'CaseDefinition.ambiguities');
  ensureString(value.compilerProfileSha, 'CaseDefinition.compilerProfileSha', 'CASE_DEFINITION_INVALID');
  if (Number.isNaN(Date.parse(value.publishedAt))) throw contractError('CASE_DEFINITION_INVALID', 'CaseDefinition.publishedAt is invalid');
  const expectations = ensureArray(value.expectations, 'CaseDefinition.expectations', 'CASE_DEFINITION_INVALID');
  if (!expectations.length) throw contractError('CASE_DEFINITION_INVALID', 'CaseDefinition.expectations must not be empty');
  expectations.forEach((item, index) => {
    const expectation = ensureObject(item, `CaseDefinition.expectations[${index}]`, 'CASE_DEFINITION_INVALID');
    if (expectation.id !== `E${index + 1}`) throw contractError('CASE_DEFINITION_INVALID', `expectation id must be E${index + 1}`);
    ensureString(expectation.text, `CaseDefinition.expectations[${index}].text`, 'CASE_DEFINITION_INVALID');
    if (!VERIFICATION_KINDS.has(expectation.verificationKind)) throw contractError('CASE_DEFINITION_INVALID', `expectation ${expectation.id} verificationKind is invalid`);
    const evidence = normalizedEvidence(expectation.sourceEvidence, `CaseDefinition.expectations[${index}].sourceEvidence`, options.sourceText);
    if (!evidence.length) throw contractError('CASE_DEFINITION_INVALID', `expectation ${expectation.id} requires source evidence`);
  });
  const intent = ensureObject(value.initialStateIntent, 'CaseDefinition.initialStateIntent', 'CASE_DEFINITION_INVALID');
  if (!INITIAL_STATE_TARGETS.has(intent.targetState)) throw contractError('CASE_DEFINITION_INVALID', 'initialStateIntent.targetState is invalid');
  ensureString(intent.rationale, 'CaseDefinition.initialStateIntent.rationale', 'CASE_DEFINITION_INVALID');
  const intentEvidence = normalizedEvidence(intent.sourceEvidence, 'CaseDefinition.initialStateIntent.sourceEvidence', options.sourceText);
  if (intent.targetState !== 'KEEP_EXISTING' && !intentEvidence.length) {
    throw contractError('CASE_DEFINITION_INVALID', 'non-default initial state intent requires source evidence');
  }
  if (options.sourceText !== undefined && value.sourceSha !== sourceSha(options.sourceText)) {
    throw contractError('CASE_DEFINITION_SOURCE_MISMATCH', 'CaseDefinition.sourceSha does not match source.md');
  }
  if (options.caseKey && value.caseKey !== options.caseKey) throw contractError('CASE_DEFINITION_SOURCE_MISMATCH', 'CaseDefinition.caseKey does not match case.json');
  if (value.definitionId !== definitionIdentity(value)) throw contractError('CASE_DEFINITION_INVALID', 'definitionId does not match content');
  if (value.definitionSha !== caseDefinitionSha(value)) throw contractError('CASE_DEFINITION_INVALID', 'definitionSha does not match content');
  return value;
}

function createCaseDefinition({ caseKey, sourceText, candidate, compilerProfileSha, publishedAt }) {
  const input = ensureObject(candidate, 'CaseDefinition candidate', 'CASE_DEFINITION_INVALID');
  const expectations = ensureArray(input.expectations, 'CaseDefinition candidate.expectations', 'CASE_DEFINITION_INVALID').map((item, index) => {
    const expectation = ensureObject(item, `CaseDefinition candidate.expectations[${index}]`, 'CASE_DEFINITION_INVALID');
    return {
      id: `E${index + 1}`,
      text: ensureString(expectation.text, `CaseDefinition candidate.expectations[${index}].text`, 'CASE_DEFINITION_INVALID').trim(),
      verificationKind: expectation.verificationKind || 'DIRECT_OBSERVATION',
      sourceEvidence: normalizedEvidence(expectation.sourceEvidence, `CaseDefinition candidate.expectations[${index}].sourceEvidence`, sourceText),
    };
  });
  const intent = ensureObject(input.initialStateIntent, 'CaseDefinition candidate.initialStateIntent', 'CASE_DEFINITION_INVALID');
  const value = {
    schemaVersion: CASE_DEFINITION_SCHEMA_VERSION,
    definitionId: '',
    caseKey,
    sourceSha: sourceSha(sourceText),
    summary: ensureString(input.summary, 'CaseDefinition candidate.summary', 'CASE_DEFINITION_INVALID').trim(),
    preconditions: stringList(input.preconditions || [], 'CaseDefinition candidate.preconditions'),
    expectations,
    ambiguities: stringList(input.ambiguities || [], 'CaseDefinition candidate.ambiguities'),
    initialStateIntent: {
      targetState: intent.targetState,
      rationale: ensureString(intent.rationale, 'CaseDefinition candidate.initialStateIntent.rationale', 'CASE_DEFINITION_INVALID').trim(),
      sourceEvidence: normalizedEvidence(intent.sourceEvidence || [], 'CaseDefinition candidate.initialStateIntent.sourceEvidence', sourceText),
    },
    compilerProfileSha: ensureString(compilerProfileSha, 'compilerProfileSha', 'CASE_DEFINITION_INVALID'),
    publishedAt: publishedAt || new Date().toISOString(),
  };
  value.definitionId = definitionIdentity(value);
  value.definitionSha = caseDefinitionSha(value);
  return validateCaseDefinition(value, { sourceText, caseKey });
}

module.exports = {
  CASE_DEFINITION_SCHEMA_VERSION,
  caseDefinitionSha,
  caseDefinitionCandidateContract,
  createCaseDefinition,
  definitionIdentity,
  validateCaseDefinition,
};

'use strict';

const { contractError } = require('../lib/contract-utils');
const { validateSourceText } = require('../execution/contracts/case-contract');
const { assertWorkspace } = require('../lib/workspace');
const { importCaseContent, stableDraftCaseKey } = require('./import-source');

function authoringError(message, fieldPath = 'request', expected = 'valid authoring request', code = 'INVALID_FIELD') {
  return contractError('CASE_AUTHORING_INPUT_INVALID', message, {
    issues: [{ fieldPath, expected, code }],
  });
}

function normalizeDrafts(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw authoringError('request must be an object', 'request', 'object');
  }
  const unknownRequestField = Object.keys(request).find((field) => field !== 'cases');
  if (unknownRequestField) {
    throw authoringError(`request.${unknownRequestField} is not supported`, unknownRequestField, 'only cases is supported', 'UNKNOWN_FIELD');
  }
  if (!Array.isArray(request.cases) || request.cases.length === 0) {
    throw authoringError('cases must be a non-empty array', 'cases', 'non-empty array', 'REQUIRED_FIELD_MISSING');
  }
  const seen = new Set();
  return request.cases.map((draft, index) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw authoringError(`cases[${index}] must be an object`, `cases[${index}]`, 'object');
    }
    const unknownDraftField = Object.keys(draft).find((field) => !['sourceLocator', 'title', 'sourceText'].includes(field));
    if (unknownDraftField) {
      throw authoringError(`cases[${index}].${unknownDraftField} is not supported`, `cases[${index}].${unknownDraftField}`, 'sourceLocator, title, or sourceText', 'UNKNOWN_FIELD');
    }
    const sourceLocator = typeof draft.sourceLocator === 'string' ? draft.sourceLocator.trim() : '';
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    if (!sourceLocator) throw authoringError(`cases[${index}].sourceLocator is required`, `cases[${index}].sourceLocator`, 'non-empty string', 'REQUIRED_FIELD_MISSING');
    if (!title) throw authoringError(`cases[${index}].title is required`, `cases[${index}].title`, 'non-empty string', 'REQUIRED_FIELD_MISSING');
    if (seen.has(sourceLocator)) throw authoringError(`cases[${index}].sourceLocator duplicates another draft`, `cases[${index}].sourceLocator`, 'unique stable source locator', 'DUPLICATE_VALUE');
    seen.add(sourceLocator);
    let sourceText;
    try {
      sourceText = validateSourceText(draft.sourceText);
    } catch (error) {
      throw authoringError(`cases[${index}].sourceText must contain non-whitespace source content`, `cases[${index}].sourceText`, 'non-empty string', 'REQUIRED_FIELD_MISSING');
    }
    return { sourceLocator, title, sourceText };
  });
}

function importDrafts(workspaceRoot, request) {
  const workspace = assertWorkspace(workspaceRoot, { allowTest: true });
  const drafts = normalizeDrafts(request);
  const cases = drafts.map((draft) => importCaseContent(workspace.root, {
    caseKey: stableDraftCaseKey(draft.sourceLocator),
    title: draft.title,
    sourceText: draft.sourceText,
    importSource: { kind: 'agent-authored', path: draft.sourceLocator },
  }));
  return { type: 'caseAuthoringImport', cases };
}

module.exports = { importDrafts, normalizeDrafts };

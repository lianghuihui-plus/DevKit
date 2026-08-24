'use strict';

const {
  contractError,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
} = require('./contract-utils');
const { sourceSha: calculateSourceSha } = require('../execution/contracts/case-contract');

function sourceLines(sourceText) {
  return String(sourceText).replace(/\r\n?/g, '\n').split('\n');
}

function validateSourceReference(value, options = {}) {
  ensureObject(value, 'source reference', 'SOURCE_REFERENCE_INVALID');
  ensureId(value.id, 'source reference id', 'SOURCE_REFERENCE_INVALID');
  ensureString(value.sourceSha, 'sourceSha', 'SOURCE_REFERENCE_INVALID');
  ensureInteger(value.lineStart, 'lineStart', 'SOURCE_REFERENCE_INVALID', 1);
  ensureInteger(value.lineEnd, 'lineEnd', 'SOURCE_REFERENCE_INVALID', 1);
  ensureString(value.quote, 'quote', 'SOURCE_REFERENCE_INVALID', { allowEmpty: true });
  if (value.lineEnd < value.lineStart) throw contractError('SOURCE_REFERENCE_INVALID', 'lineEnd must be >= lineStart');
  const sourceText = options.sourceText;
  ensureString(sourceText, 'sourceText', 'SOURCE_REFERENCE_INVALID', { allowEmpty: true });
  const expectedSourceSha = options.sourceSha || calculateSourceSha(sourceText);
  if (value.sourceSha !== expectedSourceSha) throw contractError('SOURCE_REFERENCE_MISMATCH', 'sourceSha does not match source snapshot');
  const lines = sourceLines(sourceText);
  if (value.lineEnd > lines.length) throw contractError('SOURCE_REFERENCE_INVALID', 'source reference line range is outside source snapshot');
  const expectedQuote = lines.slice(value.lineStart - 1, value.lineEnd).join('\n');
  if (value.quote.replace(/\r\n?/g, '\n') !== expectedQuote) {
    throw contractError('SOURCE_REFERENCE_MISMATCH', 'quote does not match source snapshot lines');
  }
  return value;
}

function validateSourceReferences(values, options = {}) {
  if (!Array.isArray(values)) throw contractError('SOURCE_REFERENCE_INVALID', 'sourceRefs must be an array');
  const ids = new Set();
  for (const value of values) {
    validateSourceReference(value, options);
    if (ids.has(value.id)) throw contractError('SOURCE_REFERENCE_INVALID', `duplicate source reference id: ${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

module.exports = {
  sourceLines,
  validateSourceReference,
  validateSourceReferences,
};

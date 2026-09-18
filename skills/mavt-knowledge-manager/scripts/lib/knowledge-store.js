'use strict';

const { managerError } = require('./errors');
const { authoringWarnings, isExpired, validateKnowledgeRoot } = require('./knowledge-contract');
const { assertMavtWorkspace } = require('./workspace');

function readValidated(workspace, options = {}) {
  const resolved = assertMavtWorkspace(workspace);
  return { ...resolved, ...validateKnowledgeRoot(resolved.knowledgeRoot, options) };
}

function inspectKnowledge(workspace, options = {}) {
  const validated = readValidated(workspace, options);
  return {
    schemaVersion: 1,
    status: 'VALID',
    workspace: validated.root,
    ...validated.summary,
    warningCount: validated.warnings.length,
    warnings: validated.warnings,
  };
}

function projectEntry(entry, options = {}) {
  return {
    entryId: entry.entryId,
    title: entry.title,
    relativePath: entry.relativePath,
    contentSha: entry.contentSha,
    metadata: entry.metadata,
    expired: isExpired(entry.metadata.validUntil, options.now),
    warningCodes: authoringWarnings(entry, options).map((item) => item.code),
  };
}

function listKnowledge(workspace, options = {}) {
  const validated = readValidated(workspace, options);
  return {
    schemaVersion: 1,
    status: 'VALID',
    workspace: validated.root,
    entries: validated.entries.map((entry) => projectEntry(entry, options)),
  };
}

function showKnowledge(workspace, entryId, options = {}) {
  if (typeof entryId !== 'string' || !entryId.trim()) {
    throw managerError('KNOWLEDGE_ENTRY_ID_INVALID', 'entryId is required');
  }
  const validated = readValidated(workspace, options);
  const entry = validated.entries.find((item) => item.entryId === entryId.trim());
  if (!entry) throw managerError('KNOWLEDGE_ENTRY_NOT_FOUND', `knowledge entry does not exist: ${entryId}`);
  return {
    schemaVersion: 1,
    status: 'VALID',
    workspace: validated.root,
    ...projectEntry(entry, options),
    sections: entry.sections,
    content: entry.content,
    warnings: authoringWarnings(entry, options),
  };
}

module.exports = { inspectKnowledge, listKnowledge, showKnowledge };

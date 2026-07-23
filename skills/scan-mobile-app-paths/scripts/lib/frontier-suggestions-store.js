'use strict';

const path = require('path');
const { contextDir, readJson } = require('./common');

const STATUSES = ['PENDING', 'APPLIED', 'SKIPPED', 'BLOCKED', 'DISMISSED'];

function emptySuggestions(contextId) {
  return { schemaVersion: 1, contextId, items: [] };
}

function suggestionFile(scanDir, contextId) {
  return path.join(contextDir(scanDir, contextId), 'frontier-suggestions.json');
}

function loadFrontierSuggestions(scanDir, contextId) {
  const store = readJson(suggestionFile(scanDir, contextId), emptySuggestions(contextId));
  store.schemaVersion = 1;
  store.contextId = contextId;
  store.items ||= [];
  return store;
}

function suggestionUpsertOp(contextId, item) {
  return {
    path: `contexts/${contextId}/frontier-suggestions.json`,
    op: 'UPSERT',
    collection: 'items',
    keyFields: ['suggestionId'],
    value: item,
    fallback: emptySuggestions(contextId)
  };
}

function pendingSuggestionsForState(store = {}, reachableStateId = null) {
  return (store.items || []).filter(item => item.status === 'PENDING' && (!reachableStateId || item.reachableStateId === reachableStateId));
}

module.exports = {
  STATUSES,
  emptySuggestions,
  suggestionFile,
  loadFrontierSuggestions,
  suggestionUpsertOp,
  pendingSuggestionsForState
};

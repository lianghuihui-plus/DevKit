'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const store = require('./store');

const ACTION_STATES = Object.freeze(['PREPARED', 'DISPATCHED', 'RESULT_RECORDED', 'OBSERVED', 'COMPLETED']);

function actionDraftPath(execDir, operationId) {
  return path.join(store.paths(execDir).transactions, `${operationId}.draft.json`);
}

function actionOperationPath(execDir, operationId) {
  return path.join(store.paths(execDir).operations, `${operationId}.json`);
}

function validateActionDraft(value) {
  if (!value || value.schemaVersion !== 1 || !String(value.operationId || '').startsWith('action-')
    || !ACTION_STATES.includes(value.status)) {
    throw contractError('ACTION_TRANSACTION_INVALID', 'action transaction is invalid');
  }
  return value;
}

function prepareAction(execDir, value) {
  const target = store.paths(execDir);
  fs.mkdirSync(target.transactions, { recursive: true });
  fs.mkdirSync(target.operations, { recursive: true });
  const draft = validateActionDraft({ schemaVersion: 1, status: 'PREPARED', ...value });
  writeJsonAtomic(actionDraftPath(execDir, draft.operationId), draft);
  return draft;
}

function readAction(execDir, operationId) {
  const draft = readJson(actionDraftPath(execDir, operationId), null);
  return draft ? validateActionDraft(draft) : null;
}

function transitionAction(execDir, draft, expected, status, update = {}) {
  validateActionDraft(draft);
  if (draft.status !== expected) {
    throw contractError('ACTION_TRANSACTION_STATE_MISMATCH', `action ${draft.operationId} is ${draft.status}, expected ${expected}`);
  }
  const next = validateActionDraft({ ...draft, ...update, status });
  writeJsonAtomic(actionDraftPath(execDir, draft.operationId), next);
  return next;
}

function completeAction(execDir, draft, update = {}) {
  validateActionDraft(draft);
  if (draft.status !== 'OBSERVED') {
    throw contractError('ACTION_TRANSACTION_STATE_MISMATCH', `action ${draft.operationId} must be OBSERVED before completion`);
  }
  const completed = validateActionDraft({ ...draft, ...update, status: 'COMPLETED' });
  writeJsonAtomic(actionOperationPath(execDir, draft.operationId), completed);
  const draftPath = actionDraftPath(execDir, draft.operationId);
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  return completed;
}

module.exports = {
  ACTION_STATES,
  actionDraftPath,
  actionOperationPath,
  completeAction,
  prepareAction,
  readAction,
  transitionAction,
  validateActionDraft,
};

'use strict';

const path = require('path');
const {
  facadeStepDrafts,
  executeStep,
  settleStepAtTimeLimit,
  settleStepRecoveryFailure,
} = require('../agent/facade-core');
const { executeDeviceOperation } = require('../agent/operations');
const { executeKnowledgeQuery } = require('../agent/query-knowledge');
const { commitAgentTurn } = require('../agent/turn');
const { knowledgeQueryDraftIds, operationDraftIds, turnDraftIds } = require('../execution/core');
const { readJson } = require('../lib/execution-lifecycle');
const { timeLimitState } = require('../lib/execution-time-limit');

function recoverInternalTransactions(execDir, options = {}) {
  const recovered = [];
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    const deadlineReached = execution && timeLimitState(execution, options.now || new Date()).reached;
    const step = facadeStepDrafts(execDir)[0];
    if (step) {
      if (deadlineReached) settleStepAtTimeLimit(execDir, step, options);
      else {
        try {
          executeStep(execDir, {}, { ...options, resumeStepId: step.stepId });
        } catch (error) {
          const remaining = facadeStepDrafts(execDir).find((entry) => entry.stepId === step.stepId);
          if (!remaining) throw error;
          settleStepRecoveryFailure(execDir, remaining, error, options);
        }
      }
      recovered.push({ type: 'step', id: step.stepId });
      continue;
    }
    const operationId = operationDraftIds(execDir)[0];
    if (operationId) {
      const draft = readJson(path.join(execDir, 'agent', `operation-${operationId}.draft.json`), null);
      try {
        executeDeviceOperation(execDir, draft.request, options);
        recovered.push({ type: 'operation', id: operationId });
      } catch (error) {
        const remaining = readJson(path.join(execDir, 'agent', `operation-${operationId}.draft.json`), null);
        if (remaining) throw error;
        recovered.push({ type: 'operation', id: operationId, outcome: error.code || 'FAILED' });
      }
      continue;
    }
    const queryId = knowledgeQueryDraftIds(execDir)[0];
    if (queryId) {
      const draft = readJson(path.join(execDir, 'agent', `knowledge-query-${queryId}.draft.json`), null);
      executeKnowledgeQuery({ execDir, queryId, query: draft.query, reason: draft.reason, now: options.now });
      recovered.push({ type: 'knowledge-query', id: queryId });
      continue;
    }
    const turnId = turnDraftIds(execDir)[0];
    if (turnId) {
      const draft = readJson(path.join(execDir, 'agent', 'turns', `${turnId}.draft.json`), null);
      commitAgentTurn(execDir, draft.turn, { now: options.now });
      recovered.push({ type: 'turn', id: turnId });
      continue;
    }
    return { recovered, complete: true };
  }
  throw new Error('INTERNAL_RECOVERY_EXHAUSTED: recovery did not converge');
}

function hasStepDrafts(execDir) {
  return facadeStepDrafts(execDir).length > 0;
}

module.exports = { hasStepDrafts, recoverInternalTransactions };

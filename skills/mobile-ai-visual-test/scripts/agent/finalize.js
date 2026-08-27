'use strict';

const { changePhase, finalizeExecution, validateFinalizationProposal } = require('../execution/core');
const { contractError } = require('../lib/contract-utils');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');
const { createAgentResult } = require('./core');
const { commitAgentTurn, prevalidateTurn } = require('./turn');

function finalizeWithReview(execDir, result, review, options = {}) {
  let binding = validateLiveAgentBinding(execDir);
  if (binding.execution.finalized) {
    const finalized = finalizeExecution(execDir, result, { implementationSha: binding.execution.implementationSha, now: options.now });
    return { ...finalized, agentResult: createAgentResult({ execDir }) };
  }
  let conclusionTurn = null;
  if (review) {
    const turn = review.schemaVersion === 1 && review.turnId
      ? review
      : { schemaVersion: 1, turnId: `turn-${review.factId || 'verdict-review'}`, facts: [review] };
    const verdictReviews = (turn.facts || []).filter((fact) => fact.type === 'verdictReview');
    if (verdictReviews.length > 1 || (turn.facts || []).some((fact) => !['checkpointFinding', 'verdictReview'].includes(fact.type))) {
      throw contractError('AGENT_FINALIZE_REVIEW_INVALID', 'conclusion turn may contain checkpoint findings and at most one verdict review', {
        fieldPath: 'review.facts', expected: 'checkpointFinding facts and at most one verdictReview fact', received: turn.facts,
      });
    }
    const validated = prevalidateTurn(execDir, turn, { phaseOverride: 'CONCLUDE' });
    const reviewEvents = validated.events
      .filter((event) => event.type === 'verdictReview')
      .map((event) => ({
        schemaVersion: 1,
        executionId: validated.execution.executionId,
        time: options.now || new Date().toISOString(),
        ...event,
      }));
    validateFinalizationProposal(execDir, result, {
      implementationSha: binding.execution.implementationSha,
      now: options.now,
      additionalVerdictReviews: reviewEvents,
      phaseOverride: 'CONCLUDE',
    });
    if (binding.execution.phase !== 'CONCLUDE') {
      changePhase(execDir, 'CONCLUDE', options.reason || result.summary || '形成最终结论', {
        implementationSha: binding.execution.implementationSha,
        now: options.now,
      });
      binding = validateLiveAgentBinding(execDir);
    }
    conclusionTurn = commitAgentTurn(execDir, turn, { now: options.now });
  } else if (binding.execution.phase !== 'CONCLUDE') {
    validateFinalizationProposal(execDir, result, {
      implementationSha: binding.execution.implementationSha,
      now: options.now,
      phaseOverride: 'CONCLUDE',
    });
    changePhase(execDir, 'CONCLUDE', options.reason || result.summary || '形成最终结论', {
      implementationSha: binding.execution.implementationSha,
      now: options.now,
    });
    binding = validateLiveAgentBinding(execDir);
  }
  const finalized = finalizeExecution(execDir, result, {
    implementationSha: binding.execution.implementationSha,
    now: options.now,
  });
  const agentResult = createAgentResult({ execDir });
  return {
    ...finalized,
    agentResult,
    ...(conclusionTurn ? {
      conclusionTurn,
      ...(conclusionTurn.turn.facts.some((fact) => fact.type === 'verdictReview') ? { reviewTurn: conclusionTurn } : {}),
    } : {}),
  };
}

module.exports = { finalizeWithReview };

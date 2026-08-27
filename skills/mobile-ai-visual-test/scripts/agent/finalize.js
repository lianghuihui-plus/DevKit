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
  if (binding.execution.phase !== 'CONCLUDE') {
    changePhase(execDir, 'CONCLUDE', options.reason || result.summary || '形成最终结论', {
      implementationSha: binding.execution.implementationSha,
      now: options.now,
    });
    binding = validateLiveAgentBinding(execDir);
  }
  let reviewTurn = null;
  if (review) {
    const turn = review.schemaVersion === 1 && review.turnId
      ? review
      : { schemaVersion: 1, turnId: `turn-${review.factId || 'verdict-review'}`, facts: [review] };
    if (turn.facts?.length !== 1 || turn.facts[0]?.type !== 'verdictReview') {
      throw contractError('AGENT_FINALIZE_REVIEW_INVALID', 'finalize review must contain exactly one verdictReview fact', {
        fieldPath: 'review.facts', expected: 'one verdictReview fact', received: turn.facts,
      });
    }
    const validated = prevalidateTurn(execDir, turn);
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
    });
    reviewTurn = commitAgentTurn(execDir, turn, { now: options.now });
  }
  const finalized = finalizeExecution(execDir, result, {
    implementationSha: binding.execution.implementationSha,
    now: options.now,
  });
  const agentResult = createAgentResult({ execDir });
  return { ...finalized, agentResult, ...(reviewTurn ? { reviewTurn } : {}) };
}

module.exports = { finalizeWithReview };

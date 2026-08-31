'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureArray } = require('../lib/contract-utils');
const { sourceSha } = require('../execution/contracts/case-contract');
const { sourceLines } = require('../lib/source-reference');
const { normalizeOptionalText, normalizeTextList } = require('../lib/agent-input-contract');

function semanticUnderstanding(value) {
  if (!value) return null;
  return {
    summary: value.summary,
    startConditions: value.startConditions.map(({ id, text, basis }) => ({ id, text, basis })),
    requirements: value.requirements.map(({ id, text, basis, requiredInteractions, expectedOutcomes }) => ({
      id,
      text,
      basis,
      requiredInteractions: normalizeTextList(requiredInteractions, `requirement ${id}.requiredInteractions`),
      expectedOutcomes: normalizeTextList(expectedOutcomes, `requirement ${id}.expectedOutcomes`),
    })),
    uncertainties: normalizeTextList(value.uncertainties || [], 'understanding.uncertainties'),
  };
}

function semanticCheckpoints(values = []) {
  return values.map((checkpoint) => ({
    id: checkpoint.id,
    objective: checkpoint.objective,
    requirementRefs: checkpoint.requirementRefs,
  }));
}

function buildUnderstandingTurn(execDir, input, current, generatedId, requireText) {
  if (input.checkpoints !== undefined || input.plan !== undefined) {
    throw contractError('AGENT_FACADE_INVALID', 'understand accepts only understanding; submit checkpoints through plan', {
      fieldPath: input.checkpoints !== undefined ? 'checkpoints' : 'plan', expected: 'use the plan entrypoint',
    });
  }
  if (!input.understanding) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understand request requires understanding');
  const sourceText = fs.readFileSync(path.join(execDir, 'source.snapshot.md'), 'utf8');
  const rootSourceRef = {
    id: 'source-case',
    sourceSha: sourceSha(sourceText),
    lineStart: 1,
    lineEnd: sourceLines(sourceText).length,
    quote: sourceText,
  };
  const freezeStatement = (statement) => ({
    id: statement.id,
    text: statement.text,
    basis: statement.basis,
    sourceRefs: statement.basis === 'assumed' ? [] : [rootSourceRef.id],
  });
  const freezeRequirement = (requirement) => ({
    ...freezeStatement(requirement),
    requiredInteractions: normalizeTextList(requirement.requiredInteractions, `requirement ${requirement.id}.requiredInteractions`),
    expectedOutcomes: normalizeTextList(requirement.expectedOutcomes, `requirement ${requirement.id}.expectedOutcomes`),
  });
  const reason = normalizeOptionalText(input.reason);
  return {
    schemaVersion: 1,
    turnId: generatedId('turn-understand'),
    understanding: {
      summary: input.understanding.summary,
      sourceRefs: [rootSourceRef],
      startConditions: ensureArray(input.understanding.startConditions, 'understanding.startConditions', 'AGENT_FACADE_INVALID').map(freezeStatement),
      requirements: ensureArray(input.understanding.requirements, 'understanding.requirements', 'AGENT_FACADE_INVALID').map(freezeRequirement),
      schemaVersion: 1,
      revision: (current.understanding?.revision || 0) + 1,
      uncertainties: normalizeTextList(input.understanding.uncertainties || [], 'understanding.uncertainties'),
      ...(current.understanding ? { reason: requireText(reason, 'reason') } : {}),
    },
    facts: [],
  };
}

function sameUnderstanding(current, input) {
  if (!current.understanding) return false;
  return Boolean(input.understanding) && canonicalJson(semanticUnderstanding(input.understanding))
    === canonicalJson(semanticUnderstanding(current.understanding));
}

function buildPlanTurn(input, current, generatedId) {
  if (!current.understanding) throw contractError('UNDERSTANDING_REQUIRED', 'freeze understanding before planning');
  if (!input.checkpoints) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'plan request requires checkpoints');
  return {
    schemaVersion: 1,
    turnId: generatedId('turn-plan'),
    plan: {
      schemaVersion: 1,
      revision: (current.plan?.revision || 0) + 1,
      reason: normalizeOptionalText(input.reason) || 'Agent 基于冻结用例理解建立执行计划',
      checkpoints: ensureArray(input.checkpoints, 'checkpoints', 'AGENT_FACADE_INVALID').map((checkpoint) => ({
        id: checkpoint.id,
        objective: checkpoint.objective,
        requirementRefs: checkpoint.requirementRefs,
      })),
    },
    facts: [],
  };
}

function sameCurrentPlan(current, input) {
  const lastUnderstanding = current.events.map((event) => event.type).lastIndexOf('caseUnderstood');
  const lastPlan = current.events.map((event) => event.type).lastIndexOf('planRevised');
  return Boolean(current.plan && lastPlan >= lastUnderstanding && input.checkpoints
    && canonicalJson(semanticCheckpoints(input.checkpoints))
      === canonicalJson(semanticCheckpoints(current.plan.checkpoints)));
}

module.exports = {
  buildPlanTurn,
  buildUnderstandingTurn,
  sameCurrentPlan,
  sameUnderstanding,
};

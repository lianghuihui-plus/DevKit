'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureObject,
} = require('../lib/contract-utils');
const { readExecution } = require('../lib/execution-lifecycle');
const { readJson, writeJsonAtomic, withFileLock } = require('../lib/execution-lifecycle');
const { validateUnderstanding } = require('../lib/understanding-contract');
const { validatePlan, withPlanSha } = require('../lib/plan-contract');
const { validateExecutionEvent } = require('../execution/contracts/execution-event-contract');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');
const { appendEvent, assertAgentWriteReady, assertConclusionObservationRefs, requireBoundRuntime, timelineEvents } = require('../execution/core');
const { validateKnowledgeCandidateSnapshot } = require('../lib/knowledge-snapshot');

const FACT_TYPES = new Set(['checkpointFinding', 'reflection', 'knowledgeAssessment', 'knowledgeReview', 'verdictReview']);

function assertInitialTurnReady(turn, previousUnderstanding, previousPlan) {
  if (previousUnderstanding || previousPlan) return;
  const missing = [];
  if (!turn.understanding) missing.push('understanding');
  if (!turn.plan) missing.push('plan');
  if (!turn.understanding?.sourceRefs?.length) missing.push('understanding.sourceRefs');
  if (!turn.understanding?.requirements?.length) missing.push('understanding.requirements');
  if (!turn.plan?.checkpoints?.length) missing.push('plan.checkpoints');
  if (missing.length) {
    throw contractError('AGENT_TURN_NOT_EXECUTABLE', `initial turn is missing execution-ready artifacts: ${missing.join(', ')}`, {
      fieldPath: missing[0],
      expected: 'complete understanding and at least one checkpoint in the same initial turn',
      missing,
    });
  }
}

function turnPaths(execDir, turnId) {
  const turnsDir = path.join(execDir, 'agent', 'turns');
  return {
    turnsDir,
    draft: path.join(turnsDir, `${turnId}.draft.json`),
    completed: path.join(turnsDir, `${turnId}.json`),
    lock: path.join(execDir, '.write.lock'),
  };
}

function normalizeTurn(value) {
  ensureObject(value, 'Agent turn', 'AGENT_TURN_INVALID');
  if (value.plan && value.plan.planSha === undefined) value = { ...value, plan: withPlanSha(value.plan) };
  if (value.schemaVersion !== 1) throw contractError('AGENT_TURN_SCHEMA_UNSUPPORTED', 'Agent turn schemaVersion must be 1');
  ensureId(value.turnId, 'turnId', 'AGENT_TURN_INVALID');
  const facts = ensureArray(value.facts || [], 'facts', 'AGENT_TURN_INVALID');
  const ids = new Set();
  for (const fact of facts) {
    ensureObject(fact, 'fact', 'AGENT_TURN_INVALID');
    ensureId(fact.factId, 'factId', 'AGENT_TURN_INVALID');
    if (ids.has(fact.factId)) throw contractError('AGENT_TURN_INVALID', `duplicate factId: ${fact.factId}`);
    if (!FACT_TYPES.has(fact.type)) throw contractError('AGENT_TURN_INVALID', `unsupported fact type: ${fact.type || 'missing'}`);
    ids.add(fact.factId);
  }
  if (!value.understanding && !value.plan && !facts.length) throw contractError('AGENT_TURN_INVALID', 'turn must contain understanding, plan, or facts');
  return value;
}

function prevalidateTurn(execDir, input, options = {}) {
  const turn = normalizeTurn(input);
  const loaded = readExecution(execDir);
  validateLiveAgentBinding(execDir);
  const { execution, sourceText } = loaded;
  const eventPhase = options.phaseOverride || execution.phase;
  requireBoundRuntime(execDir, execution.executionId);
  if (execution.finalized) throw contractError('EXECUTION_FINALIZED', 'finalized execution is read-only');
  assertAgentWriteReady(execDir, { allowedTurnId: turn.turnId });
  const liveUnderstanding = readJson(path.join(execDir, 'understanding.json'), null);
  const livePlan = readJson(path.join(execDir, 'plan.json'), null);
  const previousUnderstanding = options.previousUnderstanding !== undefined ? options.previousUnderstanding : liveUnderstanding;
  const previousPlan = options.previousPlan !== undefined ? options.previousPlan : livePlan;
  assertInitialTurnReady(turn, previousUnderstanding, previousPlan);
  const understanding = turn.understanding || previousUnderstanding;
  if (turn.understanding && !options.committed?.has('understanding')) {
    validateUnderstanding(turn.understanding, { sourceText, previous: previousUnderstanding });
  }
  if (!understanding && turn.plan) throw contractError('UNDERSTANDING_REQUIRED', 'plan requires understanding');
  if (turn.plan && !options.committed?.has('plan')) {
    validatePlan(turn.plan, { understanding, previous: previousPlan });
  }
  const plan = turn.plan || previousPlan;
  const events = timelineEvents(execDir);
  const eventCandidates = [];
  const knowledgeRefs = new Set(events.filter((entry) => entry.type === 'knowledgeAssessment').map((entry) => entry.knowledgeRef));
  const assessmentsByRef = new Map(events.filter((entry) => entry.type === 'knowledgeAssessment')
    .map((entry) => [entry.knowledgeRef, entry]));
  const reviewedQueries = new Set(events.filter((entry) => entry.type === 'knowledgeReview').map((entry) => entry.queryId));
  if (turn.understanding) {
    eventCandidates.push({
      type: 'caseUnderstood', writer: 'agent', phase: eventPhase,
      understandingRevision: turn.understanding.revision,
      sourceRefs: turn.understanding.sourceRefs.map((entry) => entry.id),
      turnId: turn.turnId, factId: 'understanding',
    });
  }
  if (turn.plan) {
    eventCandidates.push({
      type: 'planRevised', writer: 'agent', phase: eventPhase,
      planRevision: turn.plan.revision, planSha: turn.plan.planSha, reason: turn.plan.reason,
      turnId: turn.turnId, factId: 'plan',
    });
  }
  for (const fact of turn.facts) {
    const candidateEvent = { ...fact, writer: 'agent', phase: eventPhase, turnId: turn.turnId };
    validateExecutionEvent({ schemaVersion: 1, executionId: execution.executionId, time: execution.startedAt, ...candidateEvent }, {
      executionId: execution.executionId,
      phase: eventPhase,
    });
    if (fact.type === 'checkpointFinding') {
      if (!plan || fact.planRevision !== plan.revision || !plan.checkpoints.some((entry) => entry.id === fact.checkpointId)) {
        throw contractError('PLAN_REVISION_STALE', 'checkpoint finding must bind the resulting current plan');
      }
      const requirementIds = new Set(understanding.requirements.map((entry) => entry.id));
      if (!fact.requirementRefs.every((ref) => requirementIds.has(ref))) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'finding references an unknown requirement');
      const usableEvidence = new Set(events.filter((entry) => entry.type === 'observation' && entry.usable).map((entry) => entry.ref));
      if (!fact.evidenceRefs.every((ref) => usableEvidence.has(ref))) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'finding references unusable evidence');
    }
    if (fact.type === 'knowledgeAssessment') {
      if (knowledgeRefs.has(fact.knowledgeRef)) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'knowledgeRef must be unique within an execution');
      knowledgeRefs.add(fact.knowledgeRef);
      const query = events.find((entry) => entry.type === 'knowledgeQuery' && entry.queryId === fact.queryId);
      if (!query) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'knowledge assessment references an unknown query');
      const candidate = query.candidates.find((item) => item.entryId === fact.entryId
        && item.sourceNamespace === fact.sourceNamespace && item.relativePath === fact.relativePath
        && item.contentSha === fact.contentSha);
      if (!candidate) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'knowledge assessment does not match a frozen query candidate');
      validateKnowledgeCandidateSnapshot(execDir, candidate);
      if (fact.assessment === 'APPLICABLE' && candidate.expired) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'expired knowledge cannot be assessed as APPLICABLE');
      assessmentsByRef.set(fact.knowledgeRef, candidateEvent);
    }
    if (fact.type === 'knowledgeReview') {
      if (reviewedQueries.has(fact.queryId)) throw contractError('KNOWLEDGE_REVIEW_ALREADY_COMPLETED', `knowledge query is already reviewed: ${fact.queryId}`);
      const query = events.find((entry) => entry.type === 'knowledgeQuery' && entry.queryId === fact.queryId);
      if (!query) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'knowledge review references an unknown query');
      const refs = new Set(fact.assessmentRefs);
      if (refs.size !== fact.assessmentRefs.length) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'knowledge review assessmentRefs must be unique');
      const assessments = fact.assessmentRefs.map((ref) => assessmentsByRef.get(ref));
      if (assessments.some((assessment) => !assessment || assessment.queryId !== fact.queryId)) {
        throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'knowledge review assessments must belong to its query');
      }
      if (query.matchCount === 0 && (fact.conclusion !== 'NO_MATCH' || assessments.length !== 0)) {
        throw contractError('KNOWLEDGE_REVIEW_INVALID', 'a zero-match query requires an empty NO_MATCH review');
      }
      if (query.matchCount > 0 && (fact.conclusion === 'NO_MATCH' || assessments.length === 0)) {
        throw contractError('KNOWLEDGE_REVIEW_INVALID', 'a matched query requires assessed candidates and a non-NO_MATCH conclusion');
      }
      const values = new Set(assessments.map((assessment) => assessment.assessment));
      if (fact.conclusion === 'APPLICABLE_FOUND' && !values.has('APPLICABLE')) throw contractError('KNOWLEDGE_REVIEW_INVALID', 'APPLICABLE_FOUND requires an APPLICABLE assessment');
      if (fact.conclusion === 'NO_APPLICABLE' && values.has('APPLICABLE')) throw contractError('KNOWLEDGE_REVIEW_INVALID', 'NO_APPLICABLE cannot include an APPLICABLE assessment');
      if (fact.conclusion === 'CONFLICTING' && !values.has('CONFLICTING')) throw contractError('KNOWLEDGE_REVIEW_INVALID', 'CONFLICTING requires a CONFLICTING assessment');
      if (fact.conclusion === 'INSUFFICIENT' && !values.has('INSUFFICIENT')) throw contractError('KNOWLEDGE_REVIEW_INVALID', 'INSUFFICIENT requires an INSUFFICIENT assessment');
      reviewedQueries.add(fact.queryId);
    }
    if (fact.type === 'verdictReview') {
      if (!understanding || fact.understandingRevision !== understanding.revision) {
        throw contractError('VERDICT_REVIEW_STALE', 'verdict review must bind the current understanding revision');
      }
      if (!plan || fact.planRevision !== plan.revision || fact.planSha !== plan.planSha) {
        throw contractError('VERDICT_REVIEW_STALE', 'verdict review must bind the current plan revision and digest');
      }
      const currentRequirementIds = new Set(understanding.requirements.map((entry) => entry.id));
      if (fact.requirementRefs.length !== currentRequirementIds.size
        || !fact.requirementRefs.every((ref) => currentRequirementIds.has(ref))) {
        throw contractError('VERDICT_REVIEW_STALE', 'verdict review must cover every current requirement');
      }
      const queryIds = new Set(events.filter((entry) => entry.type === 'knowledgeQuery').map((entry) => entry.queryId));
      if (!fact.queryRefs.every((ref) => queryIds.has(ref))) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'verdict review references an unknown query');
      const sourceIds = new Set((understanding?.sourceRefs || []).map((entry) => entry.id));
      if (!fact.sourceRecheck.sourceRefs.every((ref) => sourceIds.has(ref))) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'verdict review references unknown source text');
      const usableEvidence = new Set(events.filter((entry) => entry.type === 'observation' && entry.usable).map((entry) => entry.ref));
      if (![...fact.currentObservationRefs, ...fact.recoveryAttempt.evidenceRefs].every((ref) => usableEvidence.has(ref))) {
        throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'verdict review must reference current usable observations');
      }
      assertConclusionObservationRefs(events, fact.currentObservationRefs, {
        warmSessionGeneration: execution.warmSessionGeneration,
      });
      const observationUnavailable = events.some((entry) => entry.type === 'timeLimitReached' && entry.observationUnavailable === true);
      if (fact.observationUnavailable === true && !observationUnavailable) {
        throw contractError('VERDICT_REVIEW_INVALID', 'observationUnavailable requires a matching time-limit observation gap');
      }
      if (observationUnavailable && fact.observationUnavailable !== true) {
        throw contractError('VERDICT_REVIEW_INVALID', 'time-limit observation gap must be declared by the verdict review');
      }
      if (observationUnavailable
        && fact.remainingUncertainties.length === 0) {
        throw contractError('VERDICT_REVIEW_INVALID', 'time-limit review with an unobserved state change must record remaining uncertainty');
      }
    }
    eventCandidates.push(candidateEvent);
  }
  for (const event of eventCandidates) {
    validateExecutionEvent({ schemaVersion: 1, executionId: execution.executionId, time: execution.startedAt, ...event }, { executionId: execution.executionId, phase: eventPhase });
  }
  return {
    execution,
    turn,
    understanding: turn.understanding,
    plan: turn.plan,
    previousUnderstanding,
    previousPlan,
    events: eventCandidates,
  };
}

function commitAgentTurn(execDir, input, options = {}) {
  const resolved = path.resolve(execDir);
  const normalized = normalizeTurn(input);
  const paths = turnPaths(resolved, normalized.turnId);
  return withFileLock(paths.lock, () => {
    fs.mkdirSync(paths.turnsDir, { recursive: true });
    const completed = readJson(paths.completed, null);
    if (completed) {
      if (canonicalJson(completed.turn) !== canonicalJson(normalized)) throw contractError('AGENT_TURN_BINDING_MISMATCH', 'turnId is already bound to another turn');
      return { ...completed, idempotent: true };
    }
    const draft = readJson(paths.draft, null);
    if (draft && canonicalJson(draft.turn) !== canonicalJson(normalized)) {
      throw contractError('AGENT_TURN_BINDING_MISMATCH', 'turn recovery draft does not match');
    }
    const committed = new Set(timelineEvents(resolved).filter((entry) => entry.turnId === normalized.turnId).map((entry) => entry.factId));
    const validated = prevalidateTurn(resolved, normalized, {
      committed,
      previousUnderstanding: draft ? draft.previousUnderstanding : undefined,
      previousPlan: draft ? draft.previousPlan : undefined,
    });
    const frozen = {
      schemaVersion: 1,
      executionId: validated.execution.executionId,
      previousUnderstanding: validated.previousUnderstanding,
      previousPlan: validated.previousPlan,
      turn: validated.turn,
    };
    if (draft && canonicalJson(draft) !== canonicalJson(frozen)) throw contractError('AGENT_TURN_BINDING_MISMATCH', 'turn recovery draft does not match');
    if (!draft) writeJsonAtomic(paths.draft, frozen);
    if (validated.understanding && !committed.has('understanding')) {
      writeJsonAtomic(path.join(resolved, 'understanding.json'), validated.understanding);
      appendEvent(resolved, validated.events.find((entry) => entry.factId === 'understanding'), { implementationSha: validated.execution.implementationSha, now: options.now });
      committed.add('understanding');
      if (options.interruptAfter === 'understanding') throw new Error('MAVT_AGENT_TURN_INTERRUPTED: understanding');
    }
    if (validated.plan && !committed.has('plan')) {
      writeJsonAtomic(path.join(resolved, 'plan.json'), validated.plan);
      appendEvent(resolved, validated.events.find((entry) => entry.factId === 'plan'), { implementationSha: validated.execution.implementationSha, now: options.now });
      committed.add('plan');
      if (options.interruptAfter === 'plan') throw new Error('MAVT_AGENT_TURN_INTERRUPTED: plan');
    }
    for (const event of validated.events.filter((entry) => !['understanding', 'plan'].includes(entry.factId))) {
      if (committed.has(event.factId)) continue;
      appendEvent(resolved, event, { implementationSha: validated.execution.implementationSha, now: options.now });
      committed.add(event.factId);
      if (options.interruptAfter === event.factId) throw new Error(`MAVT_AGENT_TURN_INTERRUPTED: ${event.factId}`);
    }
    const value = {
      schemaVersion: 1,
      executionId: validated.execution.executionId,
      turnId: normalized.turnId,
      committed: [...committed].sort(),
      turn: normalized,
    };
    writeJsonAtomic(paths.completed, value);
    if (fs.existsSync(paths.draft)) fs.unlinkSync(paths.draft);
    return value;
  }, { now: options.now });
}

module.exports = {
  FACT_TYPES,
  commitAgentTurn,
  normalizeTurn,
  prevalidateTurn,
  assertInitialTurnReady,
  turnPaths,
};

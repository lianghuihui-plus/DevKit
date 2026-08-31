'use strict';

const { canonicalJson, contractError, sha256 } = require('../lib/contract-utils');
const { checkpointActivity } = require('../lib/checkpoint-progress');
const { checkpointRequirements } = require('../lib/checkpoint-semantics');
const { hasCurrentStartObservation } = require('../execution/core');

function defaultResultFields(input, events) {
  const stopped = events.some((event) => event.type === 'timeLimitReached');
  if (input.verdict === 'PASS') return { executionStatus: stopped ? 'STOPPED_BY_BUDGET' : 'COMPLETED', verdictBasis: input.verdictBasis || 'DIRECT_EVIDENCE', technicalFailureCode: null };
  if (input.verdict === 'FAIL') return { executionStatus: 'COMPLETED', verdictBasis: input.verdictBasis || 'DIRECT_EVIDENCE', technicalFailureCode: null };
  if (input.verdict === 'INCONCLUSIVE') return { executionStatus: stopped ? 'STOPPED_BY_BUDGET' : 'COMPLETED', verdictBasis: 'INSUFFICIENT_EVIDENCE', technicalFailureCode: null };
  if (input.technicalFailureCode) return { executionStatus: 'TECHNICALLY_BLOCKED', verdictBasis: 'TECHNICAL_CONSTRAINT', technicalFailureCode: input.technicalFailureCode };
  return { executionStatus: 'COMPLETED', verdictBasis: input.verdictBasis || 'DIRECT_EVIDENCE', technicalFailureCode: null };
}

function checkpointFacts(current, findings) {
  const byRequirement = new Map(findings.map((finding) => [finding.requirementId, finding]));
  return current.plan.checkpoints.map((checkpoint) => {
    const related = checkpoint.requirementRefs.map((ref) => byRequirement.get(ref)).filter(Boolean);
    const activity = checkpointActivity(current.events, checkpoint.id, current.execution.warmSessionGeneration);
    const actions = activity.filter((event) => event.type === 'actionResult');
    const observations = activity.filter((event) => event.type === 'observation' && event.usable === true);
    const statuses = new Set(related.map((finding) => finding.status));
    const semanticStatus = statuses.has('NOT_SATISFIED') ? 'NOT_SATISFIED'
      : statuses.has('BLOCKED') ? 'BLOCKED'
        : statuses.has('UNRESOLVED') ? 'UNRESOLVED' : 'SATISFIED';
    const requiresAction = checkpointRequirements(current.understanding, checkpoint)
      .some((requirement) => requirement.requiredInteractions.length > 0);
    const actionRequirementSatisfied = !requiresAction || actions.length > 0;
    const findingEvidenceRefs = related.flatMap((finding) => finding.evidenceRefs || []);
    const evidenceRefs = [...new Set([
      ...observations.map((event) => event.ref),
      ...(requiresAction ? [] : findingEvidenceRefs),
    ])];
    const status = evidenceRefs.length > 0 && actionRequirementSatisfied ? semanticStatus : 'NOT_EXECUTED';
    return {
      factId: sha256(canonicalJson({ planSha: current.plan.planSha, checkpointId: checkpoint.id, findings }), 'finding', 16),
      type: 'checkpointFinding',
      checkpointId: checkpoint.id,
      planRevision: current.plan.revision,
      status,
      requirementRefs: checkpoint.requirementRefs,
      evidenceRefs,
      finding: status === 'NOT_EXECUTED'
        ? `检查点“${checkpoint.objective}”没有满足执行证据要求`
        : related.map((finding) => finding.reason).filter(Boolean).join('；') || `检查点“${checkpoint.objective}”已由最终 requirement 结论覆盖`,
      reason: status === 'NOT_EXECUTED'
        ? `关联 ${actions.length} 次操作、${observations.length} 次可用观察${requiresAction && !actionRequirementSatisfied ? '，缺少用例要求的操作' : ''}`
        : related.map((finding) => finding.reason).filter(Boolean).join('；') || `检查点“${checkpoint.objective}”已完成`,
    };
  });
}

function assertFindingEvidenceOwnership(current, findings) {
  const checkpointsByRequirement = new Map();
  for (const checkpoint of current.plan.checkpoints) {
    for (const requirementRef of checkpoint.requirementRefs) {
      checkpointsByRequirement.set(requirementRef, checkpoint.id);
    }
  }
  const observations = new Map(current.events
    .filter((event) => event.type === 'observation' && event.ref)
    .map((event) => [event.ref, event]));
  for (const [index, finding] of findings.entries()) {
    const checkpointId = checkpointsByRequirement.get(finding.requirementId);
    for (const ref of finding.evidenceRefs || []) {
      const observation = observations.get(ref);
      if (!observation || observation.usable !== true
        || observation.warmSessionGeneration !== current.execution.warmSessionGeneration) {
        throw contractError('RESULT_EVIDENCE_INVALID', 'finding evidence must be usable evidence from the current warm session', {
          fieldPath: `findings[${index}].evidenceRefs`, received: ref,
        });
      }
      const boundCheckpoint = observation.authorization?.checkpointId;
      if (boundCheckpoint && boundCheckpoint !== checkpointId) {
        throw contractError('RESULT_EVIDENCE_CHECKPOINT_MISMATCH', 'finding evidence belongs to another checkpoint', {
          fieldPath: `findings[${index}].evidenceRefs`, expected: checkpointId, received: boundCheckpoint,
        });
      }
    }
  }
}

function assertConclusionEligibility(current, input, findings, checkpointFindings, defaults) {
  const technicalBlocked = input.verdict === 'BLOCKED' && defaults.verdictBasis === 'TECHNICAL_CONSTRAINT';
  const timeLimitObservationGap = current.events.some((event) => event.type === 'timeLimitReached'
    && event.observationUnavailable === true);
  if (timeLimitObservationGap && input.verdict !== 'INCONCLUSIVE') {
    throw contractError('RESULT_SEMANTICS_INVALID', 'a time-limit observation gap can only conclude as INCONCLUSIVE', {
      fieldPath: 'verdict', allowed: ['INCONCLUSIVE'], received: input.verdict,
    });
  }
  const startEstablished = hasCurrentStartObservation(
    current.events,
    current.understanding.revision,
    current.execution.warmSessionGeneration,
  );
  if (['PASS', 'FAIL'].includes(input.verdict) && !startEstablished) {
    throw contractError('START_NOT_ESTABLISHED', `${input.verdict} requires mark-start for the current understanding and warm session`, {
      fieldPath: 'verdict', expected: 'current startEstablished evidence before PASS or FAIL', received: input.verdict,
    });
  }
  const noExecutableRequirements = current.understanding.requirements.length === 0;
  if (!technicalBlocked && !noExecutableRequirements && !current.observation
    && !(timeLimitObservationGap && input.verdict === 'INCONCLUSIVE')) {
    throw contractError('CURRENT_OBSERVATION_REQUIRED', `${input.verdict} requires a current usable observation`);
  }
  if (input.verdict === 'PASS') {
    const incomplete = checkpointFindings.filter((finding) => finding.status === 'NOT_EXECUTED');
    if (incomplete.length) {
      throw contractError('CHECKPOINT_EXECUTION_INCOMPLETE', 'PASS requires execution evidence for every current checkpoint', {
        fieldPath: 'checkpoints', expected: 'no NOT_EXECUTED checkpoint', received: incomplete.map((finding) => finding.checkpointId),
      });
    }
  }
  if (noExecutableRequirements && (input.verdict !== 'INCONCLUSIVE' || findings.length !== 0)) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'an understanding without requirements can only conclude INCONCLUSIVE with no findings', {
      fieldPath: 'verdict', expected: 'INCONCLUSIVE with findings=[]', received: input.verdict,
    });
  }
}

module.exports = {
  assertConclusionEligibility,
  assertFindingEvidenceOwnership,
  checkpointFacts,
  defaultResultFields,
};

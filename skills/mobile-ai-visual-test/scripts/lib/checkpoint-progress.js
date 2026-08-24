'use strict';

const FINDING_PROGRESS = Object.freeze({
  SATISFIED: 'VERIFIED',
  NOT_SATISFIED: 'NOT_SATISFIED',
  BLOCKED: 'BLOCKED',
  UNRESOLVED: 'UNRESOLVED',
  NOT_EXECUTED: 'NOT_EXECUTED',
});

function bindingMatches(event, checkpointId, planRevision) {
  const authorization = event.authorization || {};
  return authorization.checkpointId === checkpointId && authorization.planRevision === planRevision;
}

function deriveCheckpointProgress(plan, events = [], result = null) {
  if (!plan?.checkpoints?.length) return [];
  const requirementFindings = new Map((result?.requirementFindings || []).map((entry) => [entry.requirementId, entry]));
  return plan.checkpoints.map((checkpoint) => {
    const activity = events.filter((event) => bindingMatches(event, checkpoint.id, plan.revision));
    const actions = activity.filter((event) => event.type === 'actionResult');
    const observations = activity.filter((event) => event.type === 'observation' && event.usable === true);
    const finding = [...events].reverse().find((event) => event.type === 'checkpointFinding'
      && event.checkpointId === checkpoint.id && event.planRevision === plan.revision);
    const hasRequiredAction = checkpoint.requiredAction !== true || actions.length > 0;
    const hasExecutionEvidence = observations.length > 0 || actions.length > 0 || (finding?.evidenceRefs || []).length > 0;
    let status;
    if (finding) {
      status = FINDING_PROGRESS[finding.status] || (hasExecutionEvidence && hasRequiredAction ? 'VERIFIED' : 'NOT_EXECUTED');
      if (status === 'VERIFIED' && (!hasExecutionEvidence || !hasRequiredAction)) status = 'NOT_EXECUTED';
    } else if (activity.length) status = 'ACTIVE';
    else status = 'PENDING';
    return {
      checkpointId: checkpoint.id,
      planRevision: plan.revision,
      status,
      actionCount: actions.length,
      observationCount: observations.length,
      evidenceRefs: [...new Set([
        ...observations.map((entry) => entry.ref),
        ...(finding?.evidenceRefs || []),
      ])],
      requirementFindings: (checkpoint.requirementRefs || []).map((ref) => requirementFindings.get(ref)).filter(Boolean),
      requiredActionSatisfied: hasRequiredAction,
    };
  });
}

module.exports = { deriveCheckpointProgress };

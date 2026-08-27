'use strict';

const {
  contractError,
  ensureArray,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
} = require('../../lib/contract-utils');

const EVENT_SCHEMA_VERSION = 1;
const PHASES = new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE', 'FINALIZED']);
const EVENT_WRITERS = Object.freeze({
  phaseChanged: 'runtime-core',
  operationStarted: 'runtime-core',
  operationRejected: 'runtime-core',
  operationCompleted: 'runtime-core',
  timeLimitReached: 'runtime-core',
  observation: 'observe.sh',
  actionResult: 'action.sh',
  startEstablished: 'agent',
  caseUnderstood: 'agent',
  planRevised: 'agent',
  checkpointFinding: 'agent',
  reflection: 'agent',
  knowledgeQuery: 'knowledge-query',
  knowledgeAssessment: 'agent',
  knowledgeReview: 'agent',
  verdictReview: 'agent',
  result: 'runtime-core',
  runtimeIncident: 'runtime-core',
  recoveryStarted: 'runtime-core',
  recoveryCompleted: 'runtime-core',
});
const KNOWLEDGE_ASSESSMENTS = new Set(['APPLICABLE', 'NOT_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT']);
const KNOWLEDGE_REVIEW_CONCLUSIONS = new Set(['NO_MATCH', 'APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT']);
const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const OPERATION_KINDS = new Set(['OBSERVE', 'ACTION']);
const OPERATION_OUTCOMES = new Set(['SUCCEEDED', 'FAILED', 'REJECTED']);
const EVIDENCE_SCOPES = new Set(['case-prepare', 'case-business']);
const EVENT_PHASES = Object.freeze({
  phaseChanged: PHASES,
  operationStarted: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  operationRejected: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  operationCompleted: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  timeLimitReached: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  observation: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  actionResult: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  startEstablished: new Set(['ESTABLISH_START']),
  caseUnderstood: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  planRevised: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  checkpointFinding: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  reflection: new Set(['EXECUTE', 'INVESTIGATE']),
  knowledgeQuery: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  knowledgeAssessment: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  knowledgeReview: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  verdictReview: new Set(['CONCLUDE']),
  result: new Set(['FINALIZED']),
  runtimeIncident: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  recoveryStarted: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  recoveryCompleted: new Set(['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
});

function validateStringArray(value, label) {
  ensureArray(value, label, 'EXECUTION_EVENT_INVALID');
  value.forEach((item, index) => ensureString(item, `${label}[${index}]`, 'EXECUTION_EVENT_INVALID'));
}

function validateKnowledgeCandidate(value, label) {
  ensureObject(value, label, 'EXECUTION_EVENT_INVALID');
  ensureId(value.entryId, `${label}.entryId`, 'EXECUTION_EVENT_INVALID');
  if (!['skill', 'workspace'].includes(value.sourceNamespace)) throw contractError('EXECUTION_EVENT_INVALID', `${label}.sourceNamespace is invalid`);
  ensureString(value.relativePath, `${label}.relativePath`, 'EXECUTION_EVENT_INVALID');
  if (value.relativePath.startsWith('/') || value.relativePath.split(/[\\/]+/).includes('..')) throw contractError('EXECUTION_EVENT_INVALID', `${label}.relativePath is unsafe`);
  ensureString(value.contentSha, `${label}.contentSha`, 'EXECUTION_EVENT_INVALID');
  if (!/^[0-9a-f]{64}$/.test(value.contentSha)) throw contractError('EXECUTION_EVENT_INVALID', `${label}.contentSha is invalid`);
  ensureInteger(value.score, `${label}.score`, 'EXECUTION_EVENT_INVALID', 1);
  if (typeof value.expired !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', `${label}.expired must be boolean`);
  if (value.validUntil !== null && value.validUntil !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value.validUntil)) throw contractError('EXECUTION_EVENT_INVALID', `${label}.validUntil is invalid`);
  validateStringArray(value.conflictsWith, `${label}.conflictsWith`);
  validateStringArray(value.snippets, `${label}.snippets`);
  if (value.snapshotRef !== undefined) {
    ensureString(value.snapshotRef, `${label}.snapshotRef`, 'EXECUTION_EVENT_INVALID');
    if (value.snapshotRef.startsWith('/') || value.snapshotRef.split(/[\\/]+/).includes('..')) throw contractError('EXECUTION_EVENT_INVALID', `${label}.snapshotRef is unsafe`);
  }
  if (value.metadata !== undefined) ensureObject(value.metadata, `${label}.metadata`, 'EXECUTION_EVENT_INVALID');
  if (value.applicability !== undefined) ensureString(value.applicability, `${label}.applicability`, 'EXECUTION_EVENT_INVALID');
  if (value.traceability !== undefined) ensureString(value.traceability, `${label}.traceability`, 'EXECUTION_EVENT_INVALID');
}

function validateExecutionEvent(value, options = {}) {
  ensureObject(value, 'execution event', 'EXECUTION_EVENT_INVALID');
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION) throw contractError('EXECUTION_EVENT_SCHEMA_UNSUPPORTED', `schemaVersion must be ${EVENT_SCHEMA_VERSION}`);
  ensureString(value.executionId, 'executionId', 'EXECUTION_EVENT_INVALID');
  if (options.executionId && value.executionId !== options.executionId) throw contractError('EXECUTION_EVENT_BINDING_MISMATCH', 'executionId does not match current execution');
  const expectedWriter = EVENT_WRITERS[value.type];
  if (!expectedWriter) throw contractError('EXECUTION_EVENT_INVALID', `unsupported event type: ${value.type || 'unknown'}`);
  if (value.writer !== expectedWriter || (options.writer && value.writer !== options.writer)) {
    throw contractError('EXECUTION_EVENT_WRITER_INVALID', `${value.type} must be written by ${expectedWriter}`);
  }
  if (!PHASES.has(value.phase)) throw contractError('EXECUTION_EVENT_INVALID', 'phase is invalid');
  if (options.phase && value.phase !== options.phase) throw contractError('EXECUTION_EVENT_PHASE_INVALID', 'event phase does not match current phase');
  if (!EVENT_PHASES[value.type].has(value.phase)) throw contractError('EXECUTION_EVENT_PHASE_INVALID', `${value.type} is not allowed during ${value.phase}`);
  if (value.turnId !== undefined) ensureId(value.turnId, 'turnId', 'EXECUTION_EVENT_INVALID');
  if (value.factId !== undefined) ensureId(value.factId, 'factId', 'EXECUTION_EVENT_INVALID');
  if (value.eventId !== undefined) ensureId(value.eventId, 'eventId', 'EXECUTION_EVENT_INVALID');

  switch (value.type) {
    case 'phaseChanged':
      if (!PHASES.has(value.from) || !PHASES.has(value.to) || value.from === value.to) throw contractError('EXECUTION_EVENT_INVALID', 'phaseChanged requires different valid from/to phases');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'operationStarted':
      ensureId(value.operationId, 'operationId', 'EXECUTION_EVENT_INVALID');
      if (!OPERATION_KINDS.has(value.kind)) throw contractError('EXECUTION_EVENT_INVALID', 'operation kind is invalid');
      break;
    case 'operationRejected':
      ensureId(value.operationId, 'operationId', 'EXECUTION_EVENT_INVALID');
      if (!OPERATION_KINDS.has(value.kind)) throw contractError('EXECUTION_EVENT_INVALID', 'operation kind is invalid');
      ensureString(value.failureCode, 'failureCode', 'EXECUTION_EVENT_INVALID');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      if (value.actionType !== undefined) ensureString(value.actionType, 'actionType', 'EXECUTION_EVENT_INVALID');
      if (value.relatedOperationId !== undefined) ensureId(value.relatedOperationId, 'relatedOperationId', 'EXECUTION_EVENT_INVALID');
      break;
    case 'operationCompleted':
      ensureId(value.operationId, 'operationId', 'EXECUTION_EVENT_INVALID');
      if (!OPERATION_OUTCOMES.has(value.outcome)) throw contractError('EXECUTION_EVENT_INVALID', 'operation outcome is invalid');
      if (value.actionType !== undefined) ensureString(value.actionType, 'actionType', 'EXECUTION_EVENT_INVALID');
      if (value.stateChanging !== undefined && typeof value.stateChanging !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', 'stateChanging must be boolean');
      break;
    case 'timeLimitReached':
      ensureString(value.deadlineAt, 'deadlineAt', 'EXECUTION_EVENT_INVALID');
      if (!Number.isFinite(Date.parse(value.deadlineAt))) throw contractError('EXECUTION_EVENT_INVALID', 'deadlineAt is invalid');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      if (value.pendingOperationId !== undefined) ensureId(value.pendingOperationId, 'pendingOperationId', 'EXECUTION_EVENT_INVALID');
      if (typeof value.observationUnavailable !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', 'observationUnavailable must be boolean');
      break;
    case 'observation':
      ensureId(value.operationId, 'operationId', 'EXECUTION_EVENT_INVALID');
      ensureInteger(value.warmSessionGeneration, 'warmSessionGeneration', 'EXECUTION_EVENT_INVALID', 1);
      ensureString(value.ref, 'ref', 'EXECUTION_EVENT_INVALID');
      ensureString(value.sha256, 'sha256', 'EXECUTION_EVENT_INVALID');
      if (!/^[0-9a-f]{64}$/.test(value.sha256)) throw contractError('EXECUTION_EVENT_INVALID', 'observation sha256 is invalid');
      if (!EVIDENCE_SCOPES.has(value.scope)) throw contractError('EXECUTION_EVENT_INVALID', 'observation scope is invalid');
      if (typeof value.usable !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', 'observation usable must be boolean');
      if (value.observationPurpose !== undefined) ensureString(value.observationPurpose, 'observationPurpose', 'EXECUTION_EVENT_INVALID');
      if (value.relatedOperationId !== undefined) ensureId(value.relatedOperationId, 'relatedOperationId', 'EXECUTION_EVENT_INVALID');
      if (value.intent !== undefined) ensureString(value.intent, 'intent', 'EXECUTION_EVENT_INVALID');
      if (value.expectedOutcome !== undefined) ensureString(value.expectedOutcome, 'expectedOutcome', 'EXECUTION_EVENT_INVALID');
      if (value.artifacts !== undefined) {
        ensureObject(value.artifacts, 'artifacts', 'EXECUTION_EVENT_INVALID');
        if (value.artifacts.screenshot !== undefined) ensureString(value.artifacts.screenshot, 'artifacts.screenshot', 'EXECUTION_EVENT_INVALID');
        if (value.artifacts.layout !== undefined && value.artifacts.layout !== null) ensureString(value.artifacts.layout, 'artifacts.layout', 'EXECUTION_EVENT_INVALID');
        if (value.artifacts.logs !== undefined) validateStringArray(value.artifacts.logs, 'artifacts.logs');
      }
      if (value.technicalSignals !== undefined) ensureObject(value.technicalSignals, 'technicalSignals', 'EXECUTION_EVENT_INVALID');
      if (value.scope === 'case-prepare') {
        if (value.startConditionId !== undefined) ensureId(value.startConditionId, 'startConditionId', 'EXECUTION_EVENT_INVALID');
        ensureInteger(value.understandingRevision, 'understandingRevision', 'EXECUTION_EVENT_INVALID', 1);
      }
      break;
    case 'actionResult':
      ensureId(value.operationId, 'operationId', 'EXECUTION_EVENT_INVALID');
      ensureInteger(value.warmSessionGeneration, 'warmSessionGeneration', 'EXECUTION_EVENT_INVALID', 1);
      if (!EVIDENCE_SCOPES.has(value.scope)) throw contractError('EXECUTION_EVENT_INVALID', 'actionResult scope is invalid');
      if (typeof value.ok !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', 'actionResult ok must be boolean');
      if (value.intent !== undefined) ensureString(value.intent, 'intent', 'EXECUTION_EVENT_INVALID');
      if (value.expectedOutcome !== undefined) ensureString(value.expectedOutcome, 'expectedOutcome', 'EXECUTION_EVENT_INVALID');
      if (value.scope === 'case-prepare') {
        if (value.startConditionId !== undefined) ensureId(value.startConditionId, 'startConditionId', 'EXECUTION_EVENT_INVALID');
        ensureInteger(value.understandingRevision, 'understandingRevision', 'EXECUTION_EVENT_INVALID', 1);
      }
      break;
    case 'startEstablished':
      ensureInteger(value.understandingRevision, 'understandingRevision', 'EXECUTION_EVENT_INVALID', 1);
      ensureInteger(value.warmSessionGeneration, 'warmSessionGeneration', 'EXECUTION_EVENT_INVALID', 1);
      ensureString(value.observationRef, 'observationRef', 'EXECUTION_EVENT_INVALID');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'caseUnderstood':
      ensureInteger(value.understandingRevision, 'understandingRevision', 'EXECUTION_EVENT_INVALID', 1);
      validateStringArray(value.sourceRefs, 'sourceRefs');
      break;
    case 'planRevised':
      ensureInteger(value.planRevision, 'planRevision', 'EXECUTION_EVENT_INVALID', 1);
      ensureString(value.planSha, 'planSha', 'EXECUTION_EVENT_INVALID');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'checkpointFinding':
      ensureId(value.checkpointId, 'checkpointId', 'EXECUTION_EVENT_INVALID');
      ensureInteger(value.planRevision, 'planRevision', 'EXECUTION_EVENT_INVALID', 1);
      validateStringArray(value.requirementRefs, 'requirementRefs');
      validateStringArray(value.evidenceRefs, 'evidenceRefs');
      ensureString(value.finding, 'finding', 'EXECUTION_EVENT_INVALID');
      break;
    case 'reflection':
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'knowledgeQuery':
      ensureId(value.queryId, 'queryId', 'EXECUTION_EVENT_INVALID');
      ensureObject(value.query, 'query', 'EXECUTION_EVENT_INVALID');
      const candidates = ensureArray(value.candidates, 'candidates', 'EXECUTION_EVENT_INVALID');
      candidates.forEach((candidate, index) => validateKnowledgeCandidate(candidate, `candidates[${index}]`));
      ensureInteger(value.matchCount, 'matchCount', 'EXECUTION_EVENT_INVALID', 0);
      if (value.matchCount !== candidates.length) throw contractError('EXECUTION_EVENT_INVALID', 'matchCount must equal candidates.length');
      break;
    case 'knowledgeAssessment':
      ensureId(value.queryId, 'queryId', 'EXECUTION_EVENT_INVALID');
      ensureString(value.knowledgeRef, 'knowledgeRef', 'EXECUTION_EVENT_INVALID');
      ensureId(value.entryId, 'entryId', 'EXECUTION_EVENT_INVALID');
      if (!['skill', 'workspace'].includes(value.sourceNamespace)) throw contractError('EXECUTION_EVENT_INVALID', 'sourceNamespace is invalid');
      ensureString(value.relativePath, 'relativePath', 'EXECUTION_EVENT_INVALID');
      ensureString(value.contentSha, 'contentSha', 'EXECUTION_EVENT_INVALID');
      if (!/^[0-9a-f]{64}$/.test(value.contentSha)) throw contractError('EXECUTION_EVENT_INVALID', 'contentSha is invalid');
      if (!KNOWLEDGE_ASSESSMENTS.has(value.assessment)) throw contractError('EXECUTION_EVENT_INVALID', 'knowledge assessment is invalid');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'knowledgeReview':
      ensureId(value.queryId, 'queryId', 'EXECUTION_EVENT_INVALID');
      if (!KNOWLEDGE_REVIEW_CONCLUSIONS.has(value.conclusion)) throw contractError('EXECUTION_EVENT_INVALID', 'knowledge review conclusion is invalid');
      validateStringArray(value.assessmentRefs, 'assessmentRefs');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'verdictReview':
      ensureInteger(value.understandingRevision, 'understandingRevision', 'EXECUTION_EVENT_INVALID', 1);
      ensureInteger(value.planRevision, 'planRevision', 'EXECUTION_EVENT_INVALID', 1);
      ensureString(value.planSha, 'planSha', 'EXECUTION_EVENT_INVALID');
      validateStringArray(value.requirementRefs, 'requirementRefs');
      if (value.requirementRefs.length === 0) throw contractError('EXECUTION_EVENT_INVALID', 'verdictReview requires at least one requirement reference');
      validateStringArray(value.queryRefs, 'queryRefs');
      if (value.queryRefs.length === 0 && ['FAIL', 'INCONCLUSIVE'].includes(value.requestedVerdict)) {
        throw contractError('EXECUTION_EVENT_INVALID', `${value.requestedVerdict} verdictReview requires at least one knowledge query reference`);
      }
      if (!VERDICTS.has(value.requestedVerdict)) throw contractError('EXECUTION_EVENT_INVALID', 'requestedVerdict is invalid');
      ensureObject(value.sourceRecheck, 'sourceRecheck', 'EXECUTION_EVENT_INVALID');
      validateStringArray(value.sourceRecheck.sourceRefs, 'sourceRecheck.sourceRefs');
      if (value.sourceRecheck.sourceRefs.length === 0) throw contractError('EXECUTION_EVENT_INVALID', 'sourceRecheck requires at least one source reference');
      ensureString(value.sourceRecheck.conclusion, 'sourceRecheck.conclusion', 'EXECUTION_EVENT_INVALID');
      validateStringArray(value.currentObservationRefs, 'currentObservationRefs');
      if (value.observationUnavailable !== undefined && typeof value.observationUnavailable !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', 'verdictReview observationUnavailable must be boolean');
      if (value.currentObservationRefs.length === 0 && value.observationUnavailable !== true) throw contractError('EXECUTION_EVENT_INVALID', 'verdictReview requires a current observation or an explicit unavailable state');
      ensureObject(value.recoveryAttempt, 'recoveryAttempt', 'EXECUTION_EVENT_INVALID');
      if (typeof value.recoveryAttempt.performed !== 'boolean') throw contractError('EXECUTION_EVENT_INVALID', 'recoveryAttempt.performed must be boolean');
      ensureString(value.recoveryAttempt.explanation, 'recoveryAttempt.explanation', 'EXECUTION_EVENT_INVALID');
      validateStringArray(value.recoveryAttempt.evidenceRefs, 'recoveryAttempt.evidenceRefs');
      validateStringArray(value.remainingUncertainties, 'remainingUncertainties');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'result':
      ensureString(value.resultSha, 'resultSha', 'EXECUTION_EVENT_INVALID');
      if (!VERDICTS.has(value.verdict)) throw contractError('EXECUTION_EVENT_INVALID', 'verdict is invalid');
      break;
    case 'runtimeIncident':
      ensureId(value.incidentId, 'incidentId', 'EXECUTION_EVENT_INVALID');
      ensureString(value.triggerType, 'triggerType', 'EXECUTION_EVENT_INVALID');
      if (!['PRODUCT', 'TECHNICAL'].includes(value.category)) throw contractError('EXECUTION_EVENT_INVALID', 'incident category is invalid');
      validateStringArray(value.evidenceRefs, 'evidenceRefs');
      ensureString(value.reason, 'reason', 'EXECUTION_EVENT_INVALID');
      break;
    case 'recoveryStarted':
      ensureId(value.recoveryId, 'recoveryId', 'EXECUTION_EVENT_INVALID');
      if (value.incidentId !== null) ensureId(value.incidentId, 'incidentId', 'EXECUTION_EVENT_INVALID');
      break;
    case 'recoveryCompleted':
      ensureId(value.recoveryId, 'recoveryId', 'EXECUTION_EVENT_INVALID');
      if (value.incidentId !== null) ensureId(value.incidentId, 'incidentId', 'EXECUTION_EVENT_INVALID');
      if (!['SUCCEEDED', 'FAILED'].includes(value.status)) throw contractError('EXECUTION_EVENT_INVALID', 'recovery status is invalid');
      ensureInteger(value.warmSessionGeneration, 'warmSessionGeneration', 'EXECUTION_EVENT_INVALID', 1);
      break;
    default:
      break;
  }
  return value;
}

module.exports = {
  EVENT_SCHEMA_VERSION,
  EVENT_PHASES,
  EVENT_WRITERS,
  EVIDENCE_SCOPES,
  KNOWLEDGE_ASSESSMENTS,
  KNOWLEDGE_REVIEW_CONCLUSIONS,
  OPERATION_KINDS,
  OPERATION_OUTCOMES,
  PHASES,
  validateExecutionEvent,
};

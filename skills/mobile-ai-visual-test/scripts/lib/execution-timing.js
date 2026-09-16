'use strict';

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(after, before) {
  const end = timestamp(after);
  const start = timestamp(before);
  return end !== null && start !== null && end >= start ? end - start : null;
}

function emptyPhases() {
  return {
    coordinatorPreparationMs: null,
    initialStatePreparationMs: null,
    handoffPreparationMs: null,
    handoffSchedulingMs: null,
    caseAgentPhaseMs: null,
    reportPublicationDelayMs: null,
  };
}

const PERSISTED_PHASE_FIELDS = Object.freeze([
  'coordinatorPreparationMs',
  'initialStatePreparationMs',
  'handoffPreparationMs',
  'handoffSchedulingMs',
  'caseAgentPhaseMs',
]);

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function publicationDelay(execution, publication) {
  if (!publication?.caseReportPublishedAt || !execution.endedAt) return null;
  const derived = duration(publication?.caseReportPublishedAt, execution.endedAt);
  if (derived === null) return null;
  if (hasOwn(publication, 'reportPublicationDelayMs')) {
    return Number.isFinite(publication.reportPublicationDelayMs) && publication.reportPublicationDelayMs >= 0
      ? publication.reportPublicationDelayMs
      : null;
  }
  return derived;
}

// This projection is read-only because execution and metrics are signed before report publication.
function deriveExecutionTiming(execution = {}, metrics = {}, publication = null) {
  const processingStartedAt = execution.caseProcessingStartedAt;
  const hasPersistedCaseTiming = hasOwn(metrics, 'caseTotalElapsedMs') || PERSISTED_PHASE_FIELDS.some((field) => hasOwn(metrics, field));
  if (hasPersistedCaseTiming) {
    const phases = emptyPhases();
    for (const field of PERSISTED_PHASE_FIELDS) phases[field] = hasOwn(metrics, field) ? metrics[field] : null;
    phases.reportPublicationDelayMs = publicationDelay(execution, publication);
    return {
      durationBasis: 'CASE_TOTAL',
      startedAt: processingStartedAt || execution.startedAt || '',
      durationMs: hasOwn(metrics, 'caseTotalElapsedMs') ? metrics.caseTotalElapsedMs : null,
      phases,
    };
  }
  if (!processingStartedAt) {
    const phases = emptyPhases();
    phases.reportPublicationDelayMs = publicationDelay(execution, publication);
    return {
      durationBasis: 'EXECUTION_TOTAL',
      startedAt: execution.startedAt || '',
      durationMs: Number.isFinite(metrics?.elapsedMs) ? metrics.elapsedMs : null,
      phases,
    };
  }
  const phases = emptyPhases();
  phases.coordinatorPreparationMs = duration(execution.startedAt, processingStartedAt);
  phases.initialStatePreparationMs = duration(execution.initialStateCompletedAt, execution.startedAt);
  if (execution.autoInitialStateBlocked !== true) {
    phases.handoffPreparationMs = duration(execution.handoffReadyAt, execution.initialStateCompletedAt);
    phases.handoffSchedulingMs = duration(execution.handoffConsumedAt, execution.handoffReadyAt);
    phases.caseAgentPhaseMs = duration(execution.endedAt, execution.handoffConsumedAt);
  }
  phases.reportPublicationDelayMs = publicationDelay(execution, publication);
  return {
    durationBasis: 'CASE_TOTAL',
    startedAt: processingStartedAt,
    durationMs: duration(execution.endedAt, processingStartedAt),
    phases,
  };
}

module.exports = { deriveExecutionTiming };

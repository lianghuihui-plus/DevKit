'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { canonicalJson } = require('../lib/contract-utils');
const jsonHash = value => require('crypto').createHash('sha256').update(canonicalJson(value)).digest('hex');

const FINAL_REVIEW_EVENT = 'caseFinalReviewRequired';

function sourceText(execDir) {
  return fs.readFileSync(path.join(path.resolve(execDir), 'source.snapshot.md'), 'utf8');
}

function requestFinalReview(execDir, options = {}) {
  if (store.events(execDir).some((event) => event.type === FINAL_REVIEW_EVENT)) return false;
  store.appendEvent(execDir, FINAL_REVIEW_EVENT, {
    reason: 'FINAL_CASE_REVIEW',
  }, options);
  return true;
}

function pendingCorrections(execDir) {
  const pending = new Map();
  for (const event of store.events(execDir)) {
    if (event.type === 'checkpointResultRejected') {
      for (const ref of event.checkNodeRefs) pending.set(ref, event.eventId);
    }
    if (event.type === 'checkpointResultCorrectionRecorded') {
      for (const ref of [...event.checkNodeRefs, '*']) pending.delete(ref);
    }
  }
  return [...pending].sort(([a], [b]) => a.localeCompare(b));
}

// Track rejected submissions, including MCP schema failures before translation.
// This records request facts only; it never interprets actual/reason/summary.
function noteRejected(execDir, request, options = {}) {
  if (request?.operation !== 'recordResult') return;
  const record = () => {
    if (store.loadExecution(execDir, { allowFinalized: true }).finalized) return;
    const known = new Set(require('./case-flow-service').checkpointRegistry(execDir).map(point => point.ref));
    const refs = Array.isArray(request.input?.results)
      ? request.input.results.map(item => item?.checkNodeRef).filter(ref => known.has(ref)) : [];
    store.appendEvent(execDir, 'checkpointResultRejected', { checkNodeRefs: [...new Set(refs.length ? refs : ['*'])] }, options);
  };
  return options.lockHeld ? record() : store.withRuntimeLock(execDir, record, options);
}

function noteRecorded(execDir, request, options = {}) {
  const pending = pendingCorrections(execDir);
  if (!pending.length) return;
  store.appendEvent(execDir, 'checkpointResultCorrectionRecorded', {
    checkNodeRefs: request.input.results.map(item => item.checkNodeRef),
  }, options);
}

function snapshot(execDir, mode = 'complete', state = {}) {
  const service = require('./expectation-result-service');
  const ledger = state.ledger || service.currentLedger(execDir);
  const readiness = state.readiness || service.finishReadiness(execDir);
  const pending = pendingCorrections(execDir);
  const ledgerVerdict = mode === 'notRun' ? 'NOT_RUN'
    : readiness.ready ? require('./result-integrity').aggregateVerdict(Object.values(ledger).map(item => item.result)) : null;
  const value = {
    executionId: store.loadExecution(execDir, { allowFinalized: true }).executionId,
    sourceHash: jsonHash(sourceText(execDir)), mode,
    caseFlowRevision: state.caseFlowRevision ?? require('./case-flow-service').current(execDir)?.revision ?? null,
    results: Object.entries(ledger).map(([ref, item]) => [ref, item.semanticHash, item.result?.resultUpdateId || null]),
    readiness, pending,
  };
  return { finalReviewToken: jsonHash(value), ledgerVerdict, pendingCheckNodeRefs: pending.map(([ref]) => ref) };
}

function gate(execDir, request, options = {}) {
  const current = snapshot(execDir, request.input.mode);
  const first = requestFinalReview(execDir, options);
  let code;
  if (current.pendingCheckNodeRefs.length) code = 'RESULT_CORRECTION_REQUIRED';
  else if (first || !request.input.finalReview || request.input.finalReview.token !== current.finalReviewToken) code = 'CASE_FINAL_REVIEW_REQUIRED';
  else if (request.input.finalReview.verdict !== current.ledgerVerdict) code = 'CASE_FINAL_VERDICT_MISMATCH';
  if (code) return { status: 'RESULT_INCOMPLETE', code };
  store.appendEvent(execDir, 'caseFinalReviewConfirmed', {
    token: current.finalReviewToken, verdict: request.input.finalReview.verdict, sourceCoverageConfirmed: true,
  }, options);
  return null;
}

module.exports = { FINAL_REVIEW_EVENT, requestFinalReview, sourceText, pendingCorrections, noteRejected, noteRecorded, snapshot, gate };

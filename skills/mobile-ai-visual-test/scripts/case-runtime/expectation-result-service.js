'use strict';

const crypto = require('crypto');
const path = require('path');
const { canonicalJson, contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');
const { readJson } = require('../lib/execution-lifecycle');
const { technicalFacts, technicalFactState } = require('../lib/technical-facts');
const store = require('./store');

const STATUSES = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);

function normalizeExpectationText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function expectationSemanticHash(text) {
  const input = canonicalJson({ text: normalizeExpectationText(text) });
  return `expectation-semantic-${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function activeExpectations(execDir, model = null) {
  const current = model || require('./case-model-service').current(execDir);
  return new Map((current?.verificationPoints || []).filter((item) => item.status !== 'RETIRED')
    .map((item) => [item.ref, { ...item, semanticHash: expectationSemanticHash(item.text) }]));
}

function normalizeStringRefs(value, field) {
  if (value === undefined) return [];
  return ensureArray(value, field, 'EXPECTATION_RESULT_INVALID')
    .map((item, index) => ensureString(item, `${field}[${index}]`, 'EXPECTATION_RESULT_INVALID').trim());
}

function normalizeEvidence(value, index) {
  if (value === undefined) return { sceneRefs: [], knowledgeRefs: [], technicalRefs: [] };
  const evidence = ensureObject(value, `expectationResults[${index}].evidence`, 'EXPECTATION_RESULT_INVALID');
  const allowed = new Set(['sceneRefs', 'knowledgeRefs', 'technicalRefs', 'searchAbsence']);
  const unsupported = Object.keys(evidence).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('EXPECTATION_RESULT_INVALID', `evidence contains unsupported fields: ${unsupported.join(', ')}`);
  let evidenceBasis;
  if (evidence.searchAbsence !== undefined) {
    const search = ensureObject(evidence.searchAbsence, 'evidence.searchAbsence', 'EXPECTATION_RESULT_INVALID');
    evidenceBasis = {
      type: 'SEARCH_ABSENCE',
      sceneRef: ensureString(search.sceneRef, 'evidence.searchAbsence.sceneRef', 'EXPECTATION_RESULT_INVALID'),
      scrollContextRef: ensureString(search.scrollContextRef, 'evidence.searchAbsence.scrollContextRef', 'EXPECTATION_RESULT_INVALID'),
    };
  }
  return {
    sceneRefs: [...new Set(normalizeStringRefs(evidence.sceneRefs, 'evidence.sceneRefs'))],
    knowledgeRefs: [...new Set(normalizeStringRefs(evidence.knowledgeRefs, 'evidence.knowledgeRefs'))],
    technicalRefs: [...new Set(normalizeStringRefs(evidence.technicalRefs, 'evidence.technicalRefs'))],
    ...(evidenceBasis ? { evidenceBasis } : {}),
  };
}

function validateEvidenceRefs(execDir, evidence, expectationRef, status) {
  const events = store.events(execDir);
  const knownScenes = new Set([
    ...events.filter((event) => event.type === 'sceneObserved').map((event) => event.sceneId),
    ...fsSceneIds(execDir),
  ]);
  const unknownScenes = evidence.sceneRefs.filter((ref) => !knownScenes.has(ref));
  if (evidence.evidenceBasis && !knownScenes.has(evidence.evidenceBasis.sceneRef)) unknownScenes.push(evidence.evidenceBasis.sceneRef);
  if (unknownScenes.length) throw contractError('EVIDENCE_REFERENCE_INVALID', `unknown Scene refs: ${[...new Set(unknownScenes)].join(', ')}`);
  const knownTechnical = new Set(events.filter((event) => event.technicalFactRef).map((event) => event.technicalFactRef));
  const unknownTechnical = evidence.technicalRefs.filter((ref) => !knownTechnical.has(ref));
  if (unknownTechnical.length) throw contractError('EVIDENCE_REFERENCE_INVALID', `unknown technical refs: ${unknownTechnical.join(', ')}`);
  const applicable = require('./knowledge-review').buildKnowledgeIndex(events)
    .applicableByExpectation.get(expectationRef) || new Set();
  const invalidKnowledge = evidence.knowledgeRefs.filter((ref) => !applicable.has(ref));
  if (invalidKnowledge.length) {
    throw contractError('EVIDENCE_REFERENCE_INVALID', `knowledge refs are not applicable to ${expectationRef}: ${invalidKnowledge.join(', ')}`);
  }
  if (status !== 'BLOCKED' && evidence.technicalRefs.length) {
    throw contractError('EVIDENCE_REFERENCE_INVALID', 'technical refs are only valid for BLOCKED results');
  }
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const technicalByRef = new Map(technicalFacts(events)
    .filter((event) => event.technicalFactRef)
    .map((event) => [event.technicalFactRef, event]));
  const invalidTechnical = evidence.technicalRefs.filter((ref) => (
    technicalFactState(technicalByRef.get(ref), events, execution, expectationRef).state !== 'VALID'
  ));
  if (invalidTechnical.length) {
    throw contractError('EVIDENCE_REFERENCE_INVALID', `technical refs are not valid for ${expectationRef}: ${invalidTechnical.join(', ')}`);
  }
}

function fsSceneIds(execDir) {
  const fs = require('fs');
  const directory = store.paths(execDir).scenes;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
}

function prepareExpectationResults(execDir, values, options = {}) {
  const list = ensureArray(values || [], 'expectationResults', 'EXPECTATION_RESULT_INVALID');
  const expectations = activeExpectations(execDir, options.caseModel);
  const seen = new Set();
  return list.map((value, index) => {
    const input = ensureObject(value, `expectationResults[${index}]`, 'EXPECTATION_RESULT_INVALID');
    const allowed = new Set(['expectationRef', 'status', 'actual', 'evidence']);
    const unsupported = Object.keys(input).filter((field) => !allowed.has(field));
    if (unsupported.length) throw contractError('EXPECTATION_RESULT_INVALID', `expectation result contains unsupported fields: ${unsupported.join(', ')}`);
    const expectationRef = ensureString(input.expectationRef, `expectationResults[${index}].expectationRef`, 'EXPECTATION_RESULT_INVALID').trim();
    if (!expectations.has(expectationRef)) throw contractError('EXPECTATION_UNKNOWN', `unknown active expectation ${expectationRef}`);
    if (seen.has(expectationRef)) throw contractError('EXPECTATION_RESULT_INVALID', `duplicate expectation result ${expectationRef}`);
    seen.add(expectationRef);
    if (!STATUSES.has(input.status)) throw contractError('EXPECTATION_RESULT_INVALID', `invalid status for ${expectationRef}`);
    const evidence = normalizeEvidence(input.evidence, index);
    validateEvidenceRefs(execDir, evidence, expectationRef, input.status);
    return {
      expectationRef,
      status: input.status,
      actual: ensureString(input.actual, `expectationResults[${index}].actual`, 'EXPECTATION_RESULT_INVALID').trim(),
      evidence,
      expectationSemanticHash: expectations.get(expectationRef).semanticHash,
    };
  });
}

function resultEvents(execDir) {
  return store.events(execDir).filter((event) => event.type === 'expectationResultUpdated');
}

function invalidatedIds(execDir) {
  return new Set(store.events(execDir).filter((event) => event.type === 'expectationResultInvalidated')
    .map((event) => event.resultUpdateId).filter(Boolean));
}

function currentResultFor(execDir, expectationRef, semanticHash) {
  const invalid = invalidatedIds(execDir);
  return resultEvents(execDir).filter((event) => event.expectationRef === expectationRef
    && event.expectationSemanticHash === semanticHash && !invalid.has(event.resultUpdateId)).at(-1) || null;
}

function checkClosure(execDir, result) {
  if (!result) return ['RESULT_MISSING'];
  const reasons = [];
  const events = store.events(execDir);
  if (['PASS', 'FAIL'].includes(result.status) && !(result.evidence?.sceneRefs || []).length) reasons.push('EVIDENCE_REQUIRED');
  const inspected = new Set(events.filter((event) => event.type === 'visualInspected').map((event) => event.sceneId));
  if ((result.evidence?.sceneRefs || []).some((ref) => !inspected.has(ref))) reasons.push('VISUAL_INSPECTION_REQUIRED');
  const needsKnowledge = result.status === 'FAIL' || result.status === 'INCONCLUSIVE'
    || (result.status === 'BLOCKED' && !(result.evidence?.technicalRefs || []).length);
  if (needsKnowledge) {
    const queries = events.filter((event) => event.type === 'knowledgeQueried'
      && (event.expectationRefs || []).includes(result.expectationRef));
    const reviewed = new Set(events.filter((event) => event.type === 'knowledgeReviewed').map((event) => event.queryId));
    if (!queries.some((event) => reviewed.has(event.queryId))) reasons.push('KNOWLEDGE_REQUIRED');
  }
  if (result.evidence?.evidenceBasis) {
    const scene = require('../lib/execution-lifecycle').readJson(
      require('path').join(store.paths(execDir).scenes, `${result.evidence.evidenceBasis.sceneRef}.json`), null,
    );
    const context = (scene?.scrollContexts || []).find((item) => item.id === result.evidence.evidenceBasis.scrollContextRef);
    if (!context?.absenceConclusionSupported) reasons.push('SEARCH_COVERAGE_REQUIRED');
  }
  return [...new Set(reasons)];
}

function commitPreparedResults(execDir, prepared, options = {}) {
  const updated = [];
  const idempotent = [];
  for (const item of prepared) {
    const existing = currentResultFor(execDir, item.expectationRef, item.expectationSemanticHash);
    if (existing && canonicalJson({ status: existing.status, actual: existing.actual, evidence: existing.evidence })
      === canonicalJson({ status: item.status, actual: item.actual, evidence: item.evidence })) {
      idempotent.push(item.expectationRef);
      continue;
    }
    const resultUpdateId = store.nextId(execDir, 'resultUpdate');
    const closure = checkClosure(execDir, item);
    store.appendEvent(execDir, 'expectationResultUpdated', {
      resultUpdateId,
      submissionId: options.submissionId || null,
      expectationRef: item.expectationRef,
      status: item.status,
      actual: item.actual,
      evidence: item.evidence,
      expectationSemanticHash: item.expectationSemanticHash,
      closure: { state: closure.length ? 'UNRESOLVED' : 'RESOLVED', reasons: closure },
      decisionId: options.decisionId || null,
      basedOnSceneRef: options.basedOnSceneRef || null,
    }, options);
    updated.push(item.expectationRef);
  }
  return { updated, idempotent };
}

function applyExpectationResults(execDir, values, options = {}) {
  return commitPreparedResults(execDir, prepareExpectationResults(execDir, values, options), options);
}

function invalidateForCaseModelChange(execDir, previous, next, options = {}) {
  if (!previous) return [];
  const nextByRef = new Map((next.verificationPoints || []).map((item) => [item.ref, item]));
  const invalidated = [];
  for (const oldPoint of previous.verificationPoints || []) {
    const nextPoint = nextByRef.get(oldPoint.ref);
    const reason = !nextPoint ? 'EXPECTATION_RETIRED'
      : expectationSemanticHash(oldPoint.text) !== expectationSemanticHash(nextPoint.text) ? 'SEMANTICS_CHANGED' : null;
    if (!reason) continue;
    const latest = currentResultFor(execDir, oldPoint.ref, expectationSemanticHash(oldPoint.text));
    if (!latest) continue;
    const duplicate = store.events(execDir).some((event) => event.type === 'expectationResultInvalidated'
      && event.submissionId === (options.submissionId || null)
      && event.resultUpdateId === latest.resultUpdateId && event.reason === reason);
    if (duplicate) {
      invalidated.push(oldPoint.ref);
      continue;
    }
    store.appendEvent(execDir, 'expectationResultInvalidated', {
      submissionId: options.submissionId || null,
      resultUpdateId: latest.resultUpdateId,
      expectationRef: oldPoint.ref,
      reason,
      previousSemanticHash: expectationSemanticHash(oldPoint.text),
      nextSemanticHash: nextPoint ? expectationSemanticHash(nextPoint.text) : null,
    }, options);
    invalidated.push(oldPoint.ref);
  }
  return invalidated;
}

function currentLedger(execDir) {
  const expectations = activeExpectations(execDir);
  return Object.fromEntries([...expectations].map(([ref, point]) => {
    const result = currentResultFor(execDir, ref, point.semanticHash);
    return [ref, { expectationRef: ref, text: point.text, semanticHash: point.semanticHash, result, reasons: checkClosure(execDir, result) }];
  }));
}

function conflictCodes(execDir, item) {
  if (!item.result) return [];
  const events = store.events(execDir);
  const codes = [];
  const sceneEvents = new Map(events.filter((event) => event.type === 'sceneObserved')
    .map((event) => [event.sceneId, event]));
  for (const sceneRef of item.result.evidence?.sceneRefs || []) {
    const event = sceneEvents.get(sceneRef);
    const scene = readJson(path.join(store.paths(execDir).scenes, `${sceneRef}.json`), null);
    if (!event || !scene || scene.sceneId !== sceneRef
      || scene.screenshot?.ref !== event.screenshotRef
      || scene.screenshot?.sha256 !== event.screenshotSha256
      || canonicalJson(scene.app || null) !== canonicalJson(event.app || null)) {
      codes.push('SCENE_EVIDENCE_CHANGED');
      break;
    }
  }
  const applicable = require('./knowledge-review').buildKnowledgeIndex(events)
    .applicableByExpectation.get(item.expectationRef) || new Set();
  if ((item.result.evidence?.knowledgeRefs || []).some((ref) => !applicable.has(ref))) {
    codes.push('KNOWLEDGE_REFERENCE_INVALIDATED');
  }
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const technicalByRef = new Map(technicalFacts(events)
    .filter((event) => event.technicalFactRef)
    .map((event) => [event.technicalFactRef, event]));
  if ((item.result.evidence?.technicalRefs || []).some((ref) => (
    !technicalByRef.has(ref)
    || technicalFactState(technicalByRef.get(ref), events, execution, item.expectationRef).state !== 'VALID'
  ))) codes.push('TECHNICAL_FACT_NO_LONGER_VALID');
  if (item.result.status !== 'BLOCKED' && (item.result.evidence?.technicalRefs || []).length) {
    codes.push('RESULT_STATUS_EVIDENCE_CONFLICT');
  }
  return [...new Set(codes)];
}

function finishReadiness(execDir) {
  const ledger = currentLedger(execDir);
  const conflicts = Object.values(ledger).map((item) => ({
    expectationRef: item.expectationRef,
    codes: conflictCodes(execDir, item),
  })).filter((item) => item.codes.length);
  const conflicted = new Set(conflicts.map((item) => item.expectationRef));
  const unresolved = Object.values(ledger).filter((item) => item.reasons.length)
    .map((item) => ({ expectationRef: item.expectationRef, reasons: item.reasons }));
  const resolved = Object.values(ledger).filter((item) => !item.reasons.length && !conflicted.has(item.expectationRef))
    .map((item) => item.expectationRef);
  const noModel = Object.keys(ledger).length === 0;
  return { ready: !noModel && unresolved.length === 0 && conflicts.length === 0, resolved, unresolved, conflicts };
}

function caseStateSummary(execDir) {
  const model = require('./case-model-service').current(execDir);
  const readiness = finishReadiness(execDir);
  return {
    caseModelRevision: model?.revision || null,
    expectations: {
      active: (model?.verificationPoints || []).length,
      resolved: readiness.resolved.length,
      unresolved: readiness.unresolved.map((item) => item.expectationRef),
      conflicts: readiness.conflicts.map((item) => item.expectationRef),
    },
  };
}

function buildCaseResultFromLedger(execDir, values) {
  const readiness = finishReadiness(execDir);
  if (!readiness.ready) throw contractError('CASE_RESULT_INCOMPLETE', 'Expectation ledger is incomplete', { readiness });
  const model = require('./case-model-service').current(execDir);
  const ledger = currentLedger(execDir);
  const checks = model.verificationPoints.map((point) => {
    const result = ledger[point.ref].result;
    return {
      expectationRef: point.ref,
      status: result.status,
      actual: result.actual,
      ...(result.evidence.sceneRefs.length ? { sceneRefs: result.evidence.sceneRefs } : {}),
      ...(result.evidence.knowledgeRefs.length ? { knowledgeRefs: result.evidence.knowledgeRefs } : {}),
      ...(result.evidence.technicalRefs.length ? { technicalRefs: result.evidence.technicalRefs } : {}),
      ...(result.evidence.evidenceBasis ? { evidenceBasis: result.evidence.evidenceBasis } : {}),
    };
  });
  return {
    verdict: require('./result-integrity').aggregateVerdict(checks),
    summary: ensureString(values.summary, 'summary', 'CASE_RESULT_INVALID'),
    checks,
    uncertainties: values.uncertainties || [],
    caseModelRevision: model.revision,
  };
}

module.exports = {
  applyExpectationResults,
  buildCaseResultFromLedger,
  caseStateSummary,
  commitPreparedResults,
  currentLedger,
  expectationSemanticHash,
  finishReadiness,
  invalidateForCaseModelChange,
  normalizeExpectationText,
  prepareExpectationResults,
};

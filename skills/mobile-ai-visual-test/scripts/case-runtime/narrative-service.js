'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');
const { validateCaseSpec } = require('../execution/contracts/case-spec-contract');
const { validateCaseContext, validateDecision } = require('./contract');
const store = require('./store');

function stringList(value, label) {
  return ensureArray(value, label, 'CASE_NARRATIVE_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_NARRATIVE_INVALID').trim());
}

function contextEvents(execDir) {
  return store.events(execDir).filter((event) => event.type === 'caseContextRecorded');
}

function decisionEvents(execDir) {
  return store.events(execDir).filter((event) => event.type === 'agentDecisionRecorded');
}

function latestCaseContext(execDir) {
  return contextEvents(execDir).at(-1)?.caseContext || null;
}

function nextExpectationId(expectations) {
  const largest = expectations.map((item) => Number(String(item.id || '').match(/^E(\d+)$/)?.[1] || 0))
    .reduce((max, value) => Math.max(max, value), 0);
  return `E${largest + 1}`;
}

function normalizeExpectations(value, previous = null) {
  const items = ensureArray(value, 'caseContext.expectations', 'CASE_NARRATIVE_INVALID');
  if (!items.length) throw contractError('CASE_NARRATIVE_INVALID', 'caseContext.expectations must contain at least one item');
  const previousItems = previous?.expectations || [];
  const used = [];
  for (const [index, item] of items.entries()) {
    const text = typeof item === 'string'
      ? ensureString(item, `caseContext.expectations[${index}]`, 'CASE_NARRATIVE_INVALID').trim()
      : ensureString(ensureObject(item, `caseContext.expectations[${index}]`, 'CASE_NARRATIVE_INVALID').text,
        `caseContext.expectations[${index}].text`, 'CASE_NARRATIVE_INVALID').trim();
    if (used.some((entry) => entry.text === text)) throw contractError('CASE_NARRATIVE_INVALID', `duplicate expectation: ${text}`);
    const explicitId = typeof item === 'object' && item ? String(item.id || '').trim() : '';
    const verificationKind = typeof item === 'object' && item?.verificationKind
      ? item.verificationKind : 'DIRECT_OBSERVATION';
    const previousId = previousItems.find((entry) => entry.text === text)?.id || '';
    let id = explicitId || previousId || nextExpectationId([...previousItems, ...used]);
    if (!/^E\d+$/.test(id) || used.some((entry) => entry.id === id)) id = nextExpectationId([...previousItems, ...used]);
    used.push({ id, text, verificationKind });
  }
  return used;
}

function frozenCaseSpec(execDir) {
  const spec = require('../lib/execution-lifecycle').readJson(path.join(execDir, 'case-spec.snapshot.json'), null);
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  const sourceText = fs.readFileSync(path.join(execDir, 'source.snapshot.md'), 'utf8');
  return validateCaseSpec(spec, { sourceText, sourceSha: execution.sourceSha });
}

function normalizeCaseContext(value, previous = null, spec = null) {
  validateCaseContext(value);
  const fixed = spec ? {
    summary: spec.summary,
    preconditions: spec.preconditions,
    expectations: spec.expectations.map(({ id, text, verificationKind }) => ({ id, text, verificationKind })),
  } : null;
  const suppliedExpectations = normalizeExpectations(value.expectations, fixed || previous);
  if (fixed && (value.summary.trim() !== fixed.summary
    || canonicalJson(stringList(value.preconditions || [], 'caseContext.preconditions')) !== canonicalJson(fixed.preconditions)
    || canonicalJson(suppliedExpectations) !== canonicalJson(fixed.expectations))) {
    throw contractError('CASE_SPEC_IMMUTABLE', 'caseContext cannot replace the frozen CaseSpec summary, preconditions, or expectations');
  }
  return {
    summary: fixed?.summary || ensureString(value.summary, 'caseContext.summary', 'CASE_NARRATIVE_INVALID').trim(),
    preconditions: fixed?.preconditions || stringList(value.preconditions || [], 'caseContext.preconditions'),
    expectations: fixed?.expectations || suppliedExpectations,
    initialPlan: stringList(value.initialPlan || [], 'caseContext.initialPlan'),
    uncertainties: stringList(value.uncertainties || [], 'caseContext.uncertainties'),
  };
}

function normalizeDecision(value, context) {
  validateDecision(value);
  const decision = {
    assessment: ensureString(value.assessment || value.conclusion || value.observation || value.purpose, 'decision.assessment', 'CASE_NARRATIVE_INVALID').trim(),
    observation: ensureString(value.observation || value.assessment || value.purpose, 'decision.observation', 'CASE_NARRATIVE_INVALID').trim(),
    conclusion: ensureString(value.conclusion || value.assessment || value.purpose, 'decision.conclusion', 'CASE_NARRATIVE_INVALID').trim(),
    purpose: ensureString(value.purpose, 'decision.purpose', 'CASE_NARRATIVE_INVALID').trim(),
    expectedOutcome: ensureString(value.expectedOutcome || value.purpose, 'decision.expectedOutcome', 'CASE_NARRATIVE_INVALID').trim(),
    expectationRefs: stringList(value.expectationRefs || [], 'decision.expectationRefs'),
  };
  const known = new Set((context?.expectations || []).map((item) => item.id));
  const unknown = decision.expectationRefs.filter((ref) => !known.has(ref));
  if (unknown.length) throw contractError('CASE_NARRATIVE_INVALID', `decision references unknown expectations: ${unknown.join(', ')}`);
  if (value.planUpdate !== undefined) {
    const update = ensureObject(value.planUpdate, 'decision.planUpdate', 'CASE_NARRATIVE_INVALID');
    decision.planUpdate = {
      reason: ensureString(update.reason, 'decision.planUpdate.reason', 'CASE_NARRATIVE_INVALID').trim(),
      next: stringList(update.next, 'decision.planUpdate.next'),
    };
  }
  if (value.knowledgeReview !== undefined) {
    decision.knowledgeReview = require('./knowledge-review').normalizeKnowledgeReview(value.knowledgeReview);
  }
  if (value.uncertainties !== undefined) decision.uncertainties = stringList(value.uncertainties, 'decision.uncertainties');
  return decision;
}

function appendGap(execDir, request, error, fields, options = {}) {
  const missingFields = fields?.length ? fields : [error?.fieldPath || 'narrative'];
  const event = store.appendEvent(execDir, 'narrativeGap', {
    operation: request.operation,
    sceneId: store.readCurrentScene(execDir)?.sceneId || null,
    code: error?.code || 'CASE_NARRATIVE_MISSING',
    message: error?.message || 'Agent did not provide the business narrative for this request',
    fields: missingFields,
  }, options);
  return { code: event.code, message: event.message, fields: event.fields };
}

function shouldRecordGap(request, hasContextBefore, acceptedInitialContext) {
  return false;
}

function recordRequestNarrative(execDir, request, options = {}) {
  const warnings = [];
  let context = latestCaseContext(execDir);
  const hasContextBefore = Boolean(context);
  let contextEvent = null;
  if (request.caseContext !== undefined) {
    try {
      const normalized = normalizeCaseContext(request.caseContext, context, frozenCaseSpec(execDir));
      if (!context || canonicalJson(normalized) !== canonicalJson(context)) {
        const version = contextEvents(execDir).length + 1;
        contextEvent = store.appendEvent(execDir, 'caseContextRecorded', {
          contextVersion: version,
          reason: version === 1 ? 'INITIAL_UNDERSTANDING' : String(request.caseContext.revisionReason || 'AGENT_UPDATED_CONTEXT'),
          caseContext: normalized,
        }, options);
      }
      context = normalized;
      if (contextEvent && normalized.initialPlan.length === 0) {
        warnings.push(appendGap(execDir, request, {
          code: 'CASE_INITIAL_PLAN_MISSING',
          message: 'Agent provided an empty initial execution plan',
        }, ['caseContext.initialPlan'], options));
      }
    } catch (error) {
      warnings.push(appendGap(execDir, request, error, [error.fieldPath || 'caseContext'], options));
    }
  }

  let decisionEvent = null;
  if (request.decision !== undefined) {
    try {
      const decision = normalizeDecision(request.decision, context);
      decisionEvent = store.appendEvent(execDir, 'agentDecisionRecorded', {
        decisionId: store.nextId(execDir, 'decision'),
        requestedOperation: request.operation,
        sceneId: store.readCurrentScene(execDir)?.sceneId || null,
        contextVersion: contextEvents(execDir).at(-1)?.contextVersion || null,
        decision,
      }, options);
      if (decision.knowledgeReview) {
        require('./knowledge-review').recordKnowledgeReview(execDir, decision.knowledgeReview, decisionEvent, options);
      }
    } catch (error) {
      if (request.operation === 'act') throw error;
      warnings.push(appendGap(execDir, request, error, [error.fieldPath || 'decision'], options));
    }
  } else if (shouldRecordGap(request, hasContextBefore, Boolean(contextEvent && context))) {
    warnings.push(appendGap(execDir, request, null, [context ? 'decision' : 'caseContext'], options));
  }

  return { contextEvent, decisionEvent, warnings, ...narrativeStatus(execDir) };
}

function narrativeStatus(execDir) {
  const events = store.events(execDir);
  const contexts = events.filter((event) => event.type === 'caseContextRecorded');
  const decisions = events.filter((event) => event.type === 'agentDecisionRecorded');
  const context = contexts.at(-1)?.caseContext || null;
  const gaps = events.filter((event) => event.type === 'narrativeGap');
  const reviewedQueries = new Set(events.filter((event) => event.type === 'knowledgeReviewed').map((event) => event.queryId));
  const hasUnreviewedKnowledge = events.some((event) => event.type === 'knowledgeQueried' && !reviewedQueries.has(event.queryId));
  let plan = null;
  for (const event of events) {
    if (event.type === 'caseContextRecorded' && event.caseContext?.initialPlan?.length) {
      plan = { version: (plan?.version || 0) + 1, reason: event.reason, items: event.caseContext.initialPlan };
    } else if (event.type === 'agentDecisionRecorded' && event.decision?.planUpdate) {
      plan = { version: (plan?.version || 0) + 1, reason: event.decision.planUpdate.reason, items: event.decision.planUpdate.next };
    }
  }
  return {
    caseContext: context,
    contextVersion: contexts.at(-1)?.contextVersion || null,
    latestPlan: plan,
    lastDecision: decisions.at(-1) || null,
    recordingStatus: !context ? 'UNAVAILABLE'
      : gaps.length || !(plan?.items || []).length || hasUnreviewedKnowledge ? 'PARTIAL' : 'COMPLETE',
    narrativeGapCount: gaps.length,
  };
}

module.exports = {
  latestCaseContext,
  narrativeStatus,
  normalizeCaseContext,
  normalizeDecision,
  recordRequestNarrative,
};

'use strict';

const { contractError, ensureArray, ensureString } = require('../lib/contract-utils');
const { validateDecision } = require('./contract');
const store = require('./store');

const DECISION_SOURCE_FIELDS = Object.freeze([
  'assessment', 'observation', 'conclusion', 'purpose', 'expectedOutcome',
  'expectationRefs', 'knowledgeReview', 'uncertainties',
]);

function stringList(value, label) {
  return ensureArray(value, label, 'CASE_NARRATIVE_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_NARRATIVE_INVALID').trim());
}

function decisionEvents(execDir) {
  return store.events(execDir).filter((event) => event.type === 'agentDecisionRecorded');
}

function latestCaseContext(execDir) {
  const flow = require('./case-flow-service').current(execDir);
  if (flow) return {
    summary: flow.summary,
    preconditions: [],
    expectations: flow.nodes.filter((item) => item.type === 'CHECK').map((item) => ({
      id: item.ref,
      text: item.text,
      verificationKind: item.verificationKind,
      sourceBasis: item.sourceBasis,
    })),
    initialPlan: flow.nodes.map((item) => `${item.ref} ${item.type}: ${item.text}`),
    uncertainties: flow.uncertainties,
  };
  return null;
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
  if (value.knowledgeReview !== undefined) {
    decision.knowledgeReview = require('./knowledge-review').normalizeKnowledgeReview(value.knowledgeReview);
  }
  if (value.uncertainties !== undefined) decision.uncertainties = stringList(value.uncertainties, 'decision.uncertainties');
  return decision;
}

function decisionFieldSources(value) {
  return Object.fromEntries(DECISION_SOURCE_FIELDS.map((field) => [
    field,
    Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined
      ? 'AGENT_AUTHORED'
      : 'NOT_PROVIDED',
  ]));
}

function recordRequestNarrative(execDir, request, options = {}) {
  const context = latestCaseContext(execDir);
  let decisionEvent = null;
  if (request.decision !== undefined) {
    const fieldSources = decisionFieldSources(request.decision);
    const decision = normalizeDecision(request.decision, context);
    if (decision.knowledgeReview) require('./knowledge-review').validateKnowledgeReview(execDir, decision.knowledgeReview);
    decisionEvent = store.appendEvent(execDir, 'agentDecisionRecorded', {
      decisionId: store.nextId(execDir, 'decision'),
      requestedOperation: request.operation,
      sceneId: store.readCurrentScene(execDir)?.sceneId || null,
      contextVersion: require('./case-flow-service').currentRevision(execDir),
      decision,
      decisionFieldSources: fieldSources,
    }, options);
    if (decision.knowledgeReview) {
      require('./knowledge-review').recordKnowledgeReview(execDir, decision.knowledgeReview, decisionEvent, options);
    }
  }
  return { contextEvent: null, decisionEvent, warnings: [], ...narrativeStatus(execDir) };
}

function narrativeStatus(execDir) {
  const events = store.events(execDir);
  const decisions = decisionEvents(execDir);
  const caseFlow = require('./case-flow-service').current(execDir);
  const context = latestCaseContext(execDir);
  const reviewedQueries = new Set(events.filter((event) => event.type === 'knowledgeReviewed').map((event) => event.queryId));
  const hasUnreviewedKnowledge = events.some((event) => event.type === 'knowledgeQueried' && !reviewedQueries.has(event.queryId));
  const plan = caseFlow
    ? { version: caseFlow.revision, reason: caseFlow.reason, nodes: caseFlow.nodes, edges: caseFlow.edges }
    : null;
  return {
    caseContext: context,
    caseFlow,
    contextVersion: caseFlow?.revision || null,
    latestPlan: plan,
    lastDecision: decisions.at(-1) || null,
    recordingStatus: !context ? 'UNAVAILABLE' : !plan || hasUnreviewedKnowledge ? 'PARTIAL' : 'COMPLETE',
    narrativeGapCount: 0,
  };
}

module.exports = { latestCaseContext, narrativeStatus, normalizeDecision, recordRequestNarrative };

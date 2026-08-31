'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureId } = require('../lib/contract-utils');
const { contentSha, normalizeQuery, queryKnowledge } = require('../lib/knowledge-query');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');
const { atomicWrite, readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const {
  assertNoOperationRecovery,
  assertNoTurnRecovery,
  currentObservation,
  knowledgeQueryDraftIds,
  latestStateChangeIndex,
  recordKnowledgeQuery,
  timelineEvents,
} = require('../execution/core');
const { validateKnowledgeCandidateSnapshot } = require('../lib/knowledge-snapshot');
const {
  assertCurrentKnowledgeContext,
  buildCurrentKnowledgeContext,
  sameKnowledgeContext,
} = require('../lib/knowledge-context');

function frozenCandidates(draft) {
  if (!Array.isArray(draft?.candidates) || draft.candidateCount !== draft.candidates.length
    || typeof draft.truncated !== 'boolean') {
    throw contractError('KNOWLEDGE_QUERY_DRAFT_INVALID', 'knowledge query draft candidates are invalid');
  }
  return draft.candidates.map((candidate) => {
    if (!candidate || typeof candidate.contentSha !== 'string') {
      throw contractError('KNOWLEDGE_QUERY_DRAFT_INVALID', 'knowledge query draft candidate identity is invalid');
    }
    const { snapshotContent, ...frozen } = candidate;
    return { ...frozen, snapshotRef: frozen.snapshotRef || `knowledge/${candidate.contentSha}.md` };
  });
}

function executeKnowledgeQuery(options) {
  ensureId(options.queryId, 'queryId', 'KNOWLEDGE_QUERY_INVALID');
  const binding = validateLiveAgentBinding(options.execDir);
  assertNoOperationRecovery(options.execDir);
  assertNoTurnRecovery(options.execDir);
  const normalizedQuery = normalizeQuery(options.query);
  const events = timelineEvents(options.execDir);
  const understanding = readJson(path.join(options.execDir, 'understanding.json'), null);
  const plan = readJson(path.join(options.execDir, 'plan.json'), null);
  if (!understanding || !plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'knowledge investigation requires the current understanding and plan');
  const knowledgeContext = buildCurrentKnowledgeContext({
    execution: binding.execution,
    understanding,
    plan,
    events,
    observation: currentObservation(events, binding.execution.warmSessionGeneration),
    stateBoundaryIndex: latestStateChangeIndex(events),
  });
  if (options.knowledgeContext) assertCurrentKnowledgeContext(options.knowledgeContext, knowledgeContext);
  const agentDir = path.join(options.execDir, 'agent');
  const draftPath = path.join(agentDir, `knowledge-query-${options.queryId}.draft.json`);
  const otherDrafts = knowledgeQueryDraftIds(options.execDir).filter((queryId) => queryId !== options.queryId);
  if (otherDrafts.length) {
    throw contractError('KNOWLEDGE_QUERY_RECOVERY_REQUIRED', `recover knowledge query before starting another: ${otherDrafts.join(', ')}`);
  }
  const existing = timelineEvents(options.execDir).find((event) => event.type === 'knowledgeQuery' && event.queryId === options.queryId);
  if (existing) {
    if (canonicalJson(existing.query) !== canonicalJson(normalizedQuery)) throw contractError('KNOWLEDGE_QUERY_BINDING_MISMATCH', 'queryId is already bound to another query');
    if (!sameKnowledgeContext(existing.knowledgeContext, knowledgeContext)) {
      throw contractError('KNOWLEDGE_QUERY_BINDING_MISMATCH', 'queryId is already bound to another decision context');
    }
    const draft = readJson(draftPath, null);
    if (draft && (draft.queryId !== options.queryId || canonicalJson(draft.query) !== canonicalJson(normalizedQuery))) {
      throw contractError('KNOWLEDGE_QUERY_BINDING_MISMATCH', 'knowledge query draft does not match the committed event');
    }
    if (draft && (draft.executionId !== binding.execution.executionId
      || canonicalJson(frozenCandidates(draft)) !== canonicalJson(existing.candidates))) {
      throw contractError('KNOWLEDGE_QUERY_BINDING_MISMATCH', 'knowledge query draft candidates do not match the committed event');
    }
    existing.candidates.forEach((candidate) => validateKnowledgeCandidateSnapshot(options.execDir, candidate));
    if (draft) fs.unlinkSync(draftPath);
    return {
      schemaVersion: 1,
      queryId: existing.queryId,
      query: existing.query,
      knowledgeContext: existing.knowledgeContext,
      candidates: existing.candidates,
      candidateCount: existing.candidateCount,
      truncated: existing.truncated,
      idempotent: true,
    };
  }
  let draft = readJson(draftPath, null);
  if (draft && (draft.schemaVersion !== 1 || draft.queryId !== options.queryId
    || canonicalJson(draft.query) !== canonicalJson(normalizedQuery)
    || !sameKnowledgeContext(draft.knowledgeContext, knowledgeContext))) {
    throw contractError('KNOWLEDGE_QUERY_BINDING_MISMATCH', 'queryId is already bound to another frozen query');
  }
  if (!draft) {
    const result = queryKnowledge({ roots: binding.request.knowledgeRoots, query: normalizedQuery, now: options.now, includeContent: true });
    draft = {
      schemaVersion: 1,
      executionId: binding.execution.executionId,
      queryId: options.queryId,
      query: result.query,
      knowledgeContext,
      status: 'RESULT_FROZEN',
      candidates: result.candidates,
      candidateCount: result.candidateCount,
      truncated: result.truncated,
      frozenAt: options.now || new Date().toISOString(),
    };
    writeJsonAtomic(draftPath, draft);
  }
  if (draft.executionId !== binding.execution.executionId) {
    throw contractError('KNOWLEDGE_QUERY_DRAFT_INVALID', 'knowledge query draft does not match the current execution');
  }
  frozenCandidates(draft);
  if (options.interruptAfter === 'draft') throw new Error('MAVT_KNOWLEDGE_QUERY_INTERRUPTED: draft');
  const candidates = draft.candidates.map((candidate) => {
    const snapshotRef = `knowledge/${candidate.contentSha}.md`;
    const snapshotPath = path.join(options.execDir, snapshotRef);
    const existing = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, 'utf8') : null;
    if (existing !== null && contentSha(existing) !== candidate.contentSha) {
      throw contractError('KNOWLEDGE_SNAPSHOT_MISMATCH', `knowledge snapshot content does not match ${candidate.contentSha}`);
    }
    if (existing === null) {
      if (typeof candidate.snapshotContent !== 'string') {
        throw contractError('KNOWLEDGE_QUERY_DRAFT_INVALID', `frozen content is unavailable for ${candidate.contentSha}`);
      }
      atomicWrite(snapshotPath, candidate.snapshotContent);
    }
    const { snapshotContent, ...frozen } = candidate;
    return validateKnowledgeCandidateSnapshot(options.execDir, { ...frozen, snapshotRef });
  });
  draft = { ...draft, status: 'SNAPSHOTS_WRITTEN', candidates, snapshotsWrittenAt: options.now || new Date().toISOString() };
  writeJsonAtomic(draftPath, draft);
  if (options.interruptAfter === 'snapshots') throw new Error('MAVT_KNOWLEDGE_QUERY_INTERRUPTED: snapshots');
  const event = recordKnowledgeQuery(options.execDir, {
    queryId: options.queryId,
    query: draft.query,
    knowledgeContext: draft.knowledgeContext,
    candidates,
    candidateCount: candidates.length,
    truncated: draft.truncated,
  }, { implementationSha: binding.execution.implementationSha, now: options.now });
  if (options.interruptAfter === 'event') throw new Error('MAVT_KNOWLEDGE_QUERY_INTERRUPTED: event');
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  return {
    schemaVersion: 1,
    queryId: options.queryId,
    query: draft.query,
    knowledgeContext: draft.knowledgeContext,
    candidates,
    candidateCount: candidates.length,
    truncated: draft.truncated,
    idempotent: event.idempotent === true,
  };
}

module.exports = { executeKnowledgeQuery };

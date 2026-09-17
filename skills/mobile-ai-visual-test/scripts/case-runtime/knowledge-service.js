'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('../lib/execution-lifecycle');
const { contentSha, queryKnowledge } = require('../lib/knowledge-query');
const store = require('./store');

function keywords(query) {
  return [...new Set(String(query).split(/[\s,，。；;、]+/).map((item) => item.trim()).filter((item) => item.length > 1))].slice(0, 12);
}

function knowledge(execDir, request, options = {}) {
  const execution = store.loadExecution(execDir);
  const appId = execution.targetBinding.appId;
  const scene = store.readCurrentScene(execDir);
  const caseFlow = require('./case-flow-service').current(execDir);
  const verificationPoints = caseFlow?.nodes?.filter((item) => item.type === 'CHECK') || [];
  const relatedExpectations = verificationPoints
    .filter((item) => (request.decision?.expectationRefs || []).includes(item.ref))
    .map((item) => item.text);
  const queryId = store.nextId(execDir, 'knowledge');
  const runtime = require('../lib/execution-lifecycle').readJson(path.join(execDir, 'runtime.json'), null);
  const roots = Array.isArray(runtime?.knowledgeRoots) ? runtime.knowledgeRoots.map((root) => path.resolve(root)) : [];
  if (!roots.length || roots.some((root) => !path.isAbsolute(root))) throw new Error('KNOWLEDGE_ROOTS_UNBOUND: runtime knowledge roots are missing');
  const confirmedPage = scene?.app?.page || null;
  const hintedPage = request.context?.page || null;
  const hintedOperation = request.context?.operation || null;
  const softFields = [
    ...(!confirmedPage && hintedPage ? ['page'] : []),
    ...(hintedOperation ? ['operation'] : []),
  ];
  const result = queryKnowledge({
    roots,
    softFields,
    query: {
      platform: execution.platform,
      app: appId,
      ...(execution.targetBinding.appVersion ? { version: execution.targetBinding.appVersion } : {}),
      ...(confirmedPage || hintedPage ? { page: confirmedPage || hintedPage } : {}),
      ...(hintedOperation ? { operation: hintedOperation } : {}),
      symptom: request.query,
      keywords: keywords([request.query, caseFlow?.summary || '', ...relatedExpectations].join(' ')),
    },
    includeContent: true,
    now: options.now,
  });
  const snapshotDir = path.join(execDir, 'knowledge');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const candidates = result.candidates.map((candidate) => {
    const snapshotRef = `knowledge/${candidate.contentSha}.md`;
    const snapshotPath = path.join(execDir, snapshotRef);
    if (!fs.existsSync(snapshotPath) && typeof candidate.snapshotContent === 'string') atomicWrite(snapshotPath, candidate.snapshotContent);
    if (fs.existsSync(snapshotPath) && contentSha(fs.readFileSync(snapshotPath, 'utf8')) !== candidate.contentSha) {
      throw new Error(`KNOWLEDGE_SNAPSHOT_MISMATCH: ${snapshotRef}`);
    }
    const { snapshotContent, ...value } = candidate;
    return { ...value, snapshotRef };
  });
  const queryEvent = store.appendEvent(execDir, 'knowledgeQueried', {
    queryId,
    query: request.query,
    candidateCount: candidates.length,
    candidateRefs: candidates.map((item) => item.snapshotRef),
    candidates: candidates.map((item) => ({
      entryId: item.entryId,
      title: item.title,
      sourceNamespace: item.sourceNamespace,
      relativePath: item.relativePath,
      contentSha: item.contentSha,
      snapshotRef: item.snapshotRef,
      metadata: item.metadata,
      validUntil: item.validUntil,
      expired: item.expired,
      conflictsWith: item.conflictsWith,
      snippets: item.snippets,
    })),
    truncated: result.truncated,
    filterDiagnostics: result.filterDiagnostics,
    decisionId: request.decisionId || null,
    sceneId: scene?.sceneId || null,
    contextVersion: caseFlow?.revision || null,
    expectationRefs: request.decision?.expectationRefs || [],
    context: {
      platform: execution.platform,
      app: appId,
      ...(execution.targetBinding.appVersion ? { version: execution.targetBinding.appVersion } : {}),
      ...(confirmedPage ? { page: confirmedPage } : {}),
      ...(hintedPage || hintedOperation ? { hints: { ...(hintedPage ? { page: hintedPage } : {}), ...(hintedOperation ? { operation: hintedOperation } : {}) } } : {}),
    },
  }, options);
  const knowledgeReview = require('./knowledge-review');
  if (!candidates.length) knowledgeReview.recordNoMatch(execDir, queryEvent, options);
  return {
    status: 'KNOWLEDGE',
    queryId,
    query: request.query,
    context: {
      platform: execution.platform,
      app: appId,
      ...(execution.targetBinding.appVersion ? { version: execution.targetBinding.appVersion } : {}),
      ...(confirmedPage ? { page: confirmedPage } : {}),
      ...(hintedPage || hintedOperation ? { hints: { ...(hintedPage ? { page: hintedPage } : {}), ...(hintedOperation ? { operation: hintedOperation } : {}) } } : {}),
    },
    candidates,
    requiredReview: knowledgeReview.buildKnowledgeReviewGuidance(queryId, candidates),
    truncated: result.truncated,
    filterDiagnostics: result.filterDiagnostics,
  };
}

module.exports = { knowledge };

'use strict';

const fs = require('fs');
const { contractError } = require('./contract-utils');
const { resolveArtifact, sha256File } = require('./execution-evidence');

function validateKnowledgeCandidateSnapshot(execDir, candidate) {
  if (!candidate || typeof candidate.snapshotRef !== 'string' || !candidate.snapshotRef.trim()) {
    throw contractError('KNOWLEDGE_SNAPSHOT_MISSING', 'knowledge candidate has no frozen snapshot reference');
  }
  if (!/^[0-9a-f]{64}$/.test(candidate.contentSha || '')) {
    throw contractError('KNOWLEDGE_SNAPSHOT_INVALID', 'knowledge candidate content digest is invalid');
  }
  const expectedRef = `knowledge/${candidate.contentSha}.md`;
  if (candidate.snapshotRef.replace(/\\/g, '/') !== expectedRef) {
    throw contractError('KNOWLEDGE_SNAPSHOT_INVALID', `knowledge snapshot path must be ${expectedRef}`);
  }
  const file = resolveArtifact(execDir, candidate.snapshotRef);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw contractError('KNOWLEDGE_SNAPSHOT_MISSING', `knowledge snapshot does not exist: ${candidate.snapshotRef}`);
  }
  const actualSha = sha256File(file);
  if (actualSha !== candidate.contentSha) {
    throw contractError('KNOWLEDGE_SNAPSHOT_CHANGED', `knowledge snapshot digest changed: ${candidate.snapshotRef}`);
  }
  return { ...candidate, snapshotSha256: actualSha };
}

function candidateForAssessment(queries, assessment) {
  const query = queries.find((entry) => entry.type === 'knowledgeQuery' && entry.queryId === assessment.queryId);
  if (!query) throw contractError('KNOWLEDGE_REFERENCE_INVALID', `knowledge query is missing: ${assessment.queryId}`);
  const candidate = query.candidates.find((entry) => entry.entryId === assessment.entryId
    && entry.sourceNamespace === assessment.sourceNamespace
    && entry.relativePath === assessment.relativePath
    && entry.contentSha === assessment.contentSha);
  if (!candidate) throw contractError('KNOWLEDGE_REFERENCE_INVALID', `knowledge assessment does not match its frozen candidate: ${assessment.knowledgeRef}`);
  return candidate;
}

function validateKnowledgeAssessmentSnapshot(execDir, assessment, events) {
  return validateKnowledgeCandidateSnapshot(execDir, candidateForAssessment(events, assessment));
}

function validateResultKnowledgeSnapshots(execDir, result, events) {
  const refs = new Set((result?.requirementFindings || []).flatMap((finding) => finding.knowledgeRefs || []));
  if (!refs.size) return [];
  const assessments = new Map(events.filter((entry) => entry.type === 'knowledgeAssessment')
    .map((entry) => [entry.knowledgeRef, entry]));
  return [...refs].map((ref) => {
    const assessment = assessments.get(ref);
    if (!assessment || assessment.assessment !== 'APPLICABLE') {
      throw contractError('KNOWLEDGE_REFERENCE_INVALID', `result references unavailable applicable knowledge: ${ref}`);
    }
    return validateKnowledgeAssessmentSnapshot(execDir, assessment, events);
  });
}

module.exports = {
  candidateForAssessment,
  validateKnowledgeAssessmentSnapshot,
  validateKnowledgeCandidateSnapshot,
  validateResultKnowledgeSnapshots,
};

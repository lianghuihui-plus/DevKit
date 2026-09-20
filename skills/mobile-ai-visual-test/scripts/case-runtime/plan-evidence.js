'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

function safeId(value, label) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw contractError('PLAN_EVIDENCE_INVALID', `${label} is invalid`);
  return id;
}

function evidenceRef(kind, context, stepId) {
  return `operations/plan-evidence/${kind}-${safeId(context.planId, 'planId')}-${safeId(stepId, 'stepId')}.json`;
}

function recordPlanEvidence(execDir, kind, stepId, value, context) {
  if (!['locator', 'check', 'checkpoint'].includes(kind)) throw contractError('PLAN_EVIDENCE_INVALID', `unsupported evidence kind: ${kind}`);
  const ref = evidenceRef(kind, context, stepId);
  const file = path.join(path.resolve(execDir), ref);
  const record = { schemaVersion: 1, type: `${kind}Evidence`, planId: context.planId, stepId, ...value };
  const existing = readJson(file, null);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw contractError('PLAN_EVIDENCE_CONFLICT', `plan evidence already exists with different content: ${ref}`);
  }
  if (!existing) writeJsonAtomic(file, record);
  return ref;
}

function readScene(execDir, sceneRef) {
  const id = safeId(sceneRef, 'source Scene ref');
  const scene = readJson(path.join(path.resolve(execDir), 'scenes', `${id}.json`), null);
  if (!scene || scene.sceneId !== sceneRef) throw contractError('TARGET_NOT_FOUND', `source Scene does not exist: ${sceneRef}`);
  return scene;
}

module.exports = { evidenceRef, readScene, recordPlanEvidence };

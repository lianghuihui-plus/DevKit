'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const store = require('./store');

const STATES = Object.freeze(['PREPARED', 'UPDATES_APPLIED', 'EFFECT_REJECTED', 'EFFECT_STARTED', 'EFFECT_COMPLETED']);

function submissionIdFor(request) {
  return sha256(canonicalJson(request), 'decision', 20);
}

function draftPath(execDir, submissionId) {
  return path.join(store.paths(execDir).transactions, `${submissionId}.draft.json`);
}

function validateDraft(value) {
  if (!value || value.schemaVersion !== 1 || !String(value.submissionId || '').startsWith('decision-')
    || !STATES.includes(value.status)) throw contractError('DECISION_TRANSACTION_INVALID', 'decision transaction is invalid');
  return value;
}

function writeDraft(execDir, draft) {
  fs.mkdirSync(store.paths(execDir).transactions, { recursive: true });
  writeJsonAtomic(draftPath(execDir, draft.submissionId), validateDraft(draft));
  return draft;
}

function receiptFromPrepared(prepared) {
  return {
    ...(prepared.caseModel || prepared.caseModelExisting ? { caseModel: true } : {}),
    ...(prepared.visual ? { visual: true } : {}),
    ...(prepared.expectationResults?.length
      ? { expectationResults: prepared.expectationResults.map((item) => item.expectationRef) } : {}),
  };
}

function prepareUpdates(execDir, request, options = {}) {
  const updates = request.updates;
  if (!updates || !Object.keys(updates).length) return null;
  const caseModelService = require('./case-model-service');
  const expectationService = require('./expectation-result-service');
  const visualService = require('./visual-inspection-service');
  const modelHistory = caseModelService.history(execDir);
  const caseModelExisting = options.submissionId
    ? modelHistory.find((event) => event.submissionId === options.submissionId) || null
    : null;
  const currentModel = modelHistory.at(-1) || null;
  const baseModel = caseModelExisting
    ? modelHistory.filter((event) => event.sequence < caseModelExisting.sequence).at(-1) || null
    : currentModel;
  const currentRefs = new Set((baseModel?.verificationPoints || []).map((item) => item.ref));
  const caseModel = updates.caseModel && !caseModelExisting
    ? caseModelService.prepareRevision(execDir, updates.caseModel) : null;
  const prospectiveModel = caseModel?.event || caseModelExisting || currentModel;
  for (const result of updates.expectationResults || []) {
    if (!currentRefs.has(result.expectationRef)) {
      throw contractError('EXPECTATION_UNKNOWN', `expectation ${result.expectationRef} did not exist before this submission`);
    }
  }
  const expectationResults = updates.expectationResults
    ? expectationService.prepareExpectationResults(execDir, updates.expectationResults, { caseModel: prospectiveModel }) : [];
  const prospectiveRefs = new Set((prospectiveModel?.verificationPoints || []).map((item) => item.ref));
  const retiredResult = expectationResults.find((item) => !prospectiveRefs.has(item.expectationRef));
  if (retiredResult) throw contractError('EXPECTATION_UNKNOWN', `expectation ${retiredResult.expectationRef} is retired by this Case Model update`);
  let visual = null;
  if (updates.visual) {
    if (!request.basedOnSceneRef) throw contractError('SCENE_REQUIRED', 'updates.visual requires basedOnSceneRef');
    const unknown = (updates.visual.expectationRefs || []).find((ref) => !currentRefs.has(ref));
    if (unknown) throw contractError('EXPECTATION_UNKNOWN', `unknown visual expectation ${unknown}`);
    visual = visualService.prepareVisualInspection(execDir, {
      basedOnSceneId: request.basedOnSceneRef,
      decision: {
        purpose: '记录当前截图的视觉事实',
        expectationRefs: updates.visual.expectationRefs || [],
        observation: updates.visual.observation,
      },
    });
  }
  return { caseModel, caseModelExisting, visual, expectationResults };
}

function commitUpdates(execDir, prepared, options) {
  const receipt = receiptFromPrepared(prepared);
  let caseModelChange;
  if (prepared.caseModel || prepared.caseModelExisting) {
    const response = require('./case-model-service').commitRevision(execDir, prepared.caseModel || {
      event: prepared.caseModelExisting,
      previous: null,
      newlyRetired: null,
    }, options);
    caseModelChange = response.caseModelChange;
    interruptAfter(options, 'caseModel');
  }
  if (prepared.visual) {
    require('./visual-inspection-service').commitVisualInspection(execDir, prepared.visual, options);
    interruptAfter(options, 'visual');
  }
  if (prepared.expectationResults.length) {
    require('./expectation-result-service').commitPreparedResults(execDir, prepared.expectationResults, options);
    interruptAfter(options, 'expectationResults');
  }
  return { receipt, caseModelChange };
}

function interruptAfter(options, step) {
  if (options.interruptAfterDecisionUpdate !== step) return;
  const error = new Error(`MAVT_DECISION_INTERRUPTED: ${step}`);
  error.code = 'MAVT_DECISION_INTERRUPTED';
  throw error;
}

function interruptAfterStage(options, stage) {
  if (options.interruptAfterDecisionStage !== stage) return;
  const error = new Error(`MAVT_DECISION_INTERRUPTED: ${stage}`);
  error.code = 'MAVT_DECISION_INTERRUPTED';
  throw error;
}

function applyUpdates(execDir, request, options = {}) {
  if (!request.updates || !Object.keys(request.updates).length) return null;
  const submissionId = submissionIdFor(request);
  return store.withRuntimeLock(execDir, () => {
    const existing = readJson(draftPath(execDir, submissionId), null);
    if (existing) {
      validateDraft(existing);
      if (existing.status !== 'PREPARED') {
        return {
          submissionId,
          status: existing.status,
          updatesApplied: existing.updatesApplied,
          caseModelChange: existing.caseModelChange,
          effectCode: existing.effectCode,
          effectResponse: existing.effectResponse,
          recovered: true,
        };
      }
    }
    const prepared = prepareUpdates(execDir, request, { submissionId });
    let draft = existing || writeDraft(execDir, {
      schemaVersion: 1,
      submissionId,
      status: 'PREPARED',
      requestHash: sha256(canonicalJson(request), 'request', 32),
      basisSceneRef: request.basedOnSceneRef || null,
      updateKinds: Object.keys(request.updates).sort(),
      effectType: request.capability,
    });
    interruptAfterStage(options, 'prepared');
    const committed = commitUpdates(execDir, prepared, { ...options, submissionId, basedOnSceneRef: request.basedOnSceneRef || null });
    draft = writeDraft(execDir, {
      ...draft,
      status: 'UPDATES_APPLIED',
      updatesApplied: committed.receipt,
      caseModelChange: committed.caseModelChange || null,
    });
    interruptAfterStage(options, 'updates-applied');
    return {
      submissionId,
      status: draft.status,
      updatesApplied: draft.updatesApplied,
      caseModelChange: draft.caseModelChange || undefined,
    };
  }, options);
}

function transition(execDir, submissionId, status, update = {}) {
  if (!submissionId) return null;
  const file = draftPath(execDir, submissionId);
  const draft = validateDraft(readJson(file, null));
  return writeDraft(execDir, { ...draft, ...update, status });
}

function rejectEffect(execDir, submissionId, code) {
  return transition(execDir, submissionId, 'EFFECT_REJECTED', { effectCode: code });
}

function startEffect(execDir, submissionId) {
  return transition(execDir, submissionId, 'EFFECT_STARTED');
}

function completeEffect(execDir, submissionId, response = {}) {
  return transition(execDir, submissionId, 'EFFECT_COMPLETED', {
    effectStatus: response.status || null,
    sceneRef: response.scene?.sceneRef || response.sceneId || null,
    effectResponse: response,
  });
}

module.exports = {
  STATES,
  applyUpdates,
  completeEffect,
  draftPath,
  prepareUpdates,
  rejectEffect,
  startEffect,
  submissionIdFor,
  validateDraft,
};

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { safeActionTechnicalDetails } = require('../lib/action-result');
const { invokeScreenshotCapture } = require('../platform/device-port');
const { dispatchAction } = require('./action-service');
const { resolveActionRef } = require('./capability-catalog');
const { check } = require('./plan-checks');
const { normalizePlanRequest, validatePlanRequest } = require('./plan-contract');
const { locate } = require('./plan-locator');
const sceneService = require('./scene-service');
const store = require('./store');
const telemetry = require('./telemetry');
const transactions = require('./transaction-manager');

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function planDirectory(execDir) {
  return path.join(store.paths(execDir).operations, 'plans');
}

function planPath(execDir, planId) {
  return path.join(planDirectory(execDir), `${planId}.json`);
}

function unsignedRecord(record) {
  const { integrity, ...unsigned } = record;
  return unsigned;
}

function writePlan(execDir, record) {
  const value = { ...record, integrity: { recordSha256: digest(unsignedRecord(record)) } };
  writeJsonAtomic(planPath(execDir, record.planId), value);
  return value;
}

function readPlans(execDir) {
  const directory = planDirectory(execDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(directory, name), null)).filter(Boolean);
}

function assertPlanIntegrity(record) {
  if (!record.integrity?.recordSha256 || digest(unsignedRecord(record)) !== record.integrity.recordSha256) {
    throw contractError('PLAN_RECORD_INCOMPLETE', `plan record integrity is invalid: ${record.planId}`);
  }
}

function responseFromRecord(execDir, record, idempotent = false) {
  const events = store.events(execDir);
  const planActions = new Set(events.filter((event) =>
    event.type === 'actionRequested' && event.planId === record.planId).map((event) => event.operationId));
  const outcomeKnown = !events.some((event) => event.type === 'actionOutcomeUnknown'
    && (event.planId === record.planId || planActions.has(event.operationId)));
  return {
    status: record.status,
    outcomeKnown,
    ...(record.failure?.code ? { code: record.failure.code } : {}),
    planId: record.planId,
    planRecordRef: record.planRecordRef,
    ...(idempotent ? { idempotent: true } : {}),
    steps: record.steps.map(({ startedAt, endedAt, error, ...step }) => ({
      ...step, ...(error ? { error } : {}),
    })),
    evidence: record.evidence,
    technicalFacts: record.technicalFacts,
    remainingMs: record.remainingMs,
  };
}

function nextSceneId(execDir) {
  return `scene-${String(store.events(execDir).filter((event) => event.type === 'sceneObserved').length + 1).padStart(4, '0')}`;
}

function screenshotScene(execDir, invoked, execution, planId, step, operationId) {
  const sceneId = nextSceneId(execDir);
  const screenshot = invoked.evidence;
  return {
    schemaVersion: 2,
    sceneId,
    captureMode: 'SCREENSHOT_ONLY',
    generation: execution.warmSessionGeneration,
    warmSessionRef: {
      sessionId: execution.warmSessionId,
      epoch: execution.warmSessionEpoch,
      generation: execution.warmSessionGeneration,
    },
    capturedAt: invoked.adapterResult.time || new Date().toISOString(),
    screenshot: {
      ref: screenshot.ref,
      path: path.join(path.resolve(execDir), screenshot.ref),
      sha256: screenshot.sha256,
      width: screenshot.width,
      height: screenshot.height,
    },
    evidenceChannels: {
      visual: {
        available: true,
        ref: screenshot.ref,
        attachment: {
          type: 'image', mediaType: 'image/png', path: path.join(path.resolve(execDir), screenshot.ref), sha256: screenshot.sha256,
        },
        inspection: { tool: 'view_image', recordOperation: 'inspectVisual', order: 'VIEW_THEN_RECORD' },
      },
      layout: { available: false, ref: null, diagnostics: [{ code: 'SCREENSHOT_ONLY', severity: 'INFO', message: '本次计划步骤只采集截图' }], inline: false, inspectOperation: 'inspectScene' },
      policy: 'VISUAL_ONLY',
      conflictRule: 'AGENT_INTERPRETS_VISUAL_EVIDENCE',
    },
    layoutRef: null,
    layout: { usable: false, format: 'none', diagnostics: [] },
    captureTiming: invoked.adapterResult.captureTiming || null,
    app: invoked.adapterResult.app || null,
    signals: {}, conflicts: [], elements: [], capabilities: [], scrollContainers: [], scrollContexts: [],
    visual: { gestures: ['tap', 'doubleTap', 'longPress', 'swipe'], coordinates: 'normalized-0-to-1' },
    previousAction: null,
    source: { operation: 'runPlan', planId, stepId: step.id, operationId },
  };
}

function getPath(value, fieldPath) {
  return fieldPath.split('.').reduce((current, field) => current?.[field], value);
}

function resolveValue(value, outputs) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const match = value.match(/^\$([A-Za-z][A-Za-z0-9_-]*)\.(.+)$/);
    const resolved = match ? getPath(outputs.get(match[1]), match[2]) : undefined;
    if (resolved === undefined) throw contractError('PLAN_REFERENCE_INVALID', `plan reference is unavailable: ${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, outputs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, outputs)]));
  return value;
}

function inputReferences(value, refs = []) {
  if (typeof value === 'string' && /^\$[A-Za-z][A-Za-z0-9_-]*\./.test(value)) refs.push(value);
  else if (Array.isArray(value)) value.forEach((item) => inputReferences(item, refs));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => inputReferences(item, refs));
  return refs;
}

function normalizedPointFromPixels(execDir, point, sceneRef) {
  const scene = readJson(path.join(store.paths(execDir).scenes, `${sceneRef}.json`), null);
  const width = Number(scene?.screenshot?.width);
  const height = Number(scene?.screenshot?.height);
  if (!scene || !Array.isArray(point) || !(width > 1 && height > 1)) throw contractError('PLAN_REFERENCE_INVALID', 'resolved point cannot be mapped to its source Scene');
  return [Number(point[0]) / (width - 1), Number(point[1]) / (height - 1)];
}

function actionRequest(execDir, step, input, basisSceneRef, outputs) {
  const scene = readJson(path.join(store.paths(execDir).scenes, `${basisSceneRef}.json`), null);
  if (!scene) throw contractError('PLAN_REFERENCE_INVALID', `action basis Scene is unavailable: ${basisSceneRef}`);
  if (step.actionRef.startsWith('visual:')) {
    const gesture = step.actionRef.slice('visual:'.length);
    let point = input.point;
    if (input.pointRef) {
      const reference = String(step.input.pointRef).match(/^\$([A-Za-z][A-Za-z0-9_-]*)\./);
      const locatorOutput = reference ? outputs.get(reference[1]) : null;
      point = normalizedPointFromPixels(execDir, input.pointRef, locatorOutput?.sourceSceneRef);
    }
    return {
      visual: gesture === 'swipe' ? { gesture, from: input.from, to: input.to }
        : { gesture, point, ...(gesture === 'longPress' ? { durationMs: input.durationMs } : {}) },
    };
  }
  const capability = resolveActionRef(scene, step.actionRef, store.loadExecution(execDir).platform);
  if (!capability) throw contractError('TARGET_NOT_FOUND', `ActionRef is unavailable in plan basis Scene: ${step.actionRef}`);
  return { capabilityId: capability.id, ...(Object.keys(input).length ? { input } : {}) };
}

function finishPlanAction(execDir, dispatched, planId, stepId, options) {
  const action = { ...dispatched.action, lifecycle: { status: 'COMPLETED' } };
  let transaction = transactions.transitionAction(execDir, dispatched.transaction, 'RESULT_RECORDED', 'OBSERVED', {
    observation: 'PLAN_STEP_NO_FULL_SCENE', sceneIdAfter: null,
  });
  transactions.completeAction(execDir, transaction, { actionResult: action });
  store.appendEvent(execDir, 'actionCompleted', {
    operationId: dispatched.operationId,
    sceneId: dispatched.beforeScene.sceneId,
    sceneIdAfter: null,
    action: action.action,
    lifecycle: action.lifecycle,
    command: action.command,
    deviceExecution: action.deviceExecution,
    ...safeActionTechnicalDetails(action),
    evidence: action.evidence,
    spatialEvidenceRef: transaction.spatialEvidenceRef || null,
    decisionId: null,
    planId,
    stepId,
  }, options);
  return action;
}

function stepTime(options) {
  return options.now || new Date().toISOString();
}

function executePlan(execDir, request, options = {}) {
  const execution = store.loadExecution(execDir);
  validatePlanRequest(request, { remainingMs: options.remainingMs });
  const normalized = normalizePlanRequest(request);
  const requestSha256 = digest(normalized);
  const existing = readPlans(execDir).find((record) => record.submissionId === normalized.submissionId);
  if (existing) {
    assertPlanIntegrity(existing);
    if (existing.requestSha256 !== requestSha256) throw contractError('PLAN_SUBMISSION_CONFLICT', 'submissionId already belongs to a different plan request');
    if (!['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED'].includes(existing.status)) {
      throw contractError('PLAN_RECORD_INCOMPLETE', 'existing plan has no terminal result');
    }
    return responseFromRecord(execDir, existing, true);
  }
  const current = store.readCurrentScene(execDir);
  if (!current || current.sceneId !== normalized.basedOnSceneId) {
    throw contractError('CASE_RUNTIME_SCENE_STALE', `runPlan is based on ${normalized.basedOnSceneId}, current Scene is ${current?.sceneId || 'unavailable'}`);
  }
  const clock = options.clock || Date.now;
  const startedMs = clock();
  const deadline = startedMs + normalized.maxDurationMs;
  const planId = store.nextId(execDir, 'plan');
  const recordRef = path.relative(path.resolve(execDir), planPath(execDir, planId));
  let record = writePlan(execDir, {
    schemaVersion: 1, planId, executionId: execution.executionId,
    submissionId: normalized.submissionId, requestSha256,
    basedOnSceneRef: normalized.basedOnSceneId, flowContext: normalized.flowContext || null,
    purpose: normalized.purpose, maxDurationMs: normalized.maxDurationMs, onFailure: normalized.onFailure,
    planRecordRef: recordRef, requestedAt: stepTime(options), startedAt: stepTime(options), endedAt: null,
    elapsedMs: 0, remainingMs: normalized.maxDurationMs, status: 'PLAN_RUNNING', steps: [],
    evidence: { sceneRefs: [], screenshotRefs: [], locatorRefs: [], checkRefs: [] },
    technicalFacts: [], failure: null,
  });
  store.appendEvent(execDir, 'planRequested', {
    planId, submissionId: normalized.submissionId, requestSha256,
    maxDurationMs: normalized.maxDurationMs, planRecordRef: recordRef,
  }, options);
  const outputs = new Map();
  let currentSceneRef = normalized.basedOnSceneId;
  let failure = null;
  const sleep = options.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (const [stepIndex, step] of normalized.steps.entries()) {
    const stepStartedMs = clock();
    const startedAt = stepTime(options);
    if (stepStartedMs >= deadline) {
      failure = contractError('PLAN_TIMEOUT', `plan deadline reached before step ${step.id}`);
      break;
    }
    store.appendEvent(execDir, 'planStepStarted', { planId, stepId: step.id, stepIndex, stepType: step.type, startedAt }, options);
    const stepRecord = {
      stepId: step.id, stepIndex, type: step.type, status: 'RUNNING', startedAt, endedAt: null,
      durationMs: 0, basisSceneRef: currentSceneRef, inputRefs: [...new Set(inputReferences(step))], outputRefs: [], error: null, technicalFactRef: null,
    };
    try {
      const resolved = resolveValue(step, outputs);
      let output;
      if (step.type === 'wait') {
        if (clock() + resolved.ms > deadline) throw contractError('PLAN_TIMEOUT', `wait step exceeds plan deadline: ${step.id}`);
        sleep(resolved.ms);
        output = { waitedMs: resolved.ms };
      } else if (step.type === 'capture' && step.mode === 'SCREENSHOT_ONLY') {
        const operationId = store.nextId(execDir, 'capture');
        const invoked = (options.invokeScreenshotCapture || invokeScreenshotCapture)(execDir, {
          context: { execution }, operationId,
        }, { ...options, timeoutMs: Math.max(1, deadline - clock()) });
        const scene = screenshotScene(execDir, invoked, execution, planId, step, operationId);
        store.writeScene(execDir, scene, { promote: step.promote });
        store.appendEvent(execDir, 'sceneObserved', {
          sceneId: scene.sceneId, generation: scene.generation, operationId, purpose: 'PLAN_CAPTURE',
          relatedOperationId: null, decisionId: null, screenshotRef: scene.screenshot.ref,
          screenshotSha256: scene.screenshot.sha256, layoutRef: null, app: scene.app,
          captureMode: scene.captureMode, promoted: step.promote, planId, stepId: step.id,
        }, options);
        if (step.promote) currentSceneRef = scene.sceneId;
        record.evidence.sceneRefs.push(scene.sceneId);
        record.evidence.screenshotRefs.push(scene.screenshot.ref);
        output = { sceneRef: scene.sceneId, screenshotRef: scene.screenshot.ref, captureMode: scene.captureMode };
      } else if (step.type === 'capture') {
        const observed = sceneService.observe(execDir, {
          ...options, purpose: 'PLAN_CAPTURE', promote: step.promote, planId, stepId: step.id,
        });
        const scene = readJson(path.join(store.paths(execDir).scenes, `${observed.scene.sceneId}.json`), null);
        if (step.promote) currentSceneRef = scene.sceneId;
        record.evidence.sceneRefs.push(scene.sceneId);
        record.evidence.screenshotRefs.push(scene.screenshot.ref);
        output = { sceneRef: scene.sceneId, screenshotRef: scene.screenshot.ref, captureMode: 'FULL_SCENE' };
      } else if (step.type === 'locate') {
        const located = locate(execDir, resolved, { planId, sourceRef: resolved.sourceRef });
        record.evidence.locatorRefs.push(located.locatorRef);
        output = { ...located.resolution, locatorRef: located.locatorRef, sourceSceneRef: resolved.sourceRef };
      } else if (step.type === 'check') {
        const checked = check(execDir, resolved, {
          planId, sourceRef: resolved.sourceRef,
          references: new Set(Object.values(Object.fromEntries(outputs)).flatMap((item) => Object.values(item || {}).filter((value) => typeof value === 'string'))),
        });
        record.evidence.checkRefs.push(checked.result.checkRef);
        record.technicalFacts.push(checked.technicalFactRef);
        output = checked.result;
        stepRecord.technicalFactRef = checked.technicalFactRef;
        if (checked.result.status !== 'SATISFIED') {
          stepRecord.outputRefs = [checked.result.checkRef];
          const error = contractError('PLAN_CHECK_FAILED', `technical check ${step.id} returned ${checked.result.status}`);
          error.checkRef = checked.result.checkRef;
          throw error;
        }
      } else if (step.type === 'act') {
        const input = resolved.input || {};
        const translated = actionRequest(execDir, step, input, currentSceneRef, outputs);
        const dispatched = dispatchAction(execDir, {
          basedOnSceneId: currentSceneRef, ...translated,
          decision: { purpose: normalized.purpose, expectationRefs: [] }, planId, stepId: step.id,
        }, options);
        if (dispatched.status !== 'ACTION_DISPATCHED') throw contractError('PLAN_STEP_FAILED', `action step could not be dispatched: ${step.id}`);
        const action = finishPlanAction(execDir, dispatched, planId, step.id, options);
        output = { operationRef: dispatched.operationId, action: action.action, evidence: action.evidence };
      } else if (step.type === 'checkpoint') {
        output = { checkpointRef: require('./plan-evidence').recordPlanEvidence(execDir, 'checkpoint', step.id, {
          evidenceRefs: resolved.evidenceRefs || [],
        }, { planId }) };
      }
      outputs.set(step.id, output);
      const durationMs = Math.max(0, clock() - stepStartedMs);
      Object.assign(stepRecord, {
        status: 'COMPLETED', endedAt: stepTime(options), durationMs,
        outputRefs: Object.values(output || {}).filter((value) => typeof value === 'string'),
      });
      record.steps.push(stepRecord);
      record.elapsedMs = Math.max(0, clock() - startedMs);
      record.remainingMs = Math.max(0, deadline - clock());
      record = writePlan(execDir, record);
      telemetry.recordSpan(execDir, 'plan-step', durationMs, {
        planId, stepId: step.id, stepType: step.type, startedAt, endedAt: stepRecord.endedAt, clock: 'monotonic',
      }, options);
      store.appendEvent(execDir, 'planStepCompleted', {
        planId, stepId: step.id, stepIndex, stepType: step.type, startedAt,
        endedAt: stepRecord.endedAt, durationMs, inputRefs: stepRecord.inputRefs,
        outputRefs: stepRecord.outputRefs, status: stepRecord.status,
      }, options);
    } catch (error) {
      if (!failure) failure = error;
      const durationMs = Math.max(0, clock() - stepStartedMs);
      const technicalFactRef = error.technicalFactRef || store.appendEvent(execDir, 'technicalIssue', {
        code: error.code || 'PLAN_STEP_FAILED', message: error.message || String(error),
        operation: 'runPlan', planId, stepId: step.id, expectationRefs: [], decisionId: null,
      }, options).technicalFactRef;
      Object.assign(stepRecord, {
        status: 'FAILED', endedAt: stepTime(options), durationMs,
        error: { code: error.code || 'PLAN_STEP_FAILED', message: error.message || String(error) },
        technicalFactRef,
      });
      record.steps.push(stepRecord);
      record.elapsedMs = Math.max(0, clock() - startedMs);
      record.remainingMs = Math.max(0, deadline - clock());
      record.failure = { code: error.code || 'PLAN_STEP_FAILED', message: error.message || String(error) };
      record = writePlan(execDir, record);
      telemetry.recordSpan(execDir, 'plan-step', durationMs, {
        planId, stepId: step.id, stepType: step.type, startedAt, endedAt: stepRecord.endedAt, clock: 'monotonic',
        status: 'FAILED', code: stepRecord.error.code,
      }, options);
      store.appendEvent(execDir, 'planStepFailed', {
        planId, stepId: step.id, stepIndex, stepType: step.type, startedAt,
        endedAt: stepRecord.endedAt, durationMs, inputRefs: stepRecord.inputRefs, outputRefs: stepRecord.outputRefs,
        status: stepRecord.status, error: stepRecord.error, technicalFactRef: stepRecord.technicalFactRef,
      }, options);
      if (normalized.onFailure === 'CONTINUE' && error.actionOutcome !== 'UNKNOWN' && error.code !== 'PLAN_TIMEOUT') continue;
      break;
    }
  }
  const terminal = !failure ? 'PLAN_COMPLETED'
    : failure.actionOutcome === 'UNKNOWN' || failure.code === 'PLAN_TIMEOUT' ? 'PLAN_INTERRUPTED'
      : record.steps.some((step) => step.status === 'COMPLETED') ? 'PLAN_PARTIAL' : 'PLAN_INTERRUPTED';
  record = writePlan(execDir, {
    ...record, status: terminal, endedAt: stepTime(options), elapsedMs: Math.max(0, clock() - startedMs),
    remainingMs: Math.max(0, deadline - clock()),
    failure: failure ? { code: failure.code || 'PLAN_STEP_FAILED', message: failure.message || String(failure) } : null,
  });
  store.appendEvent(execDir, terminal === 'PLAN_COMPLETED' ? 'planCompleted' : 'planInterrupted', {
    planId, status: terminal, planRecordRef: recordRef, recordSha256: record.integrity.recordSha256,
    elapsedMs: record.elapsedMs, remainingMs: record.remainingMs, failure: record.failure,
  }, options);
  return responseFromRecord(execDir, record);
}

function recoverInterruptedPlans(execDir, options = {}) {
  const recovered = [];
  const terminalStatuses = new Set(['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED']);
  for (const record of readPlans(execDir).sort((left, right) => String(left.planId).localeCompare(String(right.planId)))) {
    if (terminalStatuses.has(record.status)) continue;
    assertPlanIntegrity(record);
    const endedAt = options.now || new Date().toISOString();
    const measuredElapsedMs = record.startedAt && Number.isFinite(Date.parse(endedAt)) && Number.isFinite(Date.parse(record.startedAt))
      ? Math.max(0, Date.parse(endedAt) - Date.parse(record.startedAt)) : 0;
    const elapsedMs = Math.max(Number(record.elapsedMs) || 0, measuredElapsedMs);
    const failure = {
      code: 'PLAN_INTERRUPTED_AFTER_PROCESS_RESTART',
      message: 'plan execution was interrupted before a terminal record was persisted',
    };
    const interrupted = writePlan(execDir, {
      ...record,
      status: 'PLAN_INTERRUPTED',
      endedAt,
      elapsedMs,
      remainingMs: Math.max(0, Number(record.maxDurationMs) - elapsedMs),
      failure,
    });
    if (!store.events(execDir).some((event) => event.type === 'planInterrupted' && event.planId === record.planId)) {
      store.appendEvent(execDir, 'planInterrupted', {
        planId: record.planId,
        status: interrupted.status,
        planRecordRef: interrupted.planRecordRef,
        recordSha256: interrupted.integrity.recordSha256,
        elapsedMs: interrupted.elapsedMs,
        remainingMs: interrupted.remainingMs,
        failure,
      }, options);
    }
    recovered.push({ kind: 'plan', operationId: record.planId, planId: record.planId, status: 'PLAN_INTERRUPTED' });
  }
  return recovered;
}

function runPlan(execDir, request, options = {}) {
  return options.lockHeld === true
    ? executePlan(execDir, request, options)
    : store.withRuntimeLock(execDir, () => executePlan(execDir, request, { ...options, lockHeld: true }), options);
}

module.exports = { assertPlanIntegrity, planPath, readPlans, recoverInterruptedPlans, runPlan };

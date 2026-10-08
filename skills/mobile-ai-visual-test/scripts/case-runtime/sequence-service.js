'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { invokeScreenshotCapture } = require('../platform/device-port');
const {
  FINAL_SCENE_RESERVE_MS,
  SEQUENCE_STATUSES,
  normalizeSequenceRequest,
  sequenceDurationMs,
  sequenceRequestKey,
} = require('./sequence-contract');
const { resolveActionRequest } = require('./action-request');
const {
  classifyActionOutcome,
  completeDispatchedAction,
  completeUnknownDispatchedAction,
  dispatchAction,
  recordCaptureFailureTechnicalFact,
} = require('./action-service');
const sceneService = require('./scene-service');
const store = require('./store');
const transactions = require('./transaction-manager');

const SEQUENCE_ID_PATTERN = /^sequence-[0-9]+$/;

function sequenceDirectory(execDir) {
  return path.join(store.paths(execDir).operations, 'sequences');
}

function validSequenceId(sequenceId) {
  if (typeof sequenceId !== 'string' || !SEQUENCE_ID_PATTERN.test(sequenceId)) {
    throw contractError('SEQUENCE_RECORD_INCOMPLETE', 'sequence record has an invalid sequenceId');
  }
  return sequenceId;
}

function sequencePath(execDir, sequenceId) {
  return path.join(sequenceDirectory(execDir), `${validSequenceId(sequenceId)}.json`);
}

function unsignedRecord(record) {
  const { integrity, ...unsigned } = record;
  return unsigned;
}

function recordDigest(record) {
  return crypto.createHash('sha256').update(canonicalJson(unsignedRecord(record))).digest('hex');
}

function writeSequenceRecord(execDir, record) {
  validSequenceId(record?.sequenceId);
  fs.mkdirSync(sequenceDirectory(execDir), { recursive: true });
  const value = {
    ...unsignedRecord(record),
    integrity: { recordSha256: recordDigest(record) },
  };
  writeJsonAtomic(sequencePath(execDir, value.sequenceId), value);
  return value;
}

function readSequences(execDir) {
  const directory = sequenceDirectory(execDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(directory, name), null))
    .filter(Boolean);
}

function incomplete(message) {
  return contractError('SEQUENCE_RECORD_INCOMPLETE', message);
}

function redactedSequenceRequest(request) {
  return {
    ...request,
    steps: request.steps.map((step) => (
      step.type === 'act' && step.input?.text !== undefined
        ? { ...step, input: { ...step.input, text: '[REDACTED]' } }
        : step
    )),
  };
}

function assertSequenceIntegrity(execDir, record) {
  if (!record || record.schemaVersion !== 1) throw incomplete('sequence record schema is invalid');
  validSequenceId(record.sequenceId);
  if (!Number.isFinite(record.deadlineMs) || record.deadlineMs < 0) {
    throw incomplete('sequence record deadline is invalid');
  }
  if (!Number.isFinite(record.elapsedMs) || record.elapsedMs < 0) {
    throw incomplete('sequence record elapsed time is invalid');
  }
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  if (record.executionId !== execution.executionId) throw incomplete('sequence record execution binding is invalid');
  const expectedRef = path.relative(path.resolve(execDir), sequencePath(execDir, record.sequenceId));
  if (record.sequenceRecordRef !== expectedRef) throw incomplete('sequence record reference is invalid');
  if (typeof record.requestKey !== 'string' || !record.requestKey.startsWith('sequence-request-')) {
    throw incomplete('sequence record request key is invalid');
  }
  if (!record.integrity?.recordSha256 || record.integrity.recordSha256 !== recordDigest(record)) {
    throw incomplete(`sequence record integrity is invalid: ${record.sequenceId}`);
  }
  if (record.request) {
    const containsRedactedInput = record.request.steps.some((step) => step.type === 'act'
      && step.input?.text === '[REDACTED]');
    const containsRawInput = record.request.steps.some((step) => step.type === 'act'
      && step.input?.text !== undefined && step.input.text !== '[REDACTED]');
    if (containsRawInput) throw incomplete('sequence request contains raw input text');
    if (!containsRedactedInput) {
      const expectedKey = sequenceRequestKey({ operation: 'runSequence', ...record.request });
      if (record.requestKey !== expectedKey) throw incomplete('sequence record request key does not match its stable request');
    }
  }
  const events = store.events(execDir);
  if (record.terminal === true && (record.steps || []).length) {
    let expectedSceneRef = record.basedOnSceneRef;
    let previousStep = null;
    for (const step of record.steps) {
      const coalescedCaptureScene = step.type === 'capture' && previousStep?.type === 'act'
        && step.preSceneRef === previousStep.preSceneRef
        && step.postSceneRef === previousStep.postSceneRef
        ? readScene(execDir, step.postSceneRef)
        : null;
      const isValidCoalescedCapture = coalescedCaptureScene
        && coalescedCaptureScene.relatedOperationId === previousStep.operationId
        && (coalescedCaptureScene.captureOrigins || []).includes('AGENT_REQUESTED')
        && (coalescedCaptureScene.captureOrigins || []).includes('ACTION_POST');
      const failedAdjacentCapture = step.type === 'capture' && step.status === 'FAILED'
        && previousStep?.type === 'act' && step.preSceneRef === previousStep.preSceneRef
        && step.postSceneRef === null;
      if (step.preSceneRef !== expectedSceneRef && !isValidCoalescedCapture && !failedAdjacentCapture) {
        throw incomplete(`sequence step chain is invalid: ${step.stepId}`);
      }
      if (step.type === 'act') {
        if (step.status === 'NOT_RUN') {
          if (step.operationId || step.postSceneRef) {
            throw incomplete(`sequence unstarted action has execution evidence: ${step.stepId}`);
          }
          previousStep = step;
          continue;
        }
        const requested = events.filter((event) => event.type === 'actionRequested'
          && event.operationId === step.operationId && event.sequenceId === record.sequenceId
          && event.stepId === step.stepId);
        if (requested.length !== 1) throw incomplete(`sequence action request is not unique: ${step.stepId}`);
        const completed = transactions.readCompletedAction(execDir, step.operationId);
        if (step.status === 'NOT_SENT') {
          const completionEvents = events.filter((event) => event.operationId === step.operationId
            && ['actionCompleted', 'actionOutcomeUnknown'].includes(event.type));
          if (completed || completionEvents.length || step.postSceneRef) {
            throw incomplete(`sequence unsent action has completion evidence: ${step.stepId}`);
          }
          previousStep = step;
          continue;
        }
        if (!completed || completed.sequenceId !== record.sequenceId || completed.stepId !== step.stepId) {
          throw incomplete(`sequence action operation is invalid: ${step.stepId}`);
        }
        if (step.status === 'UNKNOWN') {
          const unknown = events.filter((event) => event.type === 'actionOutcomeUnknown'
            && event.operationId === step.operationId);
          if (unknown.length !== 1) throw incomplete(`sequence unknown action fact is not unique: ${step.stepId}`);
        } else {
          const actionCompleted = events.filter((event) => event.type === 'actionCompleted'
            && event.operationId === step.operationId && event.sequenceId === record.sequenceId
            && event.stepId === step.stepId);
          const expectedCompletionCount = step.postSceneRef ? 1 : 0;
          if (actionCompleted.length !== expectedCompletionCount) {
            throw incomplete(`sequence action completion is not unique: ${step.stepId}`);
          }
        }
        if (step.action?.type === 'inputText' && step.action.text !== '[REDACTED]') {
          throw incomplete(`sequence action contains raw input text: ${step.stepId}`);
        }
        if (step.postSceneRef) {
          const postScene = readScene(execDir, step.postSceneRef);
          if (!postScene || postScene.relatedOperationId !== step.operationId
            || completed.sceneIdAfter !== step.postSceneRef) {
            throw incomplete(`sequence post Scene is invalid: ${step.stepId}`);
          }
        } else {
          const captureFailureFact = events.find((event) => event.type === 'technicalIssue'
            && event.technicalFactRef === completed.captureFailureTechnicalFactRef
            && event.code === 'POST_ACTION_CAPTURE_FAILED'
            && event.operationId === step.operationId
            && event.sequenceId === record.sequenceId
            && event.stepId === step.stepId);
          if (completed.sceneIdAfter !== null || !captureFailureFact
            || !(record.technicalFacts || []).includes(captureFailureFact.technicalFactRef)) {
            throw incomplete(`sequence action without post Scene lacks capture-failure closure: ${step.stepId}`);
          }
        }
      }
      if (step.postSceneRef) expectedSceneRef = step.postSceneRef;
      previousStep = step;
    }
  }
  if (record.terminal === true) {
    const recordedOperations = new Set((record.steps || [])
      .filter((step) => step.type === 'act').map((step) => step.operationId));
    const orphanedAction = events.find((event) => event.type === 'actionRequested'
      && event.sequenceId === record.sequenceId && !recordedOperations.has(event.operationId));
    if (orphanedAction) {
      throw incomplete(`sequence action is missing from the step record: ${orphanedAction.stepId}`);
    }
    const recordedCaptures = new Set((record.steps || [])
      .filter((step) => step.type === 'capture').map((step) => step.stepId));
    const orphanedCapture = events.find((event) => event.type === 'sceneObserved'
      && event.sequenceId === record.sequenceId && event.stepId
      && (event.captureOrigins || []).includes('AGENT_REQUESTED')
      && !recordedCaptures.has(event.stepId));
    if (orphanedCapture) {
      throw incomplete(`sequence capture is missing from the step record: ${orphanedCapture.stepId}`);
    }
  }
  if (record.terminal === true && record.finalSceneRef) {
    const finalScene = readScene(execDir, record.finalSceneRef);
    const finalSceneEvents = events.filter((event) => event.type === 'sceneObserved'
      && event.sceneId === record.finalSceneRef && event.sequenceId === record.sequenceId);
    if (!finalScene || finalSceneEvents.length !== 1 || finalSceneEvents[0].promoted !== true
      || !(finalScene.captureOrigins || []).includes('SEQUENCE_FINAL')) {
      throw incomplete('sequence final Scene is not the promoted SEQUENCE_FINAL Scene');
    }
  } else if (record.terminal === true) {
    const technicalFactRefs = new Set(record.technicalFacts || []);
    const finalCaptureFailure = events.find((event) => event.type === 'technicalIssue'
      && event.sequenceId === record.sequenceId && technicalFactRefs.has(event.technicalFactRef)
      && ['POST_ACTION_CAPTURE_FAILED', 'SEQUENCE_FINAL_CAPTURE_FAILED'].includes(event.code));
    if (!finalCaptureFailure) {
      throw incomplete('sequence without a final Scene lacks a final-capture technical fact');
    }
  }
  return record;
}

function findSequence(execDir, request) {
  const requestKey = sequenceRequestKey(request);
  const matches = readSequences(execDir).filter((record) => record.requestKey === requestKey);
  if (!matches.length) return null;
  if (matches.length !== 1) throw incomplete('multiple sequence records share the same request key');
  return assertSequenceIntegrity(execDir, matches[0]);
}

function findTerminalSequence(execDir, request) {
  const record = findSequence(execDir, request);
  if (!record) return null;
  if (record.terminal !== true || !SEQUENCE_STATUSES.includes(record.status)) {
    throw incomplete(`sequence record has no terminal result: ${record.sequenceId}`);
  }
  return record;
}

function responseFromSequenceRecord(record, options = {}) {
  return {
    status: record.status,
    outcomeKnown: record.outcomeKnown !== false,
    ...(record.failure?.code ? { code: record.failure.code } : {}),
    sequenceId: record.sequenceId,
    sequenceRecordRef: record.sequenceRecordRef,
    steps: record.steps || [],
    evidence: record.evidence || { sceneRefs: [], screenshotRefs: [] },
    finalSceneRef: record.finalSceneRef || null,
    remainingMs: Number(record.remainingMs) || 0,
    elapsedMs: record.elapsedMs,
    idempotent: options.idempotent === true,
  };
}

function nextSceneId(execDir) {
  const count = store.events(execDir).filter((event) => event.type === 'sceneObserved').length;
  return `scene-${String(count + 1).padStart(4, '0')}`;
}

function sequenceScreenshotPreviousAction(previousAction, beforeScene, sceneId, screenshotRef) {
  if (!previousAction) return null;
  const beforeSceneRef = previousAction.evidence?.sceneRefs?.before || beforeScene?.sceneId;
  const beforeScreenshotRefs = previousAction.evidence?.screenshotRefs
    || (beforeScene?.screenshot?.ref ? [beforeScene.screenshot.ref] : []);
  return {
    ...previousAction,
    evidence: {
      sceneRefs: {
        ...(beforeSceneRef ? { before: beforeSceneRef } : {}),
        after: sceneId,
      },
      screenshotRefs: [...new Set([...beforeScreenshotRefs, screenshotRef])],
    },
  };
}

function persistSequenceScreenshotScene(execDir, invoked, execution, metadata = {}, options = {}) {
  if (typeof options.promote !== 'boolean') {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'Sequence screenshot promotion must be explicit');
  }
  if (typeof metadata.operationId !== 'string' || !metadata.operationId.trim()) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'Sequence screenshot operationId is required');
  }
  const capture = sceneService.normalizeCaptureMetadata(metadata);
  if (!capture.sequenceId) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'Sequence screenshot sequenceId is required');
  }
  if (capture.relatedOperationId && !capture.captureOrigins.includes('ACTION_POST')) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'a Sequence relatedOperationId requires ACTION_POST capture origin');
  }
  const screenshot = invoked?.evidence;
  if (!screenshot?.ref || !screenshot.sha256) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'Sequence screenshot evidence is invalid');
  }
  const sceneId = nextSceneId(execDir);
  const previousAction = sequenceScreenshotPreviousAction(
    metadata.previousAction || null,
    metadata.beforeScene || null,
    sceneId,
    screenshot.ref,
  );
  const capturedAt = options.now || invoked.adapterResult?.time || new Date().toISOString();
  const scene = {
    schemaVersion: 2,
    sceneId,
    captureMode: 'SCREENSHOT_ONLY',
    generation: execution.warmSessionGeneration,
    warmSessionRef: {
      sessionId: execution.warmSessionId,
      epoch: execution.warmSessionEpoch,
      generation: execution.warmSessionGeneration,
    },
    capturedAt,
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
          type: 'image',
          mediaType: 'image/png',
          path: path.join(path.resolve(execDir), screenshot.ref),
          sha256: screenshot.sha256,
        },
        inspection: { tool: 'view_image', recordOperation: 'inspectVisual', order: 'VIEW_THEN_RECORD' },
      },
      layout: {
        available: false,
        ref: null,
        diagnostics: [{ code: 'SCREENSHOT_ONLY', severity: 'INFO', message: 'Sequence step captured visual evidence only' }],
        inline: false,
        inspectOperation: 'inspectScene',
      },
      policy: 'VISUAL_ONLY',
      conflictRule: 'AGENT_INTERPRETS_VISUAL_EVIDENCE',
    },
    layoutRef: null,
    layout: { usable: false, format: 'none', diagnostics: [] },
    captureTiming: invoked.adapterResult?.captureTiming || null,
    app: invoked.adapterResult?.app || null,
    signals: {},
    conflicts: [],
    elements: [],
    capabilities: [],
    scrollContainers: [],
    scrollContexts: [],
    visual: { gestures: ['tap', 'doubleTap', 'longPress', 'swipe'], coordinates: 'normalized-0-to-1' },
    previousAction,
    captureOrigins: capture.captureOrigins,
    relatedOperationId: capture.relatedOperationId,
    sequenceId: capture.sequenceId,
    stepId: capture.stepId,
    source: {
      operation: 'runSequence',
      stepId: capture.stepId,
      operationId: metadata.operationId,
    },
  };
  store.writeScene(execDir, scene, { promote: options.promote });
  store.appendEvent(execDir, 'sceneObserved', {
    sceneId: scene.sceneId,
    generation: scene.generation,
    warmSessionRef: scene.warmSessionRef,
    operationId: metadata.operationId,
    purpose: metadata.purpose || 'SEQUENCE_CAPTURE',
    captureOrigins: scene.captureOrigins,
    relatedOperationId: scene.relatedOperationId,
    decisionId: metadata.decisionId || null,
    screenshotRef: scene.screenshot.ref,
    screenshotSha256: scene.screenshot.sha256,
    layoutRef: null,
    app: scene.app,
    technicalSignals: null,
    captureMode: scene.captureMode,
    promoted: options.promote,
    sequenceId: scene.sequenceId,
    stepId: scene.stepId,
  }, { now: capturedAt });
  return scene;
}

function sceneChanged(scene) {
  return {
    status: 'SCENE_CHANGED',
    outcomeKnown: true,
    scene: sceneService.projectSceneSummary(scene),
  };
}

function now(options) {
  return options.now || new Date().toISOString();
}

function actionRequestFor(step, basisSceneId, purpose, decisionId) {
  return {
    basedOnSceneId: basisSceneId,
    ...(step.capabilityId ? { capabilityId: step.capabilityId } : {}),
    ...(step.input !== undefined ? { input: step.input } : {}),
    ...(step.visual ? { visual: step.visual } : {}),
    decision: { purpose, expectationRefs: [] },
    decisionId: decisionId || null,
  };
}

function dispatchedPreviousAction(dispatched) {
  return {
    ...dispatched.action,
    lifecycle: { status: classifyActionOutcome(dispatched.adapterResult) },
  };
}

function readScene(execDir, sceneId) {
  return readJson(path.join(store.paths(execDir).scenes, `${sceneId}.json`), null);
}

function interruptAt(options, boundary) {
  if (options.interruptAfter !== boundary) return;
  const error = new Error(`MAVT_SEQUENCE_INTERRUPTED: ${boundary}`);
  error.code = 'MAVT_SEQUENCE_INTERRUPTED';
  error.interruptAfter = boundary;
  throw error;
}

function sequenceTechnicalFactRefs(execDir, sequenceId) {
  return store.events(execDir)
    .filter((event) => event.sequenceId === sequenceId && event.technicalFactRef)
    .map((event) => event.technicalFactRef);
}

function recordSequenceFinalCaptureFailure(execDir, record, error, options = {}) {
  const existing = store.events(execDir).find((event) => event.type === 'technicalIssue'
    && event.sequenceId === record.sequenceId && event.code === 'SEQUENCE_FINAL_CAPTURE_FAILED');
  if (existing) return existing;
  return store.appendEvent(execDir, 'technicalIssue', {
    code: 'SEQUENCE_FINAL_CAPTURE_FAILED',
    ...(error.code ? { internalCode: error.code } : {}),
    message: 'Sequence final Scene capture failed',
    operation: 'runSequence',
    sequenceId: record.sequenceId,
    stepId: null,
    decisionId: record.decisionId || null,
  }, options);
}

function uniquePush(values, ...items) {
  for (const item of items.filter(Boolean)) if (!values.includes(item)) values.push(item);
}

function usableMs(deadline, clock) {
  return deadline - clock() - FINAL_SCENE_RESERVE_MS;
}

function fullScene(execDir, options, metadata) {
  sceneService.observe(execDir, {
    ...options,
    purpose: metadata.purpose,
    captureOrigins: metadata.captureOrigins,
    relatedOperationId: metadata.relatedOperationId || null,
    sequenceId: metadata.sequenceId,
    stepId: metadata.stepId || null,
    previousAction: metadata.previousAction || null,
    previousScene: metadata.previousScene || null,
    promote: metadata.promote,
    preAdapterDelayMs: metadata.preAdapterDelayMs || 0,
    timeoutMs: metadata.timeoutMs,
  });
  const event = store.events(execDir).filter((item) => item.type === 'sceneObserved'
    && item.sequenceId === metadata.sequenceId).at(-1);
  return event ? readScene(execDir, event.sceneId) : null;
}

function screenshotScene(execDir, execution, options, metadata) {
  const capture = options.invokeScreenshotCapture
    || (options.invokeDeviceOperation
      ? (dir, payload, captureOptions) => options.invokeDeviceOperation(dir, payload, 'CAPTURE', captureOptions)
      : invokeScreenshotCapture);
  const operationId = store.nextId(execDir, 'capture');
  const invoked = capture(execDir, { context: { execution }, operationId }, {
    ...options, timeoutMs: metadata.timeoutMs,
  });
  return persistSequenceScreenshotScene(execDir, invoked, execution, {
    operationId,
    purpose: metadata.purpose,
    captureOrigins: metadata.captureOrigins,
    relatedOperationId: metadata.relatedOperationId || null,
    sequenceId: metadata.sequenceId,
    stepId: metadata.stepId || null,
    previousAction: metadata.previousAction || null,
    beforeScene: metadata.previousScene || null,
    decisionId: options.decisionId || null,
  }, { promote: metadata.promote, now: now(options) });
}

function actionStepRecord(step, stepIndex, operationId, beforeScene, afterScene, action,
  status = 'COMPLETED', error = null, durationMs = null) {
  return {
    stepId: step.id,
    stepIndex,
    type: 'act',
    status,
    operationId,
    preSceneRef: beforeScene.sceneId,
    postSceneRef: afterScene?.sceneId || null,
    action: action?.action || action || null,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(error ? { error } : {}),
  };
}

function captureStepRecord(step, stepIndex, beforeScene, afterScene,
  status = 'COMPLETED', error = null, durationMs = null) {
  return {
    stepId: step.id,
    stepIndex,
    type: 'capture',
    status,
    mode: step.mode,
    purpose: step.purpose,
    preSceneRef: beforeScene.sceneId,
    postSceneRef: afterScene?.sceneId || null,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(error ? { error } : {}),
  };
}

function waitStepRecord(step, stepIndex, scene, status = 'COMPLETED', error = null, durationMs = null) {
  return {
    stepId: step.id,
    stepIndex,
    type: 'wait',
    status,
    ms: step.ms,
    preSceneRef: scene.sceneId,
    postSceneRef: scene.sceneId,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(error ? { error } : {}),
  };
}

function runSequence(execDir, request, options = {}) {
  const existing = findTerminalSequence(execDir, request);
  if (existing) return responseFromSequenceRecord(existing, { idempotent: true });

  const normalized = normalizeSequenceRequest(request);
  const execution = store.loadExecution(execDir);
  const beforeScene = store.readCurrentScene(execDir);
  if (!beforeScene || beforeScene.sceneId !== normalized.basedOnSceneId) return sceneChanged(beforeScene);

  const preparedActions = new Map();
  normalized.steps.forEach((step, stepIndex) => {
    if (step.type !== 'act') return;
    const actionRequest = actionRequestFor(
      step, beforeScene.sceneId, normalized.purpose, options.decisionId,
    );
    const resolvedAction = resolveActionRequest(beforeScene, actionRequest, execution.platform);
    preparedActions.set(stepIndex, { actionRequest, resolvedAction });
  });
  if ([...preparedActions.values()].some(({ resolvedAction }) => resolvedAction.stale)) return sceneChanged(beforeScene);

  const clock = options.clock || Date.now;
  const startedMs = clock();
  const durationMs = sequenceDurationMs(options.remainingMs);
  const deadline = startedMs + durationMs;
  const sequenceId = store.nextId(execDir, 'sequence');
  const recordRef = path.relative(path.resolve(execDir), sequencePath(execDir, sequenceId));
  let record = writeSequenceRecord(execDir, {
    schemaVersion: 1,
    sequenceId,
    executionId: execution.executionId,
    requestKey: sequenceRequestKey(request),
    request: redactedSequenceRequest(normalized),
    basedOnSceneRef: beforeScene.sceneId,
    purpose: normalized.purpose,
    flowContext: normalized.flowContext || null,
    decisionId: options.decisionId || null,
    sequenceRecordRef: recordRef,
    requestedAt: now(options),
    startedAt: now(options),
    endedAt: null,
    terminal: false,
    status: 'SEQUENCE_RUNNING',
    outcomeKnown: true,
    steps: [],
    evidence: { sceneRefs: [], screenshotRefs: [] },
    finalSceneRef: null,
    deadlineMs: deadline,
    remainingMs: durationMs,
    elapsedMs: 0,
    technicalFacts: [],
    failure: null,
  });
  interruptAt(options, 'sequence-record-persisted');
  store.appendEvent(execDir, 'sequenceRequested', {
    sequenceId,
    requestKey: record.requestKey,
    basedOnSceneRef: beforeScene.sceneId,
    sequenceRecordRef: recordRef,
    decisionId: options.decisionId || null,
  }, options);
  interruptAt(options, 'sequence-created');

  let workingScene = beforeScene;
  let finalScene = null;
  const stepRecords = [];
  const sceneRefs = [beforeScene.sceneId];
  const screenshotRefs = [beforeScene.screenshot.ref];
  let failure = null;
  let finalCaptureAttempted = false;

  function persistProgress() {
    record = writeSequenceRecord(execDir, {
      ...record,
      steps: stepRecords,
      evidence: { sceneRefs: [...sceneRefs], screenshotRefs: [...screenshotRefs] },
      remainingMs: Math.max(0, deadline - clock()),
      elapsedMs: Math.max(0, clock() - startedMs),
      failure,
    });
  }

  for (let stepIndex = 0; stepIndex < normalized.steps.length; stepIndex += 1) {
    const step = normalized.steps[stepIndex];
    const stepStartedMs = clock();
    const stepDurationMs = () => Math.max(0, clock() - stepStartedMs);
    store.appendEvent(execDir, 'sequenceStepStarted', {
      sequenceId, stepId: step.id, stepIndex, stepType: step.type,
      decisionId: options.decisionId || null,
    }, options);

    if (step.type === 'wait') {
      if (step.ms > usableMs(deadline, clock)) {
        failure = { code: 'SEQUENCE_TIMEOUT', message: `wait step exceeds usable Sequence budget: ${step.id}` };
        stepRecords.push(waitStepRecord(step, stepIndex, workingScene, 'NOT_RUN', failure, stepDurationMs()));
        persistProgress();
        break;
      }
      (options.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)))(step.ms);
      const waitDurationMs = stepDurationMs();
      if (typeof options.onAdapterSpan === 'function') {
        options.onAdapterSpan({
          name: 'sequenceWait', kind: 'WAIT', durationMs: waitDurationMs, explicitWaitMs: step.ms,
        });
      }
      stepRecords.push(waitStepRecord(step, stepIndex, workingScene, 'COMPLETED', null, waitDurationMs));
      persistProgress();
      continue;
    }

    if (step.type === 'capture') {
      const terminalCapture = stepIndex === normalized.steps.length - 1;
      const timeoutMs = terminalCapture && step.mode === 'FULL_SCENE'
        ? deadline - clock() : usableMs(deadline, clock);
      if (timeoutMs <= 0) {
        failure = { code: 'SEQUENCE_TIMEOUT', message: `capture step exceeds usable Sequence budget: ${step.id}` };
        stepRecords.push(captureStepRecord(
          step, stepIndex, workingScene, null, 'NOT_RUN', failure, stepDurationMs(),
        ));
        persistProgress();
        break;
      }
      const origins = ['AGENT_REQUESTED', ...(terminalCapture && step.mode === 'FULL_SCENE' ? ['SEQUENCE_FINAL'] : [])];
      let postScene;
      try {
        postScene = step.mode === 'FULL_SCENE'
          ? (() => {
            if (terminalCapture) finalCaptureAttempted = true;
            return fullScene(execDir, options, {
            purpose: step.purpose,
            captureOrigins: origins,
            sequenceId,
            stepId: step.id,
            previousScene: workingScene,
            promote: terminalCapture,
            timeoutMs,
            });
          })()
          : screenshotScene(execDir, execution, options, {
            purpose: step.purpose,
            captureOrigins: origins,
            sequenceId,
            stepId: step.id,
            previousScene: workingScene,
            promote: false,
            timeoutMs,
          });
      } catch (error) {
        failure = { code: error.code || 'SEQUENCE_CAPTURE_FAILED', message: 'Sequence capture step failed' };
        stepRecords.push(captureStepRecord(
          step, stepIndex, workingScene, null, 'FAILED', failure, stepDurationMs(),
        ));
        if (terminalCapture && step.mode === 'FULL_SCENE') {
          recordSequenceFinalCaptureFailure(execDir, record, error, options);
        }
        persistProgress();
        break;
      }
      stepRecords.push(captureStepRecord(
        step, stepIndex, workingScene, postScene, 'COMPLETED', null, stepDurationMs(),
      ));
      uniquePush(sceneRefs, postScene.sceneId);
      uniquePush(screenshotRefs, postScene.screenshot.ref);
      workingScene = postScene;
      if (terminalCapture && step.mode === 'FULL_SCENE') finalScene = postScene;
      persistProgress();
      continue;
    }

    const prepared = preparedActions.get(stepIndex);
    const actionTimeoutMs = usableMs(deadline, clock);
    if (actionTimeoutMs <= 0) {
      failure = { code: 'SEQUENCE_TIMEOUT', message: `sequence has no usable action budget before step ${step.id}` };
      stepRecords.push(actionStepRecord(
        step, stepIndex, null, workingScene, null, prepared.resolvedAction.action,
        'NOT_RUN', failure, stepDurationMs(),
      ));
      persistProgress();
      break;
    }
    const operationId = store.nextId(execDir, 'action');
    let dispatched;
    try {
      dispatched = dispatchAction(execDir, {
        ...prepared.actionRequest,
        basedOnSceneId: workingScene.sceneId,
        sequenceId,
        stepId: step.id,
      }, {
        ...options,
        beforeScene: workingScene,
        resolvedAction: prepared.resolvedAction,
        operationId,
        timeoutMs: actionTimeoutMs,
      });
    } catch (error) {
      if (error.actionOutcome !== 'UNKNOWN' || !error.actionDispatch) throw error;
      const finalTimeoutMs = deadline - clock();
      let postScene = null;
      try {
        finalCaptureAttempted = true;
        if (finalTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before unknown action final capture');
        postScene = fullScene(execDir, options, {
            purpose: 'SEQUENCE_FINAL',
            captureOrigins: ['ACTION_POST', 'SEQUENCE_FINAL'],
            relatedOperationId: operationId,
            sequenceId,
            stepId: step.id,
            previousAction: {
              operationId,
              lifecycle: { status: 'UNKNOWN' },
              action: error.actionDispatch.action,
              command: { status: 'UNKNOWN' },
              deviceExecution: { status: 'UNVERIFIED' },
            },
            previousScene: workingScene,
            promote: true,
            timeoutMs: finalTimeoutMs,
        });
      } catch (captureError) {
        const fact = recordCaptureFailureTechnicalFact(
          execDir, operationId, {
            ...error.actionDispatch, sequenceId, stepId: step.id,
          }, error.actionDispatch.action, captureError, options,
        );
        completeUnknownDispatchedAction(execDir, {
          ...error.actionDispatch, operationId, code: error.code, message: error.message,
        }, null, {
          decisionId: options.decisionId || null, sequenceId, stepId: step.id, preSceneRef: workingScene.sceneId,
        }, { ...options, promoteScene: true, captureFailureTechnicalFactRef: fact.technicalFactRef });
        failure = { code: 'SEQUENCE_ACTION_OUTCOME_UNKNOWN', message: 'action outcome and final Scene are unknown' };
        stepRecords.push(actionStepRecord(step, stepIndex, operationId, workingScene, null,
          error.actionDispatch.action, 'UNKNOWN', failure, stepDurationMs()));
        persistProgress();
        break;
      }
      const action = completeUnknownDispatchedAction(execDir, {
        ...error.actionDispatch, operationId, code: error.code, message: error.message,
      }, postScene, {
        decisionId: options.decisionId || null, sequenceId, stepId: step.id, preSceneRef: workingScene.sceneId,
      }, { ...options, promoteScene: true });
      finalScene = postScene;
      uniquePush(sceneRefs, postScene?.sceneId);
      uniquePush(screenshotRefs, postScene?.screenshot?.ref);
      failure = { code: 'SEQUENCE_ACTION_OUTCOME_UNKNOWN', message: 'action outcome is unknown' };
      stepRecords.push(actionStepRecord(
        step, stepIndex, operationId, workingScene, postScene, action, 'UNKNOWN', failure, stepDurationMs(),
      ));
      persistProgress();
      break;
    }

    if (dispatched.status !== 'ACTION_DISPATCHED') throw incomplete(`prevalidated action did not dispatch: ${step.id}`);
    const outcome = classifyActionOutcome(dispatched.adapterResult);
    const actionMustTerminate = outcome !== 'COMPLETED';
    const adjacentCapture = !actionMustTerminate && normalized.steps[stepIndex + 1]?.type === 'capture'
      ? normalized.steps[stepIndex + 1] : null;
    const captureStepIndex = adjacentCapture ? stepIndex + 1 : null;
    const captureIsTerminal = captureStepIndex === normalized.steps.length - 1;
    let postScene;
    let automaticCaptureFailed = false;
    let explicitCaptureFailed = false;
    const adjacentCaptureStartedMs = adjacentCapture ? clock() : null;
    let adjacentCaptureDurationMs = null;

    try {
      if (adjacentCapture) {
        const captureTimeoutMs = captureIsTerminal && adjacentCapture.mode === 'FULL_SCENE'
          ? deadline - clock() : usableMs(deadline, clock);
        if (captureTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', `capture step exceeds Sequence budget: ${adjacentCapture.id}`);
        const origins = ['AGENT_REQUESTED', 'ACTION_POST',
          ...(captureIsTerminal && adjacentCapture.mode === 'FULL_SCENE' ? ['SEQUENCE_FINAL'] : [])];
        postScene = adjacentCapture.mode === 'FULL_SCENE'
          ? (() => {
            if (captureIsTerminal) finalCaptureAttempted = true;
            return fullScene(execDir, options, {
            purpose: adjacentCapture.purpose,
            captureOrigins: origins,
            relatedOperationId: operationId,
            sequenceId,
            stepId: adjacentCapture.id,
            previousAction: dispatchedPreviousAction(dispatched),
            previousScene: workingScene,
            promote: captureIsTerminal,
            timeoutMs: captureTimeoutMs,
            });
          })()
          : screenshotScene(execDir, execution, options, {
            purpose: adjacentCapture.purpose,
            captureOrigins: origins,
            relatedOperationId: operationId,
            sequenceId,
            stepId: adjacentCapture.id,
            previousAction: dispatchedPreviousAction(dispatched),
            previousScene: workingScene,
            promote: false,
            timeoutMs: captureTimeoutMs,
          });
        adjacentCaptureDurationMs = Math.max(0, clock() - adjacentCaptureStartedMs);
        if (captureIsTerminal && adjacentCapture.mode === 'FULL_SCENE') finalScene = postScene;
      } else if (actionMustTerminate || stepIndex === normalized.steps.length - 1) {
        const finalTimeoutMs = deadline - clock();
        if (finalTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before final Scene capture');
        finalCaptureAttempted = true;
        postScene = fullScene(execDir, options, {
          purpose: 'SEQUENCE_FINAL',
          captureOrigins: ['ACTION_POST', 'SEQUENCE_FINAL'],
          relatedOperationId: operationId,
          sequenceId,
          stepId: step.id,
          previousAction: dispatchedPreviousAction(dispatched),
          previousScene: workingScene,
          promote: true,
          preAdapterDelayMs: dispatched.action.action.type === 'wait' ? 0 : 500,
          timeoutMs: finalTimeoutMs,
        });
        finalScene = postScene;
      } else {
        const captureTimeoutMs = usableMs(deadline, clock);
        if (captureTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', `sequence has no capture budget after step ${step.id}`);
        postScene = screenshotScene(execDir, execution, options, {
          purpose: 'ACTION_POST',
          captureOrigins: ['ACTION_POST'],
          relatedOperationId: operationId,
          sequenceId,
          stepId: step.id,
          previousAction: dispatchedPreviousAction(dispatched),
          previousScene: workingScene,
          promote: false,
          timeoutMs: captureTimeoutMs,
        });
      }
    } catch (captureError) {
      if (adjacentCapture) {
        adjacentCaptureDurationMs = Math.max(0, clock() - adjacentCaptureStartedMs);
      }
      if (adjacentCapture && !finalCaptureAttempted) {
        explicitCaptureFailed = true;
        try {
          const finalTimeoutMs = deadline - clock();
          if (finalTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before final Scene capture');
          finalCaptureAttempted = true;
          postScene = fullScene(execDir, options, {
            purpose: 'SEQUENCE_FINAL',
            captureOrigins: ['ACTION_POST', 'SEQUENCE_FINAL'],
            relatedOperationId: operationId,
            sequenceId,
            stepId: step.id,
            previousAction: dispatchedPreviousAction(dispatched),
            previousScene: workingScene,
            promote: true,
            timeoutMs: finalTimeoutMs,
          });
          finalScene = postScene;
          failure = { code: captureError.code || 'SEQUENCE_CAPTURE_FAILED', message: 'Sequence explicit capture failed' };
        } catch (finalError) {
          recordSequenceFinalCaptureFailure(execDir, record, finalError, options);
        }
      }
      const wasIntermediateAutomaticCapture = !actionMustTerminate
        && !adjacentCapture && stepIndex !== normalized.steps.length - 1;
      if (wasIntermediateAutomaticCapture) {
        automaticCaptureFailed = true;
        try {
          const finalTimeoutMs = deadline - clock();
          if (finalTimeoutMs > 0) {
            finalCaptureAttempted = true;
            postScene = fullScene(execDir, options, {
              purpose: 'SEQUENCE_FINAL',
              captureOrigins: ['ACTION_POST', 'SEQUENCE_FINAL'],
              relatedOperationId: operationId,
              sequenceId,
              stepId: step.id,
              previousAction: dispatchedPreviousAction(dispatched),
              previousScene: workingScene,
              promote: true,
              timeoutMs: finalTimeoutMs,
            });
            finalScene = postScene;
            failure = {
              code: captureError.code || 'POST_ACTION_CAPTURE_FAILED',
              message: 'automatic post-action capture failed; Sequence stopped after final handoff',
            };
          }
        } catch (finalError) {
          recordSequenceFinalCaptureFailure(execDir, record, finalError, options);
          postScene = null;
        }
      }
      if (!postScene) {
        const fact = recordCaptureFailureTechnicalFact(
          execDir, operationId, {
            decisionId: options.decisionId || null, sequenceId, stepId: step.id,
          }, dispatched.action.action, captureError, options,
        );
        const action = completeDispatchedAction(execDir, dispatched, null, {
          decisionId: options.decisionId || null, sequenceId, stepId: step.id, preSceneRef: workingScene.sceneId,
        }, { ...options, promoteScene: false, captureFailureTechnicalFactRef: fact.technicalFactRef });
        failure = { code: captureError.code || 'POST_ACTION_CAPTURE_FAILED', message: 'post-action capture failed' };
        stepRecords.push(actionStepRecord(
          step, stepIndex, operationId, workingScene, null, action, 'FAILED', failure, stepDurationMs(),
        ));
        if (adjacentCapture) {
          stepRecords.push(captureStepRecord(
            adjacentCapture, captureStepIndex, workingScene, null, 'FAILED', failure,
            adjacentCaptureDurationMs,
          ));
        }
        persistProgress();
        break;
      }
    }

    interruptAt(options, 'post-scene-persisted');
    const action = completeDispatchedAction(execDir, dispatched, postScene, {
      decisionId: options.decisionId || null,
      sequenceId,
      stepId: step.id,
      preSceneRef: workingScene.sceneId,
    }, { ...options, promoteScene: finalScene?.sceneId === postScene.sceneId });
    interruptAt(options, 'action-transaction-completed');
    stepRecords.push(actionStepRecord(
      step, stepIndex, operationId, workingScene, postScene, action,
      outcome === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
      outcome === 'COMPLETED' ? null : { code: 'SEQUENCE_ACTION_FAILED', message: 'device reported a known action failure' },
      stepDurationMs(),
    ));
    uniquePush(sceneRefs, postScene.sceneId);
    uniquePush(screenshotRefs, postScene.screenshot.ref);
    const actionBeforeScene = workingScene;
    workingScene = postScene;

    if (adjacentCapture) {
      stepRecords.push(captureStepRecord(adjacentCapture, captureStepIndex, actionBeforeScene,
        explicitCaptureFailed ? null : postScene, explicitCaptureFailed ? 'FAILED' : 'COMPLETED',
        explicitCaptureFailed ? failure : null, adjacentCaptureDurationMs));
      stepIndex += 1;
    }
    if (outcome !== 'COMPLETED') {
      failure = { code: 'SEQUENCE_ACTION_FAILED', message: 'device reported a known action failure' };
      persistProgress();
      break;
    }
    if (automaticCaptureFailed || explicitCaptureFailed) {
      persistProgress();
      break;
    }
    persistProgress();
  }

  if (!finalScene && !finalCaptureAttempted) {
    try {
      const finalTimeoutMs = deadline - clock();
      if (finalTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before final Scene capture');
      finalCaptureAttempted = true;
      finalScene = fullScene(execDir, options, {
        purpose: 'SEQUENCE_FINAL',
        captureOrigins: ['SEQUENCE_FINAL'],
        sequenceId,
        previousScene: workingScene,
        promote: true,
        timeoutMs: finalTimeoutMs,
      });
      uniquePush(sceneRefs, finalScene.sceneId);
      uniquePush(screenshotRefs, finalScene.screenshot.ref);
    } catch (error) {
      failure ||= { code: error.code || 'SEQUENCE_FINAL_CAPTURE_FAILED', message: 'final Scene capture failed' };
      recordSequenceFinalCaptureFailure(execDir, record, error, options);
    }
  }

  interruptAt(options, 'sequence-final-scene-persisted');

  record = writeSequenceRecord(execDir, {
    ...record,
    terminal: true,
    status: failure ? 'SEQUENCE_PARTIAL' : 'SEQUENCE_COMPLETED',
    outcomeKnown: failure?.code !== 'SEQUENCE_ACTION_OUTCOME_UNKNOWN',
    endedAt: now(options),
    elapsedMs: Math.max(0, clock() - startedMs),
    steps: stepRecords,
    evidence: {
      sceneRefs: [...new Set(sceneRefs)],
      screenshotRefs: [...new Set(screenshotRefs)],
    },
    finalSceneRef: finalScene?.sceneId || null,
    remainingMs: Math.max(0, deadline - clock()),
    technicalFacts: sequenceTechnicalFactRefs(execDir, sequenceId),
    failure,
  });
  interruptAt(options, 'sequence-terminal-record-persisted');
  store.appendEvent(execDir, 'sequenceCompleted', {
    sequenceId,
    status: record.status,
    outcomeKnown: record.outcomeKnown,
    finalSceneRef: finalScene?.sceneId || null,
    sequenceRecordRef: recordRef,
    recordSha256: record.integrity.recordSha256,
    elapsedMs: record.elapsedMs,
    failure: record.failure,
    decisionId: options.decisionId || null,
  }, options);
  return responseFromSequenceRecord(record);
}

function sequenceDrafts(execDir, sequenceId) {
  const directory = store.paths(execDir).transactions;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith('action-') && name.endsWith('.draft.json'))
    .map((name) => readJson(path.join(directory, name), null))
    .filter((draft) => draft?.sequenceId === sequenceId);
}

function completedSequenceActions(execDir, sequenceId) {
  const directory = store.paths(execDir).operations;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^action-[0-9]+\.json$/.test(name))
    .map((name) => transactions.readCompletedAction(execDir, path.basename(name, '.json')))
    .filter((action) => action?.sequenceId === sequenceId);
}

function sequenceScenes(execDir, sequenceId) {
  return store.events(execDir)
    .filter((event) => event.type === 'sceneObserved' && event.sequenceId === sequenceId)
    .map((event) => readScene(execDir, event.sceneId))
    .filter(Boolean);
}

function recoveryPreviousAction(draft, unknown) {
  return {
    operationId: draft.operationId,
    lifecycle: { status: unknown ? 'UNKNOWN' : classifyActionOutcome(draft.deviceResult || {}) },
    action: draft.action,
    command: unknown ? { status: 'UNKNOWN' } : draft.deviceResult?.command,
    deviceExecution: unknown ? { status: 'UNVERIFIED' } : draft.deviceResult?.deviceExecution,
  };
}

function recoveryRemainingMs(record, options = {}) {
  const clock = options.clock || Date.now;
  return Math.max(0, record.deadlineMs - clock());
}

function recoveryFinalScene(execDir, record, previousScene, draft, unknown, options) {
  const timeoutMs = recoveryRemainingMs(record, options);
  if (timeoutMs <= 0) {
    throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before recovery Scene capture');
  }
  const metadata = {
    purpose: 'SEQUENCE_FINAL_RECOVERY',
    captureOrigins: draft ? ['ACTION_POST', 'SEQUENCE_FINAL'] : ['SEQUENCE_FINAL'],
    sequenceId: record.sequenceId,
    stepId: draft?.stepId || null,
    previousScene,
    promote: true,
    timeoutMs,
  };
  if (draft) {
    metadata.relatedOperationId = draft.operationId;
    metadata.previousAction = recoveryPreviousAction(draft, unknown);
  }
  return fullScene(execDir, options, metadata);
}

function recoveredActionStep(record, draft, beforeScene, afterScene, action, status, error) {
  const stepIndex = record.request.steps.findIndex((step) => step.id === draft.stepId);
  const step = record.request.steps[stepIndex];
  if (!step || step.type !== 'act') throw incomplete(`sequence recovery cannot resolve action step: ${draft.stepId}`);
  return actionStepRecord(step, stepIndex, draft.operationId, beforeScene, afterScene, action, status, error);
}

function recoverClosedActionStep(execDir, record, stepRecords) {
  const recordedOperations = new Set(stepRecords.map((step) => step.operationId).filter(Boolean));
  const orphaned = completedSequenceActions(execDir, record.sequenceId)
    .filter((action) => !recordedOperations.has(action.operationId));
  if (!orphaned.length) return null;
  if (orphaned.length !== 1) {
    throw incomplete(`sequence has multiple completed actions without step records: ${record.sequenceId}`);
  }
  const completed = orphaned[0];
  const stepIndex = record.request.steps.findIndex((step) => step.id === completed.stepId);
  const step = record.request.steps[stepIndex];
  if (!step || step.type !== 'act' || stepIndex !== stepRecords.length) {
    throw incomplete(`sequence completed action is not the next request step: ${completed.stepId}`);
  }
  const beforeScene = readScene(execDir, completed.sceneId);
  const afterScene = completed.sceneIdAfter ? readScene(execDir, completed.sceneIdAfter) : null;
  if (!beforeScene || completed.sceneIdAfter && !afterScene) {
    throw incomplete(`sequence completed action Scene is missing: ${completed.operationId}`);
  }
  const unknown = completed.outcomeKnown === false || completed.outcome === 'UNKNOWN'
    || completed.actionResult?.outcomeKnown === false;
  const failed = !unknown && (completed.outcome === 'FAILED'
    || completed.actionResult?.lifecycle?.status === 'FAILED');
  const status = unknown ? 'UNKNOWN' : failed ? 'FAILED' : 'COMPLETED';
  const error = unknown
    ? { code: 'SEQUENCE_ACTION_OUTCOME_UNKNOWN', message: 'action outcome is unknown after interruption' }
    : failed ? { code: 'SEQUENCE_ACTION_FAILED', message: 'device reported a known action failure' } : null;
  const steps = [actionStepRecord(
    step, stepIndex, completed.operationId, beforeScene, afterScene,
    completed.actionResult || completed.action, status, error,
  )];
  let recoveryError = error;
  const adjacentCapture = record.request.steps[stepIndex + 1];
  if (status === 'COMPLETED' && adjacentCapture?.type === 'capture') {
    const origins = afterScene?.captureOrigins || [];
    const explicitCaptureCompleted = afterScene?.stepId === adjacentCapture.id
      && afterScene.relatedOperationId === completed.operationId
      && origins.includes('AGENT_REQUESTED') && origins.includes('ACTION_POST');
    const fallbackFinalScene = afterScene?.stepId === step.id
      && afterScene.relatedOperationId === completed.operationId
      && origins.includes('ACTION_POST') && origins.includes('SEQUENCE_FINAL')
      && !origins.includes('AGENT_REQUESTED');
    if (explicitCaptureCompleted) {
      steps.push(captureStepRecord(adjacentCapture, stepIndex + 1, beforeScene, afterScene));
    } else if (fallbackFinalScene) {
      recoveryError = {
        code: 'SEQUENCE_CAPTURE_FAILED',
        message: 'adjacent capture failed before the final Scene handoff',
      };
      steps.push(captureStepRecord(
        adjacentCapture, stepIndex + 1, beforeScene, null, 'FAILED', recoveryError,
      ));
    } else {
      throw incomplete(`sequence adjacent capture cannot be reconstructed: ${adjacentCapture.id}`);
    }
  }
  return {
    afterScene,
    status,
    error: recoveryError,
    steps,
  };
}

function terminalizeRecoveredSequence(execDir, record, update, options) {
  const finalRecord = writeSequenceRecord(execDir, {
    ...record,
    terminal: true,
    status: 'SEQUENCE_INTERRUPTED',
    endedAt: now(options),
    remainingMs: recoveryRemainingMs(record, options),
    technicalFacts: sequenceTechnicalFactRefs(execDir, record.sequenceId),
    ...update,
  });
  const terminalEvent = store.events(execDir).find((event) => (
    ['sequenceCompleted', 'sequenceInterrupted'].includes(event.type)
      && event.sequenceId === record.sequenceId
  ));
  if (!terminalEvent) {
    store.appendEvent(execDir, 'sequenceInterrupted', {
      sequenceId: record.sequenceId,
      status: finalRecord.status,
      outcomeKnown: finalRecord.outcomeKnown,
      finalSceneRef: finalRecord.finalSceneRef,
      sequenceRecordRef: finalRecord.sequenceRecordRef,
      recordSha256: finalRecord.integrity.recordSha256,
      elapsedMs: finalRecord.elapsedMs,
      failure: finalRecord.failure || null,
      decisionId: finalRecord.decisionId || null,
    }, options);
  }
  assertSequenceIntegrity(execDir, finalRecord);
  return finalRecord;
}

function repairSequenceBoundaryEvents(execDir, record, options) {
  assertSequenceIntegrity(execDir, record);
  const events = store.events(execDir);
  const requested = events.filter((event) => event.type === 'sequenceRequested'
    && event.sequenceId === record.sequenceId);
  const terminal = events.filter((event) => ['sequenceCompleted', 'sequenceInterrupted'].includes(event.type)
    && event.sequenceId === record.sequenceId);
  if (requested.length > 1 || requested[0] && (requested[0].requestKey !== record.requestKey
    || requested[0].sequenceRecordRef !== record.sequenceRecordRef)
    || terminal.length > 1 || terminal[0] && (record.terminal !== true
      || terminal[0].status !== record.status
      || terminal[0].recordSha256 !== record.integrity.recordSha256
      || terminal[0].sequenceRecordRef !== record.sequenceRecordRef)) {
    throw incomplete(`sequence boundary events are invalid: ${record.sequenceId}`);
  }
  if (!requested.length) {
    store.appendEvent(execDir, 'sequenceRequested', {
      sequenceId: record.sequenceId,
      requestKey: record.requestKey,
      basedOnSceneRef: record.basedOnSceneRef,
      sequenceRecordRef: record.sequenceRecordRef,
      decisionId: record.decisionId || null,
    }, options);
  }
  if (record.terminal !== true || terminal.length) return false;
  store.appendEvent(execDir, record.status === 'SEQUENCE_INTERRUPTED' ? 'sequenceInterrupted' : 'sequenceCompleted', {
    sequenceId: record.sequenceId,
    status: record.status,
    outcomeKnown: record.outcomeKnown,
    finalSceneRef: record.finalSceneRef,
    sequenceRecordRef: record.sequenceRecordRef,
    recordSha256: record.integrity.recordSha256,
    elapsedMs: record.elapsedMs,
    failure: record.failure || null,
    decisionId: record.decisionId || null,
  }, options);
  return true;
}

function recoverInterruptedSequences(execDir, options = {}) {
  const recovered = [];
  for (const storedRecord of readSequences(execDir)) {
    repairSequenceBoundaryEvents(execDir, storedRecord, options);
    if (storedRecord.terminal === true) {
      continue;
    }
    let record = assertSequenceIntegrity(execDir, storedRecord);
    const drafts = sequenceDrafts(execDir, record.sequenceId);
    if (drafts.length > 1) throw incomplete(`sequence has multiple pending action transactions: ${record.sequenceId}`);
    const draft = drafts[0] || null;
    const scenes = sequenceScenes(execDir, record.sequenceId);
    let finalScene = scenes.filter((scene) => (scene.captureOrigins || []).includes('SEQUENCE_FINAL')).at(-1) || null;
    const stepRecords = [...(record.steps || [])];
    const sceneRefs = new Set(record.evidence?.sceneRefs || [record.basedOnSceneRef]);
    const screenshotRefs = new Set(record.evidence?.screenshotRefs || []);
    let failure = record.failure || { code: 'SEQUENCE_INTERRUPTED', message: 'Sequence stopped after Runtime interruption' };
    let outcomeKnown = record.outcomeKnown !== false;
    let captureAttempted = false;

    if (!draft) {
      const closed = recoverClosedActionStep(execDir, record, stepRecords);
      if (closed) {
        stepRecords.push(...closed.steps);
        if (closed.afterScene) {
          sceneRefs.add(closed.afterScene.sceneId);
          if (closed.afterScene.screenshot?.ref) screenshotRefs.add(closed.afterScene.screenshot.ref);
          if ((closed.afterScene.captureOrigins || []).includes('SEQUENCE_FINAL')) finalScene = closed.afterScene;
        }
        if (closed.error) {
          failure = closed.error;
          outcomeKnown = closed.status !== 'UNKNOWN';
        }
      }
    }

    if (draft) {
      const beforeScene = readScene(execDir, draft.sceneId);
      if (!beforeScene) throw incomplete(`sequence action basis Scene is missing: ${draft.operationId}`);
      if (draft.status === 'PREPARED') {
        const stepIndex = record.request.steps.findIndex((step) => step.id === draft.stepId);
        const step = record.request.steps[stepIndex];
        if (!step || step.type !== 'act') throw incomplete(`sequence recovery cannot resolve prepared step: ${draft.stepId}`);
        fs.unlinkSync(transactions.actionDraftPath(execDir, draft.operationId));
        stepRecords.push({
          stepId: step.id,
          stepIndex,
          type: 'act',
          status: 'NOT_SENT',
          operationId: draft.operationId,
          preSceneRef: beforeScene.sceneId,
          postSceneRef: null,
          action: draft.action,
          error: failure,
        });
      } else if (['DISPATCHED', 'RESULT_RECORDED', 'OBSERVED'].includes(draft.status)) {
        const unknown = draft.status === 'DISPATCHED' || draft.outcomeKnown === false;
        let postScene = scenes.filter((scene) => scene.relatedOperationId === draft.operationId).at(-1) || null;
        if (!postScene && draft.sceneIdAfter) postScene = readScene(execDir, draft.sceneIdAfter);
        if (!postScene && draft.status !== 'OBSERVED') {
          captureAttempted = true;
          try {
            postScene = recoveryFinalScene(execDir, record, beforeScene, draft, unknown, options);
          } catch (error) {
            const fact = recordCaptureFailureTechnicalFact(execDir, draft.operationId, {
              decisionId: draft.decisionId || record.decisionId || null,
              sequenceId: record.sequenceId,
              stepId: draft.stepId,
            }, draft.action, error, options);
            const completionOptions = {
              ...options,
              promoteScene: true,
              captureFailureTechnicalFactRef: fact.technicalFactRef,
            };
            if (unknown) {
              completeUnknownDispatchedAction(execDir, {
                operationId: draft.operationId,
                beforeScene,
                action: draft.action,
                code: 'ACTION_OUTCOME_UNKNOWN_AFTER_INTERRUPTION',
                message: 'action dispatch completed without a recorded device result',
              }, null, {
                sequenceId: record.sequenceId, stepId: draft.stepId, preSceneRef: beforeScene.sceneId,
              }, completionOptions);
            } else {
              completeDispatchedAction(execDir, {
                operationId: draft.operationId,
                beforeScene,
                action: { action: draft.action },
                adapterResult: draft.deviceResult,
              }, null, {
                sequenceId: record.sequenceId, stepId: draft.stepId, preSceneRef: beforeScene.sceneId,
              }, completionOptions);
            }
            const code = unknown ? 'SEQUENCE_ACTION_OUTCOME_UNKNOWN' : 'POST_ACTION_CAPTURE_FAILED';
            failure = { code, message: 'Sequence recovery could not capture the final Scene' };
            outcomeKnown = !unknown;
            stepRecords.push(recoveredActionStep(
              record, draft, beforeScene, null, draft.action, unknown ? 'UNKNOWN' : 'FAILED', failure,
            ));
          }
        }

        if (postScene) {
          let action;
          if (draft.status === 'OBSERVED') {
            action = postScene.previousAction || draft.actionResult || { action: draft.action };
            transactions.completeAction(execDir, draft, { actionResult: action, recoveredAfterInterruption: true });
          } else if (unknown) {
            action = completeUnknownDispatchedAction(execDir, {
              operationId: draft.operationId,
              beforeScene,
              action: draft.action,
              code: 'ACTION_OUTCOME_UNKNOWN_AFTER_INTERRUPTION',
              message: 'action dispatch completed without a recorded device result',
            }, postScene, {
              sequenceId: record.sequenceId, stepId: draft.stepId, preSceneRef: beforeScene.sceneId,
            }, { ...options, promoteScene: (postScene.captureOrigins || []).includes('SEQUENCE_FINAL') });
          } else {
            action = completeDispatchedAction(execDir, {
              operationId: draft.operationId,
              beforeScene,
              action: { action: draft.action },
              adapterResult: draft.deviceResult,
            }, postScene, {
              sequenceId: record.sequenceId, stepId: draft.stepId, preSceneRef: beforeScene.sceneId,
            }, { ...options, promoteScene: (postScene.captureOrigins || []).includes('SEQUENCE_FINAL') });
          }
          const status = unknown ? 'UNKNOWN'
            : classifyActionOutcome(draft.deviceResult || action) === 'FAILED' ? 'FAILED' : 'COMPLETED';
          if (unknown) {
            failure = { code: 'SEQUENCE_ACTION_OUTCOME_UNKNOWN', message: 'action outcome is unknown after interruption' };
            outcomeKnown = false;
          }
          stepRecords.push(recoveredActionStep(record, draft, beforeScene, postScene, action, status,
            status === 'COMPLETED' ? null : failure));
          sceneRefs.add(postScene.sceneId);
          if (postScene.screenshot?.ref) screenshotRefs.add(postScene.screenshot.ref);
          if ((postScene.captureOrigins || []).includes('SEQUENCE_FINAL')) finalScene = postScene;
        }
      } else {
        throw incomplete(`sequence action draft has unsupported state: ${draft.status}`);
      }
    }

    if (!finalScene && !captureAttempted) {
      captureAttempted = true;
      const previousScene = scenes.at(-1) || readScene(execDir, record.basedOnSceneRef);
      try {
        finalScene = recoveryFinalScene(execDir, record, previousScene, null, false, options);
      } catch (error) {
        recordSequenceFinalCaptureFailure(execDir, record, error, options);
      }
    }
    if (finalScene) {
      sceneRefs.add(finalScene.sceneId);
      if (finalScene.screenshot?.ref) screenshotRefs.add(finalScene.screenshot.ref);
    }

    record = terminalizeRecoveredSequence(execDir, record, {
      steps: stepRecords.sort((left, right) => left.stepIndex - right.stepIndex),
      evidence: { sceneRefs: [...sceneRefs], screenshotRefs: [...screenshotRefs] },
      finalSceneRef: finalScene?.sceneId || null,
      outcomeKnown,
      failure,
    }, options);
    recovered.push({
      kind: 'sequence',
      sequenceId: record.sequenceId,
      status: record.status,
      response: responseFromSequenceRecord(record),
    });
  }
  return recovered;
}

module.exports = {
  assertSequenceIntegrity,
  findSequence,
  findTerminalSequence,
  persistSequenceScreenshotScene,
  readSequences,
  recoverInterruptedSequences,
  responseFromSequenceRecord,
  runSequence,
  sequencePath,
  writeSequenceRecord,
};

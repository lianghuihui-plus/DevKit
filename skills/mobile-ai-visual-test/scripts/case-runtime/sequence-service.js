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
  dispatchAction,
} = require('./action-service');
const sceneService = require('./scene-service');
const store = require('./store');

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

function assertSequenceIntegrity(execDir, record) {
  if (!record || record.schemaVersion !== 1) throw incomplete('sequence record schema is invalid');
  validSequenceId(record.sequenceId);
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
  return record;
}

function findTerminalSequence(execDir, request) {
  const requestKey = sequenceRequestKey(request);
  const matches = readSequences(execDir).filter((record) => record.requestKey === requestKey);
  if (!matches.length) return null;
  if (matches.length !== 1) throw incomplete('multiple sequence records share the same request key');
  const record = assertSequenceIntegrity(execDir, matches[0]);
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

function runSequence(execDir, request, options = {}) {
  const existing = findTerminalSequence(execDir, request);
  if (existing) return responseFromSequenceRecord(existing, { idempotent: true });

  const normalized = normalizeSequenceRequest(request);
  if (!normalized.steps.every((step) => step.type === 'act')) {
    throw contractError('SEQUENCE_NOT_IMPLEMENTED', 'this runtime revision supports act-only sequences');
  }

  const execution = store.loadExecution(execDir);
  const beforeScene = store.readCurrentScene(execDir);
  if (!beforeScene || beforeScene.sceneId !== normalized.basedOnSceneId) return sceneChanged(beforeScene);

  const preparedActions = normalized.steps.map((step) => {
    const actionRequest = actionRequestFor(
      step, beforeScene.sceneId, normalized.purpose, options.decisionId,
    );
    const resolvedAction = resolveActionRequest(beforeScene, actionRequest, execution.platform);
    return { step, actionRequest, resolvedAction };
  });
  if (preparedActions.some(({ resolvedAction }) => resolvedAction.stale)) return sceneChanged(beforeScene);

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
    remainingMs: durationMs,
    technicalFacts: [],
    failure: null,
  });
  store.appendEvent(execDir, 'sequenceRequested', {
    sequenceId,
    requestKey: record.requestKey,
    basedOnSceneRef: beforeScene.sceneId,
    sequenceRecordRef: recordRef,
    decisionId: options.decisionId || null,
  }, options);

  let workingScene = beforeScene;
  let finalScene = null;
  const stepRecords = [];
  const sceneRefs = [beforeScene.sceneId];
  const screenshotRefs = [beforeScene.screenshot.ref];

  for (const [stepIndex, prepared] of preparedActions.entries()) {
    const { step, actionRequest, resolvedAction } = prepared;
    const actionTimeoutMs = deadline - clock() - FINAL_SCENE_RESERVE_MS;
    if (actionTimeoutMs <= 0) {
      throw contractError('SEQUENCE_TIMEOUT', `sequence has no usable action budget before step ${step.id}`);
    }
    const operationId = store.nextId(execDir, 'action');
    const dispatched = dispatchAction(execDir, {
      ...actionRequest,
      basedOnSceneId: workingScene.sceneId,
      sequenceId,
      stepId: step.id,
    }, {
      ...options,
      beforeScene: workingScene,
      resolvedAction,
      operationId,
      timeoutMs: actionTimeoutMs,
    });
    if (dispatched.status !== 'ACTION_DISPATCHED') {
      throw contractError('SEQUENCE_NOT_IMPLEMENTED', `prevalidated action did not dispatch: ${step.id}`);
    }
    if (classifyActionOutcome(dispatched.adapterResult) !== 'COMPLETED') {
      throw contractError('SEQUENCE_NOT_IMPLEMENTED', 'action failure completion is not implemented in this runtime revision');
    }

    const terminalAction = stepIndex === preparedActions.length - 1;
    let postScene;
    if (terminalAction) {
      const finalTimeoutMs = deadline - clock();
      if (finalTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before final Scene capture');
      sceneService.observe(execDir, {
        ...options,
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
      postScene = store.readCurrentScene(execDir);
      finalScene = postScene;
    } else {
      const captureTimeoutMs = deadline - clock() - FINAL_SCENE_RESERVE_MS;
      if (captureTimeoutMs <= 0) {
        throw contractError('SEQUENCE_TIMEOUT', `sequence has no capture budget after step ${step.id}`);
      }
      const captureOperationId = store.nextId(execDir, 'capture');
      const capture = options.invokeScreenshotCapture
        || (options.invokeDeviceOperation
          ? (dir, payload, captureOptions) => options.invokeDeviceOperation(dir, payload, 'CAPTURE', captureOptions)
          : invokeScreenshotCapture);
      const invoked = capture(execDir, {
        context: { execution }, operationId: captureOperationId,
      }, { ...options, timeoutMs: captureTimeoutMs });
      postScene = persistSequenceScreenshotScene(execDir, invoked, execution, {
        operationId: captureOperationId,
        purpose: 'ACTION_POST',
        captureOrigins: ['ACTION_POST'],
        relatedOperationId: operationId,
        sequenceId,
        stepId: step.id,
        previousAction: dispatchedPreviousAction(dispatched),
        beforeScene: workingScene,
        decisionId: options.decisionId || null,
      }, { promote: false, now: now(options) });
    }

    const action = completeDispatchedAction(execDir, dispatched, postScene, {
      decisionId: options.decisionId || null,
      sequenceId,
      stepId: step.id,
      preSceneRef: workingScene.sceneId,
    }, { ...options, promoteScene: terminalAction });
    stepRecords.push({
      stepId: step.id,
      stepIndex,
      type: 'act',
      status: 'COMPLETED',
      operationId,
      preSceneRef: workingScene.sceneId,
      postSceneRef: postScene.sceneId,
      action: action.action,
    });
    sceneRefs.push(postScene.sceneId);
    screenshotRefs.push(postScene.screenshot.ref);
    workingScene = postScene;
    record = writeSequenceRecord(execDir, {
      ...record,
      steps: stepRecords,
      evidence: {
        sceneRefs: [...new Set(sceneRefs)],
        screenshotRefs: [...new Set(screenshotRefs)],
      },
      remainingMs: Math.max(0, deadline - clock()),
    });
  }

  record = writeSequenceRecord(execDir, {
    ...record,
    terminal: true,
    status: 'SEQUENCE_COMPLETED',
    endedAt: now(options),
    steps: stepRecords,
    evidence: {
      sceneRefs: [...new Set(sceneRefs)],
      screenshotRefs: [...new Set(screenshotRefs)],
    },
    finalSceneRef: finalScene.sceneId,
    remainingMs: Math.max(0, deadline - clock()),
  });
  store.appendEvent(execDir, 'sequenceCompleted', {
    sequenceId,
    status: record.status,
    finalSceneRef: finalScene.sceneId,
    sequenceRecordRef: recordRef,
    decisionId: options.decisionId || null,
  }, options);
  return responseFromSequenceRecord(record);
}

module.exports = {
  assertSequenceIntegrity,
  findTerminalSequence,
  persistSequenceScreenshotScene,
  readSequences,
  responseFromSequenceRecord,
  runSequence,
  sequencePath,
  writeSequenceRecord,
};

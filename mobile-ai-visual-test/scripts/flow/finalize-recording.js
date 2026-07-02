#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  nowIso,
  readJson,
  readJsonl,
  writeJson,
  writeText,
} = require('../common');

function usage() {
  console.error('Usage: finalize-recording.js <flow-dir> --recording-id <id> [--status READY|DRAFT|FAILED]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const flowDir = path.resolve(args[0]);
let recordingId = '';
let status = 'READY';

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--recording-id': recordingId = args[++i]; break;
    case '--status': status = args[++i]; break;
    default: usage();
  }
}

if (!recordingId) usage();
if (!['READY', 'DRAFT', 'FAILED'].includes(status)) throw new Error(`Invalid flow status: ${status}`);

const recordingDir = path.join(flowDir, 'recordings', recordingId);
const timelinePath = path.join(recordingDir, 'timeline.jsonl');
const events = readJsonl(timelinePath);
const start = events.find((event) => event.type === 'flowRecordingStart') || {};
const statePath = path.join(flowDir, 'state.json');
const state = readJson(statePath, {});
const flowId = state.flowId || start.flowId;
const name = state.name || start.name || flowId;
const intent = state.intent || start.intent || [];
const recordingPlatform = state.recordingPlatform || start.recordingPlatform || state.environment?.platform || '';
const flowScope = state.flowScope || start.flowScope || 'universal';
const platform = flowScope === 'platform' ? (state.platform || start.platform || recordingPlatform) : undefined;
const steps = buildSteps(events, recordingId);
validateReadyFlow(status, steps);
const endedAt = nowIso();
const flow = {
  schemaVersion: 1,
  id: flowId,
  name,
  intent,
  recordingPlatform,
  flowScope,
  platform,
  status,
  latestRecordingId: recordingId,
  updatedAt: endedAt,
  steps,
  safety: {
    destructive: false,
    requiresConfirmation: false,
  },
};

writeJson(path.join(flowDir, 'flow.json'), flow);
writeText(path.join(flowDir, 'flow.md'), renderFlowMarkdown(flow, status));
writeJson(statePath, {
  ...state,
  schemaVersion: 1,
  flowId,
  name,
  intent,
  recordingPlatform,
  flowScope,
  platform,
  latestRecordingId: recordingId,
  latestStatus: status,
  updatedAt: endedAt,
  stepCount: steps.length,
});
writeText(timelinePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n${JSON.stringify({
  time: endedAt,
  type: 'flowRecordingResult',
  status,
  stepCount: steps.length,
})}\n`);

console.log(JSON.stringify({
  flowDir,
  recordingId,
  flowJson: path.join(flowDir, 'flow.json'),
  flowMd: path.join(flowDir, 'flow.md'),
  stepCount: steps.length,
  status,
}, null, 2));

function buildSteps(events, recordingId) {
  const steps = [];
  const observations = events.filter((event) => event.type === 'observation');
  const actions = events.filter((event) => event.type === 'flowAction');
  for (const [index, actionEvent] of actions.entries()) {
    const before = observations.filter((event) => event.time <= actionEvent.time).at(-1);
    const after = observations.find((event) => event.time > actionEvent.time);
    const actionResult = actionEvent.actionResult || {};
    steps.push({
      id: `flow-step-${String(index + 1).padStart(3, '0')}`,
      humanInstruction: actionEvent.humanInstruction || '',
      beforeObservation: observationRef(before, recordingId),
      action: {
        type: actionEvent.action?.type || actionResult.action,
        x: actionEvent.action?.x || actionResult.x,
        y: actionEvent.action?.y || actionResult.y,
        text: actionEvent.action?.text || actionResult.text,
        fromX: actionEvent.action?.fromX || actionResult.fromX,
        fromY: actionEvent.action?.fromY || actionResult.fromY,
        toX: actionEvent.action?.toX || actionResult.toX,
        toY: actionEvent.action?.toY || actionResult.toY,
        durationMs: actionEvent.action?.durationMs || actionResult.durationMs,
        target: actionEvent.action?.target,
        coordinateSource: actionEvent.action?.coordinateSource || actionResult.coordinateSource,
        targetBounds: actionEvent.action?.targetBounds || actionResult.targetBounds,
        coordinateEvidence: actionEvent.action?.coordinateEvidence || actionResult.coordinateEvidence,
      },
      actionResult: actionResult.type || Object.prototype.hasOwnProperty.call(actionResult, 'ok') ? {
        ok: actionResult.ok,
        failureCode: actionResult.failureCode,
        error: actionResult.error,
      } : undefined,
      afterObservation: observationRef(after, recordingId),
      successHint: actionEvent.successHint,
    });
  }
  return steps;
}

function validateReadyFlow(status, steps) {
  if (status !== 'READY') return;
  if (!steps.length) throw new Error('READY Flow requires at least one recorded step');
  for (const step of steps) {
    if (!step.action?.type) throw new Error(`READY Flow step missing action type: ${step.id}`);
    if (step.actionResult?.ok !== true) throw new Error(`READY Flow step action failed: ${step.id}`);
    if (!step.beforeObservation?.screenshot && !step.beforeObservation?.layout) {
      throw new Error(`READY Flow step missing before observation: ${step.id}`);
    }
    if (!step.afterObservation?.screenshot && !step.afterObservation?.layout) {
      throw new Error(`READY Flow step missing after observation: ${step.id}`);
    }
  }
}

function observationRef(event, recordingId) {
  if (!event) return {};
  const artifacts = event.artifacts || {};
  return {
    screenshot: artifacts.screenshot ? `recordings/${recordingId}/${artifacts.screenshot}` : undefined,
    layout: artifacts.layout ? `recordings/${recordingId}/${artifacts.layout}` : undefined,
  };
}

function renderFlowMarkdown(flow, status) {
  const lines = [];
  lines.push(`# ${flow.name}`);
  lines.push('');
  lines.push(`状态：${status}`);
  lines.push(`Flow ID：${flow.id}`);
  lines.push(`最近录制：${flow.latestRecordingId}`);
  lines.push('');
  lines.push('## 意图');
  if (flow.intent.length) {
    for (const item of flow.intent) lines.push(`- ${item}`);
  } else {
    lines.push('- 未设置');
  }
  lines.push('');
  lines.push('## 步骤');
  if (flow.steps.length) {
    for (const [index, step] of flow.steps.entries()) {
      lines.push(`${index + 1}. ${step.humanInstruction || step.action?.type || step.id}`);
      if (step.successHint) lines.push(`   - 成功提示：${step.successHint}`);
      if (step.beforeObservation?.screenshot) lines.push(`   - 前置截图：${step.beforeObservation.screenshot}`);
      if (step.afterObservation?.screenshot) lines.push(`   - 后置截图：${step.afterObservation.screenshot}`);
    }
  } else {
    lines.push('暂无步骤。');
  }
  return `${lines.join('\n')}\n`;
}

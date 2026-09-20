#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectPreviousAction } = require('../case-runtime/agent-facing-contract');
const { projectAgentFacingResponse, translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-plan-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'agent-plan' });
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({ ...execution, finalized: false, status: 'RUNNING', lifecycle: 'RUNNING' }, null, 2)}\n`);
store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));

const publicRequest = {
  capability: 'runPlan', submissionId: 'run-plan-033-attempt-01', basedOnSceneRef: 'scene-0002',
  purpose: '唤起视频控制栏并解除童锁', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'reveal', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
    { id: 'after', type: 'capture', mode: 'SCREENSHOT_ONLY' },
  ],
};
const translated = translateAgentFacingRequest(fixture.execDir, publicRequest);
assert.deepStrictEqual(translated, {
  operation: 'runPlan', submissionId: publicRequest.submissionId, basedOnSceneId: 'scene-0002',
  purpose: publicRequest.purpose, maxDurationMs: 2500, onFailure: 'STOP', steps: publicRequest.steps,
  decision: { purpose: publicRequest.purpose, expectationRefs: [] },
});

const projected = projectAgentFacingResponse(fixture.execDir, {
  status: 'PLAN_COMPLETED', planId: 'plan-0001', planRecordRef: 'operations/plans/plan-0001.json',
  steps: [{ stepId: 'reveal', type: 'act', status: 'COMPLETED', durationMs: 20, outputRefs: ['action-0002'] }],
  evidence: { sceneRefs: ['scene-0003'], screenshotRefs: ['screenshots/capture-0001.png'], locatorRefs: [], checkRefs: [] },
  technicalFacts: [], remainingMs: 2100,
}, publicRequest);
assert.strictEqual(projected.status, 'PLAN_COMPLETED');
assert.strictEqual(projected.planId, 'plan-0001');
assert.strictEqual(projected.verdict, undefined);
assert.strictEqual(projected.screenComparison, undefined);
assert.strictEqual(JSON.stringify(projected).includes('observedEffect'), false);

const previous = projectPreviousAction({
  operationId: 'action-0001', action: { type: 'tap' }, command: { status: 'ACCEPTED' },
  evidence: { sceneRefs: { before: 'scene-0001', after: 'scene-0002' }, screenshotRefs: ['a.png', 'b.png'] },
  observedEffect: { status: 'CHANGED' },
});
assert.strictEqual(previous.screenComparison, undefined);
assert.deepStrictEqual(previous.evidence.sceneRefs, { before: 'scene-0001', after: 'scene-0002' });

console.log('agent-facing plan passed');

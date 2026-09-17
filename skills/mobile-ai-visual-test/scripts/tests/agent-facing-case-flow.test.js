#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateAgentFacingRequest } = require('../case-runtime/agent-facing-contract');
const { translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const caseFlowService = require('../case-runtime/case-flow-service');
const store = require('../case-runtime/store');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-case-flow-'));
const execDir = path.join(temp, 'execution');
fs.mkdirSync(path.join(execDir, 'scenes'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 12, runtime: 'case-runtime', executionId: 'execution-case-flow-agent',
  platform: 'ios', status: 'RUNNING', finalized: false,
});
const scene = {
  sceneId: 'scene-1', capturedAt: '2026-09-17T02:00:00.000Z',
  screenshot: { ref: 'screenshots/scene-1.png', path: '/tmp/scene-1.png', width: 1, height: 1 },
  app: { inTargetApp: true }, elements: [], scrollContexts: [], visual: { gestures: [] }, signals: {}, conflicts: [],
};
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-1.json'), scene);
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
store.appendEvent(execDir, 'sceneObserved', { sceneId: 'scene-1', screenshotRef: scene.screenshot.ref, app: scene.app });

const caseFlow = {
  baseRevision: null,
  summary: '验证条件分支',
  entryNodeRef: 'N1',
  nodes: [
    { ref: 'N1', type: 'DECISION', text: '是否满足前置条件', sourceBasis: '原始用例前置条件' },
    { ref: 'N2', type: 'CHECK', text: '目标结果可见', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期' },
    { ref: 'N3', type: 'CHECK', text: '可选弹窗正确', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原文若出现则检查' },
    { ref: 'N4', type: 'END', text: '完成' },
  ],
  edges: [
    { ref: 'L1', from: 'N1', to: 'N2', condition: '满足前置条件' },
    { ref: 'L2', from: 'N1', to: 'N3', condition: '进入可选分支' },
    { ref: 'L3', from: 'N2', to: 'N4' },
    { ref: 'L4', from: 'N3', to: 'N4' },
  ],
  uncertainties: [],
};

const plan = { capability: 'plan', caseFlow };
assert.deepStrictEqual(validateAgentFacingRequest(plan), []);
assert.deepStrictEqual(translateAgentFacingRequest(execDir, plan), {
  operation: 'recordCaseFlow', caseFlow,
});
assert.ok(validateAgentFacingRequest({ capability: 'plan', caseModel: {} })
  .some((item) => item.field === 'caseFlow' && item.code === 'REQUIRED'));

caseFlowService.revise(execDir, caseFlow);
assert.deepStrictEqual(translateAgentFacingRequest(execDir, {
  capability: 'observe', purpose: '确认分支', flowContext: { nodeRef: 'N1', selectedEdgeRef: 'L1' },
}), {
  operation: 'observe', flowContext: { nodeRef: 'N1', selectedEdgeRef: 'L1' },
  decision: { purpose: '确认分支', expectationRefs: [] },
});
assert.throws(() => translateAgentFacingRequest(execDir, {
  capability: 'observe', flowContext: { nodeRef: 'N2', selectedEdgeRef: 'L3' },
}), (error) => error?.code === 'AGENT_INPUT_INVALID'
  && error.issues.some((item) => item.code === 'CASE_FLOW_CONTEXT_INVALID'));
assert.deepStrictEqual(validateAgentFacingRequest({
  capability: 'recordResult',
  results: [{ checkNodeRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未进入可选分支', evidence: {} }],
}), []);
assert.deepStrictEqual(translateAgentFacingRequest(execDir, {
  capability: 'recordResult',
  results: [{ checkNodeRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未进入可选分支', evidence: {} }],
}), {
  operation: 'recordExpectationResults',
  results: [{ expectationRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未进入可选分支', evidence: {} }],
});
assert.ok(validateAgentFacingRequest({
  capability: 'recordResult', results: [{ expectationRef: 'N3', status: 'PASS', actual: '可见' }],
}).some((item) => item.field.includes('expectationRef')));

assert.deepStrictEqual(validateAgentFacingRequest({
  capability: 'finish', outcome: 'NOT_RUN', reason: '账号不具备前置条件',
  evidence: { sceneRefs: ['scene-1'], technicalRefs: [] }, summary: '未进入目标业务验证', uncertainties: [],
}), []);
const notRun = translateAgentFacingRequest(execDir, {
  capability: 'finish', outcome: 'NOT_RUN', reason: '账号不具备前置条件',
  evidence: { sceneRefs: ['scene-1'], technicalRefs: [] }, summary: '未进入目标业务验证', uncertainties: [],
});
assert.strictEqual(notRun.result.verdict, 'NOT_RUN');
assert.deepStrictEqual(notRun.result.checks, []);
assert.strictEqual(notRun.result.caseFlowRevision, 1);
assert.deepStrictEqual(notRun.result.notRunEvidence.sceneRefs, ['scene-1']);
assert.ok(validateAgentFacingRequest({
  capability: 'finish', outcome: 'NOT_RUN', reason: '前置条件不满足', summary: '未执行', uncertainties: [],
}).some((item) => item.field === 'evidence' && item.code === 'REQUIRED'));

fs.rmSync(temp, { recursive: true, force: true });
console.log('agent-facing case flow passed');

#!/usr/bin/env node
'use strict';

process.env.MAVT_SELF_TEST = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');
const { validateResultIntegrity } = require('../case-runtime/result-integrity');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-flow-result-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { verdict: 'PASS', suffix: 'case-flow-result' });
const eventsPath = path.join(fixture.execDir, 'events.jsonl');
const events = fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const converted = events.map((event) => {
  const value = { ...event };
  delete value.caseModelRevision;
  if (event.type === 'caseModelRevised') return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    executionId: event.executionId,
    sequence: event.sequence,
    time: event.time,
    type: 'caseFlowRevised',
    revision: 1,
    reason: 'INITIAL_CASE_FLOW',
    summary: '验证当前报告结果',
    entryNodeRef: 'N1',
    nodes: [
      { ref: 'N1', type: 'CHECK', text: '验证当前报告结果', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期' },
      { ref: 'N2', type: 'END', text: '完成' },
    ],
    edges: [{ ref: 'L1', from: 'N1', to: 'N2' }],
    uncertainties: [], retiredNodeRefs: [], retiredEdgeRefs: [],
  };
  return { ...value, caseFlowRevision: 1 };
});
fs.writeFileSync(eventsPath, `${converted.map((event) => JSON.stringify(event)).join('\n')}\n`);

const pass = validateResultIntegrity(fixture.execDir, {
  verdict: 'PASS', summary: '目标结果正常', caseFlowRevision: 1,
  checks: [{ checkNodeRef: 'N1', status: 'PASS', actual: '页面符合预期', sceneRefs: ['scene-0002'] }],
  uncertainties: [],
});
assert.strictEqual(pass.result.verdict, 'PASS');
assert.strictEqual(pass.graph.expectationCoverage.caseFlowRevision, 1);

const notRun = validateResultIntegrity(fixture.execDir, {
  verdict: 'NOT_RUN', summary: '前置条件不满足', caseFlowRevision: 1, checks: [], uncertainties: [],
  notRunReason: '当前账号没有所需权益',
  notRunEvidence: { sceneRefs: ['scene-0002'], technicalRefs: [] },
});
assert.strictEqual(notRun.result.verdict, 'NOT_RUN');
assert.deepStrictEqual(notRun.graph.expectationCoverage.expectations, []);
assert.throws(() => validateResultIntegrity(fixture.execDir, {
  verdict: 'NOT_RUN', summary: '前置条件不满足', caseFlowRevision: 1, checks: [], uncertainties: [],
  notRunReason: '当前账号没有所需权益',
  notRunEvidence: { sceneRefs: ['scene-unknown'], technicalRefs: [] },
}), (error) => error?.code === 'CASE_RESULT_SCENE_UNKNOWN');

fs.rmSync(root, { recursive: true, force: true });
console.log('case flow result integrity passed');

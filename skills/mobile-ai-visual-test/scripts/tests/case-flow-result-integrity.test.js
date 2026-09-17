#!/usr/bin/env node
'use strict';

process.env.MAVT_SELF_TEST = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');
const { validateResultIntegrity } = require('../case-runtime/result-integrity');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-flow-result-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { verdict: 'PASS', suffix: 'case-flow-result' });

const pass = validateResultIntegrity(fixture.execDir, {
  verdict: 'PASS', summary: '目标结果正常', caseFlowRevision: 1,
  checks: [{ checkNodeRef: 'N2', status: 'PASS', actual: '页面符合预期', sceneRefs: ['scene-0002'] }],
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

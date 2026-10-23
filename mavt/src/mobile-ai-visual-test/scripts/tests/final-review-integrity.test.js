'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildContract } = require('../build-agent-contract');
const { createExecution } = require('../case-runtime/lifecycle');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { createInitialStatePreflight } = require('../lib/app-provisioning');
const { run } = require('../case-runtime/agent-facing-client');
const { createTestWorkspace } = require('./support/workspace-fixture');
const { simpleCaseFlow } = require('./support/case-flow');
const store = require('../case-runtime/store');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-review-integrity-'));
createTestWorkspace(root);
fs.mkdirSync(path.join(root, 'knowledge'));
const source = '首次启动先出现年龄确认，点已满14岁后出现隐私协议，同意后进入登录。';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function fixture(platform, suffix) {
  const contract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform });
  const caseJson = createCaseContract({ caseKey: 'ck-012345678901', title: suffix, sourceText: source, importPath: '/fixture/order.md' });
  const runtimeDir = path.join(root, 'cases', suffix, 'platforms', platform);
  const requirement = { schemaVersion: 1, targetState: 'KEEP_EXISTING', rationale: '离线复核 fixture' };
  const preparationPolicy = { schemaVersion: 1, allowedEffects: [], targetAppOnly: true };
  return createExecution({ workspaceRoot: root, runtimeDir, executionId: `execution-${suffix}`, batchId: null,
    platform, sourceText: source, caseJson, targetBinding: { platform, deviceId: 'offline', appId: 'com.example.offline', entry: 'Entry' },
    initialStateRequirement: requirement, initialStatePreflight: createInitialStatePreflight({ requirement, preparationPolicy, platform }),
    preparationPolicy, runtimeSha: contract.runtimeSha, adapterSha: contract.adapterSha, caseProtocolSha: contract.protocolSha,
    coordinatorProtocolSha: 'offline-coordinator', batchContractSha: 'offline-batch', executionRequestSha: 'offline-request',
    interactionPolicy: 'UNATTENDED', warmSessionGeneration: 1, initialObserve: false }).execDir;
}
function observe(execDir, platform, purpose) {
  const observed = run(execDir, { operation: 'observe', input: { purpose } }, { invokeDeviceOperation(dir, payload, kind) {
    assert.strictEqual(kind, 'OBSERVE');
    const screenshot = `screenshots/${payload.operationId}.png`;
    fs.writeFileSync(path.join(dir, screenshot), png);
    return { adapterResult: { schemaVersion: 1, type: 'observation', platform,
      device: { id: 'offline' }, app: { appId: 'com.example.offline', inTargetApp: true }, artifacts: { screenshot, layout: null, logs: [] } },
    evidence: { ref: screenshot, sha256: require('crypto').createHash('sha256').update(png).digest('hex'), width: 1, height: 1, usable: true } };
  } });
  assert.strictEqual(observed.status, 'SUCCEEDED', JSON.stringify({ observed, events: store.events(execDir).filter(event => event.type === 'technicalIssue') }));
  return observed.data.ref;
}
function inspect(execDir, sceneRef, refs) {
  const response = run(execDir, { operation: 'inspect', input: { mode: 'visual', sceneRef, checkNodeRefs: refs, observation: '离线 Agent 提供的已看图事实' } });
  assert.strictEqual(response.status, 'SUCCEEDED', JSON.stringify(response));
}
const review = (response, verdict) => ({ token: response.result.finalReviewToken, verdict, sourceCoverageConfirmed: true });
try {
  for (const platform of ['android', 'ios', 'harmony']) {
    const execDir = fixture(platform, `${platform}-order`);
    const flow = simpleCaseFlow(source, '隐私协议内容完整');
    assert.strictEqual(run(execDir, { operation: 'plan', input: { caseFlow: flow } }).status, 'SUCCEEDED');
    const privacy = observe(execDir, platform, '先出现隐私');
    const age = observe(execDir, platform, '后出现年龄确认');
    inspect(execDir, privacy, ['N2']);
    assert.strictEqual(run(execDir, { operation: 'recordResult', input: { results: [{ checkNodeRef: 'N2', status: 'PASS', actual: '隐私弹窗内容满足预期', evidence: { sceneRefs: [privacy] } }] } }).status, 'SUCCEEDED');
    const finish = { operation: 'finish', input: { mode: 'complete', summary: '内容正确，复核原文顺序' } };
    const first = run(execDir, finish);
    assert.strictEqual(first.error.code, 'CASE_FINAL_REVIEW_REQUIRED');
    const revised = structuredClone(flow);
    revised.baseRevision = 1;
    revised.reason = 'Agent 复核发现遗漏原文业务时序，补齐独立检查';
    revised.nodes.push({ ref: 'N4', type: 'CHECK', text: '先年龄确认后隐私协议', sourceBasis: source, requirement: 'REQUIRED', verificationKind: 'DIRECT_OBSERVATION' });
    revised.edges = [{ ref: 'L1', from: 'N1', to: 'N2' }, { ref: 'L3', from: 'N2', to: 'N4' }, { ref: 'L4', from: 'N4', to: 'N3' }];
    const planned = run(execDir, { operation: 'plan', input: { caseFlow: revised } });
    assert.strictEqual(planned.status, 'SUCCEEDED', JSON.stringify(planned));
    assert.notStrictEqual(planned.result.finalReviewToken, first.result.finalReviewToken);
    inspect(execDir, privacy, ['N4']);
    const correction = { operation: 'recordResult', input: { results: [{ checkNodeRef: 'N4', status: 'FAIL', actual: '先隐私后年龄，与原文相反', evidence: { sceneRefs: [privacy, age] } }] } };
    assert.strictEqual(run(execDir, correction).error.code, 'VISUAL_INSPECTION_REQUIRED');
    inspect(execDir, age, ['N4']);
    const recorded = run(execDir, correction);
    assert.strictEqual(recorded.result.outcome, 'RESULTS_RECORDED', JSON.stringify(recorded));
    assert.deepStrictEqual(recorded.result.pendingCheckNodeRefs, []);
    const finished = run(execDir, { ...finish, input: { ...finish.input, finalReview: review(recorded, 'FAIL') } });
    assert.strictEqual(finished.result.verdict, 'FAIL', JSON.stringify(finished));
    const result = JSON.parse(fs.readFileSync(path.join(execDir, 'result.json')));
    assert.deepStrictEqual(result.checks.map(item => item.status), ['PASS', 'FAIL']);
    assert.ok(store.events(execDir).some(event => event.type === 'caseFinalReviewConfirmed' && event.verdict === 'FAIL'));
  }
  const execDir = fixture('harmony', 'not-run');
  run(execDir, { operation: 'plan', input: { caseFlow: simpleCaseFlow(source, '进入目标业务状态') } });
  const scene = observe(execDir, 'harmony', '必要条件无法建立');
  const finish = { operation: 'finish', input: { mode: 'notRun', reason: '必要条件无法建立且无安全继续路径，未验证业务', summary: '未运行', evidence: { sceneRefs: [scene], technicalRefs: [] } } };
  const first = run(execDir, finish);
  assert.strictEqual(first.error.code, 'CASE_FINAL_REVIEW_REQUIRED', JSON.stringify(first));
  assert.strictEqual(first.result.ledgerVerdict, 'NOT_RUN');
  assert.strictEqual(run(execDir, { ...finish, input: { ...finish.input, finalReview: review(first, 'NOT_RUN') } }).result.verdict, 'NOT_RUN');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('final review integrity passed (three platforms and NOT_RUN; offline fixtures)');

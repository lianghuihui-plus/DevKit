#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { now, compactLocalTimestamp, compareTimestamps } = require('./lib/common');

const startedMs = Date.now();
const scripts = __dirname;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-restore-self-test-'));
const bin = path.join(temp, 'bin');
const stateFile = path.join(temp, 'state');
const restartModeFile = path.join(temp, 'restart-mode');
const restartCountFile = path.join(temp, 'restart-count');
fs.mkdirSync(bin);
fs.writeFileSync(stateFile, 'home');
fs.writeFileSync(restartModeFile, '');
fs.writeFileSync(restartCountFile, '0');

const fakeHdc = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const offset = args[0] === '-t' ? 2 : 0;
const command = args.slice(offset);
const stateFile = process.env.SMAP_FAKE_STATE;
if (command[0] === 'shell' && command[1] === 'uitest' && command[2] === '--version') {
  console.log('uitest 1.0');
  process.exit(0);
}
if (command[0] === 'shell' && command[1] === 'aa' && command[2] === 'dump') {
  console.log('AbilityRecord ID #1\\n state #FOREGROUND\\n ability type [PAGE]\\n bundle name [com.example.demo]\\n main name [EntryAbility]');
  process.exit(0);
}
if (command[0] === 'shell' && command[1] === 'uitest' && command[2] === 'uiInput') {
  if (command[3] === 'click') {
    const x = Number(command[4]);
    const state = fs.readFileSync(stateFile, 'utf8').trim();
    if (state === 'startup-popup' && x >= 300) fs.writeFileSync(stateFile, 'home');
  }
  process.exit(0);
}
if (command[0] === 'shell' && command[1] === 'aa') {
  if (command[2] === 'start') {
    const countFile = process.env.SMAP_FAKE_RESTART_COUNT;
    fs.writeFileSync(countFile, String(Number(fs.readFileSync(countFile, 'utf8')) + 1));
    const mode = fs.readFileSync(process.env.SMAP_FAKE_RESTART_MODE, 'utf8').trim();
    if (mode === 'startup-popup') fs.writeFileSync(stateFile, 'startup-popup');
    else if (mode !== 'preserve') fs.writeFileSync(stateFile, 'home');
  }
  process.exit(0);
}
if (command[0] === 'shell' && command[1] === 'uitest' && ['screenCap', 'dumpLayout'].includes(command[2])) process.exit(0);
if (command[0] === 'file' && command[1] === 'recv') {
  const output = command[3];
  const state = fs.readFileSync(stateFile, 'utf8').trim();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (command[2].endsWith('.png')) {
    fs.writeFileSync(output, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(state)]));
    if (state.startsWith('animated-')) fs.writeFileSync(stateFile, 'animated-' + (Number(state.split('-')[1]) + 1));
  } else {
    const texts = state === 'startup-popup' ? ['启动公告', '关闭'] : ['首页', '我的'];
    fs.writeFileSync(output, JSON.stringify({
      type: state === 'startup-popup' ? 'Dialog' : 'Page',
      children: texts.map((text, index) => ({ type: 'Text', resourceId: 'id' + index, text, bounds: [0, index * 100, 100, index * 100 + 50] }))
    }));
  }
  process.exit(0);
}
process.exit(0);
`;

fs.writeFileSync(path.join(bin, 'hdc'), fakeHdc, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'devecocli'), '#!/usr/bin/env node\nconsole.log("fake-device connected")\n', { mode: 0o755 });

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  SMAP_HDC: path.join(bin, 'hdc'),
  SMAP_DEVECOCLI: path.join(bin, 'devecocli'),
  SMAP_FAKE_STATE: stateFile,
  SMAP_FAKE_RESTART_MODE: restartModeFile,
  SMAP_FAKE_RESTART_COUNT: restartCountFile,
  SMAP_RESTART_SETTLE_MS: '1',
  SMAP_OBSERVATION_INITIAL_DELAY_MS: '0',
  SMAP_OBSERVATION_SAMPLE_INTERVAL_MS: '0',
  SMAP_OBSERVATION_TIMEOUT_MS: '1000',
  SMAP_OBSERVATION_VISUAL_FALLBACK_MS: '0'
};

function run(file, args = []) {
  const result = spawnSync(path.join(scripts, file), args, { encoding: 'utf8', env, timeout: 30000 });
  if (result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${file} returned invalid JSON: ${error.message}\n${result.stdout}`);
  }
}

let tests = 0;
function check(actual, expected) {
  assert.deepEqual(actual, expected);
  tests += 1;
}

function prepareRun(appMapRoot, scanId) {
  const scanDir = run('init-scan.js', [
    '--app-map-root', appMapRoot,
    '--scan-id', scanId,
    '--device', 'fake-device',
    '--contexts', 'guest',
    '--navigation-policy', 'always-replay',
    '--app-version', '1.0',
    '--build-version', '10'
  ]).scanDir;
  const shown = run('show-plan.js', ['--scan-dir', scanDir]);
  run('context.js', ['confirm-plan', '--scan-dir', scanDir, '--plan-hash', shown.planHash]);
  const prepared = run('prepare-context.js', ['prepare', '--scan-dir', scanDir, '--context', 'guest']);
  const observationId = prepared.observation.observationId;
  run('context.js', ['verify', '--scan-dir', scanDir, '--context', 'guest', '--observation-id', observationId]);
  run('context.js', ['start', '--scan-dir', scanDir, '--context', 'guest']);
  const visualStateId = run('graph.js', [
    'upsert-visual', '--scan-dir', scanDir, '--context', 'guest', '--root', 'true',
    '--observation-id', observationId, '--logical-screen-key', 'home', '--name', '首页'
  ]).visualState.id;
  const reachableStateId = run('graph.js', [
    'upsert-reachable', '--scan-dir', scanDir, '--context', 'guest', '--root', 'true',
    '--visual-state-id', visualStateId,
    '--arrival-signature', JSON.stringify({ backBehaviorKey: 'root-exit' }),
    '--depth', JSON.stringify({ pathDepth: 0, routeDepth: 0, modalDepth: 0 })
  ]).reachableState.id;
  return { scanDir, observationId, reachableStateId };
}

function addAndClaim(scanDir, reachableStateId, candidateGroupKey) {
  const item = run('frontier.js', [
    'add', '--scan-dir', scanDir, '--context', 'guest',
    '--from-reachable-state-id', reachableStateId,
    '--candidate-group-key', candidateGroupKey,
    '--candidate', JSON.stringify({ type: 'tap', target: '无效区域', fallbackBounds: [400, 0, 500, 100] })
  ]).item;
  const claimed = run('frontier.js', ['claim', '--scan-dir', scanDir, '--context', 'guest']).item;
  check(claimed.id, item.id);
  return claimed;
}

function resolveNoStateChange(scanDir, attempt) {
  const acted = run('execute-frontier.js', [
    'act', '--scan-dir', scanDir, '--context', 'guest', '--attempt-id', attempt.attemptId
  ]).attempt;
  return run('execute-frontier.js', [
    'review-outcome', '--scan-dir', scanDir, '--context', 'guest',
    '--attempt-id', acted.attemptId,
    '--observation-id', acted.reviewObservationId,
    '--disposition', 'NO_STATE_CHANGE'
  ]).attempt;
}

try {
  const localDate = new Date();
  const offsetMinutes = -localDate.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const expectedOffset = `${offsetSign}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`;
  const localNow = now(localDate);
  check(localNow.endsWith(expectedOffset), true);
  check(Date.parse(localNow), localDate.getTime());
  check(compactLocalTimestamp(localDate), `${String(localDate.getFullYear()).padStart(4, '0')}${String(localDate.getMonth() + 1).padStart(2, '0')}${String(localDate.getDate()).padStart(2, '0')}${String(localDate.getHours()).padStart(2, '0')}${String(localDate.getMinutes()).padStart(2, '0')}${String(localDate.getSeconds()).padStart(2, '0')}`);
  check(compareTimestamps('2026-07-15T08:00:00.000Z', '2026-07-15T16:30:00.000+08:00') < 0, true);

  const appMapRoot = path.join(temp, 'app-map');
  run('init-app-root.js', [
    '--app-map-root', appMapRoot,
    '--bundle-name', 'com.example.demo',
    '--entry-ability', 'EntryAbility',
    '--environment', 'test'
  ]);
  const generatedRun = run('init-scan.js', [
    '--app-map-root', appMapRoot,
    '--device', 'fake-device',
    '--contexts', 'guest',
    '--app-version', '1.0',
    '--build-version', '10'
  ]);
  check(path.basename(generatedRun.scanDir).startsWith(`scan-${compactLocalTimestamp(localDate).slice(0, 8)}`), true);

  const stable = prepareRun(appMapRoot, 'restore-popup');
  fs.writeFileSync(restartModeFile, 'startup-popup');
  const popupFrontier = addAndClaim(stable.scanDir, stable.reachableStateId, 'home/recurring-startup-popup');
  const restartsBefore = Number(fs.readFileSync(restartCountFile, 'utf8'));
  let popupAttempt = run('execute-frontier.js', [
    'prepare', '--scan-dir', stable.scanDir, '--context', 'guest',
    '--frontier-id', popupFrontier.id, '--claim-token', popupFrontier.claimToken
  ]).attempt;
  check(popupAttempt.status, 'AWAITING_RESTORE_REVIEW');
  const restartsAfterPrepare = Number(fs.readFileSync(restartCountFile, 'utf8'));
  check(restartsAfterPrepare, restartsBefore + 1);
  popupAttempt = run('execute-frontier.js', [
    'review-restore', '--scan-dir', stable.scanDir, '--context', 'guest',
    '--attempt-id', popupAttempt.attemptId,
    '--observation-id', popupAttempt.reviewObservationId,
    '--disposition', 'DISMISSIBLE_POPUP',
    '--dismiss-action', JSON.stringify({ type: 'tap', target: '关闭', fallbackBounds: [300, 0, 400, 100] })
  ]).attempt;
  check(popupAttempt.status, 'READY_FOR_ACTION');
  check(Number(fs.readFileSync(restartCountFile, 'utf8')), restartsAfterPrepare);
  check(Boolean(popupAttempt.interruptions[0].afterObservationId), true);
  check(popupAttempt.restoreResults[0].status, 'SUCCEEDED');
  check(resolveNoStateChange(stable.scanDir, popupAttempt).status, 'NO_STATE_CHANGE');
  check(run('finalize-scan.js', ['--scan-dir', stable.scanDir, '--status', 'COMPLETED']).scan.status, 'COMPLETED');

  fs.writeFileSync(stateFile, 'animated-1');
  fs.writeFileSync(restartModeFile, 'preserve');
  const dynamic = prepareRun(appMapRoot, 'restore-dynamic');
  const dynamicRootObservation = JSON.parse(fs.readFileSync(path.join(dynamic.scanDir, 'evidence', 'observations', dynamic.observationId, 'observation.json'), 'utf8'));
  check(dynamicRootObservation.stability.status, 'LAYOUT_STABLE_VISUAL_DYNAMIC');
  fs.writeFileSync(restartModeFile, '');
  fs.writeFileSync(stateFile, 'home');
  const dynamicFrontier = addAndClaim(dynamic.scanDir, dynamic.reachableStateId, 'home/dynamic-restore');
  const dynamicPrepared = run('execute-frontier.js', [
    'prepare', '--scan-dir', dynamic.scanDir, '--context', 'guest',
    '--frontier-id', dynamicFrontier.id, '--claim-token', dynamicFrontier.claimToken
  ]);
  let dynamicAttempt = dynamicPrepared.attempt;
  check(dynamicAttempt.status, 'AWAITING_RESTORE_REVIEW');
  check(dynamicAttempt.restoreMismatch.comparison, 'PROBABLE');
  check(dynamicPrepared.reviewRequest.dispositions.includes('EXPECTED_STATE_EQUIVALENT'), true);
  const reviewObservation = JSON.parse(fs.readFileSync(path.join(dynamic.scanDir, 'evidence', 'observations', dynamicAttempt.reviewObservationId, 'observation.json'), 'utf8'));
  const assessment = {
    status: 'EXPECTED_STATE_EQUIVALENT',
    expectedReachableStateId: dynamic.reachableStateId,
    observedSha256: reviewObservation.stability.finalScreenshotSha256,
    rationale: '页面布局与语义一致，仅动态视觉内容变化'
  };
  dynamicAttempt = run('execute-frontier.js', [
    'review-restore', '--scan-dir', dynamic.scanDir, '--context', 'guest',
    '--attempt-id', dynamicAttempt.attemptId,
    '--observation-id', dynamicAttempt.reviewObservationId,
    '--disposition', 'EXPECTED_STATE_EQUIVALENT',
    '--visual-assessment', JSON.stringify(assessment)
  ]).attempt;
  check(dynamicAttempt.status, 'READY_FOR_ACTION');
  check(dynamicAttempt.restoreResults[0].equivalenceReviews.length, 1);
  check(dynamicAttempt.restoreResults[0].equivalenceReviews[0].observedSha256, assessment.observedSha256);
  check(resolveNoStateChange(dynamic.scanDir, dynamicAttempt).status, 'NO_STATE_CHANGE');
  check(run('finalize-scan.js', ['--scan-dir', dynamic.scanDir, '--status', 'COMPLETED']).scan.status, 'COMPLETED');
  check(dynamicRootObservation.capturedAt.endsWith(expectedOffset), true);

  run('register-run.js', ['--scan-dir', stable.scanDir]);
  run('register-run.js', ['--scan-dir', dynamic.scanDir]);
  const snapshot = run('build-snapshot.js', ['--app-map-root', appMapRoot]);
  check(snapshot.manifest.generatedAt.endsWith(expectedOffset), true);
  check(snapshot.manifest.generationId.startsWith(`snapshot-${compactLocalTimestamp(localDate).slice(0, 8)}`), true);
  const snapshotMetrics = JSON.parse(fs.readFileSync(path.join(snapshot.snapshotDir, 'metrics.json'), 'utf8'));
  check(snapshotMetrics.execution.runs.length, 2);
  check(snapshotMetrics.execution.totals.actions > 0, true);
  const dashboard = run('build-dashboard.js', ['--app-map-root', appMapRoot]);
  const dashboardHtml = fs.readFileSync(dashboard.dashboardPath, 'utf8');
  check(dashboardHtml.includes('data-view="execution"'), true);
  const embedded = dashboardHtml.match(/<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/);
  const dashboardData = JSON.parse(embedded[1]);
  check(dashboardData.execution.runs.length, 2);
  check(dashboardData.execution.runs.every(runItem => runItem.contexts.every(context => context.contextLabel === '未登录')), true);
  run('rebuild-run-index.js', ['--app-map-root', appMapRoot]);
  const rebuiltIndex = JSON.parse(fs.readFileSync(path.join(appMapRoot, 'run-index.json'), 'utf8'));
  check(rebuiltIndex.rebuiltAt.endsWith(expectedOffset), true);

  console.log(JSON.stringify({
    schemaVersion: 1,
    ok: true,
    scope: 'restore',
    tests,
    durationMs: Date.now() - startedMs
  }, null, 2));
} finally {
  if (!process.env.SMAP_KEEP_SELF_TEST) fs.rmSync(temp, { recursive: true, force: true });
}

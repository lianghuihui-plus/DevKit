#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertKnownActionOutcome, duringActionCaptureRequired } = require('../platform/device-port');
const {
  HelperActionOutcomeUnknown,
  HelperAuthenticationRejected,
  HelperUnavailableBeforeDispatch,
} = require('../platform/adapters/android/lib/android-helper-client');
const {
  helperActionTransaction,
  main: helperActionMain,
} = require('../platform/adapters/android/atoms/helper-action');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

assert.deepStrictEqual(helperActionTransaction({ type: 'inputText', text: '中文', mode: 'replace' }).steps,
  [{ kind: 'rpc', cmd: 'type', params: { text: '中文', append: false } }]);
assert.deepStrictEqual(helperActionTransaction({
  type: 'inputText', x: 10, y: 20, text: '追加', mode: 'append',
}).steps, [
  { kind: 'rpc', cmd: 'tap', params: { x: 10, y: 20 } },
  { kind: 'rpc', cmd: 'type', params: { text: '追加', append: true } },
]);
assert.deepStrictEqual(helperActionTransaction({ type: 'doubleTap', x: 10, y: 20 }).steps,
  [{ kind: 'rpc', cmd: 'double_tap', params: { x: 10, y: 20 } }]);
assert.deepStrictEqual(helperActionTransaction({ type: 'doubleTap', x: 10, y: 20, intervalMs: 120 }).steps, [
  { kind: 'rpc', cmd: 'tap', params: { x: 10, y: 20 } },
  { kind: 'wait', ms: 120 },
  { kind: 'rpc', cmd: 'tap', params: { x: 10, y: 20 } },
]);
assert.strictEqual(helperActionTransaction({ type: 'longPress', x: 10, y: 20, durationMs: 499 }).supported, false);
assert.strictEqual(helperActionTransaction({
  type: 'swipe', fromX: 0, fromY: 0, toX: 1, toY: 0, velocity: 40000,
}).supported, false);
assert.strictEqual(helperActionTransaction({
  type: 'swipe', fromX: 0, fromY: 0, toX: 2000, toY: 0, velocity: 200,
}).supported, false);
assert.deepStrictEqual(helperActionTransaction({ type: 'back' }).steps,
  [{ kind: 'rpc', cmd: 'global', params: { action: 'back' } }]);
assert.throws(() => assertKnownActionOutcome({
  command: { status: 'UNKNOWN' }, failureCode: 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN',
}), (error) => error.code === 'ACTION_OUTCOME_UNKNOWN'
  && error.actionOutcomeUnknown === true
  && error.adapterResult.failureCode === 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN');
assert.strictEqual(duringActionCaptureRequired({ command: { status: 'REJECTED' } }, {
  observationPolicy: { duringActionAtMs: 250 },
}), false);
assert.strictEqual(duringActionCaptureRequired({ command: { status: 'ACCEPTED' } }, {
  observationPolicy: { duringActionAtMs: 250 },
}), true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-helper-action-'));
const sessionPath = path.join(root, 'session.json');
fs.writeFileSync(sessionPath, JSON.stringify({
  deviceId: 'android-device', localPort: 41000, token: 'secret-token', protocolVersion: 2,
}), { mode: 0o600 });

async function invokeMain(action, dependencies) {
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  try {
    await helperActionMain([
      '--session-state', sessionPath,
      '--action-json', JSON.stringify(action),
      '--timeout-ms', '10000',
    ], dependencies);
    return JSON.parse(stdout);
  } finally {
    process.stdout.write = originalWrite;
  }
}

(async () => {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const calls = [];
  const success = await invokeMain({ type: 'tap', x: 10, y: 20 }, {
    ensureSession: async () => session,
    performAction: async (_session, cmd, params) => {
      calls.push({ cmd, params });
      return { success: true };
    },
  });
  assert.deepStrictEqual(calls, [{ cmd: 'tap', params: { x: 10, y: 20 } }]);
  assert.strictEqual(success.command.status, 'ACCEPTED');
  assert.strictEqual(success.command.transport, 'ANDROID_HELPER_HTTP');

  const rpcTimeouts = [];
  await invokeMain({ type: 'doubleTap', x: 10, y: 20 }, {
    now: () => 0,
    ensureSession: async () => session,
    performAction: async (_session, _cmd, _params, options) => {
      rpcTimeouts.push(options.timeoutMs);
      return { success: true };
    },
  });
  await invokeMain({ type: 'longPress', x: 10, y: 20, durationMs: 3500 }, {
    now: () => 0,
    ensureSession: async () => session,
    performAction: async (_session, _cmd, _params, options) => {
      rpcTimeouts.push(options.timeoutMs);
      return { success: true };
    },
  });
  await invokeMain({ type: 'swipe', fromX: 0, fromY: 0, toX: 600, toY: 0, velocity: 600 }, {
    now: () => 0,
    ensureSession: async () => session,
    performAction: async (_session, _cmd, _params, options) => {
      rpcTimeouts.push(options.timeoutMs);
      return { success: true };
    },
  });
  assert.deepStrictEqual(rpcTimeouts, [5000, 6500, 4500]);

  const unknown = await invokeMain({ type: 'tap', x: 10, y: 20 }, {
    ensureSession: async () => session,
    performAction: async () => { throw new HelperActionOutcomeUnknown('socket closed'); },
  });
  assert.strictEqual(unknown.command.status, 'UNKNOWN');
  assert.strictEqual(unknown.deviceExecution.status, 'UNVERIFIED');
  assert.strictEqual(unknown.failureCode, 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN');

  let partialCalls = 0;
  const partial = await invokeMain({ type: 'doubleTap', x: 10, y: 20, intervalMs: 20 }, {
    ensureSession: async () => session,
    sleep: async () => {},
    performAction: async () => {
      partialCalls += 1;
      return { success: partialCalls === 1, error: partialCalls === 1 ? undefined : 'gesture rejected' };
    },
  });
  assert.strictEqual(partialCalls, 2);
  assert.strictEqual(partial.command.status, 'ACCEPTED');
  assert.strictEqual(partial.deviceExecution.status, 'FAILED');

  let authCalls = 0;
  let reauthenticateCalls = 0;
  const recovered = await invokeMain({ type: 'home' }, {
    ensureSession: async () => session,
    reauthenticateSession: async () => { reauthenticateCalls += 1; return session; },
    performAction: async () => {
      authCalls += 1;
      if (authCalls === 1) throw new HelperAuthenticationRejected();
      return { success: true };
    },
  });
  assert.strictEqual(recovered.command.status, 'ACCEPTED');
  assert.strictEqual(authCalls, 2);
  assert.strictEqual(reauthenticateCalls, 1);

  let retryUnknownCalls = 0;
  const retryUnknown = await invokeMain({ type: 'home' }, {
    ensureSession: async () => session,
    reauthenticateSession: async () => session,
    performAction: async () => {
      retryUnknownCalls += 1;
      if (retryUnknownCalls === 1) throw new HelperAuthenticationRejected();
      throw new HelperActionOutcomeUnknown('retry timed out');
    },
  });
  assert.strictEqual(retryUnknownCalls, 2);
  assert.strictEqual(retryUnknown.command.status, 'UNKNOWN');
  assert.strictEqual(retryUnknown.failureCode, 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN');

  const authLost = await invokeMain({ type: 'home' }, {
    ensureSession: async () => session,
    reauthenticateSession: async () => { throw new Error('claim lost'); },
    performAction: async () => { throw new HelperAuthenticationRejected(); },
  });
  assert.strictEqual(authLost.command.status, 'REJECTED');
  assert.strictEqual(authLost.deviceExecution.status, 'NOT_EXECUTED');

  let unavailableStdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { unavailableStdout += chunk; return true; };
  try {
    await assert.rejects(() => helperActionMain([
      '--session-state', sessionPath,
      '--action-json', JSON.stringify({ type: 'tap', x: 10, y: 20 }),
      '--timeout-ms', '10000',
    ], {
      ensureSession: async () => session,
      performAction: async () => { throw new HelperUnavailableBeforeDispatch('connection refused'); },
    }), (error) => error.exitCode === 20);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.strictEqual(unavailableStdout, '');

  const bin = path.join(root, 'bin');
  const state = path.join(root, 'adapter-state');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  const pngFixture = path.join(state, 'fixture.png');
  fs.writeFileSync(pngFixture, PNG);
  const fakeNode = path.join(bin, 'node');
  fs.writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *"/helper-action.js" ]]; then
  shift
  printf 'helper-action\n' >> "$MAVT_FAKE_STATE/calls.log"
  action=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --action-json) action="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  type="$($MAVT_REAL_NODE -e 'process.stdout.write(JSON.parse(process.argv[1]).type)' "$action")"
  unsupported="$($MAVT_REAL_NODE -e 'const a=JSON.parse(process.argv[1]);process.stdout.write(String(a.type==="longPress"&&a.durationMs<500))' "$action")"
  if [[ "$unsupported" == "true" ]]; then exit 20; fi
  case "$MAVT_HELPER_MODE" in
    unavailable) exit 20 ;;
    unknown)
      printf '{"schemaVersion":2,"type":"actionResult","platform":"android","action":"%s","command":{"status":"UNKNOWN","transport":"ANDROID_HELPER_HTTP","elapsedMs":1},"deviceExecution":{"status":"UNVERIFIED","verification":"NONE"},"failureCode":"ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN"}\n' "$type"
      exit 0 ;;
    success)
      printf '{"schemaVersion":2,"type":"actionResult","platform":"android","action":"%s","command":{"status":"ACCEPTED","transport":"ANDROID_HELPER_HTTP","elapsedMs":1},"deviceExecution":{"status":"UNVERIFIED","verification":"REQUEST_ECHO"}}\n' "$type"
      exit 0 ;;
  esac
fi
exec "$MAVT_REAL_NODE" "$@"
`);
  fs.chmodSync(fakeNode, 0o755);
  const fakeAdb = path.join(bin, 'adb');
  fs.writeFileSync(fakeAdb, `#!/usr/bin/env bash
printf 'adb %s\n' "$*" >> "$MAVT_FAKE_STATE/calls.log"
if [[ "$*" == *"exec-out screencap -p"* ]]; then cat "$MAVT_PNG_FIXTURE"; fi
exit 0
`);
  fs.chmodSync(fakeAdb, 0o755);

  function runAdapter(backend, mode, actionArgs = ['--type', 'tap', '--x', '10', '--y', '20'], withSession = true) {
    fs.rmSync(path.join(state, 'calls.log'), { force: true });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MAVT_REAL_NODE: process.execPath,
      MAVT_FAKE_STATE: state,
      MAVT_PNG_FIXTURE: pngFixture,
      MAVT_HELPER_MODE: mode,
      MAVT_ANDROID_HELPER_SESSION_STATE: sessionPath,
    };
    if (!withSession) delete env.MAVT_ANDROID_HELPER_SESSION_STATE;
    const result = childProcess.spawnSync(path.resolve(__dirname, '../platform/adapters/android/action.sh'), [
      '--device', 'android-device', '--app', 'com.example', ...actionArgs,
      '--android-ui-backend', backend,
    ], {
      encoding: 'utf8',
      env,
    });
    const adapterCalls = fs.existsSync(path.join(state, 'calls.log'))
      ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8') : '';
    return { result, calls: adapterCalls, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }

  const helper = runAdapter('helper', 'success');
  assert.strictEqual(helper.result.status, 0, helper.result.stderr);
  assert.strictEqual(helper.json.command.transport, 'ANDROID_HELPER_HTTP');
  assert.strictEqual(helper.calls.includes('adb '), false);

  const fallback = runAdapter('auto', 'unavailable');
  assert.strictEqual(fallback.result.status, 0, fallback.result.stderr);
  assert.strictEqual(fallback.json.command.transport, 'ADB_INPUT');
  assert.strictEqual((fallback.calls.match(/adb /g) || []).length, 1);

  const strict = runAdapter('helper', 'unavailable');
  assert.strictEqual(strict.result.status, 0, strict.result.stderr);
  assert.strictEqual(strict.json.command.status, 'REJECTED');
  assert.strictEqual(strict.json.deviceExecution.status, 'NOT_EXECUTED');
  assert.strictEqual(strict.calls.includes('adb '), false);

  const strictMissing = runAdapter('helper', 'success', undefined, false);
  assert.strictEqual(strictMissing.result.status, 0, strictMissing.result.stderr);
  assert.strictEqual(strictMissing.json.command.status, 'REJECTED');
  assert.strictEqual(strictMissing.json.command.failureCode, 'ANDROID_HELPER_SESSION_MISSING');
  assert.strictEqual(strictMissing.calls.includes('adb '), false);

  const strictUnsupported = runAdapter('helper', 'success', [
    '--type', 'longPress', '--x', '10', '--y', '20', '--duration-ms', '499',
  ]);
  assert.strictEqual(strictUnsupported.result.status, 0, strictUnsupported.result.stderr);
  assert.strictEqual(strictUnsupported.json.command.status, 'REJECTED');
  assert.strictEqual(strictUnsupported.calls.includes('adb '), false);

  const adapterUnknown = runAdapter('auto', 'unknown');
  assert.strictEqual(adapterUnknown.result.status, 0, adapterUnknown.result.stderr);
  assert.strictEqual(adapterUnknown.json.command.status, 'UNKNOWN');
  assert.strictEqual(adapterUnknown.calls.includes('adb '), false);

  const captureOut = path.join(root, 'during-capture');
  const captured = runAdapter('helper', 'success', [
    '--type', 'longPress', '--x', '10', '--y', '20', '--duration-ms', '500',
    '--capture-out', captureOut, '--capture-label', 'during-helper', '--capture-at-ms', '1',
  ]);
  assert.strictEqual(captured.result.status, 0, captured.result.stderr);
  assert.strictEqual(captured.json.command.transport, 'ANDROID_HELPER_HTTP');
  assert.strictEqual(captured.json.duringActionCapture.artifacts.screenshot, 'screenshots/during-helper.png');
  assert.strictEqual((captured.calls.match(/helper-action/g) || []).length, 1);
  assert.strictEqual((captured.calls.match(/shell input swipe/g) || []).length, 0);
  assert.strictEqual((captured.calls.match(/exec-out screencap/g) || []).length, 1);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('android helper action passed');
})().catch((error) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});

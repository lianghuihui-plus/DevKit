#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const XML = '<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][100,200]"/></hierarchy>';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-helper-observation-'));
const bin = path.join(root, 'bin');
const state = path.join(root, 'state');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(state, { recursive: true });
const pngFixture = path.join(state, 'fixture.png');
const xmlFixture = path.join(state, 'fixture.xml');
fs.writeFileSync(pngFixture, PNG);
fs.writeFileSync(xmlFixture, XML);

const fakeNode = path.join(bin, 'node');
fs.writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *"/helper-snapshot.js" ]]; then
  shift
  screenshot=""; layout=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --screenshot-out) screenshot="$2"; shift 2 ;;
      --layout-out) layout="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  printf 'helper\n' >> "$MAVT_FAKE_STATE/calls.log"
  if [[ "$MAVT_HELPER_MODE" == "fail" ]]; then exit 1; fi
  if [[ "$MAVT_HELPER_MODE" == "barrier" ]]; then
    : > "$MAVT_FAKE_STATE/helper.started"
    for _ in {1..100}; do [[ -f "$MAVT_FAKE_STATE/adb.started" ]] && break; sleep 0.02; done
    [[ -f "$MAVT_FAKE_STATE/adb.started" ]] || exit 9
  fi
  mkdir -p "$(dirname "$screenshot")" "$(dirname "$layout")"
  cp "$MAVT_PNG_FIXTURE" "$screenshot"
  cp "$MAVT_XML_FIXTURE" "$layout"
  printf '%s\n' '{"ok":true,"backend":"helper","helperVersion":"1.2.1","protocolVersion":2,"atomicElapsedMs":120,"requestElapsedMs":180}'
  exit 0
fi
exec "$MAVT_REAL_NODE" "$@"
`);
fs.chmodSync(fakeNode, 0o755);

const fakeAdb = path.join(bin, 'adb');
fs.writeFileSync(fakeAdb, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-s" ]]; then shift 2; fi
printf '%s\n' "$*" >> "$MAVT_FAKE_STATE/calls.log"
: > "$MAVT_FAKE_STATE/adb.started"
command="\${1:-}"; shift || true
remote="$MAVT_FAKE_STATE/remote.xml"
if [[ "$command" == "exec-out" ]]; then cat "$MAVT_PNG_FIXTURE"; exit 0; fi
if [[ "$command" == "logcat" ]]; then echo 'test log'; exit 0; fi
if [[ "$command" == "pull" ]]; then cp "$remote" "$2"; exit 0; fi
if [[ "$command" == "shell" ]]; then
  case "\${1:-}" in
    dumpsys)
      if [[ "\${2:-}" == "window" ]]; then echo 'mCurrentFocus=Window{ u0 com.example/.MainActivity }'; else echo 'ResumedActivity: com.example/.MainActivity'; fi
      exit 0 ;;
    pidof) echo '1234'; exit 0 ;;
    rm) rm -f "$remote"; exit 0 ;;
    test) [[ -s "$remote" ]]; exit ;;
    uiautomator) cp "$MAVT_XML_FIXTURE" "$remote"; echo 'UI hierarchy dumped'; exit 0 ;;
  esac
fi
exit 2
`);
fs.chmodSync(fakeAdb, 0o755);

const observe = path.resolve(__dirname, '../platform/adapters/android/observe.sh');
const capture = path.resolve(__dirname, '../platform/adapters/android/capture.sh');

function resetState() {
  for (const name of ['calls.log', 'helper.started', 'adb.started', 'remote.xml']) {
    fs.rmSync(path.join(state, name), { force: true });
  }
}

function runAdapter(command, backend, mode, label) {
  resetState();
  const out = path.join(root, `${path.basename(command)}-${backend}-${mode}`);
  fs.rmSync(out, { recursive: true, force: true });
  const result = childProcess.spawnSync(command, [
    '--device', 'android-device', '--app', 'com.example', '--out', out,
    '--label', label, '--android-ui-backend', backend,
  ], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MAVT_REAL_NODE: process.execPath,
      MAVT_FAKE_STATE: state,
      MAVT_PNG_FIXTURE: pngFixture,
      MAVT_XML_FIXTURE: xmlFixture,
      MAVT_HELPER_MODE: mode,
      MAVT_ANDROID_HELPER_SESSION_STATE: '/secure/helper-session.json',
    },
  });
  const calls = fs.existsSync(path.join(state, 'calls.log'))
    ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8') : '';
  return { result, out, calls, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

const helper = runAdapter(observe, 'helper', 'success', 'observation-helper');
assert.strictEqual(helper.result.status, 0, helper.result.stderr);
assert.strictEqual(helper.json.artifacts.screenshot, 'screenshots/observation-helper.png');
assert.strictEqual(helper.json.artifacts.layout, 'layouts/observation-helper.xml');
assert.strictEqual(helper.json.technicalSignals.androidUiBackend.selected, 'helper');
assert.strictEqual(helper.json.technicalSignals.layoutCapture.status, 'AVAILABLE');
assert.strictEqual(helper.json.app.processId, '1234');
assert.deepStrictEqual(helper.json.technicalSignals.captureTiming.order, ['helperSnapshot']);
assert.strictEqual((helper.calls.match(/uiautomator dump/g) || []).length, 0);
assert.strictEqual((helper.calls.match(/exec-out screencap/g) || []).length, 0);
assert.strictEqual((helper.calls.match(/logcat/g) || []).length, 0);
assert.strictEqual(Object.hasOwn(helper.json.artifacts, 'logs'), false);
assert.strictEqual(Object.hasOwn(helper.json.capabilities, 'logs'), false);
assert.strictEqual(Object.hasOwn(helper.json.raw, 'logFiles'), false);

const parallel = runAdapter(observe, 'helper', 'barrier', 'observation-parallel');
assert.strictEqual(parallel.result.status, 0, parallel.result.stderr);
assert.strictEqual(fs.existsSync(path.join(state, 'helper.started')), true);
assert.strictEqual(fs.existsSync(path.join(state, 'adb.started')), true);

const fallback = runAdapter(observe, 'auto', 'fail', 'observation-fallback');
assert.strictEqual(fallback.result.status, 0, fallback.result.stderr);
assert.strictEqual(fallback.json.technicalSignals.androidUiBackend.selected, 'uiautomator');
assert.strictEqual(fallback.json.technicalSignals.androidUiBackend.fallback, 'ANDROID_HELPER_SNAPSHOT_FAILED');
assert.strictEqual((fallback.calls.match(/uiautomator dump/g) || []).length, 1);
assert.strictEqual((fallback.calls.match(/exec-out screencap/g) || []).length, 1);

const strictFailure = runAdapter(observe, 'helper', 'fail', 'observation-strict-failure');
assert.notStrictEqual(strictFailure.result.status, 0);
assert.strictEqual(fs.existsSync(path.join(strictFailure.out, 'screenshots', 'observation-strict-failure.png')), false);
assert.strictEqual(fs.existsSync(path.join(strictFailure.out, 'layouts', 'observation-strict-failure.xml')), false);
assert.strictEqual((strictFailure.calls.match(/uiautomator dump/g) || []).length, 0);

const helperCapture = runAdapter(capture, 'helper', 'success', 'capture-helper');
assert.strictEqual(helperCapture.result.status, 0, helperCapture.result.stderr);
assert.strictEqual(helperCapture.json.artifacts.screenshot, 'screenshots/capture-helper.png');
assert.strictEqual(helperCapture.json.captureTiming.androidUiBackend.selected, 'uiautomator');
assert.strictEqual((helperCapture.calls.match(/helper/g) || []).length, 0);
assert.strictEqual((helperCapture.calls.match(/exec-out screencap/g) || []).length, 1);
assert.strictEqual(fs.readdirSync(path.join(helperCapture.out, 'screenshots')).length, 1);

const fallbackCapture = runAdapter(capture, 'auto', 'fail', 'capture-fallback');
assert.strictEqual(fallbackCapture.result.status, 0, fallbackCapture.result.stderr);
assert.strictEqual(fallbackCapture.json.captureTiming.androidUiBackend.selected, 'uiautomator');
assert.strictEqual((fallbackCapture.calls.match(/helper/g) || []).length, 0);
assert.strictEqual((fallbackCapture.calls.match(/exec-out screencap/g) || []).length, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log('android helper observation passed');

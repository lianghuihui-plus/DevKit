#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-layout-'));
const bin = path.join(temp, 'bin');
const state = path.join(temp, 'state');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(state, { recursive: true });
const fakeAdb = path.join(bin, 'adb');
fs.writeFileSync(fakeAdb, `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-s" ]]; then shift 2; fi
command="\${1:-}"
shift || true
remote_file="$MAVT_FAKE_ADB_STATE/remote.xml"
if [[ "$command" == "shell" ]]; then
  if [[ "\${1:-}" == "rm" ]]; then rm -f "$remote_file"; exit 0; fi
  if [[ "\${1:-}" == "test" ]]; then [[ -s "$remote_file" ]]; exit; fi
  if [[ "\${1:-}" == "uiautomator" && "\${2:-}" == "dump" ]]; then
    case "$MAVT_FAKE_ADB_MODE" in
      success) printf '%s\n' '<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][100,200]"/></hierarchy>' > "$remote_file"; echo 'UI hierarchy dumped'; exit 0 ;;
      idle) echo 'ERROR: could not get idle state.' >&2; exit 0 ;;
      missing) echo 'UI hierarchy dumped'; exit 0 ;;
      invalid) printf '%s\n' 'not xml' > "$remote_file"; echo 'UI hierarchy dumped'; exit 0 ;;
      timeout) exec sleep 2 ;;
    esac
  fi
fi
if [[ "$command" == "pull" ]]; then cp "$remote_file" "\${2}"; exit 0; fi
exit 2
`);
fs.chmodSync(fakeAdb, 0o755);

const atom = path.resolve(__dirname, '../platform/adapters/android/atoms/dump-tree.sh');

function run(mode, options = {}) {
  const runDir = path.join(temp, mode);
  fs.mkdirSync(runDir, { recursive: true });
  const out = path.join(runDir, 'tree.xml');
  if (options.stale) fs.writeFileSync(out, '<stale/>\n');
  const result = childProcess.spawnSync(atom, [
    '--device', 'android-device', '--out', out, '--remote', `/sdcard/${mode}.xml`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MAVT_FAKE_ADB_STATE: state,
      MAVT_FAKE_ADB_MODE: mode,
      MAVT_ANDROID_LAYOUT_TIMEOUT_SECONDS: String(options.timeoutSeconds || 1),
    },
  });
  return { result, out, json: JSON.parse(result.stdout) };
}

const success = run('success');
assert.strictEqual(success.result.status, 0);
assert.strictEqual(success.json.ok, true);
assert.strictEqual(success.json.capture.status, 'AVAILABLE');
assert.strictEqual(success.json.capture.code, null);
assert.strictEqual(fs.existsSync(success.out), true);

const idle = run('idle', { stale: true });
assert.strictEqual(idle.result.status, 1);
assert.strictEqual(idle.json.capture.code, 'ANDROID_LAYOUT_NOT_IDLE');
assert.strictEqual(fs.existsSync(idle.out), false);

const missing = run('missing', { stale: true });
assert.strictEqual(missing.result.status, 1);
assert.strictEqual(missing.json.capture.code, 'ANDROID_LAYOUT_OUTPUT_MISSING');
assert.strictEqual(fs.existsSync(missing.out), false);

const invalid = run('invalid');
assert.strictEqual(invalid.result.status, 1);
assert.strictEqual(invalid.json.capture.code, 'ANDROID_LAYOUT_INVALID');
assert.strictEqual(fs.existsSync(invalid.out), false);

const timeout = run('timeout');
assert.strictEqual(timeout.result.status, 1);
assert.strictEqual(timeout.json.capture.code, 'ANDROID_LAYOUT_TIMEOUT');
assert.ok(timeout.json.capture.durationMs >= 900 && timeout.json.capture.durationMs < 1800);
assert.strictEqual(fs.existsSync(timeout.out), false);

fs.rmSync(temp, { recursive: true, force: true });
console.log('android-layout-capture passed');

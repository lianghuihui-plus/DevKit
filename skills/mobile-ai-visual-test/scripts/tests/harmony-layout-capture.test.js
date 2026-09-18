#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-harmony-layout-'));
const bin = path.join(temp, 'bin');
const state = path.join(temp, 'state');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(state, { recursive: true });

const emptyTree = JSON.stringify({
  attributes: { bounds: '[0,0][0,0]', type: '' },
  children: [],
});
const mergedTree = JSON.stringify({
  attributes: { bounds: '[0,0][2232,1008]', type: 'MergedRoot' },
  children: [
    { attributes: { bounds: '[0,0][2232,1008]', type: 'AppWindow', text: 'App' }, children: [] },
    { attributes: { bounds: '[497,157][1551,766]', type: 'SystemDialog', text: '不允许 / 允许' }, children: [] },
  ],
});
const appTree = JSON.stringify({
  attributes: { bounds: '[0,0][2232,1008]', type: 'AppWindow', text: 'App' },
  children: [],
});

const fakeHdc = path.join(bin, 'hdc');
fs.writeFileSync(fakeHdc, `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-t" ]]; then shift 2; fi
printf '%s\n' "$*" >> "$MAVT_FAKE_HDC_LOG"
remote_file="$MAVT_FAKE_HDC_STATE/remote.json"
if [[ "\${1:-}" == "shell" && "\${2:-}" == "rm" ]]; then rm -f "$remote_file"; exit 0; fi
if [[ "\${1:-}" == "shell" && "\${2:-}" == "uitest" && "\${3:-}" == "dumpLayout" ]]; then
  has_bundle=false
  for arg in "$@"; do [[ "$arg" == "-b" ]] && has_bundle=true; done
  case "$MAVT_FAKE_HDC_MODE" in
    merged) [[ "$has_bundle" == true ]] && printf '%s' "$MAVT_EMPTY_TREE" > "$remote_file" || printf '%s' "$MAVT_MERGED_TREE" > "$remote_file" ;;
    fallback) [[ "$has_bundle" == true ]] && printf '%s' "$MAVT_APP_TREE" > "$remote_file" || printf '%s' "$MAVT_EMPTY_TREE" > "$remote_file" ;;
    empty) printf '%s' "$MAVT_EMPTY_TREE" > "$remote_file" ;;
  esac
  echo 'DumpLayout saved'
  exit 0
fi
if [[ "\${1:-}" == "file" && "\${2:-}" == "recv" ]]; then cp "$remote_file" "\${4}"; exit 0; fi
exit 2
`);
fs.chmodSync(fakeHdc, 0o755);

const atom = path.resolve(__dirname, '../platform/adapters/harmony/atoms/dump-tree.sh');

function run(mode) {
  const runDir = path.join(temp, mode);
  fs.mkdirSync(runDir, { recursive: true });
  const out = path.join(runDir, 'tree.json');
  const log = path.join(runDir, 'dump.log');
  const hdcLog = path.join(runDir, 'hdc.log');
  const result = childProcess.spawnSync(atom, [
    '--device', 'harmony-device', '--bundle', 'com.example.harmony',
    '--out', out, '--remote', `/data/local/tmp/${mode}.json`, '--log', log,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MAVT_FAKE_HDC_STATE: state,
      MAVT_FAKE_HDC_MODE: mode,
      MAVT_FAKE_HDC_LOG: hdcLog,
      MAVT_EMPTY_TREE: emptyTree,
      MAVT_MERGED_TREE: mergedTree,
      MAVT_APP_TREE: appTree,
    },
  });
  return {
    result,
    out,
    log: fs.readFileSync(log, 'utf8'),
    commands: fs.readFileSync(hdcLog, 'utf8').trim().split('\n'),
  };
}

const merged = run('merged');
assert.strictEqual(merged.result.status, 0, merged.result.stderr);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(merged.out, 'utf8')), JSON.parse(mergedTree));
assert.match(merged.result.stdout, /"variant": "with-m"/);
assert.strictEqual(merged.commands.find((line) => line.includes('uitest dumpLayout')).includes(' -b '), false);

const fallback = run('fallback');
assert.strictEqual(fallback.result.status, 0, fallback.result.stderr);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(fallback.out, 'utf8')), JSON.parse(appTree));
assert.match(fallback.result.stdout, /"variant": "with-m-bundle"/);
assert.match(fallback.log, /rejected unusable layout: with-m/);

const empty = run('empty');
assert.strictEqual(empty.result.status, 1);
assert.strictEqual(fs.existsSync(empty.out), false);
assert.match(empty.result.stderr, /Harmony dump-tree failed/);

fs.rmSync(temp, { recursive: true, force: true });
console.log('harmony-layout-capture passed');

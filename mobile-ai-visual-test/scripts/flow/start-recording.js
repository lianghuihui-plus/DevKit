#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  ensureDir,
  nowIso,
  sha1,
  slugify,
  workspaceRoot,
  writeJson,
  writeText,
} = require('../common');

function usage() {
  console.error('Usage: start-recording.js --name <flow-name> [--intent <a,b,c>] [--cwd <workspace-cwd>] [--platform <platform>] [--device <device>] [--app <appId>] [--entry <entry>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let name = '';
let intentText = '';
let cwd = process.cwd();
const environment = {};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--name': name = args[++i]; break;
    case '--intent': intentText = args[++i]; break;
    case '--cwd': cwd = path.resolve(args[++i]); break;
    case '--platform': environment.platform = args[++i]; break;
    case '--device': environment.device = args[++i]; break;
    case '--app':
    case '--bundle': environment.appId = args[++i]; break;
    case '--entry':
    case '--ability': environment.entry = args[++i]; break;
    default: usage();
  }
}

if (!name) usage();

const flowId = `flow-${sha1(name).slice(0, 12)}`;
const flowDir = path.join(workspaceRoot(cwd), 'flows', `${slugify(name)}__${flowId}`);
const recordingId = recordingIdFromDate();
const recordingDir = path.join(flowDir, 'recordings', recordingId);
const intent = intentText.split(',').map((item) => item.trim()).filter(Boolean);
const startedAt = nowIso();

ensureDir(path.join(recordingDir, 'screenshots'));
ensureDir(path.join(recordingDir, 'layouts'));
ensureDir(path.join(recordingDir, 'logs'));
writeText(path.join(recordingDir, 'timeline.jsonl'), `${JSON.stringify({
  time: startedAt,
  type: 'flowRecordingStart',
  flowId,
  recordingId,
  name,
  intent,
})}\n`);
writeJson(path.join(flowDir, 'state.json'), {
  schemaVersion: 1,
  flowId,
  name,
  intent,
  latestRecordingId: recordingId,
  latestStatus: 'RECORDING',
  updatedAt: startedAt,
  environment,
});

console.log(JSON.stringify({ flowId, flowDir, recordingId, recordingDir, environment }, null, 2));

function recordingIdFromDate(date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
    '-',
    String(date.getMilliseconds()).padStart(3, '0'),
  ].join('');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

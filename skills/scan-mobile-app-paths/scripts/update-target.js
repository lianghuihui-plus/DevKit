#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, readJson, now, commitEvent, output, main, fail } = require('./lib/common');
const { validateTarget } = require('./lib/schema');

main(() => {
  const args = parseArgs(); const { scanDir, appRoot } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: true }); const app = readJson(path.join(appRoot, 'app.json'));
  if (scan.status !== 'CREATED') fail('Target can only be updated before plan confirmation', 'RUN_STATE_INVALID');
  const old = readJson(path.join(scanDir, 'target.json'));
  const target = validateTarget({ ...old, bundleName: args.bundleName || old.bundleName, entryAbility: args.entryAbility || old.entryAbility, environment: args.environment || old.environment, deviceId: args.device || old.deviceId, appVersion: args.appVersion ?? old.appVersion, buildVersion: args.buildVersion ?? old.buildVersion });
  if (target.bundleName !== app.bundleName || target.environment !== app.environment) fail('Target identity does not match app.json', 'APP_IDENTITY_MISMATCH');
  target.confirmedAt = now(); target.detectionSource = args.detectionSource || old.detectionSource;
  scan.target = target; scan.updatedAt = target.confirmedAt;
  commitEvent(scanDir, 'targetConfirmed', { target: { ...target, deviceId: target.deviceId } }, [{ path: 'target.json', op: 'REPLACE', value: target }, { path: 'scan.json', op: 'REPLACE', value: scan }]);
  output({ schemaVersion: 1, ok: true, target });
});

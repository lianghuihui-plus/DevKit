#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, assertAbsolute, ensureDir, exists, readJson, writeJsonAtomic, now, slug, output, main, fail } = require('./lib/common');

main(() => {
  const args = parseArgs();
  const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root');
  const identity = {
    platform: args.platform || 'harmony', bundleName: required(args, 'bundleName'),
    environment: required(args, 'environment'), defaultEntryAbility: required(args, 'entryAbility')
  };
  if (identity.platform !== 'harmony') fail('First version only supports platform=harmony', 'PLATFORM_UNSUPPORTED');
  ensureDir(root);
  const appFile = path.join(root, 'app.json');
  let app;
  if (exists(appFile)) {
    app = readJson(appFile);
    for (const key of ['platform', 'bundleName', 'environment']) if (app[key] !== identity[key]) fail(`App root identity mismatch on ${key}`, 'APP_IDENTITY_MISMATCH');
    if (args.entryAbility && app.defaultEntryAbility !== args.entryAbility) {
      app.defaultEntryAbility = String(args.entryAbility);
      app.updatedAt = now();
      writeJsonAtomic(appFile, app);
    }
  } else {
    app = { schemaVersion: 1, appKey: args.appKey || slug(`${identity.bundleName}-${identity.environment}`), ...identity, createdAt: now() };
    writeJsonAtomic(appFile, app);
  }
  ensureDir(path.join(root, 'runs'));
  ensureDir(path.join(root, 'maps'));
  ensureDir(path.join(root, 'snapshots', 'generations'));
  if (!exists(path.join(root, 'run-index.json'))) writeJsonAtomic(path.join(root, 'run-index.json'), { schemaVersion: 1, appKey: app.appKey, runs: [] });
  output({ schemaVersion: 1, ok: true, appMapRoot: root, app });
});

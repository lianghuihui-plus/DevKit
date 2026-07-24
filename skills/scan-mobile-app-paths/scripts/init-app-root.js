#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveAppMapRoot, ensureDir, exists, readJson, writeJsonAtomic, now, slug, output, main, fail, jsonArg } = require('./lib/common');

main(() => {
  const args = parseArgs();
  const identity = {
    platform: args.platform || 'harmony', bundleName: required(args, 'bundleName'),
    environment: required(args, 'environment'), defaultEntryAbility: required(args, 'entryAbility')
  };
  const root = resolveAppMapRoot(args, { bundleName: identity.bundleName, requireExisting: false });
  const candidateRules = args.candidateRules ? jsonArg(args.candidateRules, null, '--candidate-rules') : null;
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
    if (candidateRules) {
      app.candidateRules = candidateRules;
      app.updatedAt = now();
      writeJsonAtomic(appFile, app);
    }
  } else {
    app = { schemaVersion: 1, appKey: args.appKey || slug(`${identity.bundleName}-${identity.environment}`), ...identity, createdAt: now() };
    if (candidateRules) app.candidateRules = candidateRules;
    writeJsonAtomic(appFile, app);
  }
  ensureDir(path.join(root, 'runs'));
  ensureDir(path.join(root, 'maps'));
  ensureDir(path.join(root, 'snapshots', 'generations'));
  if (!exists(path.join(root, 'run-index.json'))) writeJsonAtomic(path.join(root, 'run-index.json'), { schemaVersion: 1, appKey: app.appKey, runs: [] });
  output({ schemaVersion: 1, ok: true, appMapRoot: root, app });
});

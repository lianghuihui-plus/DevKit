#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, assertAbsolute, readJson, writeTextAtomic, sha256, output, main, fail, safeSegment } = require('./lib/common');
const { buildDashboardViewModel } = require('./lib/dashboard-view-model');

const PLACEHOLDER = '__SMAP_DASHBOARD_DATA__';

function checksum(value) { return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
function inside(base, candidate) { const relative = path.relative(base, candidate); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
function loadChecked(file, expected, label) { const value = readJson(file); if (checksum(value) !== expected) fail(`${label} checksum does not match Snapshot manifest`, 'DASHBOARD_SOURCE_CHECKSUM_INVALID'); return value; }
function embeddedJson(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

main(() => {
  const args = parseArgs(); const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root'); const app = readJson(path.join(root, 'app.json')); const snapshotsRoot = path.join(root, 'snapshots'); const pointer = readJson(path.join(snapshotsRoot, 'current.json'));
  const generationId = safeSegment(pointer.generationId, 'generationId'); let generationDir = path.resolve(snapshotsRoot, String(pointer.relativePath || ''));
  if (!inside(snapshotsRoot, generationDir) || path.basename(generationDir) !== generationId || path.basename(path.dirname(generationDir)) !== 'generations') fail('Snapshot pointer escapes the generations directory', 'DASHBOARD_SOURCE_INVALID');
  const realSnapshotsRoot = fs.realpathSync(snapshotsRoot); generationDir = fs.realpathSync(generationDir); if (!inside(realSnapshotsRoot, generationDir)) fail('Snapshot generation resolves outside snapshots root', 'DASHBOARD_SOURCE_INVALID');
  const manifest = readJson(path.join(generationDir, 'manifest.json')); if (manifest.generationId !== generationId || checksum(manifest) !== pointer.manifestSha256) fail('Snapshot pointer manifest verification failed', 'DASHBOARD_SOURCE_CHECKSUM_INVALID');
  for (const key of ['map', 'authDiff', 'unresolved', 'metrics']) if (!manifest.checksums?.[key]) fail(`Snapshot manifest lacks ${key} checksum`, 'DASHBOARD_SOURCE_INVALID');
  const map = loadChecked(path.join(generationDir, 'map.json'), manifest.checksums.map, 'map.json'); const authDiff = loadChecked(path.join(generationDir, 'auth-diff.json'), manifest.checksums.authDiff, 'auth-diff.json'); const unresolved = loadChecked(path.join(generationDir, 'unresolved.json'), manifest.checksums.unresolved, 'unresolved.json'); const metrics = loadChecked(path.join(generationDir, 'metrics.json'), manifest.checksums.metrics, 'metrics.json');
  const templateFile = path.resolve(__dirname, '..', 'assets', 'dashboard-template.html'); const template = fs.readFileSync(templateFile, 'utf8'); const occurrences = template.split(PLACEHOLDER).length - 1; if (occurrences !== 1) fail(`Dashboard template must contain exactly one ${PLACEHOLDER} placeholder`, 'DASHBOARD_TEMPLATE_INVALID');
  const templateSha256 = sha256(Buffer.from(template)); const viewModel = buildDashboardViewModel({ appMapRoot: root, app, pointer, manifest, map, metrics, authDiff, unresolved, templateSha256 }); const html = template.replace(PLACEHOLDER, embeddedJson(viewModel));
  if (html.includes(PLACEHOLDER)) fail('Dashboard template placeholder was not fully resolved', 'DASHBOARD_TEMPLATE_INVALID');
  const dashboardDir = path.join(root, 'dashboard'); if (fs.existsSync(dashboardDir) && fs.lstatSync(dashboardDir).isSymbolicLink()) fail('Dashboard output directory must not be a symbolic link', 'DASHBOARD_OUTPUT_INVALID'); const outputFile = path.join(dashboardDir, 'index.html'); writeTextAtomic(outputFile, html);
  output({ schemaVersion: 1, ok: true, dashboardPath: outputFile, generationId, sourceManifestSha256: pointer.manifestSha256, templateSha256, htmlSha256: sha256(Buffer.from(html)), summary: viewModel.overview });
});

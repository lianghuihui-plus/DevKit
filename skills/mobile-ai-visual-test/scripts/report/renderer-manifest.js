'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUPPORT_FILES = Object.freeze([
  'scripts/render-context.js',
  'scripts/render-index.js',
  'scripts/lib/cli-args.js',
  'scripts/lib/completion-contract.js',
  'scripts/lib/display-format.js',
  'scripts/lib/execution-reader.js',
  'scripts/lib/failure-catalog.js',
  'scripts/lib/knowledge-snapshot.js',
  'scripts/lib/execution-evidence.js',
  'scripts/lib/image-evidence.js',
  'scripts/lib/contract-utils.js',
]);

function walkFiles(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs.readdirSync(absolute).sort().flatMap((name) => walkFiles(root, path.posix.join(relative, name)));
}

function localDependencyFiles(skillRoot, roots) {
  const resolvedRoot = fs.realpathSync(skillRoot);
  const prefix = `${resolvedRoot}${path.sep}`;
  const files = new Set();
  const visited = new Set();
  function visit(loaded) {
    if (!loaded?.filename || visited.has(loaded.filename)) return;
    visited.add(loaded.filename);
    const filename = fs.realpathSync(loaded.filename);
    if (filename !== resolvedRoot && !filename.startsWith(prefix)) return;
    files.add(path.relative(resolvedRoot, filename).replace(/\\/g, '/'));
    loaded.children.forEach(visit);
  }
  for (const relative of roots.filter((value) => value.endsWith('.js'))) {
    const absolute = path.join(resolvedRoot, relative);
    const loaded = fs.realpathSync(absolute) === fs.realpathSync(__filename)
      ? module
      : require.cache[require.resolve(absolute)] || (require(absolute), require.cache[require.resolve(absolute)]);
    visit(loaded);
  }
  return [...files];
}

function reportRendererInfo(skillRoot = path.resolve(__dirname, '../..')) {
  const roots = [...new Set([...walkFiles(skillRoot, 'scripts/report'), ...SUPPORT_FILES])];
  const dependencyRoots = roots.filter((relative) => ![
    'scripts/render-context.js',
    'scripts/render-index.js',
    'scripts/report/render-context.js',
    'scripts/report/render-index.js',
  ].includes(relative));
  const files = [...new Set([...roots, ...localDependencyFiles(skillRoot, dependencyRoots)])].sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const file = path.join(skillRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`REPORT_RENDERER_FILE_MISSING: ${relative}`);
    hash.update(`${relative}\0`, 'utf8');
    hash.update(fs.readFileSync(file));
    hash.update('\0', 'utf8');
  }
  return { rendererSha: `report-renderer-${hash.digest('hex').slice(0, 16)}`, rendererFiles: files };
}

module.exports = { reportRendererInfo };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { reportingError } = require('./errors');
const SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const SOURCE_EXECUTION_BYTES = 32 * 1024 * 1024;
const STRUCTURED = /\.(json|jsonl)$/i;
const EVIDENCE_ROOTS = /^(screenshots|layouts|logs|scenes|operations|action-spatial-evidence|knowledge|telemetry|sequences|capabilities|resources|spans)\//;
function fail(code = 'REPORTING_SOURCE_INVALID') {
  throw reportingError(code, 'Reporting source validation failed');
}
function safePath(root, relative, optional = false) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..'))
    fail('REPORTING_PATH_UNSAFE');
  const base = path.resolve(root);
  let current = path.parse(base).root;
  for (const part of path.relative(current, base).split(path.sep).concat(relative.split('/'))) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        fail('REPORTING_PATH_UNSAFE');
    }
    catch (e) {
      if (e.code === 'ENOENT' && optional)
        return null;
      if (e.code === 'ENOENT')
        fail('REPORTING_EVIDENCE_MISSING');
      throw e;
    }
  }
  return current;
}
function text(file) {
  try {
    return new TextDecoder('utf-8', {
      fatal: true
    }).decode(fs.readFileSync(file));
  }
  catch {
    fail();
  }
}
function rejectReserved(value, depth = 0) {
  if (depth > 64)
    fail();
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.hasOwn(value, 'fileId'))
      fail('REPORTING_RESERVED_FIELD_COLLISION');
    for (const child of Object.values(value))
      rejectReserved(child, depth + 1);
  }
}
function parse(file) {
  try {
    const raw = text(file);
    const data = file.endsWith('.jsonl') ? raw.split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s)) : JSON.parse(raw);
    rejectReserved(data);
    return data;
  }
  catch (e) {
    if (e.code?.startsWith('REPORTING_'))
      throw e;
    fail();
  }
}
function readJson(root, relative, optional = false) {
  const file = safePath(root, relative, optional);
  if (!file)
    return null;
  if (fs.statSync(file).size > SOURCE_FILE_BYTES)
    fail('REPORTING_SOURCE_BUDGET_EXCEEDED');
  return parse(file);
}
function list(root, relative) {
  const dir = safePath(root, relative, true);
  return dir ? fs.readdirSync(dir).filter(n => !n.startsWith('.')).sort() : [];
}
function digest(file) {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, n));
    return hash.digest('hex');
  }
  finally {
    fs.closeSync(fd);
  }
}
// Inventory sizes before decoding anything; malformed optional files cannot fall
// through the renderer's permissive read helpers. Directory entries are signed too.
function inventory(root) {
  const files = [], directories = [];
  let structuredBytes = 0;
  function walk(relative = '') {
    const dir = relative ? safePath(root, relative) : root;
    const names = fs.readdirSync(dir).sort();
    directories.push({
      relative,
      names
    });
    for (const name of names) {
      if (name.startsWith('.'))
        continue;
      const rel = relative ? `${relative}/${name}` : name, file = safePath(root, rel);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) {
        if (!['transactions', 'cache'].includes(name))
          walk(rel);
        continue;
      }
      if (STRUCTURED.test(rel)) {
        structuredBytes += stat.size;
        if (stat.size > SOURCE_FILE_BYTES || structuredBytes > SOURCE_EXECUTION_BYTES)
          fail('REPORTING_SOURCE_BUDGET_EXCEEDED');
      }
      files.push({
        relative: rel,
        path: file,
        bytes: stat.size
      });
    }
  }
  walk();
  for (const file of files) {
    file.hash = digest(file.path);
    if (STRUCTURED.test(file.relative))
      parse(file.path);
  }
  return {
    root,
    files,
    directories,
    structuredBytes
  };
}
function verifyInventory(value) {
  for (const d of value.directories) {
    const names = fs.readdirSync(d.relative ? safePath(value.root, d.relative) : value.root).sort();
    if (JSON.stringify(names) !== JSON.stringify(d.names))
      fail('REPORTING_SOURCE_CHANGED');
  }
  for (const f of value.externalFiles || []) {
    const file = safePath(f.root,f.relative,true);
    if ((file ? digest(file) : null) !== f.hash) fail('REPORTING_SOURCE_CHANGED');
  }
  for (const f of value.files)
    if (digest(safePath(value.root, f.relative)) !== f.hash)
      fail('REPORTING_SOURCE_CHANGED');
}
function readHealthMetadata(execDir, inv) {
  const workspace = path.resolve(execDir, '../../../../../..');
  const caseDir = path.resolve(execDir, '../../../..');
  const runtimeDir = path.resolve(execDir, '../..');
  const scopes = {workspace, case:caseDir, platform:runtimeDir};
  const metadata = {};
  inv.externalFiles = [];
  for (const [scope, directory] of Object.entries(scopes)) {
    for (const name of ['report-metadata.json', 'report-publication.draft.json']) {
      const relative = path.relative(workspace,path.join(directory,name)).split(path.sep).join('/');
      const file = safePath(workspace,relative,true);
      inv.externalFiles.push({root:workspace,relative,hash:file ? digest(file) : null});
      if (!file) continue;
      const size = fs.statSync(file).size;
      inv.structuredBytes += size;
      if (size > SOURCE_FILE_BYTES || inv.structuredBytes > SOURCE_EXECUTION_BYTES)
        fail('REPORTING_SOURCE_BUDGET_EXCEEDED');
      const value = parse(file);
      if (name === 'report-publication.draft.json') fail('REPORTING_WAITING_PUBLICATION');
      metadata[scope] = value;
    }
  }
  return metadata;
}
function collectRefs(value, refs = new Set(), key = '') {
  if (Array.isArray(value)) {
    for (const child of value)
      collectRefs(child, refs, key);
    return refs;
  }
  if (value && typeof value === 'object') {
    for (const [name, child] of Object.entries(value))
      collectRefs(child, refs, name);
    return refs;
  }
  if (typeof value === 'string' && (/^(ref|baseRef|contentRef|snapshotRef|screenshot|layout|artifact|resource)$/i.test(key) || /Refs?$/.test(key)) && value.includes('/')) {
    // Logical CHECK/scene/knowledge identities without evidence file prefixes are
    // not paths. Explicit file-reference fields still reject attempts to escape.
    if (EVIDENCE_ROOTS.test(value) || value.startsWith('../') || value.startsWith('/') || value.includes('\\'))
      refs.add(value);
  }
  return refs;
}
function createSourceReader14(options = {}) {
  return {
    readJson,
    inventory,
    verifyInventory,
    readDefinition(caseDir) {
      const definition = readJson(caseDir, 'case.json'), sourcePath = safePath(caseDir, 'source.md');
      if (!definition?.identity?.caseKey || !definition.identity.title)
        fail();
      if (fs.statSync(sourcePath).size > SOURCE_FILE_BYTES)
        fail('REPORTING_SOURCE_BUDGET_EXCEEDED');
      return {
        case: definition,
        sourceText: text(sourcePath),
        signature: [{
            path: safePath(caseDir, 'case.json'),
            hash: digest(safePath(caseDir, 'case.json'))
          }, {
            path: sourcePath,
            hash: digest(sourcePath)
          }]
      };
    },
    readExecution(execDir) {
      const inv = inventory(execDir), execution = readJson(execDir, 'execution.json');
      if (execution?.schemaVersion !== 14)
        fail('REPORTING_SOURCE_VERSION_UNSUPPORTED');
      safePath(execDir, 'case.snapshot.json');
      safePath(execDir, 'source.snapshot.md');
      const healthMetadata = readHealthMetadata(execDir,inv);
      const report = require('../lib/execution-reader').readExecutionReport(execDir);
      if (report.readability !== 'READABLE' || report.completionError || !report.snapshot?.identity?.caseKey || report.finalizationPending || report.pendingCompletion)
        fail();
      const graph = require('./artifacts').discoverEvidence({
        inventory: inv,
        report
      });
      const trace = (options.buildTrace || require('../report/execution-trace').buildExecutionTrace)(report);
      const views = require('../report/case-flow-projection').projectCaseFlowViews(report);
      return {
        inventory: inv,
        report,
        trace,
        views,
        healthMetadata,
        graph
      };
    },
  };
}
module.exports = {
  SOURCE_FILE_BYTES,
  SOURCE_EXECUTION_BYTES,
  safePath,
  readJson,
  list,
  digest,
  text,
  parse,
  rejectReserved,
  inventory,
  verifyInventory,
  collectRefs,
  createSourceReader14
};

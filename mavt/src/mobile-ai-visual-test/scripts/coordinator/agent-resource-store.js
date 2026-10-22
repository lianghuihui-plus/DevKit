'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const RESOURCE_CATALOG = require('./agent-facing-contract').PUBLIC_CONTRACT.resourceCatalog;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (value) => hash(canonicalJson(value));
const fail = (message) => contractError('RESOURCE_INTEGRITY_INVALID', message);

function rootFor(state) { return fs.realpathSync(path.dirname(state.statePath)); }
function scopeFor(state) { return hash(`coordinator\n${rootFor(state)}\n${state.batchId}`).slice(0, 24); }
function regularFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || path.normalize(relative) !== relative
    || relative === '..' || relative.startsWith(`..${path.sep}`)) throw fail('resource authority must remain inside its run');
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw fail('resource authority cannot be a symbolic link');
  }
  if (!fs.lstatSync(cursor).isFile() || fs.realpathSync(cursor) !== cursor) throw fail('resource authority must be a canonical file');
  return cursor;
}
function immutableJson(state, relative, content) {
  const root = rootFor(state);
  let directory = root;
  for (const part of path.dirname(relative).split(path.sep)) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw fail('invalid resource directory');
  }
  const file = path.join(root, relative);
  if (fs.existsSync(file)) {
    if (canonicalJson(JSON.parse(fs.readFileSync(regularFile(root, relative), 'utf8'))) !== canonicalJson(content)) throw fail('immutable resource cannot be rebound');
    return;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(content)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    try { fs.linkSync(temporary, file); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (canonicalJson(JSON.parse(fs.readFileSync(regularFile(root, relative), 'utf8'))) !== canonicalJson(content)) throw fail('conflicting resource publication');
    }
  } finally { fs.unlinkSync(temporary); }
}
function catalogPath(ref) { return path.join('coordinator-resources', 'catalog', `${hash(ref)}.json`); }
function descriptor(record, role = 'associated') {
  return { ref: record.ref, type: record.type, role, revision: record.revision, integrity: `sha256:${record.integrity}` };
}
function publishSnapshot(state, type, content, resources = []) {
  if (!RESOURCE_CATALOG[type] || type === 'caseDispatch') throw fail('invalid snapshot type');
  const body = JSON.parse(JSON.stringify({ content, resources }));
  const integrity = digest(body);
  const revision = state.revision;
  const ref = `mavt:${scopeFor(state)}:${type}:${revision}-${integrity}`;
  const source = path.join('coordinator-resources', 'snapshots', `${revision}-${integrity}.json`);
  immutableJson(state, source, body);
  const record = { ref, type, revision, integrity, source, authority: 'snapshot' };
  immutableJson(state, catalogPath(ref), record);
  return readResource(state, ref);
}
function dispatchContent(handoff, source, delegationPrompt, caseNo) {
  return { caseNo, handoffId: source.handoffId, loaderCommand: handoff.loaderCommand, delegationPrompt };
}
function publishDispatch(state, handoff, delegationPrompt, caseNo) {
  try {
    const candidates = [rootFor(state), path.dirname(state.statePath)].map((root) => path.relative(root, handoff.path));
    const source = candidates.find((relative) => relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const value = JSON.parse(fs.readFileSync(regularFile(rootFor(state), source), 'utf8'));
    if (digest(value) !== handoff.sha256 || value.handoffId !== handoff.handoffId || value.batchId !== state.batchId
      || !Number.isInteger(value.sequence) || value.sequence < 1
      || source !== path.join('handoffs', value.executionId, `${value.sequence}-${handoff.sha256}.json`)) throw fail('handoff identity or digest mismatch');
    const content = dispatchContent(handoff, value, delegationPrompt, caseNo);
    const integrity = digest({ content, resources: [] });
    const ref = `mavt:${scopeFor(state)}:caseDispatch:${encodeURIComponent(`${value.handoffId}:${value.sequence}:${handoff.sha256}:${integrity}`)}`;
    const existing = path.join(rootFor(state), catalogPath(ref));
    if (fs.existsSync(existing)) return readResource(state, ref);
    const record = { ref, type: 'caseDispatch', revision: state.revision, integrity,
      source, authority: 'handoff', sourceIntegrity: handoff.sha256, handoffId: handoff.handoffId,
      sequence: value.sequence, loaderCommand: handoff.loaderCommand, delegationPrompt, caseNo };
    immutableJson(state, catalogPath(ref), record);
    return readResource(state, ref);
  } catch (error) { throw error.code === 'RESOURCE_INTEGRITY_INVALID' ? error : fail('handoff authority unavailable'); }
}
function readResource(state, ref) {
  const match = typeof ref === 'string' && ref.match(/^mavt:([a-f0-9]{24}):([^:]+):(.+)$/);
  if (!match) throw contractError('RESOURCE_UNKNOWN', 'resource ref was not published');
  if (match[1] !== scopeFor(state)) throw contractError('RESOURCE_SCOPE_MISMATCH', 'resource belongs to another scope');
  const relative = catalogPath(ref);
  if (!RESOURCE_CATALOG[match[2]] || !fs.existsSync(path.join(rootFor(state), relative))) throw contractError('RESOURCE_UNKNOWN', 'resource ref was not published');
  try {
    const record = JSON.parse(fs.readFileSync(regularFile(rootFor(state), relative), 'utf8'));
    if (record.ref !== ref || record.type !== match[2]) throw fail('catalog binding mismatch');
    const source = JSON.parse(fs.readFileSync(regularFile(rootFor(state), record.source), 'utf8'));
    let body;
    if (record.authority === 'handoff') {
      const identity = `${source.handoffId}:${source.sequence}:${record.sourceIntegrity}:${record.integrity}`;
      if (record.type !== 'caseDispatch' || digest(source) !== record.sourceIntegrity || source.batchId !== state.batchId
        || source.handoffId !== record.handoffId || source.sequence !== record.sequence || encodeURIComponent(identity) !== match[3]
        || record.source !== path.join('handoffs', source.executionId, `${source.sequence}-${record.sourceIntegrity}.json`)) throw fail('handoff integrity mismatch');
      body = { content: dispatchContent(record, source, record.delegationPrompt, record.caseNo), resources: [] };
    } else {
      if (record.authority !== 'snapshot' || `${record.revision}-${record.integrity}` !== match[3]) throw fail('snapshot binding mismatch');
      body = source;
    }
    if (digest(body) !== record.integrity) throw fail('resource content digest mismatch');
    return { data: { ref, type: record.type, content: body.content }, resources: body.resources, descriptor: descriptor(record) };
  } catch (error) { throw error.code === 'RESOURCE_INTEGRITY_INVALID' ? error : fail('resource authority missing or invalid'); }
}
function terminalResource(state) {
  const relative = path.join('coordinator-resources', 'terminal.json');
  if (!fs.existsSync(path.join(rootFor(state), relative))) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(regularFile(rootFor(state), relative), 'utf8'));
    const resource = readResource(state, saved.ref);
    if (resource.data.type !== 'runSummary') throw fail('terminal resource type mismatch');
    return resource;
  } catch (error) { throw error.code === 'RESOURCE_INTEGRITY_INVALID' ? error : fail('terminal resource unavailable'); }
}
function bindTerminalResource(state, resource) {
  if (resource?.data?.type !== 'runSummary') throw fail('terminal resource type mismatch');
  const current = terminalResource(state);
  if (current?.data.ref === resource.data.ref) return;
  writeJsonAtomic(path.join(rootFor(state), 'coordinator-resources', 'terminal.json'), { ref: resource.data.ref });
}
module.exports = { publishSnapshot, publishDispatch, readResource, terminalResource, bindTerminalResource };

'use strict';
// Fixed reporting-v2 contract snapshot (2026-10-23). No runtime schema engine
// or external Dashboard checkout is loaded by the producer.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { reportingError } = require('./errors');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const TERMINAL_DECISIONS = new Set(['CREATED', 'REPLACED', 'ALREADY_CURRENT', 'STALE_IGNORED']);
const REMOTE_CODES = new Set(['INVALID_MANIFEST', 'INVALID_DOCUMENT', 'CONTENT_MISMATCH', 'REFERENCE_INVALID',
  'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_VERSION', 'REVISION_CONFLICT', 'EXECUTION_IDENTITY_CONFLICT',
  'DEFINITION_CONFLICT', 'INTERNAL_ERROR', 'VALIDATION_TIMEOUT']);
const LIMITS = Object.freeze({
  manifestBytes: 4194304,
  cases: 1000,
  executions: 3000,
  files: 10000,
  documentBytes: 16777216,
  fileBytes: 67108864,
  sessionBytes: 4294967296,
  gzipRatio: 100,
  jsonDepth: 64,
  referenceDepth: 16,
  concurrentUploads: 4,
  jsonlLineBytes: 1048576,
  indexDescriptorBytes: 32768
});
const SECTION_KINDS = Object.freeze(['case-source', 'runtime', 'checks', 'flow', 'actions', 'sequences', 'scenes', 'spatial-evidence', 'metrics', 'records', 'invocations', 'events', 'timing', 'logs', 'knowledge', 'report-health', 'integrity']);
const CORE = ['case-source', 'runtime', 'checks', 'flow', 'actions', 'scenes', 'metrics'];
const UNIQUE = {
  checks: 'checkId',
  actions: 'operationId',
  sequences: 'sequenceId',
  scenes: 'sceneId',
  records: 'id',
  logs: 'id'
};
const ROW_FIELDS = {
  checks: ['checkId', 'status'],
  actions: ['operationId', 'type', 'outcome'],
  sequences: ['sequenceId', 'status'],
  scenes: ['sceneId'],
  'spatial-evidence': ['operationId', 'kind'],
  records: ['id', 'type'],
  invocations: ['invocationId', 'phase'],
  events: ['eventId', 'type', 'time'],
  timing: ['name'],
  logs: ['id', 'label']
};
const own = (v, k) => Object.hasOwn(v, k);
function invalid(message = 'Invalid reporting contract') {
  throw reportingError('REPORTING_CONTRACT_INVALID', message);
}
function check(condition) {
  if (!condition)
    invalid();
}
function terminalResult(value, manifest, remoteId) {
  const protocol = condition => { if (!condition) throw reportingError('REPORTING_PROTOCOL_INVALID'); };
  const safeCode = code => REMOTE_CODES.has(code) ? code : 'REMOTE_REJECTED';
  function safeFieldPath(field) {
    if (field === '/workspace') return field;
    const match = /^\/(cases|executions|files)\/(\d+)(?:\/(definition|report|revision|definitionRevision|summary|sections|data|dataFiles|fileId))?$/.exec(field || '');
    return match && Number(match[2]) < manifest[match[1]].length ? field : '/';
  }
  protocol(value?.protocolVersion === '2.0' && validId(value.sessionId) && value.sessionId === remoteId);
  protocol(['COMMITTED', 'REJECTED'].includes(value.status));
  const result = value.results;
  protocol(result && result.workspace?.id === manifest.workspace.id && Array.isArray(result.cases) && Array.isArray(result.executions));
  function decision(row) {
    protocol(row && typeof row === 'object');
    protocol(value.status === 'COMMITTED' ? TERMINAL_DECISIONS.has(row.decision) && row.code === null
      : row.decision === 'REJECTED' && typeof row.code === 'string');
    return { decision: row.decision, code: row.code === null ? null : safeCode(row.code) };
  }
  function members(rows, expected, identity, fields) {
    protocol(rows.length === expected.length);
    const identities = new Set(expected.map(identity));
    return rows.map(row => {
      protocol(row && typeof row === 'object' && !Array.isArray(row));
      const key = identity(row);
      protocol(identities.delete(key));
      return { ...Object.fromEntries(fields.map(k => [k, row[k]])), ...decision(row) };
    });
  }
  const cases = members(result.cases, manifest.cases, row => row.caseKey, ['caseKey']);
  const executions = members(result.executions, manifest.executions,
    row => `${row.caseKey}\0${row.platform}\0${row.executionId}`, ['caseKey', 'platform', 'executionId']);
  protocol(Array.isArray(value.errors) && value.errors.length <= Math.max(1,
    manifest.cases.length + manifest.executions.length + manifest.files.length));
  protocol(value.status !== 'COMMITTED' || value.errors.length === 0);
  return { protocolVersion: '2.0', sessionId: remoteId, status: value.status,
    results: { workspace: { id: manifest.workspace.id, ...decision(result.workspace) }, cases, executions },
    errors: value.errors.map(e => ({ path: safeFieldPath(e?.path), code: safeCode(e?.code) })) };
}
function object(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function string(v, min = 0, max = Infinity) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}
function id(v) {
  return string(v) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
}
function integer(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}
function revision(v) {
  return integer(v, 1);
}
function timestamp(v) {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function strict(v, keys) {
  check(object(v) && Object.keys(v).every(k => keys.includes(k)));
}
function extension(v) {
  check(v === undefined || object(v));
}
function bytes(v) {
  return Buffer.byteLength(JSON.stringify(v));
}
function ref(v) {
  check(object(v) && Object.keys(v).length === 1 && id(v.fileId));
}
function references(v, refs = new Set(), depth = 0, limits = LIMITS) {
  check(depth <= limits.jsonDepth);
  if (v && typeof v === 'object') {
    if (!Array.isArray(v) && own(v, 'fileId')) {
      check(id(v.fileId));
      refs.add(v.fileId);
    }
    for (const child of Object.values(v))
      references(child, refs, depth + 1, limits);
  }
  return refs;
}
function resolveLimits(input = {}) {
  check(object(input));
  const result = {
    ...LIMITS
  };
  for (const [key, value] of Object.entries(input)) {
    check(own(LIMITS, key) && integer(value, 1));
    result[key] = Math.min(LIMITS[key], value);
  }
  return Object.freeze(result);
}
function validateCapabilities(c) {
  check(object(c) && c.protocolVersions?.includes('2.0') && c.documentVersions?.includes('1.0') && c.encodings?.includes('identity'));
  check(Array.isArray(c.platforms) && ['android', 'ios', 'harmony'].every(p => c.platforms.includes(p)));
  check(object(c.sectionVersions) && SECTION_KINDS.every(k => c.sectionVersions[k]?.includes('1.0')));
  check(c.unknownSections === 'preserve-with-generic-view');
  return resolveLimits(c.limits);
}
function validateManifest(m, { limits = LIMITS, now = Date.now() } = {}) {
  strict(m, ['protocolVersion', 'producer', 'workspace', 'cases', 'executions', 'files', 'extensions']);
  check(m.protocolVersion === '2.0');
  extension(m.extensions);
  strict(m.producer, ['name', 'version', 'extensions']);
  check(string(m.producer.name, 1, 128) && string(m.producer.version, 1, 128));
  extension(m.producer.extensions);
  strict(m.workspace, ['id', 'name', 'revision', 'extensions']);
  check(id(m.workspace.id) && string(m.workspace.name, 1, 256) && revision(m.workspace.revision));
  extension(m.workspace.extensions);
  check(bytes(m.workspace) <= limits.indexDescriptorBytes);
  for (const v of [m.extensions, m.producer.extensions, m.workspace.extensions])
    check(references(v, new Set(), 0, limits).size === 0);
  check(Array.isArray(m.cases)
    && m.cases.length <= limits.cases
    && Array.isArray(m.executions)
    && m.executions.length <= limits.executions
    && Array.isArray(m.files)
    && m.files.length <= limits.files);
  const unique = (values) => check(new Set(values).size === values.length);
  unique(m.cases.map(c => c.caseKey));
  unique(m.executions.map(e => `${e.caseKey}/${e.platform}`));
  unique(m.executions.map(e => e.executionId));
  unique(m.files.map(f => f.id));
  const cases = new Set(m.cases.map(c => c.caseKey)), ids = new Set(m.files.map(f => f.id)), hashes = new Map();
  let total = 0;
  for (const c of m.cases) {
    strict(c, ['caseKey', 'caseNo', 'title', 'definitionRevision', 'definition', 'extensions']);
    check(id(c.caseKey) && string(c.title, 1, 1024) && revision(c.definitionRevision) && (c.caseNo === undefined || string(c.caseNo, 0, 128)));
    ref(c.definition);
    extension(c.extensions);
    check(bytes(c) <= limits.indexDescriptorBytes);
  }
  for (const e of m.executions) {
    strict(e, ['caseKey', 'platform', 'executionId', 'startedAt', 'endedAt', 'revision', 'summary', 'report', 'extensions']);
    check(id(e.caseKey)
      && cases.has(e.caseKey)
      && ['android', 'ios', 'harmony'].includes(e.platform)
      && id(e.executionId)
      && timestamp(e.startedAt)
      && (e.endedAt === null
      || timestamp(e.endedAt))
      && revision(e.revision));
    ref(e.report);
    extension(e.extensions);
    check(Date.parse(e.startedAt) <= now + 300000 && (e.endedAt === null || (e.endedAt >= e.startedAt && Date.parse(e.endedAt) <= now + 300000)));
    const s = e.summary;
    strict(s, ['executionStatus', 'displayStatus', 'durationMs', 'text', 'extensions']);
    check(['COMPLETED', 'FINISHED', 'FAILED', 'CANCELLED'].includes(s.executionStatus)
      && ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN', 'CANCELLED', 'RESULT_MISSING'].includes(s.displayStatus)
      && (s.durationMs === null
      || integer(s.durationMs))
      && (s.text === undefined
      || s.text === null
      || string(s.text, 0, 4096)));
    extension(s.extensions);
    check((s.executionStatus === 'CANCELLED') === (s.displayStatus === 'CANCELLED') && !(s.executionStatus === 'FAILED' && s.displayStatus === 'PASS'));
    check(bytes(e) <= limits.indexDescriptorBytes);
  }
  for (const f of m.files) {
    strict(f, ['id', 'sha256', 'bytes', 'mediaType', 'encoding', 'purpose', 'extensions']);
    check(id(f.id)
      && /^sha256:[a-f0-9]{64}$/.test(f.sha256)
      && integer(f.bytes, 0, limits.fileBytes)
      && string(f.mediaType, 1, 128)
      && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(f.mediaType)
      && ['identity', 'gzip'].includes(f.encoding)
      && /^[a-z][a-z0-9.-]{0,63}$/.test(f.purpose));
    extension(f.extensions);
    if (['application/json', 'application/x-ndjson'].includes(f.mediaType))
      check(f.bytes <= limits.documentBytes);
    const prior = hashes.get(f.sha256);
    check(!prior || (prior.bytes === f.bytes && prior.mediaType === f.mediaType));
    if (!prior)
      total += f.bytes;
    hashes.set(f.sha256, f);
  }
  check(total <= limits.sessionBytes && bytes(m) <= limits.manifestBytes);
  for (const value of references(m, new Set(), 0, limits))
    check(ids.has(value));
  return m;
}
function validateSectionData(s, data, doc, { execution, title } = {}) {
  check(Array.isArray(data) || object(data));
  if (s.schemaVersion.startsWith('1.')) {
    if (own(ROW_FIELDS, s.kind)) {
      check(Array.isArray(data));
      for (const r of data) {
        check(object(r) && ROW_FIELDS[s.kind].every(k => typeof r[k] === 'string'));
        if (s.kind === 'checks') {
          check(own(r, 'expected') && (r.expected === null || typeof r.expected === 'string') && own(r, 'actual') && (r.actual === null || typeof r.actual === 'string'));
          if (execution?.summary.displayStatus === 'PASS')
            check(['PASS', 'WAIVED', 'NOT_APPLICABLE'].includes(r.status));
        }
        if (s.kind === 'sequences')
          check(Array.isArray(r.steps));
        if (s.kind === 'scenes')
          check(r.screenshot === null || object(r.screenshot) && id(r.screenshot.fileId));
        if (s.kind === 'timing')
          check(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0);
        if (s.kind === 'logs')
          check(object(r.content) && id(r.content.fileId));
      }
    }
    else if (SECTION_KINDS.includes(s.kind))
      check(object(data));
    if (s.kind === 'case-source')
      check(typeof data.source === 'string'
        && object(data.identity)
        && data.identity.caseKey === doc.subject.caseKey
        && typeof data.identity.title === 'string'
        && (title === undefined
        || data.identity.title === title));
    if (s.kind === 'runtime') {
      check(typeof data.executionId === 'string'
        && typeof data.platform === 'string'
        && typeof data.startedAt === 'string'
        && (data.endedAt === null
        || typeof data.endedAt === 'string')
        && typeof data.executionStatus === 'string');
      if (execution) {
        for (const k of ['executionId', 'platform', 'startedAt', 'endedAt'])
          check(data[k] === execution[k]);
        check(data.executionStatus === execution.summary.executionStatus);
        for (const k of ['displayStatus', 'durationMs'])
          check(data[k] === undefined || data[k] === execution.summary[k]);
        if (execution.endedAt === null)
          check(typeof data.endedAtReason === 'string');
      }
    }
    if (s.kind === 'flow') {
      check(Array.isArray(data.nodes) && Array.isArray(data.edges));
      const ids = new Set();
      for (const n of data.nodes) {
        check(object(n) && typeof n.id === 'string' && typeof n.type === 'string' && typeof n.title === 'string' && !ids.has(n.id));
        ids.add(n.id);
      }
      const edges = new Set();
      for (const e of data.edges) {
        check(object(e) && typeof e.id === 'string' && typeof e.from === 'string' && typeof e.to === 'string' && !edges.has(e.id) && ids.has(e.from) && ids.has(e.to));
        edges.add(e.id);
      }
    }
    if (s.kind === 'report-health')
      check(typeof data.status === 'string' && Array.isArray(data.issues));
  }
}
function validateDocument(doc, context = {}) {
  const { limits = LIMITS } = context;
  check(object(doc) && /^1\.[0-9]+$/.test(doc.documentVersion) && ['case-definition', 'execution-report'].includes(doc.documentType));
  strict(doc.subject, ['caseKey', 'platform', 'executionId']);
  check(id(doc.subject.caseKey));
  const execution = doc.documentType === 'execution-report';
  check(execution ? (id(doc.subject.executionId) && /^[a-z][a-z0-9-]{0,31}$/.test(doc.subject.platform)) : (!own(doc.subject, 'executionId') && !own(doc.subject, 'platform')));
  if (context.execution)
    check(doc.subject.caseKey === context.execution.caseKey && doc.subject.executionId === context.execution.executionId && doc.subject.platform === context.execution.platform);
  check(Array.isArray(doc.sections) && doc.sections.length >= 1 && doc.sections.length <= 256);
  const ids = new Set(), stable = new Map();
  for (const s of doc.sections) {
    check(object(s)
      && id(s.id)
      && !ids.has(s.id)
      && /^[a-z][a-z0-9.-]{0,63}$/.test(s.kind)
      && /^[1-9][0-9]*\.[0-9]+$/.test(s.schemaVersion)
      && string(s.title, 1, 256)
      && ['available', 'unavailable', 'not-applicable'].includes(s.availability));
    ids.add(s.id);
    check(s.reason === undefined || string(s.reason, 1, 4096));
    if (s.availability === 'available') {
      check(own(s, 'data') !== own(s, 'dataFiles'));
      if (own(s, 'data')) {
        validateSectionData(s, s.data, doc, context);
        remember(s, s.data, stable);
      }
      else {
        check(Array.isArray(s.dataFiles) && s.dataFiles.length >= 1 && s.dataFiles.length <= 10000);
        for (const r of s.dataFiles)
          check(object(r) && id(r.fileId) && (r.label === undefined || string(r.label, 0, 1024)));
      }
    }
    else
      check(typeof s.reason === 'string' && !own(s, 'data') && !own(s, 'dataFiles'));
  }
  for (const kind of execution ? CORE : ['case-source']) {
    const section = doc.sections.find(s => s.kind === kind && s.schemaVersion.startsWith('1.'));
    check(section && (!['case-source', 'runtime'].includes(kind) || section.availability === 'available'));
  }
  references(doc, new Set(), 0, limits);
  check(bytes(doc) <= limits.documentBytes);
  return doc;
}
function remember(s, data, stable) {
  const field = UNIQUE[s.kind];
  if (!field || !Array.isArray(data))
    return;
  const seen = stable.get(s.kind) || new Set();
  for (const row of data) {
    check(!seen.has(row[field]));
    seen.add(row[field]);
  }
  stable.set(s.kind, seen);
}
function parseBytes(buffer, ndjson = false, limits = LIMITS) {
  check(buffer.length <= limits.documentBytes);
  let raw;
  try {
    raw = new TextDecoder('utf8', {
      fatal: true
    }).decode(buffer);
  }
  catch {
    invalid();
  }
  try {
    return ndjson ? raw.split('\n').filter(s => s.trim()).map(line => {
      check(Buffer.byteLength(line) <= limits.jsonlLineBytes);
      return JSON.parse(line);
    }) : JSON.parse(raw);
  }
  catch (e) {
    if (e.code?.startsWith('REPORTING_'))
      throw e;
    invalid();
  }
}
async function validateGraph(manifest, load, { limits = LIMITS } = {}) {
  validateManifest(manifest, {
    limits
  });
  const files = new Map(manifest.files.map(f => [f.id, f])), adj = new Map(), all = new Set(), closures = new Map();
  const read = async (fileId) => {
    const f = files.get(fileId);
    check(f);
    const buffer = await load(fileId);
    check(Buffer.isBuffer(buffer) && buffer.length === f.bytes && 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex') === f.sha256);
    return parseBytes(buffer, f.mediaType === 'application/x-ndjson', limits);
  };
  async function children(fileId) {
    if (adj.has(fileId))
      return adj.get(fileId);
    const f = files.get(fileId);
    check(f);
    const refs = references(f.extensions, new Set(), 0, limits);
    if (['application/json', 'application/x-ndjson'].includes(f.mediaType))
      references(await read(fileId), refs, 0, limits);
    adj.set(fileId, refs);
    return refs;
  }
  async function visit(fileId, path, reached) {
    check(files.has(fileId) && !path.has(fileId) && path.size <= limits.referenceDepth);
    reached.add(fileId);
    const next = new Set([...path, fileId]);
    for (const child of await children(fileId))
      await visit(child, next, reached);
  }
  async function root(descriptor, reference, execution) {
    check(files.get(reference.fileId)?.mediaType === 'application/json');
    const doc = await read(reference.fileId);
    validateDocument(doc, {
      execution,
      title: execution ? undefined : descriptor.title,
      limits
    });
    check(doc.subject.caseKey === descriptor.caseKey && doc.documentType === (execution ? 'execution-report' : 'case-definition'));
    const stable = new Map();
    for (const s of doc.sections) {
      if (s.availability !== 'available')
        continue;
      if (s.data) {
        remember(s, s.data, stable);
        continue;
      }
      const objectKind = SECTION_KINDS.includes(s.kind) && !own(ROW_FIELDS, s.kind);
      if (objectKind)
        check(s.dataFiles.length === 1);
      for (const r of s.dataFiles) {
        const f = files.get(r.fileId);
        check(f && ['application/json', 'application/x-ndjson'].includes(f.mediaType) && (!objectKind || f.mediaType === 'application/json'));
        const data = await read(r.fileId);
        validateSectionData(s, data, doc, {
          execution,
          title: execution ? undefined : descriptor.title
        });
        remember(s, data, stable);
      }
    }
    const reached = new Set();
    for (const r of references(descriptor, new Set(), 0, limits))
      await visit(r, new Set(), reached);
    for (const r of reached)
      all.add(r);
    closures.set(execution ? `execution:${execution.executionId}` : `definition:${descriptor.caseKey}`, reached);
  }
  for (const c of manifest.cases)
    await root(c, c.definition, null);
  for (const e of manifest.executions)
    await root(e, e.report, e);
  check(all.size === files.size);
  return closures;
}
module.exports = {
  validId,
  terminalResult,
  CONTRACT_SNAPSHOT: 'reporting-v2/2026-10-23',
  CONTRACT_SCHEMA_SHA256: '705495e422a0530fe1feccce5caf6806fe36bc4e83aaa47e83189f1e3d26082d',
  LIMITS,
  SECTION_KINDS,
  resolveLimits,
  validateCapabilities,
  validateManifest,
  validateDocument,
  validateSectionData,
  validateGraph,
  parseBytes,
  references,
  bytes
};

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { canonicalJson } = require('./revisions');
const { safePath, parse, collectRefs, digest } = require('./source-reader');
const { reportingError } = require('./errors');
const { references } = require('./contracts');
const MEDIA = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.xml': 'application/xml'
};
const stableId = (...parts) => 'f-' + crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48);
function mediaType(relative) {
  const media = MEDIA[path.extname(relative).toLowerCase()];
  if (!media)
    throw reportingError('REPORTING_ATTACHMENT_UNSUPPORTED', 'Unsupported report evidence type');
  return media;
}
function durableWrite(file, content) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700
  });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  }
  finally {
    fs.closeSync(fd);
  }
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  }
  finally {
    fs.closeSync(dir);
  }
}
function assertShareable(value) {
  if (value && typeof value === 'object') {
    if (value.sensitive === true || value.containsSensitiveInformation === true || value.sensitivity === 'sensitive')
      throw reportingError('REPORTING_SENSITIVE_EVIDENCE', 'Evidence requires a safe export copy');
    for (const child of Object.values(value))
      assertShareable(child);
  }
}
function discoverEvidence(source) {
  const { report, inventory } = source, root = inventory.root, available = new Map(inventory.files.map(f => [f.relative, f])), seeds = new Set();
  for (const f of ['execution.json', 'case.snapshot.json', 'source.snapshot.md', 'result.json', 'metrics.json', 'events.jsonl', 'binding.snapshot.json', 'validation-profile.snapshot.json', 'telemetry/invocations.jsonl', 'telemetry/spans.jsonl', 'report-metadata.json'])
    if (available.has(f))
      seeds.add(f);
  for (const f of available.keys())
    if (f.startsWith('logs/'))
      seeds.add(f);
  for (const event of report.events) {
    if (event.sceneId && event.type === 'sceneObserved')
      seeds.add(`scenes/${event.sceneId}.json`);
    if (event.operationId && /^action(Completed|OutcomeUnknown)$/.test(event.type))
      seeds.add(`operations/${event.operationId}.json`);
    if (event.capabilityInvocationId && event.type.startsWith('capabilityInvocation'))
      seeds.add(`capabilities/invocations/${event.capabilityInvocationId}.json`);
  }
  const graph = new Map();
  function visit(relative, stack = new Set()) {
    if (stack.has(relative))
      throw reportingError('REPORTING_REFERENCE_CYCLE');
    if (graph.has(relative))
      return;
    const file = safePath(root, relative);
    const media = mediaType(relative);
    let data = null;
    const refs = new Set();
    if (media === 'application/json' || media === 'application/x-ndjson') {
      data = parse(file);
      collectRefs(data, refs);
      // A Sequence carries its own canonical identity, not a recursive dependency.
      if (data?.sequenceRecordRef === relative)
        refs.delete(relative);
      assertShareable(data);
    }
    graph.set(relative, {
      relative,
      path: file,
      mediaType: media,
      data,
      refs
    });
    const next = new Set([...stack, relative]);
    for (const ref of refs)
      visit(ref, next);
  }
  for (const seed of seeds)
    visit(seed);
  return graph;
}
function createArtifactStore({ workspace, packageId, repository, redactor, limits }) {
  repository.writeWorkspace(workspace, `staging/${packageId}/stage.json`, {
    state: 'COLLECTING',
    packageId
  });
  const staging = path.join(workspace, '.mavt/reporting/staging', packageId), files = new Map(), adj = new Map();
  function record(id, relative, media, purpose) {
    const file = path.join(staging, 'blobs', id), stat = fs.statSync(file), sha256 = 'sha256:' + digest(file);
    if (stat.size > limits.fileBytes || (['application/json', 'application/x-ndjson'].includes(media) && stat.size > limits.documentBytes))
      throw reportingError('REPORTING_UNIT_TOO_LARGE');
    const descriptor = {
      id,
      sha256,
      bytes: stat.size,
      mediaType: media,
      encoding: 'identity',
      purpose
    };
    files.set(id, {
      ...descriptor,
      path: file
    });
    return {
      fileId: id
    };
  }
  function putJson(logical, value, purpose = 'report-data') {
    const id = stableId(logical), raw = canonicalJson(value), file = path.join(staging, 'blobs', id);
    if (files.has(id)) {
      if ('sha256:' + crypto.createHash('sha256').update(raw).digest('hex') !== files.get(id).sha256)
        throw reportingError('REPORTING_FILE_ID_COLLISION');
      return {
        fileId: id
      };
    }
    durableWrite(file, raw);
    adj.set(id, references(value));
    return record(id, logical, 'application/json', purpose);
  }
  async function putSource(logical, entry) {
    const id = stableId(logical);
    if (files.has(id))
      return {
        fileId: id
      };
    const file = path.join(staging, 'blobs', id);
    fs.mkdirSync(path.dirname(file), {
      recursive: true,
      mode: 0o700
    });
    if (entry.data !== null) {
      const value = redactor.redact(entry.data);
      const raw = entry.mediaType === 'application/x-ndjson' ? value.map(v => canonicalJson(v)).join('\n') + '\n' : canonicalJson(value);
      durableWrite(file, raw);
      adj.set(id, references(value));
    }
    else if (entry.mediaType.startsWith('image/') && entry.mediaType !== 'image/svg+xml') {
      const input = fs.openSync(entry.path, 'r'), output = fs.openSync(file, 'wx', 0o600), buffer = Buffer.allocUnsafe(65536);
      let size = 0;
      try {
        let n;
        while ((n = fs.readSync(input, buffer, 0, buffer.length, null))) {
          size += n;
          if (size > limits.fileBytes)
            throw reportingError('REPORTING_UNIT_TOO_LARGE');
          fs.writeSync(output, buffer, 0, n);
        }
        fs.fsyncSync(output);
      }
      finally {
        fs.closeSync(input);
        fs.closeSync(output);
      }
      adj.set(id, new Set());
    }
    else {
      // Independent logs and text evidence are processed a line at a time. The
      // bounded line budget prevents a hostile unbroken log exhausting memory.
      const input = fs.createReadStream(entry.path, {
        highWaterMark: 65536
      }), output = fs.openSync(file, 'wx', 0o600), decoder = new TextDecoder('utf8', {
        fatal: true
      });
      let size = 0, pending = '';
      function writeText(value) {
        const raw = redactor.text(value);
        size += Buffer.byteLength(raw);
        if (size > limits.fileBytes)
          throw reportingError('REPORTING_UNIT_TOO_LARGE');
        fs.writeSync(output, raw);
      }
      try {
        for await (const chunk of input) {
          pending += decoder.decode(chunk, {
            stream: true
          });
          let end;
          while ((end = pending.indexOf('\n')) !== -1) {
            if (Buffer.byteLength(pending.slice(0, end)) > limits.documentBytes)
              throw reportingError('REPORTING_SOURCE_BUDGET_EXCEEDED');
            writeText(pending.slice(0, end + 1));
            pending = pending.slice(end + 1);
          }
          if (Buffer.byteLength(pending) > limits.documentBytes)
            throw reportingError('REPORTING_SOURCE_BUDGET_EXCEEDED');
        }
        pending += decoder.decode();
        if (pending)
          writeText(pending);
        fs.fsyncSync(output);
      }
      finally {
        input.destroy();
        fs.closeSync(output);
      }
      adj.set(id, new Set());
    }
    return record(id, logical, entry.mediaType, 'evidence');
  }
  function closure(roots) {
    const reached = new Set();
    function visit(id, stack = new Set()) {
      if (stack.has(id))
        throw reportingError('REPORTING_REFERENCE_CYCLE');
      if (!files.has(id))
        throw reportingError('REPORTING_EVIDENCE_MISSING');
      if (reached.has(id))
        return;
      reached.add(id);
      const next = new Set([...stack, id]);
      for (const child of adj.get(id) || [])
        visit(child, next);
    }
    for (const id of roots)
      visit(id);
    return [...reached].sort().map(id => files.get(id));
  }
  function descriptors(entries) {
    return entries.map(({ path: ignored, ...d }) => d).sort((a, b) => a.id.localeCompare(b.id));
  }
  function finalize() {
    const parent = path.join(workspace, '.mavt/reporting/packages');
    fs.mkdirSync(parent, {
      recursive: true,
      mode: 0o700
    });
    const final = path.join(parent, packageId);
    fs.renameSync(staging, final);
    for (const f of files.values())
      f.path = path.join(final, 'blobs', f.id);
    const fd = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(fd);
    }
    finally {
      fs.closeSync(fd);
    }
    return final;
  }
  return {
    staging,
    files,
    putJson,
    putSource,
    closure,
    descriptors,
    finalize,
    durableWrite
  };
}
module.exports = {
  stableId,
  mediaType,
  durableWrite,
  discoverEvidence,
  createArtifactStore
};

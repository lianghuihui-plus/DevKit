'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRepository, safeId } = require('./repository');
const { createIdentity } = require('./identity');
const { createRevisions, canonicalJson } = require('./revisions');
const { reportingError } = require('./errors');
const { createSourceReader14, digest, safePath } = require('./source-reader');
const { selectSources } = require('./selection');
const { createRedactor } = require('./redaction');
const { createArtifactStore, discoverEvidence, durableWrite, releaseStagedData } = require('./artifacts');
const { definitionDocument, executionDocument, runtimeProjection, listMetrics } = require('./sections');
const { LIMITS, resolveLimits, validateCapabilities, validateManifest, validateDocument, validateGraph } = require('./contracts');
const PRODUCER = Object.freeze({
  name: 'mavt',
  version: '0.4.0'
});
const hash = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
/**
* @typedef {object} ExportUnit
* @property {string} key Stable definition/platform/execution logical identity.
* @property {object} definition Current definition descriptor.
* @property {object|null} execution At most one selected platform execution.
* @property {string[]} fileIds Recursive complete dependency closure.
* @typedef {object} FrozenSession
* @property {string} id Package-local session identity.
* @property {string} key Durable UUID Idempotency-Key, reused verbatim.
* @property {string} manifestPath Absolute path to immutable original UTF8 bytes.
* @property {string} manifestSha256 Digest of those original bytes.
* @property {object} limits Negotiated and client-capped limit snapshot.
*/

function verifySignatures(workspace, signatures) {
  for (const signature of signatures) {
    const relative = path.relative(workspace, signature.path).split(path.sep).join('/');
    const file = safePath(workspace, relative, true);
    if (signature.directory) {
      const names = file ? fs.readdirSync(file).sort() : null;
      if (JSON.stringify(names) !== JSON.stringify(signature.names))
        throw reportingError('REPORTING_SOURCE_CHANGED');
    } else if ((file ? digest(file) : null) !== signature.hash) {
      throw reportingError('REPORTING_SOURCE_CHANGED');
    }
  }
}

function defaults(dependencies = {}) {
  const repository = dependencies.repository || createRepository();
  return {
    ...dependencies,
    repository,
    identity: dependencies.identity || createIdentity({
      repository
    }),
    revisions: dependencies.revisions || createRevisions({
      repository
    }),
    sourceReader: dependencies.sourceReader || createSourceReader14({
      buildTrace: dependencies.buildTrace
    })
  };
}
function manifestFor(units, workspace, store) {
  const cases = new Map(), executions = [], fileIds = new Set();
  for (const unit of units) {
    cases.set(unit.definition.caseKey, unit.definition);
    if (unit.execution)
      executions.push(unit.execution);
    for (const id of unit.fileIds)
      fileIds.add(id);
  }
  return {
    protocolVersion: '2.0',
    producer: PRODUCER,
    workspace,
    cases: [...cases.values()].sort((a, b) => a.caseKey.localeCompare(b.caseKey)),
    executions: executions.sort((a, b) => a.caseKey.localeCompare(b.caseKey) || a.platform.localeCompare(b.platform)),
    files: store.descriptors([...fileIds].map(id => store.files.get(id)))
  };
}
function groupsFor(units, workspace, store, limits) {
  const groups = [];
  let current = [];
  for (const unit of units) {
    const trial = [...current, unit];
    let valid = true;
    try {
      validateManifest(manifestFor(trial, workspace, store), {
        limits
      });
    }
    catch (e) {
      if (e.code !== 'REPORTING_CONTRACT_INVALID')
        throw e;
      valid = false;
    }
    if (!valid) {
      if (current.length)
        groups.push(current);
      current = [unit];
      try {
        validateManifest(manifestFor(current, workspace, store), {
          limits
        });
      }
      catch {
        throw reportingError('REPORTING_UNIT_TOO_LARGE', 'One report unit exceeds session limits');
      }
    }
    else
      current = trial;
  }
  if (current.length || !groups.length)
    groups.push(current);
  return groups;
}
/**
* All selected units validate locally before the one PACKAGE_READY transaction.
* No HTTP is performed here. capabilities comes from the worker's GET response;
* explicit limits may further reduce budgets (offline tests can omit both).
* request: {workspace,scope:'workspace'|'batch',batchId?,capabilities?,limits?}.
*/
async function collectExport(request, dependencies = {}) {
  const context = {};
  try {
    return await collect(request, dependencies, context);
  }
  catch (error) {
    // Stages are not resumable frozen packages. Dispose failed collections while
    // preserving the original error; if storage is unavailable, durable ownership
    // lets a later explicit write reclaim the abandoned bytes after retention.
    if (context.packageId) {
      try {
        const { repository, workspace, packageId, identityEpoch } = context;
        for (const area of ['staging', 'packages']) {
          let exists = false;
          repository.withWorkspaceLock(workspace, () => {
            const relative = `${area}/${packageId}/stage.json`, stage = repository.readWorkspace(workspace, relative);
            if (stage?.identityEpoch !== identityEpoch || stage.exportVersion !== 1
              || stage.packageId !== packageId || stage.ownerPid !== process.pid) return;
            exists = true;
            repository.writeWorkspace(workspace, relative, { ...stage, state: 'FAILED' });
          });
          if (exists && area === 'staging') {
            let complete = false;
            while (!complete) complete = repository.withWorkspaceLock(workspace, () =>
              releaseStagedData(workspace, packageId, repository, identityEpoch));
          }
        }
      } catch { /* Never replace a source/validation failure with a cleanup error. */ }
    }
    if (error.code?.startsWith('REPORTING_'))
      throw error;
    throw reportingError('REPORTING_SOURCE_INVALID', 'Report collection failed validation or local IO');
  }
}
async function collect(request, dependencies = {}, context = {}) {
  const deps = defaults(dependencies), { repository, identity, revisions, sourceReader } = deps;
  const capabilityLimits = request.capabilities ? validateCapabilities(request.capabilities) : LIMITS;
  const clientLimits = resolveLimits(request.limits || {});
  const limits = resolveLimits(Object.fromEntries(Object.keys(LIMITS).map(key => [
    key, Math.min(capabilityLimits[key], clientLimits[key])
  ])));
  const workspace = path.resolve(request.workspace), ident = identity.ensure(workspace), selection = selectSources(request, {
    repository,
    sourceReader
  });
  const redactor = createRedactor(ident.anonymizationSalt), packageId = crypto.randomUUID();
  Object.assign(context, { workspace, packageId, repository, identityEpoch: ident.identityEpoch });
  const store = createArtifactStore({
    workspace,
    packageId,
    repository,
    redactor,
    limits,
    identityEpoch: ident.identityEpoch,
    owner: deps.collectionOwner,
    createdAt: deps.clock ? new Date(deps.clock()).toISOString() : repository.now()
  });
  const definitions = new Map(), units = [], entries = [], sourceInventories = [];
  const workspaceDescriptor = redactor.redact({
    id: ident.workspaceId,
    name: selection.marker.name || path.basename(workspace),
    revision: 1,
    extensions: {
      mavt: {
        marker: selection.marker
      }
    }
  });
  entries.push({
    kind: 'workspace',
    key: ident.workspaceId,
    descriptor: workspaceDescriptor
  });
  for (const selectedDefinition of selection.definitions) {
    const definition = {...selectedDefinition,...sourceReader.readDefinition(selectedDefinition.caseDir)};
    const doc = definitionDocument(definition, redactor);
    validateDocument(doc, {
      title: redactor.redact(definition.case.identity.title),
      limits
    });
    const reference = store.putJson(`definition/${definition.caseKey}`, doc, 'case-definition'), identityData = definition.case.identity;
    const descriptor = {
      caseKey: definition.caseKey,
      ...(identityData.caseNo === undefined ? {} : {
        caseNo: String(identityData.caseNo)
      }),
      title: redactor.redact(identityData.title),
      definitionRevision: 1,
      definition: reference,
      extensions: {mavt:{sourceSummary:redactor.text(definition.sourceText.split(/\r?\n/).map(line=>line.trim()).find(line=>line && !line.startsWith('#')) || '').slice(0,1024)}}
    };
    const closure = store.closure([reference.fileId]);
    definitions.set(definition.caseKey, {
      descriptor,
      closure,
      sourceHash: hash(definition.sourceText)
    });
    entries.push({
      kind: 'definition',
      key: definition.caseKey,
      descriptor,
      dependencies: store.descriptors(closure)
    });
  }
  for (const selected of selection.selected) {
    const source = sourceReader.readExecution(selected.execDir);
    if (source.report.snapshot.identity.caseKey !== selected.caseKey
      || source.report.execution.executionId !== selected.execution.executionId
      || source.report.execution.platform !== selected.platform)
      throw reportingError('REPORTING_SOURCE_INVALID');
    const graph = source.graph || discoverEvidence(source), artifactMap = {};
    for (const entry of [...graph.values()].sort((a, b) => a.relative.localeCompare(b.relative)))
      artifactMap[entry.relative] = await store.putSource(`execution/${selected.execution.executionId}/source/${entry.relative}`, entry);
    const runtime = runtimeProjection(source), definition = definitions.get(selected.caseKey);
    const doc = executionDocument({
      source,
      runtime,
      graph,
      artifactMap,
      caseKey: selected.caseKey
    }, store, redactor, limits);
    const reference = store.putJson(`execution/${selected.execution.executionId}/document`, doc, 'execution-report');
    const descriptor = {
      caseKey: selected.caseKey,
      platform: selected.platform,
      executionId: runtime.executionId,
      startedAt: runtime.startedAt,
      endedAt: runtime.endedAt,
      revision: 1,
      summary: redactor.redact({
        executionStatus: runtime.executionStatus,
        displayStatus: runtime.displayStatus,
        durationMs: runtime.durationMs,
        text: source.report.display?.summary || null,
        extensions: {
          mavt: listMetrics(source)
        }
      }),
      report: reference,
      extensions: {
        mavt: {
          sourceCurrent: definition.sourceHash === hash(source.report.sourceText),
          sourceExecutionStatus: source.report.execution.executionStatus ?? null
        }
      }
    };
    const executionClosure = store.closure([reference.fileId]);
    const fileIds = [...new Set([...definition.closure, ...executionClosure].map(f => f.id))].sort();
    const unit = {
      key: `${selected.caseKey}/${selected.platform}/${descriptor.executionId}`,
      definition: definition.descriptor,
      execution: descriptor,
      fileIds
    };
    units.push(unit);
    entries.push({
      kind: 'execution',
      key: descriptor.executionId,
      descriptor,
      dependencies: store.descriptors(executionClosure)
    });
    sourceReader.verifyInventory(source.inventory);
    sourceInventories.push(source.inventory);
  }
  for (const [caseKey, d] of definitions)
    if (!units.some(u => u.definition.caseKey === caseKey))
      units.push({
        key: caseKey,
        definition: d.descriptor,
        execution: null,
        fileIds: d.closure.map(f => f.id)
      });
  units.sort((a, b) => a.key.localeCompare(b.key));
  // First validate every unit and closure before reserving versions; no partial
  // package or prepare authority can escape a later source/size failure.
  const provisionalGroups = groupsFor(units, workspaceDescriptor, store, limits);
  for (const group of provisionalGroups) {
    const manifest = manifestFor(group, workspaceDescriptor, store);
    await validateGraph(manifest, id => Promise.resolve(fs.readFileSync(store.files.get(id).path)), {
      limits
    });
    if (deps.validatePackage)
      await deps.validatePackage(manifest, id => fs.readFileSync(store.files.get(id).path));
  }
  verifySignatures(workspace, selection.signatures);
  const reservation = revisions.reserve(workspace, {
    packageId,
    entries
  });
  const revision = new Map(reservation.allocations.map(a => [`${a.kind}:${a.key}`, a.revision]));
  workspaceDescriptor.revision = revision.get(`workspace:${ident.workspaceId}`);
  for (const d of definitions.values())
    d.descriptor.definitionRevision = revision.get(`definition:${d.descriptor.caseKey}`);
  for (const unit of units)
    if (unit.execution)
      unit.execution.revision = revision.get(`execution:${unit.execution.executionId}`);
  const groups = groupsFor(units, workspaceDescriptor, store, limits), sessions = [], manifests = [];
  for (const [i, group] of groups.entries()) {
    const manifest = manifestFor(group, workspaceDescriptor, store);
    await validateGraph(manifest, id => Promise.resolve(fs.readFileSync(store.files.get(id).path)), {
      limits
    });
    const rawManifest = canonicalJson(manifest), id = `session-${String(i + 1).padStart(4, '0')}`, relative = `sessions/${id}/manifest.json`;
    durableWrite(path.join(store.staging, relative), rawManifest);
    sessions.push({
      id,
      key: crypto.randomUUID(),
      manifestRelative: relative,
      manifestSha256: hash(rawManifest),
      unitKeys: group.map(u => u.key),
      limits
    });
    manifests.push(manifest);
  }
  // Recheck mutable source signatures and staged bytes immediately before the
  // publication boundary. Network code only consumes assertReady + this wrapper.
  for (const inv of sourceInventories)
    sourceReader.verifyInventory(inv);
  verifySignatures(workspace, selection.signatures);
  for (const file of store.files.values())
    if ('sha256:' + digest(file.path) !== file.sha256)
      throw reportingError('REPORTING_PACKAGE_CORRUPT');
  const frozen = {
    format: 'mavt-frozen/1',
    packageId,
    identityEpoch: ident.identityEpoch,
    limits,
    sessions,
    files: store.descriptors([...store.files.values()]),
    units: units.map(({ key, fileIds, definition, execution }) => ({
      key,
      fileIds,
      caseKey: definition.caseKey,
      platform: execution?.platform ?? null,
      executionId: execution?.executionId ?? null
    })),
    excluded: selection.excluded
  };
  repository.writeWorkspace(workspace, `staging/${packageId}/frozen.json`, {
    identityEpoch: ident.identityEpoch,
    frozen
  });
  store.finalize();
  revisions.publish(workspace, {
    transactionId: reservation.transactionId,
    manifest: frozen
  });
  return readFrozenExport(workspace, packageId, deps);
}
function readFrozenExport(workspace, packageId, dependencies = {}) {
  const deps = defaults(dependencies);
  safeId(packageId);
  const ready = deps.revisions.assertReady(workspace, packageId), frozen = ready.manifest;
  if (frozen?.format !== 'mavt-frozen/1' || frozen.packageId !== packageId || frozen.identityEpoch !== ready.identityEpoch)
    throw reportingError('REPORTING_PACKAGE_CORRUPT');
  try {
    const base = safePath(workspace, `.mavt/reporting/packages/${packageId}`), files = frozen.files.map(f => ({
      ...f,
      path: safePath(base, `blobs/${f.id}`)
    }));
    for (const file of files)
      if (fs.statSync(file.path).size !== file.bytes || 'sha256:' + digest(file.path) !== file.sha256)
        throw reportingError('REPORTING_PACKAGE_CORRUPT');
    const manifests = [], sessions = frozen.sessions.map(s => {
      if (!/^[a-f0-9-]{36}$/.test(s.key))
        throw reportingError('REPORTING_PACKAGE_CORRUPT');
      const manifestPath = safePath(base, s.manifestRelative), rawManifest = fs.readFileSync(manifestPath, 'utf8');
      if (hash(rawManifest) !== s.manifestSha256)
        throw reportingError('REPORTING_PACKAGE_CORRUPT');
      const manifest = JSON.parse(rawManifest);
      validateManifest(manifest, {
        limits: s.limits
      });
      manifests.push(manifest);
      return {
        ...s,
        manifestPath,
        rawManifest,
        manifest,
        files: manifest.files.map(f => files.find(x => x.id === f.id))
      };
    });
    return {
      state: 'PACKAGE_READY',
      packageId,
      identityEpoch: ready.identityEpoch,
      limits: frozen.limits,
      sessions,
      manifests,
      files,
      units: frozen.units,
      excluded: frozen.excluded
    };
  }
  catch (e) {
    if (e.code === 'REPORTING_PACKAGE_CORRUPT')
      throw e;
    throw reportingError('REPORTING_PACKAGE_CORRUPT', 'Frozen package failed verification');
  }
}
module.exports = {
  collectExport,
  readFrozenExport
};

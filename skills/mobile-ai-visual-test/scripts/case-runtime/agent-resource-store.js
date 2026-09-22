'use strict';

// This catalog binds public handles to immutable authorities. It never decides
// operation status, visual meaning, checkpoint validity, or the next action.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const store = require('./store');

const TYPES = new Set(Object.keys(require('./agent-facing-contract').PUBLIC_CONTRACT.resourceCatalog));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(canonicalJson(value));
const fail = (message) => contractError('RESOURCE_INTEGRITY_INVALID', message);

function scope(execDir) {
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  return hash(`${fs.realpathSync(execDir)}\n${execution.executionId}`).slice(0, 24);
}

function resourceRef(execDir, type, id) {
  if (!TYPES.has(type)) throw fail(`unsupported resource type: ${type}`);
  if (typeof id !== 'string' || !id || path.isAbsolute(id)) throw fail('resource identity must not be an absolute path');
  return `mavt:${scope(execDir)}:${type}:${encodeURIComponent(String(id))}`;
}

// The parser only identifies scope/type syntax. It never authorizes a read;
// each Facade must perform its own exact publication registry lookup.
function parseResourceRef(ref) {
  const match = typeof ref === 'string' && ref.match(/^mavt:([a-f0-9]{24}):([^:]+):(.+)$/);
  return match ? { scope: match[1], type: match[2], identity: match[3] } : null;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function regularFile(root, relative) {
  const canonicalRoot = fs.realpathSync(root);
  if (typeof relative !== 'string' || path.isAbsolute(relative) || path.normalize(relative) !== relative) throw fail('resource path must be canonical and relative');
  const file = path.resolve(canonicalRoot, relative);
  if (!inside(canonicalRoot, file)) throw fail('resource path escapes its authority');
  let cursor = canonicalRoot;
  for (const segment of path.relative(canonicalRoot, file).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw fail('resource paths must not contain symbolic links');
  }
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw fail('resource authority is not a canonical regular file');
  return file;
}

function ensureDirectory(execDir, relative) {
  const root = fs.realpathSync(execDir);
  let cursor = root;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
    if (fs.lstatSync(cursor).isSymbolicLink() || !fs.lstatSync(cursor).isDirectory()) throw fail('resource directory is not canonical');
  }
  return cursor;
}

function immutableJson(execDir, relative, value) {
  ensureDirectory(execDir, path.dirname(relative));
  const file = path.join(fs.realpathSync(execDir), relative);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(regularFile(execDir, relative), 'utf8'));
    if (canonicalJson(existing) !== canonicalJson(value)) throw fail('published reference cannot be rebound');
    return;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, file); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (canonicalJson(JSON.parse(fs.readFileSync(regularFile(execDir, relative), 'utf8'))) !== canonicalJson(value)) throw fail('conflicting resource publication');
    }
  } finally { fs.unlinkSync(temporary); }
}

function sourceValue(execDir, source) {
  const root = source.kind === 'handoff' ? source.workspaceRoot : execDir;
  const file = regularFile(root, source.path);
  if (source.kind === 'event') {
    // Never use store.events here: its tail-repair mode is a write on read.
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const matches = lines.filter((line, index) => line && (index < lines.length - 1 || text.endsWith('\n')))
      .map((line) => JSON.parse(line)).filter((event) => event.eventId === source.eventId);
    if (matches.length !== 1) throw fail('published event is missing or ambiguous');
    if (matches[0].executionId !== store.loadExecution(execDir, { allowFinalized: true }).executionId) throw fail('event scope mismatch');
    return { value: matches[0], sha256: jsonHash(matches[0]) };
  }
  const bytes = fs.readFileSync(file);
  const value = source.kind === 'binary' ? null : source.kind === 'text' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
  if (source.kind === 'handoff') {
    const execution = store.loadExecution(execDir, { allowFinalized: true });
    if (value.executionId !== execution.executionId || value.batchId !== execution.batchId) throw fail('handoff binding mismatch');
    const expected = path.join('runs', value.batchId, 'handoffs', value.executionId, `${value.sequence}-${jsonHash(value)}.json`);
    if (source.path !== expected) throw fail('handoff authority path mismatch');
    const { payloadSha256, ...payload } = value;
    if (jsonHash(payload) !== payloadSha256) throw fail('handoff payload digest mismatch');
  }
  return { value, sha256: hash(bytes), file };
}

function projectSource(type, raw, params, source) {
  if (type === 'caseBrief') return { ...raw.brief, casePrompt: raw.casePrompt };
  if (type === 'elementSet') return raw.elements || [];
  if (type === 'layout') return source.field ? raw[source.field] : raw;
  if (type === 'screenshot') return { path: source.file, width: params.width, height: params.height,
    sha256: source.sha256, mediaType: params.mediaType || 'image/png' };
  if (type === 'scene') {
    const { buildCapabilities, actionRefFor } = require('./capability-catalog');
    const { projectPreviousAction } = require('./agent-facing-contract');
    const previous = raw.previousAction ? projectPreviousAction(raw.previousAction) : null;
    return {
      sceneId: raw.sceneId, sceneRef: params.sceneRef, capturedAt: raw.capturedAt, generation: raw.generation,
      ...params.refs, targetApp: raw.app || {}, signals: raw.signals || {}, conflicts: raw.conflicts || [],
      interactionContext: { scrollContexts: raw.scrollContexts || [], keyboard: raw.signals?.keyboard || {}, visual: raw.visual || {} },
      actions: buildCapabilities(raw, params.platform).map((action) => ({ ref: actionRefFor(action), label: action.label,
        kind: action.kind, ...(action.kind === 'wait' ? { input: { ms: 'positive-integer' } } : action.input ? { input: action.input } : {}) })),
      ...(previous ? { previousAction: { operationId: previous.operationRef, deliveryStatus: previous.deliveryStatus,
        commandDeliveryKnown: previous.commandDeliveryKnown, ...(previous.technicalResult ? { technicalResult: previous.technicalResult } : {}),
        ...(previous.evidence ? { evidence: remapReferences(previous.evidence, params.refMap || {}) } : {}),
        ...(params.refs.actionSpatialEvidenceRef ? { actionSpatialEvidenceRef: params.refs.actionSpatialEvidenceRef } : {}) } } : {}),
    };
  }
  if (type === 'candidateSet') return { queryId: raw.queryId, query: raw.query, context: raw.context,
    candidates: (raw.candidates || []).map(({ snapshotRef, ...candidate }) => ({ ...candidate,
      knowledgeDocumentRef: params.documents[snapshotRef] })), truncated: raw.truncated === true,
    filterDiagnostics: raw.filterDiagnostics || [] };
  if (type === 'knowledgeQuery') return { queryId: raw.queryId, query: raw.query, context: raw.context,
    sceneId: raw.sceneId, checkNodeIds: raw.expectationRefs || [], candidateSetRef: params.candidateSetRef,
    knowledgeReviewRefs: params.knowledgeReviewRefs || [] };
  return remapReferences(raw, params.refMap || {});
}

function remapReferences(value, refMap) {
  if (typeof value === 'string') return refMap[value] || value;
  if (Array.isArray(value)) return value.map((item) => remapReferences(item, refMap));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapReferences(item, refMap)]));
}

function registryPath(ref) { return `operations/resources/catalog/${hash(ref)}.json`; }

function publishResource(execDir, descriptor, content) {
  try {
    const { type, id, source: givenSource, params = {}, associations = [], revision } = descriptor;
    const ref = descriptor.ref || resourceRef(execDir, type, id);
    if (ref !== resourceRef(execDir, type, id)) throw fail('resource ref must match its scoped identity');
    let source = givenSource;
    if (!source) {
      if (!['checkpointLedger', 'layout'].includes(type)) throw fail(`${type} requires its immutable authority`);
      const relative = `operations/resources/snapshots/${type}-${jsonHash(content)}.json`;
      immutableJson(execDir, relative, content);
      source = { kind: 'json', path: relative };
    }
    const loaded = sourceValue(execDir, source);
    if (type === 'planResult') {
      if (!['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED'].includes(loaded.value?.status)) throw fail('plan result is not terminal');
      const { integrity, ...unsigned } = loaded.value;
      if (integrity?.recordSha256 !== jsonHash(unsigned)) throw fail('terminal plan integrity is invalid');
    }
    if (type === 'caseResult' && !store.loadExecution(execDir, { allowFinalized: true }).finalized) throw fail('case result is not committed');
    const canonical = projectSource(type, loaded.value, params, { ...source, ...loaded });
    const integrity = jsonHash(canonical);
    const publicDescriptor = { ref, type, role: type, ...(revision !== undefined ? { revision } : {}), integrity };
    const record = { descriptor: publicDescriptor, id, source: { ...source, sha256: loaded.sha256 }, params,
      associations: associations.filter((item) => item.ref !== ref) };
    immutableJson(execDir, registryPath(ref), record);
    return { data: { ref, type, content: canonical }, descriptor: publicDescriptor,
      resources: record.associations, declaredResources: record.associations };
  } catch (error) {
    if (error.code === 'RESOURCE_INTEGRITY_INVALID') throw error;
    throw fail(`resource publication failed: ${error.message}`);
  }
}

function readPublishedResource(execDir, ref) {
  const match = parseResourceRef(ref);
  if (match && match.scope !== scope(execDir)) throw contractError('RESOURCE_SCOPE_MISMATCH', 'reference belongs to another bound scope');
  if (!match || !fs.existsSync(path.join(execDir, registryPath(ref)))) throw contractError('RESOURCE_UNKNOWN', 'reference has not been published');
  try {
    const record = JSON.parse(fs.readFileSync(regularFile(execDir, registryPath(ref)), 'utf8'));
    if (record.descriptor.ref !== ref || resourceRef(execDir, record.descriptor.type, record.id) !== ref) throw fail('catalog binding mismatch');
    const loaded = sourceValue(execDir, record.source);
    if (loaded.sha256 !== record.source.sha256) throw fail('resource authority digest mismatch');
    const content = projectSource(record.descriptor.type, loaded.value, record.params, { ...record.source, ...loaded });
    if (jsonHash(content) !== record.descriptor.integrity) throw fail('resource content digest mismatch');
    return { data: { ref, type: record.descriptor.type, content }, resources: record.associations,
      declaredResources: record.associations, descriptor: record.descriptor, id: record.id };
  } catch (error) {
    if (error.code === 'RESOURCE_INTEGRITY_INVALID') throw error;
    throw fail(`published resource is unreadable: ${error.message}`);
  }
}

function publishEvent(execDir, type, event, params = {}, associations = []) {
  const id = type === 'checkpointResult' ? event.resultUpdateId : type === 'technicalFact' ? event.technicalFactRef
    : ['knowledgeQuery', 'candidateSet'].includes(type) ? event.queryId : event.eventId;
  const dependencies = ['checkpointResult', 'technicalFact', 'knowledgeReview', 'externalActionDeclaration'].includes(type)
    ? artifactAssociations(execDir, event, resourceRef(execDir, type, id)) : { refMap: {}, associations: [] };
  return publishResource(execDir, { type, id, source: { kind: 'event', path: 'events.jsonl', eventId: event.eventId },
    params: { ...params, refMap: { ...dependencies.refMap, ...params.refMap } }, associations: [...associations, ...dependencies.associations],
    ...(type === 'caseFlow' ? { revision: event.revision } : {}) });
}

function publishScreenshot(execDir, screenshot) {
  const relative = screenshot.ref || path.relative(execDir, screenshot.path);
  const file = regularFile(execDir, relative);
  const bytes = fs.readFileSync(file);
  if (screenshot.sha256 && screenshot.sha256 !== hash(bytes)) throw fail('screenshot authority digest mismatch');
  const image = relative.endsWith('.png') ? require('../lib/image-evidence').inspectPng(file) : null;
  if (image && !image.width) throw fail('screenshot dimensions are unavailable');
  const dimensions = image || { width: screenshot.width, height: screenshot.height };
  return publishResource(execDir, { type: 'screenshot', id: relative, source: { kind: 'binary', path: relative },
    params: { width: dimensions.width, height: dimensions.height, mediaType: screenshot.mediaType || (relative.endsWith('.svg') ? 'image/svg+xml' : 'image/png') } });
}

function publishArtifact(execDir, type, relative, associations = [], params = {}) {
  const source = { kind: type === 'knowledgeDocument' ? 'text' : 'json', path: relative };
  const dependencies = ['planEvidence', 'planResult', 'caseResult'].includes(type)
    ? artifactAssociations(execDir, sourceValue(execDir, source).value, resourceRef(execDir, type, relative), relative)
    : { refMap: {}, associations: [] };
  return publishResource(execDir, { type, id: relative, source,
    params: { ...params, refMap: { ...dependencies.refMap, ...params.refMap } }, associations: [...associations, ...dependencies.associations] });
}

function artifactAssociations(execDir, content, selfRef, selfId) {
  const refMap = selfId ? { [selfId]: selfRef } : {};
  const associations = new Map();
  const visit = (value, field = '') => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, field));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => visit(item,
      /Refs$/.test(field) && !/Refs?$/.test(key) ? field : key));
    if (typeof value !== 'string' || !/(?:Refs?|ref)$/.test(field) || refMap[value] || value === selfRef) return;
    let resource;
    if (value.startsWith('mavt:')) resource = readPublishedResource(execDir, value);
    else if (/^scene-[\w-]+$/.test(value)) resource = publishScene(execDir, value);
    else if (/^screenshots\/[^/]+\.(png|jpg|svg)$/.test(value)) resource = publishScreenshot(execDir, { ref: value });
    else if (/^layouts\/[^/]+\.json$/.test(value)) resource = publishArtifact(execDir, 'layout', value);
    else if (/^knowledge\/[^/]+\.md$/.test(value)) resource = publishArtifact(execDir, 'knowledgeDocument', value);
    else if (/^operations\/plan-evidence\/[^/]+\.json$/.test(value)) resource = publishArtifact(execDir, 'planEvidence', value);
    else if (/^action-spatial-evidence\/[^/]+\.json$/.test(value)) resource = publishSpatial(execDir, value);
    else if (/^technical-/.test(value)) {
      const event = store.events(execDir).find((item) => item.technicalFactRef === value);
      if (event && resourceRef(execDir, 'technicalFact', value) !== selfRef) resource = publishEvent(execDir, 'technicalFact', event);
    }
    if (resource) { refMap[value] = resource.data.ref; associations.set(resource.data.ref, resource.descriptor); }
  };
  visit(content);
  return { refMap, associations: [...associations.values()] };
}

function publishScene(execDir, sceneId) {
  const ref = resourceRef(execDir, 'scene', sceneId);
  if (fs.existsSync(path.join(execDir, registryPath(ref)))) {
    // An existing Scene has a frozen dependency set. Verify its exact binding
    // and source once; do not rebuild the action history behind that binding.
    return readPublishedResource(execDir, ref);
  }
  const source = { kind: 'json', path: `scenes/${sceneId}.json` };
  const scene = sourceValue(execDir, source).value;
  const screenshot = scene.screenshot?.ref || scene.screenshot?.path ? publishScreenshot(execDir, scene.screenshot) : null;
  const elements = publishResource(execDir, { type: 'elementSet', id: sceneId, source });
  let layout = null;
  if (scene.layoutRef) layout = publishArtifact(execDir, 'layout', scene.layoutRef);
  else if (scene.layout !== undefined && scene.layout !== null) layout = publishResource(execDir, { type: 'layout', id: sceneId }, scene.layout);
  const spatialRef = scene.previousAction?.spatialEvidence?.ref || scene.previousAction?.spatialEvidenceRef;
  const spatial = spatialRef ? publishSpatial(execDir, spatialRef) : null;
  const dependencies = artifactAssociations(execDir, scene.previousAction?.evidence, resourceRef(execDir, 'scene', sceneId), sceneId);
  const associated = [...[screenshot, layout, elements, spatial].filter(Boolean).map((item) => item.descriptor), ...dependencies.associations];
  return publishResource(execDir, { type: 'scene', id: sceneId, source, associations: associated,
    params: { sceneRef: resourceRef(execDir, 'scene', sceneId), refMap: dependencies.refMap, platform: store.loadExecution(execDir, { allowFinalized: true }).platform,
      refs: { ...(screenshot ? { screenshotRef: screenshot.data.ref } : {}), ...(layout ? { layoutRef: layout.data.ref } : {}),
        elementSetRef: elements.data.ref, ...(spatial ? { actionSpatialEvidenceRef: spatial.data.ref } : {}) } } });
}

function publishSpatial(execDir, relative) {
  const raw = sourceValue(execDir, { kind: 'json', path: relative }).value;
  const screenshots = [];
  if (raw.screenshot?.ref) screenshots.push(publishScreenshot(execDir, raw.screenshot));
  if (raw.annotatedScreenshotRef) screenshots.push(publishScreenshot(execDir, { ref: raw.annotatedScreenshotRef,
    width: raw.screenshot?.width, height: raw.screenshot?.height }));
  const refs = Object.fromEntries(screenshots.map((item) => [item.id || path.relative(execDir, item.data.content.path), item.data.ref]));
  return publishArtifact(execDir, 'actionSpatialEvidence', relative, screenshots.map((item) => item.descriptor), { refMap: refs });
}

function publishKnowledge(execDir, query, events) {
  const documents = (query.candidates || []).map((candidate) => publishArtifact(execDir, 'knowledgeDocument', candidate.snapshotRef));
  const candidateSet = publishEvent(execDir, 'candidateSet', query, {
    documents: Object.fromEntries((query.candidates || []).map((candidate, index) => [candidate.snapshotRef, documents[index].data.ref])),
  }, documents.map((item) => item.descriptor));
  // Query snapshots bind only reviews already present at first publication.
  const queryRef = resourceRef(execDir, 'knowledgeQuery', query.queryId);
  const existing = fs.existsSync(path.join(execDir, registryPath(queryRef))) ? readPublishedResource(execDir, queryRef) : null;
  const reviews = events.filter((event) => event.type === 'knowledgeReviewed' && event.queryId === query.queryId)
    .map((event) => publishEvent(execDir, 'knowledgeReview', event));
  const publishedQuery = existing || publishEvent(execDir, 'knowledgeQuery', query, {
    candidateSetRef: candidateSet.data.ref, knowledgeReviewRefs: reviews.map((item) => item.data.ref),
  }, [candidateSet.descriptor, ...reviews.map((item) => item.descriptor)]);
  return { candidateSet, query: publishedQuery, documents, reviews };
}

function publishLedger(execDir, events = store.events(execDir)) {
  const flow = require('./case-flow-service');
  const results = require('./expectation-result-service');
  const content = { eventHighWaterMark: events.at(-1)?.sequence || 0, caseFlowRevision: flow.current(execDir)?.revision || null,
    registry: flow.checkpointRegistry(execDir), ledger: results.currentLedger(execDir), readiness: results.finishReadiness(execDir) };
  const id = jsonHash(content);
  const dependencies = artifactAssociations(execDir, content, resourceRef(execDir, 'checkpointLedger', id));
  return publishResource(execDir, { type: 'checkpointLedger', id, params: { refMap: dependencies.refMap }, associations: dependencies.associations }, content);
}

function publishCaseBrief(execDir, handoffPath, workspaceRoot) {
  const relative = path.relative(fs.realpathSync(workspaceRoot), path.resolve(handoffPath));
  const source = { kind: 'handoff', workspaceRoot: fs.realpathSync(workspaceRoot), path: relative };
  const envelope = sourceValue(execDir, source).value;
  const dependencies = artifactAssociations(execDir, envelope.brief, resourceRef(execDir, 'caseBrief', envelope.handoffId));
  return publishResource(execDir, { type: 'caseBrief', id: envelope.handoffId, source, associations: dependencies.associations });
}

// Facade-owned publication recovery, also called by Batch under the execution
// lock before sealing. This publishes immutable authorities only; it neither
// constructs an Agent response nor replays the finish transaction.
function publishFinalResources(execDir, events = store.events(execDir)) {
  if (!store.loadExecution(execDir, { allowFinalized: true }).finalized) return [];
  return [
    ...(events.some((event) => event.type === 'caseFlowRevised') ? [publishLedger(execDir, events)] : []),
    publishArtifact(execDir, 'caseResult', 'result.json'),
  ];
}

function provideOperationResources(execDir, response, request) {
  const events = store.events(execDir);
  const finalizedFinish = request.operation === 'finish' && store.loadExecution(execDir, { allowFinalized: true }).finalized;
  const published = [];
  const result = {};
  let primary;
  const add = (value) => { if (value) published.push(value); return value; };
  const sceneId = response.scene?.sceneId || response.sceneId || response.visualInspection?.sceneId || response.actionInspection?.sceneId;
  if (sceneId && ['observe', 'act', 'inspect', 'recover'].includes(request.operation)) {
    const value = add(publishScene(execDir, sceneId));
    result.sceneRef = value.data.ref;
    if (['observe', 'act'].includes(request.operation) || (request.operation === 'recover' && request.input.mode !== 'external')) primary = value;
  }
  if (request.operation === 'plan' && response.caseFlow) {
    const value = add(publishEvent(execDir, 'caseFlow', response.caseFlow));
    result.caseFlowRef = value.data.ref;
    result.invalidatedResultRefs = (response.caseFlowChange?.invalidatedResultRefs || []).flatMap((nodeId) => {
      const invalidation = events.filter((event) => event.type === 'expectationResultInvalidated'
        && event.expectationRef === nodeId && event.caseFlowRevision === response.caseFlow.revision).at(-1);
      const update = invalidation && events.find((event) => event.type === 'expectationResultUpdated' && event.resultUpdateId === invalidation.resultUpdateId);
      return update ? [add(publishEvent(execDir, 'checkpointResult', update)).data.ref] : [];
    });
  }
  if (['plan', 'recordResult', 'finish'].includes(request.operation)) {
    if (!finalizedFinish && events.some((event) => event.type === 'caseFlowRevised')) add(publishLedger(execDir, events));
    if (request.operation === 'recordResult') {
      const ids = new Set((request.input.results || []).map((item) => item.checkNodeRef));
      const current = new Map(events.filter((event) => event.type === 'expectationResultUpdated' && ids.has(event.expectationRef))
        .map((event) => [event.expectationRef, event]));
      result.recordedResultRefs = [...current.values()].map((event) => add(publishEvent(execDir, 'checkpointResult', event)).data.ref);
    }
  }
  if (request.operation === 'knowledge') {
    const queryId = response.queryId || request.input.queryId;
    const query = events.find((event) => event.type === 'knowledgeQueried' && event.queryId === queryId);
    if (query) {
      const values = publishKnowledge(execDir, query, events);
      add(values.query); add(values.candidateSet); values.documents.forEach(add); values.reviews.forEach(add);
      result.knowledgeQueryRef = values.query.data.ref; result.candidateSetRef = values.candidateSet.data.ref;
      result.reviewRequired = values.reviews.length === 0; result.candidateCount = query.candidates.length;
      if (request.input.mode === 'query') primary = values.candidateSet;
      else if (values.reviews.length) result.knowledgeReviewRef = values.reviews.at(-1).data.ref;
    }
  }
  if (request.operation === 'runPlan' && response.planId) {
    const relative = `operations/plans/${response.planId}.json`;
    const record = sourceValue(execDir, { kind: 'json', path: relative }).value;
    if (['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED'].includes(record.status)) {
      const associations = [];
      const refMap = {};
      const walk = (value) => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (value && typeof value === 'object') return Object.values(value).forEach(walk);
        if (typeof value !== 'string' || refMap[value]) return;
        let found;
        if (/^scene-\d+$/.test(value)) found = publishScene(execDir, value);
        else if (/^operations\/plan-evidence\/[^/]+\.json$/.test(value)) found = publishArtifact(execDir, 'planEvidence', value);
        else if (/^action-spatial-evidence\/[^/]+\.json$/.test(value)) found = publishSpatial(execDir, value);
        else if (/^screenshots\/[^/]+\.(png|jpg|svg)$/.test(value)) found = publishScreenshot(execDir, { ref: value });
        if (found) { add(found); associations.push(found.descriptor); refMap[value] = found.data.ref; }
      };
      walk(record.evidence); walk(record.steps);
      primary = add(publishArtifact(execDir, 'planResult', relative, associations, { refMap }));
      result.planResultRef = primary.data.ref;
    }
  }
  if (response.status === 'EXTERNAL_ACTION_RECORDED') {
    const event = events.filter((item) => item.type === 'externalActionDeclared').at(-1);
    if (event) result.externalActionDeclarationRef = add(publishEvent(execDir, 'externalActionDeclaration', event)).data.ref;
  }
  for (const factRef of new Set([response.technicalFactRef, response.action?.technicalFactRef,
    response.recovery?.technicalFactRef].filter(Boolean))) {
    const event = events.find((item) => item.technicalFactRef === factRef);
    if (event) add(publishEvent(execDir, 'technicalFact', event));
  }
  if (finalizedFinish) {
    for (const publication of publishFinalResources(execDir, events)) {
      add(publication);
      if (publication.data.type === 'caseResult') result.caseResultRef = publication.data.ref;
    }
  }
  const descriptors = new Map();
  for (const item of published) for (const descriptor of [item.descriptor, ...(item.resources || [])]) {
    if (descriptor) descriptors.set(descriptor.ref, descriptor);
  }
  return { result, ...(primary ? { data: primary.data } : {}), resources: [...descriptors.values()] };
}

function resolveRequestReferences(execDir, value, field = '') {
  if (typeof value === 'string' && /Refs?$/.test(field) && value.startsWith('mavt:')) {
    return readPublishedResource(execDir, value).id;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRequestReferences(execDir, item, field));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRequestReferences(execDir, item, key)]));
}

module.exports = { TYPES, publishResource, readPublishedResource, resourceRef, publishEvent, publishScene,
  publishArtifact, publishCaseBrief, publishLedger, publishFinalResources, provideOperationResources, resolveRequestReferences, parseResourceRef };

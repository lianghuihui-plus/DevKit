#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const resources = require('../case-runtime/agent-resource-store');
const { run } = require('../case-runtime/agent-facing-client');
const store = require('../case-runtime/store');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-resources-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function fixture(id, platform = 'harmony') {
  const dir = path.join(temp, id);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  writeJsonAtomic(path.join(dir, 'execution.json'), { schemaVersion: 14, runtime: 'case-runtime', executionId: id, platform, finalized: false });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'screenshots/scene-0001.png'), png);
  const scene = { sceneId: 'scene-0001', capturedAt: '2026-09-22T00:00:00Z', generation: 1,
    screenshot: { ref: 'screenshots/scene-0001.png', width: 100, height: 200 },
    layout: { nodes: Array.from({ length: 70 }, (_, i) => ({ id: `n${i}` })) },
    elements: Array.from({ length: 70 }, (_, i) => ({ id: `e${i}`, text: `button ${i}`, clickable: true, enabled: true, visible: true, bounds: [0, 0, 10, 10] })),
    app: { appId: 'test', inTargetApp: true }, signals: {}, conflicts: [], scrollContexts: [], visual: { gestures: ['tap'] } };
  store.writeScene(dir, scene);
  return { dir, scene };
}
const { dir, scene } = fixture('execution-a');
const observed = run(dir, { operation: 'observe', input: {} }, { executeRequest: () => ({ status: 'SCENE', scene }) });
assert.strictEqual(observed.status, 'SUCCEEDED');
assert.strictEqual(observed.data.type, 'scene');
assert.strictEqual(Object.hasOwn(observed.data.content, 'sceneId'), false);
assert.ok(!observed.data.ref.includes(encodeURIComponent(path.resolve(dir))));
assert.ok(observed.data.content.actions.length > 70, 'all published actions are retained');
assert.strictEqual(observed.data.content.layout, undefined);
assert.strictEqual(observed.data.content.elements, undefined);
const reread = run(dir, { operation: 'read', input: { ref: observed.data.ref } });
assert.deepStrictEqual(reread.data, observed.data);
assert.ok(!reread.resources.some((item) => item.ref === reread.data.ref));
const elements = resources.readPublishedResource(dir, observed.data.content.elementSetRef);
assert.strictEqual(elements.data.content.length, 70);
const jsonLayout = resources.readPublishedResource(dir, observed.data.content.layoutRef);
assert.strictEqual(jsonLayout.data.mediaType, 'application/json');
assert.strictEqual(jsonLayout.descriptor.mediaType, 'application/json');
assert.deepStrictEqual(jsonLayout.data.content, scene.layout);
const binary = resources.readPublishedResource(dir, observed.data.content.screenshotRef).data.content;
assert.strictEqual(binary.sha256, crypto.createHash('sha256').update(png).digest('hex'));
assert.strictEqual(binary.path, fs.realpathSync(path.join(dir, 'screenshots/scene-0001.png')));
assert.strictEqual(observed.resources.find((item) => item.type === 'screenshot').mediaType, 'image/png');

// Android and iOS publish their raw layout as XML without changing the Agent read protocol.
for (const platform of ['android', 'ios']) {
  const xmlFixture = fixture(`execution-${platform}-xml`, platform);
  const xml = `<?xml version="1.0"?><hierarchy platform="${platform}"><node text="允许"/></hierarchy>\n`;
  fs.mkdirSync(path.join(xmlFixture.dir, 'layouts'));
  fs.writeFileSync(path.join(xmlFixture.dir, 'layouts/scene-0001.xml'), xml);
  store.writeScene(xmlFixture.dir, {
    ...xmlFixture.scene,
    layoutRef: 'layouts/scene-0001.xml',
    layout: { usable: true, format: 'xml', diagnostics: [] },
  });
  const xmlScene = resources.publishScene(xmlFixture.dir, xmlFixture.scene.sceneId);
  const xmlDescriptor = xmlScene.resources.find((item) => item.type === 'layout');
  assert.ok(xmlDescriptor, `${platform} Scene must publish its XML layout`);
  assert.strictEqual(xmlDescriptor.mediaType, 'application/xml');
  const xmlLayout = resources.readPublishedResource(xmlFixture.dir, xmlScene.data.content.layoutRef);
  assert.strictEqual(xmlLayout.data.mediaType, 'application/xml');
  assert.strictEqual(xmlLayout.data.content, xml);
  const catalogDir = path.join(xmlFixture.dir, 'operations/resources/catalog');
  const layoutCatalogPath = fs.readdirSync(catalogDir).map((name) => path.join(catalogDir, name)).find((file) => {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.descriptor.ref === xmlScene.data.content.layoutRef;
  });
  const layoutCatalog = JSON.parse(fs.readFileSync(layoutCatalogPath, 'utf8'));
  writeJsonAtomic(layoutCatalogPath, { ...layoutCatalog,
    descriptor: { ...layoutCatalog.descriptor, mediaType: 'application/json' } });
  assert.throws(() => resources.readPublishedResource(xmlFixture.dir, xmlScene.data.content.layoutRef), {
    code: 'RESOURCE_INTEGRITY_INVALID',
  });
  writeJsonAtomic(layoutCatalogPath, layoutCatalog);
  fs.appendFileSync(path.join(xmlFixture.dir, 'layouts/scene-0001.xml'), '<!-- changed -->\n');
  assert.throws(() => resources.readPublishedResource(xmlFixture.dir, xmlScene.data.content.layoutRef), {
    code: 'RESOURCE_INTEGRITY_INVALID',
  });
}

for (const [id, relative, declaredFormat, expectedDiagnostic] of [
  ['execution-unknown-layout', 'layouts/scene-0001.yaml', 'yaml', {
    resourceType: 'layout', code: 'RESOURCE_FORMAT_UNSUPPORTED', format: 'yaml',
  }],
  ['execution-mismatched-layout', 'layouts/scene-0001.json', 'xml', {
    resourceType: 'layout', code: 'RESOURCE_FORMAT_UNSUPPORTED', format: 'xml',
    reason: 'FORMAT_DECLARATION_MISMATCH', pathFormat: 'json',
  }],
]) {
  const unsupported = fixture(id, 'android');
  fs.mkdirSync(path.join(unsupported.dir, 'layouts'));
  fs.writeFileSync(path.join(unsupported.dir, relative), declaredFormat === 'xml' ? '<hierarchy/>\n' : 'root: unsupported\n');
  const unsupportedScene = {
    ...unsupported.scene,
    layoutRef: relative,
    layout: { usable: true, format: declaredFormat, diagnostics: [] },
  };
  store.writeScene(unsupported.dir, unsupportedScene);
  const degraded = run(unsupported.dir, { operation: 'observe', input: {} }, {
    executeRequest: () => ({ status: 'SCENE', scene: unsupportedScene }),
  });
  assert.strictEqual(degraded.status, 'SUCCEEDED');
  assert.strictEqual(degraded.data.type, 'scene');
  assert.strictEqual(degraded.data.content.layoutRef, undefined);
  assert.deepStrictEqual(degraded.data.content.resourceDiagnostics, [expectedDiagnostic]);
  assert.ok(!degraded.resources.some((item) => item.type === 'layout'));
}
const missingLayout = fixture('execution-missing-layout', 'ios');
const missingLayoutScene = { ...missingLayout.scene, layoutRef: 'layouts/missing.yaml',
  layout: { usable: true, format: 'yaml', diagnostics: [] } };
store.writeScene(missingLayout.dir, missingLayoutScene);
const missingLayoutResponse = run(missingLayout.dir, { operation: 'observe', input: {} }, {
  executeRequest: () => ({ status: 'SCENE', scene: missingLayoutScene }),
});
assert.strictEqual(missingLayoutResponse.status, 'FAILED');
assert.strictEqual(missingLayoutResponse.error.code, 'RESOURCE_INTEGRITY_INVALID');
const previousActionFixture = fixture('execution-previous-action');
store.writeScene(previousActionFixture.dir, {
  ...previousActionFixture.scene,
  previousAction: {
    operationId: 'action-accepted', action: { type: 'tap' }, command: { status: 'ACCEPTED' },
  },
});
const previousActionScene = resources.publishScene(previousActionFixture.dir, previousActionFixture.scene.sceneId);
assert.strictEqual(previousActionScene.data.content.previousAction.deliveryStatus, 'COMMAND_RESPONSE_RECORDED');
assert.strictEqual(previousActionScene.data.content.previousAction.commandDeliveryKnown, true);
assert.strictEqual(Object.hasOwn(previousActionScene.data.content.previousAction, 'outcomeKnown'), false);
const other = fixture('execution-b');
assert.throws(() => resources.readPublishedResource(other.dir, observed.data.ref), { code: 'RESOURCE_SCOPE_MISMATCH' });
assert.throws(() => resources.readPublishedResource(dir, 'not-published'), { code: 'RESOURCE_UNKNOWN' });
assert.strictEqual(run(dir, { operation: 'read', input: { ref: resources.resourceRef(dir, 'scene', 'not-published') } }).error.code, 'RESOURCE_UNKNOWN');
assert.strictEqual(run(other.dir, { operation: 'read', input: { ref: observed.data.ref } }).status, 'REJECTED');
assert.strictEqual(require('../case-runtime/agent-facing-translator').translateAgentFacingRequest(dir, {
  operation: 'act', input: { sceneRef: observed.data.ref, action: { ref: 'e0:tap' } },
}).basedOnSceneId, scene.sceneId);
const unknownWithBrokenArtifact = run(dir, { operation: 'act', input: { sceneRef: observed.data.ref, action: { ref: 'e0:tap' } } }, {
  executeRequest: () => ({ status: 'SCENE', outcomeKnown: false, action: { status: 'UNKNOWN' }, scene: { sceneId: 'scene-missing' } }),
});
assert.strictEqual(unknownWithBrokenArtifact.status, 'UNKNOWN', 'publication failure must not erase uncertain device delivery');
assert.strictEqual(unknownWithBrokenArtifact.error.retryable, false);

// Public resource classifications survive non-read request translation.
const corruptFixture = fixture('execution-corrupted-ref');
const corruptScene = resources.publishScene(corruptFixture.dir, corruptFixture.scene.sceneId);
writeJsonAtomic(path.join(corruptFixture.dir, 'scenes', `${corruptFixture.scene.sceneId}.json`), { ...corruptFixture.scene, generation: 2 });
for (const operation of ['act', 'inspect']) {
  for (const [targetDir, ref, status, code, retryable] of [
    [dir, resources.resourceRef(dir, 'scene', 'unpublished'), 'REJECTED', 'RESOURCE_UNKNOWN', true],
    [other.dir, observed.data.ref, 'REJECTED', 'RESOURCE_SCOPE_MISMATCH', false],
    [corruptFixture.dir, corruptScene.data.ref, 'FAILED', 'RESOURCE_INTEGRITY_INVALID', false],
  ]) {
    const input = operation === 'act' ? { sceneRef: ref, action: { ref: 'e0:tap' } }
      : { mode: 'visual', sceneRef: ref, observation: 'visible' };
    const rejected = run(targetDir, { operation, input }, { executeRequest: () => { throw new Error('must not reach broker'); } });
    assert.strictEqual(rejected.status, status);
    assert.strictEqual(rejected.error.code, code);
    assert.strictEqual(rejected.error.retryable, retryable);
  }
}

// Technical facts live in distinct immutable locations for action and recovery.
for (const [operation, location, eventType, input] of [
  ['act', 'action', 'actionOutcomeUnknown', { sceneRef: observed.data.ref, action: { ref: 'e0:tap' } }],
  ['recover', 'recovery', 'recoveryOutcomeUnknown', { mode: 'restart', sceneRef: observed.data.ref, reason: 'connection lost' }],
]) {
  const fact = store.appendEvent(dir, eventType, { operationId: `unknown-${operation}` });
  const uncertain = run(dir, { operation, input }, { executeRequest: () => ({ status: 'SCENE',
    scene: { sceneId: scene.sceneId },
    [location]: { status: 'UNKNOWN', technicalFactRef: fact.technicalFactRef } }) });
  assert.strictEqual(uncertain.status, 'UNKNOWN');
  const descriptor = uncertain.resources.find((item) => item.type === 'technicalFact');
  assert.ok(descriptor, `${location} technical fact must be available`);
  assert.strictEqual(resources.readPublishedResource(dir, descriptor.ref).data.content.eventId, fact.eventId);
}

// Publishing one more Scene must not reconstruct the complete action history.
const chain = fixture('execution-chain');
resources.publishScene(chain.dir, chain.scene.sceneId);
for (let index = 2; index <= 30; index += 1) {
  const sceneId = `scene-${String(index).padStart(4, '0')}`;
  const previousId = `scene-${String(index - 1).padStart(4, '0')}`;
  store.writeScene(chain.dir, { ...chain.scene, sceneId, previousAction: { operationId: `action-${index}`,
    command: { status: 'ACCEPTED' }, evidence: { sceneRefs: { before: previousId, after: sceneId } } } });
  let sceneReads = 0;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function trackedRead(file, ...args) {
    if (String(file).includes('/scenes/')) sceneReads += 1;
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    const published = resources.publishScene(chain.dir, sceneId);
    resources.readPublishedResource(chain.dir, published.data.ref);
    assert.ok(sceneReads <= 6, `Scene publication/read must be bounded, read ${sceneReads} sources at depth ${index}`);
  } finally { fs.readFileSync = originalReadFileSync; }
}
const chainCurrent = store.readCurrentScene(chain.dir);
writeJsonAtomic(path.join(chain.dir, 'scenes', `${chainCurrent.sceneId}.json`), { ...chainCurrent, generation: 99 });
assert.throws(() => resources.publishScene(chain.dir, chainCurrent.sceneId), { code: 'RESOURCE_INTEGRITY_INVALID' },
  'reuse still verifies the directly requested source');
store.writeScene(chain.dir, { ...chain.scene, sceneId: 'scene-0031', previousAction: { operationId: 'action-31',
  evidence: { sceneRefs: { before: chainCurrent.sceneId, after: 'scene-0031' } } } });
assert.throws(() => resources.publishScene(chain.dir, 'scene-0031'), { code: 'RESOURCE_INTEGRITY_INVALID' },
  'reuse must verify the exact direct association binding');

// Events bind the exact revision rather than a mutable current projection.
const flow = require('../case-runtime/case-flow-service');
const flowInput = { baseRevision: null, summary: 'check', entryNodeRef: 'N1', nodes: [
  { ref: 'N1', type: 'CHECK', text: 'Visible', sourceBasis: 'expected visible', requirement: 'REQUIRED', verificationKind: 'DIRECT_OBSERVATION' },
  { ref: 'N2', type: 'END', text: 'done' },
], edges: [{ ref: 'L1', from: 'N1', to: 'N2' }], uncertainties: [] };
const revision1 = flow.revise(other.dir, flowInput);
const originalFlow = resources.publishEvent(other.dir, 'caseFlow', revision1.caseFlow);
const ledger1 = resources.publishLedger(other.dir);
const revision2 = flow.revise(other.dir, { ...flowInput, baseRevision: 1, reason: 'clarify', summary: 'revised check' });
const latestFlow = resources.publishEvent(other.dir, 'caseFlow', revision2.caseFlow);
assert.notStrictEqual(originalFlow.data.ref, latestFlow.data.ref);
assert.deepStrictEqual(resources.readPublishedResource(other.dir, originalFlow.data.ref).data, originalFlow.data);
const ledger2 = resources.publishLedger(other.dir);
assert.notStrictEqual(ledger1.data.ref, ledger2.data.ref);
assert.deepStrictEqual(resources.readPublishedResource(other.dir, ledger1.data.ref).data, ledger1.data);
assert.throws(() => resources.publishResource(other.dir, { type: 'checkpointLedger', id: 'constant' }, { value: 1 })
  && resources.publishResource(other.dir, { type: 'checkpointLedger', id: 'constant' }, { value: 2 }), { code: 'RESOURCE_INTEGRITY_INVALID' });

// Knowledge candidates retain every snippet but refer to the frozen full text.
fs.mkdirSync(path.join(other.dir, 'knowledge'));
fs.writeFileSync(path.join(other.dir, 'knowledge/k.md'), '# Frozen knowledge\nComplete document');
const query = store.appendEvent(other.dir, 'knowledgeQueried', { queryId: 'knowledge-1', query: 'problem', context: { platform: 'harmony' },
  candidates: [{ entryId: 'K1', title: 'One', snapshotRef: 'knowledge/k.md', metadata: { app: 'test' },
    snippets: Array.from({ length: 80 }, (_, i) => `snippet-${i}`) }], filterDiagnostics: [{ count: 1 }], truncated: false });
const queried = resources.provideOperationResources(other.dir, { status: 'KNOWLEDGE', queryId: query.queryId }, { operation: 'knowledge', input: { mode: 'query' } });
assert.strictEqual(queried.data.type, 'candidateSet');
assert.strictEqual(queried.data.content.candidates[0].snippets.length, 80);
assert.strictEqual(resources.readPublishedResource(other.dir, queried.data.content.candidates[0].knowledgeDocumentRef).data.content, '# Frozen knowledge\nComplete document');
const queryBefore = resources.readPublishedResource(other.dir, queried.result.knowledgeQueryRef);
const review = store.appendEvent(other.dir, 'knowledgeReviewed', { queryId: query.queryId, conclusion: 'NONE_APPLICABLE', assessments: [{ entryId: 'K1', status: 'NOT_APPLICABLE', reason: 'different page' }] });
const reviewed = resources.provideOperationResources(other.dir, { status: 'KNOWLEDGE_REVIEWED', queryId: query.queryId }, { operation: 'knowledge', input: { mode: 'review', queryId: query.queryId } });
assert.strictEqual(resources.readPublishedResource(other.dir, reviewed.result.knowledgeReviewRef).data.content.eventId, review.eventId);
assert.deepStrictEqual(resources.readPublishedResource(other.dir, queried.result.knowledgeQueryRef).data, queryBefore.data);

for (const [type, eventType, body] of [
  ['checkpointResult', 'expectationResultUpdated', { resultUpdateId: 'resultUpdate-0001', expectationRef: 'N1', status: 'PASS', evidence: {} }],
  ['externalActionDeclaration', 'externalActionDeclared', { summary: 'reconnected', reason: 'transport', tool: 'host', evidence: false, verificationRequired: true }],
  ['technicalFact', 'technicalIssue', { code: 'TEST_TECHNICAL', message: 'deterministic fact' }],
]) {
  const event = store.appendEvent(other.dir, eventType, body);
  const publication = resources.publishEvent(other.dir, type, event);
  assert.deepStrictEqual(resources.readPublishedResource(other.dir, publication.data.ref).data, publication.data);
}

// Existing artifact authorities are reused; only the catalog binding is added.
for (const [type, relative, body] of [
  ['planEvidence', 'operations/plan-evidence/check-1.json', { type: 'check', passed: true }],
  ['actionSpatialEvidence', 'action-spatial-evidence/action-1.json', { operationId: 'action-1', requested: { x: 1, y: 2 } }],
  ['planResult', 'operations/plans/plan-1.json', { planId: 'plan-1', status: 'PLAN_COMPLETED', steps: [], evidence: {} }],
  ['caseResult', 'result.json', { verdict: 'PASS', checks: [] }],
]) {
  fs.mkdirSync(path.dirname(path.join(other.dir, relative)), { recursive: true });
  if (type === 'planResult') body.integrity = { recordSha256: crypto.createHash('sha256').update(require('../lib/contract-utils').canonicalJson(body)).digest('hex') };
  writeJsonAtomic(path.join(other.dir, relative), body);
  if (type === 'caseResult') {
    assert.throws(() => resources.publishArtifact(other.dir, type, relative), { code: 'RESOURCE_INTEGRITY_INVALID' });
    store.updateExecution(other.dir, { finalized: true });
  }
  const publication = resources.publishArtifact(other.dir, type, relative);
  assert.deepStrictEqual(resources.readPublishedResource(other.dir, publication.data.ref).data.content, body);
}
const handoff = require('../batch/agent-handoff').createAgentHandoff({ workspaceRoot: temp, batchId: 'batch-resources', executionId: 'execution-b',
  caseProtocolSha: 'protocol-sha', casePrompt: 'execute case', brief: { case: { source: 'original case' }, runtime: { command: 'bound command' } } });
store.updateExecution(other.dir, { batchId: 'batch-resources' });
const brief = resources.publishCaseBrief(other.dir, handoff.path, temp);
assert.deepStrictEqual(resources.readPublishedResource(other.dir, brief.data.ref).data.content.case, { source: 'original case' });
assert.ok(!fs.readdirSync(path.join(other.dir, 'operations/resources/snapshots')).some((name) => name.startsWith('caseBrief')));

// A published file cannot be replaced by a symbolic link, even within scope.
writeJsonAtomic(path.join(other.dir, 'source.json'), { stable: true });
const linked = resources.publishArtifact(other.dir, 'planEvidence', 'source.json');
fs.renameSync(path.join(other.dir, 'source.json'), path.join(other.dir, 'moved.json'));
fs.symlinkSync(path.join(other.dir, 'moved.json'), path.join(other.dir, 'source.json'));
assert.throws(() => resources.readPublishedResource(other.dir, linked.data.ref), { code: 'RESOURCE_INTEGRITY_INVALID' });
assert.throws(() => resources.publishArtifact(other.dir, 'planEvidence', '../execution-a/execution.json'), { code: 'RESOURCE_INTEGRITY_INVALID' });
assert.throws(() => resources.resourceRef(other.dir, 'scene', path.resolve(other.dir)), { code: 'RESOURCE_INTEGRITY_INVALID' });
const beforeEvents = fs.readFileSync(path.join(other.dir, 'events.jsonl'), 'utf8');
fs.appendFileSync(path.join(other.dir, 'events.jsonl'), '{"partial":');
resources.readPublishedResource(other.dir, originalFlow.data.ref);
assert.strictEqual(fs.readFileSync(path.join(other.dir, 'events.jsonl'), 'utf8'), `${beforeEvents}{"partial":`);
writeJsonAtomic(path.join(other.dir, 'operations/plans/pending.json'), { status: 'RUNNING' });
assert.throws(() => resources.publishArtifact(other.dir, 'planResult', 'operations/plans/pending.json'), { code: 'RESOURCE_INTEGRITY_INVALID' });
const tamperedEvents = beforeEvents.split('\n').filter(Boolean).map((line) => {
  const event = JSON.parse(line);
  return JSON.stringify(event.eventId === revision1.caseFlow.eventId ? { ...event, summary: 'mutated history' } : event);
}).join('\n') + '\n';
fs.writeFileSync(path.join(other.dir, 'events.jsonl'), tamperedEvents);
assert.throws(() => resources.readPublishedResource(other.dir, originalFlow.data.ref), { code: 'RESOURCE_INTEGRITY_INVALID' });
writeJsonAtomic(path.join(dir, 'current-scene.json'), { sceneId: 'new-current' });
assert.deepStrictEqual(resources.readPublishedResource(dir, observed.data.ref).data, observed.data);
store.updateExecution(dir, { finalized: true });
assert.strictEqual(run(dir, { operation: 'read', input: { ref: observed.data.ref } }).status, 'SUCCEEDED');
assert.strictEqual(run(dir, { operation: 'observe', input: {} }).error.code, 'CASE_RUNTIME_FINALIZED');
fs.writeFileSync(binary.path, 'tampered');
assert.throws(() => resources.readPublishedResource(dir, observed.data.content.screenshotRef), { code: 'RESOURCE_INTEGRITY_INVALID' });
assert.strictEqual(run(dir, { operation: 'read', input: { ref: observed.data.content.screenshotRef } }).status, 'FAILED');
console.log('agent-facing resources tests passed');

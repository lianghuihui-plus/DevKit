#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const resources = require('../case-runtime/agent-resource-store');
const store = require('../case-runtime/store');
const { queryCapabilities } = require('../case-runtime/capability-modules/broker');
const {
  freezeCatalog,
  loadCatalog,
  resolveCapability,
} = require('../case-runtime/capability-modules/snapshot-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-capability-catalog-'));
function execution(id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'execution.json'), {
    schemaVersion: 14, runtime: 'case-runtime', executionId: id, platform: 'harmony', finalized: false,
  });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  return dir;
}

const execDir = execution('execution-a');
const otherDir = execution('execution-b');
const discovery = {
  available: [{
    moduleId: 'fixture', moduleVersion: '1.0.0', moduleSummary: 'Fixture provider', implementationVersion: 'fixture 1',
    definitions: [{
      name: 'student.update', summary: 'Update one student',
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { studentId: { type: 'string', minLength: 1 } }, required: ['studentId'] },
      invocation: { kind: 'fixture', id: 'student.update' },
    }],
    diagnostics: [],
  }],
  unavailable: [{ moduleId: 'offline', summary: 'Offline fixture', diagnostic: 'not configured' }],
};

const first = freezeCatalog(execDir, discovery, { now: '2026-10-09T10:00:00.000Z' });
assert.strictEqual(first.schemaVersion, 1);
assert.strictEqual(first.executionId, 'execution-a');
assert.strictEqual(first.available.length, 1);
assert.strictEqual(first.available[0].name, 'fixture.student.update');
assert.match(first.available[0].capabilityRef, /^mavt:[a-f0-9]{24}:capabilityDefinition:/);
assert.deepStrictEqual(first.unavailableModules, discovery.unavailable);

const definition = resolveCapability(execDir, first.available[0].capabilityRef);
assert.strictEqual(definition.name, 'fixture.student.update');
assert.strictEqual(definition.providerCapabilityName, 'student.update');
assert.deepStrictEqual(resources.readPublishedResource(execDir, first.available[0].capabilityRef).data.content, definition);
assert.throws(() => resolveCapability(otherDir, first.available[0].capabilityRef), { code: 'RESOURCE_SCOPE_MISMATCH' });

const second = freezeCatalog(execDir, {
  available: [], unavailable: [{ moduleId: 'fixture', summary: 'changed', diagnostic: 'changed' }],
}, { now: '2026-10-09T11:00:00.000Z' });
assert.deepStrictEqual(second, first, 'the first catalog remains frozen');
assert.deepStrictEqual(loadCatalog(execDir), first);

const catalogPath = path.join(execDir, 'capabilities/catalog.snapshot.json');
const definitionFiles = fs.readdirSync(path.join(execDir, 'capabilities/definitions'));
assert.strictEqual(definitionFiles.length, 1);
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'capabilityCatalogFrozen').length, 1);
assert.strictEqual(store.events(execDir).find((event) => event.type === 'capabilityCatalogFrozen').catalogDigest, first.digest);
const catalogRef = resources.resourceRef(execDir, 'capabilityCatalog', path.relative(execDir, catalogPath));
assert.strictEqual(resources.readPublishedResource(execDir, catalogRef).data.type, 'capabilityCatalog');

const catalogRegistry = path.join(execDir, 'operations', 'resources', 'catalog',
  `${crypto.createHash('sha256').update(catalogRef).digest('hex')}.json`);
fs.unlinkSync(catalogRegistry);
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
const recovered = queryCapabilities(execDir, { capabilityProviders: [], now: '2026-10-09T12:00:00.000Z' });
assert.deepStrictEqual(recovered.data.content, first);
assert.strictEqual(resources.readPublishedResource(execDir, catalogRef).data.type, 'capabilityCatalog');
assert.strictEqual(store.events(execDir).filter((event) => event.type === 'capabilityCatalogFrozen').length, 1);
assert.strictEqual(store.events(execDir)[0].catalogDigest, first.digest);

const tampered = { ...first, availableCount: 99 };
writeJsonAtomic(catalogPath, tampered);
assert.throws(() => loadCatalog(execDir), (error) => error.code === 'CAPABILITY_CATALOG_INVALID');

console.log('capability catalog store tests passed');

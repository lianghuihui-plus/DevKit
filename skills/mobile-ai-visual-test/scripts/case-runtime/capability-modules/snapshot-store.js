'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('../../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../../lib/execution-lifecycle');
const resources = require('../agent-resource-store');
const store = require('../store');

const CATALOG_RELATIVE = 'capabilities/catalog.snapshot.json';
const DEFINITION_DIRECTORY = 'capabilities/definitions';

function catalogDigest(value) {
  const { digest: _digest, ...payload } = value;
  return sha256(canonicalJson(payload), 'capability-catalog');
}

function definitionDigest(value) {
  return sha256(canonicalJson(value), 'capability-definition');
}

function invalid(message) {
  throw contractError('CAPABILITY_CATALOG_INVALID', message);
}

function writeImmutableJson(file, value) {
  if (fs.existsSync(file)) {
    const existing = readJson(file, null);
    if (canonicalJson(existing) !== canonicalJson(value)) invalid(`immutable capability artifact changed: ${path.basename(file)}`);
    return;
  }
  writeJsonAtomic(file, value);
}

function validateCatalog(execDir, catalog) {
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  if (!catalog || catalog.schemaVersion !== 1 || catalog.executionId !== execution.executionId
    || !Array.isArray(catalog.available) || !Array.isArray(catalog.unavailableModules)) {
    invalid('capability catalog shape or execution binding is invalid');
  }
  if (catalog.availableCount !== catalog.available.length || catalog.digest !== catalogDigest(catalog)) {
    invalid('capability catalog digest or counts are invalid');
  }
  return catalog;
}

function loadCatalog(execDir) {
  const catalog = readJson(path.join(execDir, CATALOG_RELATIVE), null);
  return catalog ? validateCatalog(execDir, catalog) : null;
}

function ensureCatalogPublication(execDir, catalog, options = {}) {
  const definitionPublications = catalog.available.map((item) => {
    const relative = `${DEFINITION_DIRECTORY}/${item.definitionDigest}.json`;
    const definition = readJson(path.join(execDir, relative), null);
    if (!definition || definitionDigest(definition) !== item.definitionDigest
      || definition.name !== item.name || definition.moduleId !== item.moduleId) {
      invalid(`capability definition does not match catalog: ${item.name}`);
    }
    const publication = resources.publishArtifact(execDir, 'capabilityDefinition', relative);
    if (publication.data.ref !== item.capabilityRef) invalid(`capability reference changed: ${item.name}`);
    return publication;
  });
  resources.publishArtifact(execDir, 'capabilityCatalog', CATALOG_RELATIVE,
    definitionPublications.map((item) => item.descriptor));
  const frozenEvents = store.events(execDir).filter((event) => event.type === 'capabilityCatalogFrozen');
  if (frozenEvents.some((event) => event.catalogDigest !== catalog.digest)) {
    invalid('capability catalog event digest does not match the frozen catalog');
  }
  if (!frozenEvents.length) {
    store.appendEvent(execDir, 'capabilityCatalogFrozen', {
      catalogSchemaVersion: 1,
      catalogDigest: catalog.digest,
      availableCount: catalog.availableCount,
      unavailableModuleCount: catalog.unavailableModules.length,
    }, options);
  }
  return catalog;
}

function freezeCatalog(execDir, discovery, options = {}) {
  const existing = loadCatalog(execDir);
  if (existing) return ensureCatalogPublication(execDir, existing, options);
  const execution = store.loadExecution(execDir);
  const definitionsDirectory = path.join(execDir, DEFINITION_DIRECTORY);
  fs.mkdirSync(definitionsDirectory, { recursive: true });
  const available = [];
  const definitionPublications = [];
  for (const module of discovery.available || []) {
    for (const candidate of module.definitions || []) {
      const definition = {
        schemaVersion: 1,
        type: 'capabilityDefinition',
        moduleId: module.moduleId,
        moduleVersion: module.moduleVersion,
        moduleSummary: module.moduleSummary,
        implementationVersion: module.implementationVersion || null,
        name: `${module.moduleId}.${candidate.name}`,
        providerCapabilityName: candidate.name,
        summary: candidate.summary,
        inputSchema: candidate.inputSchema,
        ...(candidate.sensitiveFields ? { sensitiveFields: candidate.sensitiveFields } : {}),
        ...(candidate.invocation ? { invocation: candidate.invocation } : {}),
      };
      const digest = definitionDigest(definition);
      const relative = `${DEFINITION_DIRECTORY}/${digest}.json`;
      writeImmutableJson(path.join(execDir, relative), definition);
      const publication = resources.publishArtifact(execDir, 'capabilityDefinition', relative);
      definitionPublications.push(publication);
      available.push({
        name: definition.name,
        summary: definition.summary,
        moduleId: definition.moduleId,
        definitionDigest: digest,
        capabilityRef: publication.data.ref,
      });
    }
  }
  available.sort((left, right) => left.name.localeCompare(right.name));
  const payload = {
    schemaVersion: 1,
    type: 'capabilityCatalog',
    executionId: execution.executionId,
    frozenAt: options.now || new Date().toISOString(),
    availableCount: available.length,
    available,
    modules: (discovery.available || []).map((module) => ({
      moduleId: module.moduleId,
      moduleVersion: module.moduleVersion,
      moduleSummary: module.moduleSummary,
      implementationVersion: module.implementationVersion || null,
      diagnostics: module.diagnostics || [],
    })),
    unavailableModules: discovery.unavailable || [],
  };
  const catalog = { ...payload, digest: catalogDigest(payload) };
  writeImmutableJson(path.join(execDir, CATALOG_RELATIVE), catalog);
  return ensureCatalogPublication(execDir, catalog, options);
}

function resolveCapability(execDir, capabilityRef) {
  const published = resources.readPublishedResource(execDir, capabilityRef);
  if (published.data.type !== 'capabilityDefinition') {
    throw contractError('CAPABILITY_REFERENCE_INVALID', 'reference is not a capability definition');
  }
  const catalog = loadCatalog(execDir);
  if (!catalog?.available.some((item) => item.capabilityRef === capabilityRef)) {
    throw contractError('CAPABILITY_REFERENCE_INVALID', 'capability is not present in the frozen catalog');
  }
  return published.data.content;
}

module.exports = {
  CATALOG_RELATIVE,
  DEFINITION_DIRECTORY,
  catalogDigest,
  definitionDigest,
  ensureCatalogPublication,
  freezeCatalog,
  loadCatalog,
  resolveCapability,
};

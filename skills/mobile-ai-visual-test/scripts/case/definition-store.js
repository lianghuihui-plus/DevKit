'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { createCaseDefinition, validateCaseDefinition } = require('../execution/contracts/case-definition-contract');

function definitionsRoot(caseDir) {
  return path.join(path.resolve(caseDir), 'definitions');
}

function currentDefinitionPath(caseDir) {
  return path.join(definitionsRoot(caseDir), 'current.json');
}

function definitionPath(caseDir, definitionId) {
  return path.join(definitionsRoot(caseDir), `${definitionId}.json`);
}

function compilerLoaderCommand(caseDir) {
  const entry = path.resolve(__dirname, '../case-definition.js');
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} load-source --case-dir ${JSON.stringify(path.resolve(caseDir))}`;
}

function definitionRequired(caseDir, caseJson) {
  const error = contractError('CASE_DEFINITION_REQUIRED', `case ${caseJson.identity.caseNo || caseJson.identity.caseKey} has no published CaseDefinition`);
  error.caseKey = caseJson.identity.caseKey;
  error.compilerHandoff = { loaderCommand: compilerLoaderCommand(caseDir) };
  return error;
}

function readCaseSource(caseDir) {
  const resolved = path.resolve(caseDir);
  const caseJson = readJson(path.join(resolved, 'case.json'), null);
  validateCaseContract(caseJson);
  const sourcePath = path.join(resolved, 'source.md');
  if (!fs.existsSync(sourcePath)) throw contractError('CASE_INPUT_UNREADABLE', 'case source.md is missing');
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  if (sourceSha(sourceText) !== caseJson.identity.sourceSha) throw contractError('CASE_SOURCE_CHANGED', 'case source.md does not match case.json');
  return { caseDir: resolved, caseJson, sourceText };
}

function publishCaseDefinition(options) {
  const { caseDir, caseJson, sourceText } = readCaseSource(options.caseDir);
  const candidate = createCaseDefinition({
    caseKey: caseJson.identity.caseKey,
    sourceText,
    candidate: options.candidate,
    compilerProfileSha: options.compilerProfileSha,
    publishedAt: options.now,
  });
  const root = definitionsRoot(caseDir);
  const file = definitionPath(caseDir, candidate.definitionId);
  fs.mkdirSync(root, { recursive: true });
  let definition = candidate;
  if (fs.existsSync(file)) {
    definition = validateCaseDefinition(readJson(file, null), { sourceText, caseKey: caseJson.identity.caseKey });
    const comparable = (value) => {
      const copy = { ...value };
      delete copy.publishedAt;
      delete copy.definitionSha;
      return copy;
    };
    if (canonicalJson(comparable(definition)) !== canonicalJson(comparable(candidate))) {
      throw contractError('CASE_DEFINITION_IMMUTABLE', `definition already exists with different content: ${candidate.definitionId}`);
    }
  } else {
    writeJsonAtomic(file, candidate);
  }
  const current = {
    schemaVersion: 1,
    definitionId: definition.definitionId,
    definitionSha: definition.definitionSha,
    sourceSha: definition.sourceSha,
    status: 'READY',
  };
  const currentFile = currentDefinitionPath(caseDir);
  const existingCurrent = readJson(currentFile, null);
  if (!existingCurrent || canonicalJson(existingCurrent) !== canonicalJson(current)) writeJsonAtomic(currentFile, current);
  return { definition, current, path: file };
}

function loadPublishedCaseDefinition(caseDir, expectedRef = null) {
  const source = readCaseSource(caseDir);
  const current = readJson(currentDefinitionPath(caseDir), null);
  if (!current) throw definitionRequired(source.caseDir, source.caseJson);
  if (current.schemaVersion !== 1 || current.status !== 'READY' || current.sourceSha !== source.caseJson.identity.sourceSha) {
    throw contractError('CASE_DEFINITION_CURRENT_INVALID', 'current CaseDefinition pointer is invalid or stale');
  }
  if (expectedRef && (expectedRef.definitionId !== current.definitionId || expectedRef.definitionSha !== current.definitionSha)) {
    throw contractError('CASE_DEFINITION_REF_MISMATCH', 'requested CaseDefinition is not the current published definition');
  }
  const file = definitionPath(source.caseDir, current.definitionId);
  if (!fs.existsSync(file)) throw contractError('CASE_DEFINITION_MISSING', 'published CaseDefinition file is missing');
  const definition = validateCaseDefinition(readJson(file, null), { sourceText: source.sourceText, caseKey: source.caseJson.identity.caseKey });
  if (definition.definitionSha !== current.definitionSha || definition.sourceSha !== current.sourceSha) {
    throw contractError('CASE_DEFINITION_CURRENT_INVALID', 'current CaseDefinition pointer does not match its definition');
  }
  return { ...source, definition, current, path: file };
}

module.exports = {
  compilerLoaderCommand,
  currentDefinitionPath,
  definitionPath,
  definitionsRoot,
  loadPublishedCaseDefinition,
  publishCaseDefinition,
  readCaseSource,
};

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { createCaseContract, validateSourceText } = require('../execution/contracts/case-contract');
const { assertWorkspace } = require('../lib/workspace');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { ensureWorkspaceCaseNumbers, nextCaseNo, withCaseNo } = require('../lib/case-numbering');
const { rebuildCaseDerivedArtifacts } = require('../report/report-service');

function stableCaseKey(inputPath) {
  return `ck-${crypto.createHash('sha256').update(path.resolve(inputPath)).digest('hex').slice(0, 12)}`;
}

function stableDraftCaseKey(sourceLocator) {
  return `ck-${crypto.createHash('sha256').update(`agent-authored:${sourceLocator}`).digest('hex').slice(0, 12)}`;
}

function fallbackTitle(inputPath) {
  const extension = path.extname(inputPath);
  return path.basename(inputPath, extension).trim() || 'Untitled case';
}

function caseDirectoryName(title, caseKey) {
  const safeTitle = title.replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
  return `${safeTitle}__${caseKey}`;
}

function existingCaseDir(workspaceRoot, caseKey) {
  const casesRoot = path.join(workspaceRoot, 'cases');
  if (!fs.existsSync(casesRoot)) return null;
  for (const name of fs.readdirSync(casesRoot).sort()) {
    const caseDir = path.join(casesRoot, name);
    const casePath = path.join(caseDir, 'case.json');
    if (!fs.existsSync(casePath)) continue;
    try {
      if (readJson(casePath, null)?.identity?.caseKey === caseKey) return caseDir;
    } catch {
      // Invalid case directories are handled by their owning validation path.
    }
  }
  return null;
}

function importCaseContent(workspaceRoot, input, options = {}) {
  const workspace = assertWorkspace(workspaceRoot, { allowTest: true });
  const { caseKey, title, sourceText, importSource } = input;
  const caseDir = existingCaseDir(workspace.root, caseKey)
    || path.join(workspace.root, 'cases', caseDirectoryName(title, caseKey));
  ensureWorkspaceCaseNumbers(workspace.root);
  const draftPath = path.join(caseDir, 'case-import.draft.json');
  let draft = readJson(draftPath, null);
  if (!draft) {
    const normalized = validateSourceText(sourceText);
    const existing = readJson(path.join(caseDir, 'case.json'), null);
    const caseNo = existing?.identity?.caseNo || nextCaseNo(workspace.root, title);
    const caseJson = createCaseContract({ caseKey, caseNo, title, sourceText: normalized, importSource });
    draft = { schemaVersion: 1, importSource, caseKey, sourceText: normalized, caseJson };
    fs.mkdirSync(caseDir, { recursive: true });
    writeJsonAtomic(draftPath, draft);
  }
  if (draft.schemaVersion !== 1 || JSON.stringify(draft.importSource) !== JSON.stringify(importSource) || draft.caseKey !== caseKey
    || draft.caseJson?.identity?.caseKey !== caseKey) {
    throw contractError('CASE_IMPORT_DRAFT_INVALID', 'import draft does not match the requested source');
  }
  if (!draft.caseJson.identity.caseNo) {
    const current = readJson(path.join(caseDir, 'case.json'), null);
    const caseNo = current?.identity?.caseKey === caseKey && current.identity.caseNo
      ? current.identity.caseNo
      : nextCaseNo(workspace.root, title);
    draft.caseJson = withCaseNo(draft.caseJson, caseNo);
    writeJsonAtomic(draftPath, draft);
  }
  if (options.interruptAfter === 'draft') throw new Error('MAVT_CASE_IMPORT_INTERRUPTED: draft');
  const sourcePath = path.join(caseDir, 'source.md');
  const sourceTemp = `${sourcePath}.import.tmp`;
  fs.writeFileSync(sourceTemp, draft.sourceText);
  fs.renameSync(sourceTemp, sourcePath);
  if (options.interruptAfter === 'source') throw new Error('MAVT_CASE_IMPORT_INTERRUPTED: source');
  writeJsonAtomic(path.join(caseDir, 'case.json'), draft.caseJson);
  if (options.interruptAfter === 'case') throw new Error('MAVT_CASE_IMPORT_INTERRUPTED: case');
  const reports = rebuildCaseDerivedArtifacts(caseDir, { scope: 'all' });
  if (options.interruptAfter === 'report') throw new Error('MAVT_CASE_IMPORT_INTERRUPTED: report');
  fs.unlinkSync(draftPath);
  return { caseDir, caseJson: draft.caseJson, sourcePath, contextHtml: reports.rootReport.contextHtml };
}

function importSource(workspaceRoot, inputPath, options = {}) {
  const absoluteInput = path.resolve(inputPath);
  let sourceText;
  try {
    const stat = fs.statSync(absoluteInput);
    if (!stat.isFile()) throw new Error('input path is not a file');
    sourceText = fs.readFileSync(absoluteInput, 'utf8');
  } catch (error) {
    const wrapped = new Error(`CASE_INPUT_UNREADABLE: ${error.message}`);
    wrapped.code = 'CASE_INPUT_UNREADABLE';
    wrapped.exitCode = 2;
    throw wrapped;
  }
  return importCaseContent(workspaceRoot, {
    caseKey: stableCaseKey(absoluteInput),
    title: fallbackTitle(absoluteInput),
    sourceText,
    importSource: { kind: 'file', path: absoluteInput },
  }, options);
}

module.exports = {
  caseDirectoryName,
  fallbackTitle,
  importCaseContent,
  importSource,
  stableCaseKey,
  stableDraftCaseKey,
};

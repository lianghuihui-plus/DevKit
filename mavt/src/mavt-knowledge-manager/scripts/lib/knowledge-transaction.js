'use strict';

const fs = require('fs');
const path = require('path');
const {
  authoringWarnings,
  contentSha,
  loadKnowledgeEntries,
  parseKnowledgeEntry,
  validateKnowledgeEntries,
  validateKnowledgeRoot,
} = require('./knowledge-contract');
const { managerError } = require('./errors');
const { assertMavtWorkspace } = require('./workspace');

const ENTRY_ID_PATTERN = /^K-[A-Za-z0-9][A-Za-z0-9._-]{0,125}$/;
const OPERATION_FIELDS = Object.freeze({
  ADD: new Set(['type', 'draftPath']),
  UPDATE: new Set(['type', 'entryId', 'draftPath']),
  DELETE: new Set(['type', 'entryId']),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return contentSha(canonical(value));
}

function readJson(file, code, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw managerError(code, `${label} is not valid JSON: ${error.message}`);
  }
}

function onlyFields(value, allowed, label) {
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length) {
    throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `${label} contains unsupported fields: ${unsupported.join(', ')}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function readDraft(draftPath, knowledgeRoot) {
  const resolved = path.resolve(requireString(draftPath, 'draftPath'));
  if (!fs.existsSync(resolved)) throw managerError('KNOWLEDGE_DRAFT_INVALID', `draft does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw managerError('KNOWLEDGE_DRAFT_INVALID', `draft must be a regular file: ${resolved}`);
  }
  const relativeToKnowledge = path.relative(path.resolve(knowledgeRoot), resolved);
  if (relativeToKnowledge && !relativeToKnowledge.startsWith('..') && !path.isAbsolute(relativeToKnowledge)) {
    throw managerError('KNOWLEDGE_DRAFT_INVALID', 'draft must be outside the live knowledge directory');
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const entry = parseKnowledgeEntry(content, { absolutePath: resolved });
  return { draftPath: resolved, draftSha: entry.contentSha, content, entry };
}

function normalizeRequest(requestPath, knowledgeRoot) {
  const resolvedRequest = path.resolve(requireString(requestPath, 'request path'));
  if (!fs.existsSync(resolvedRequest) || !fs.statSync(resolvedRequest).isFile()) {
    throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `request file does not exist: ${resolvedRequest}`);
  }
  const raw = readJson(resolvedRequest, 'KNOWLEDGE_TRANSACTION_INVALID', 'request');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw managerError('KNOWLEDGE_TRANSACTION_INVALID', 'request must be an object');
  }
  onlyFields(raw, new Set(['schemaVersion', 'reason', 'operations']), 'request');
  if (raw.schemaVersion !== 1) throw managerError('KNOWLEDGE_TRANSACTION_INVALID', 'request schemaVersion must be 1');
  const reason = requireString(raw.reason, 'request.reason');
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    throw managerError('KNOWLEDGE_TRANSACTION_INVALID', 'request.operations must be a non-empty array');
  }
  const operations = raw.operations.map((rawOperation, index) => {
    if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
      throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `operations[${index}] must be an object`);
    }
    const type = requireString(rawOperation.type, `operations[${index}].type`).toUpperCase();
    if (!OPERATION_FIELDS[type]) {
      throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `operations[${index}].type must be ADD, UPDATE, or DELETE`);
    }
    onlyFields(rawOperation, OPERATION_FIELDS[type], `operations[${index}]`);
    if (type === 'ADD') return { type, ...readDraft(rawOperation.draftPath, knowledgeRoot) };
    const entryId = requireString(rawOperation.entryId, `operations[${index}].entryId`);
    if (!ENTRY_ID_PATTERN.test(entryId)) {
      throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `operations[${index}].entryId is invalid: ${entryId}`);
    }
    if (type === 'UPDATE') return { type, entryId, ...readDraft(rawOperation.draftPath, knowledgeRoot) };
    return { type, entryId };
  });
  return { requestPath: resolvedRequest, schemaVersion: 1, reason, operations };
}

function cloneEntry(entry) {
  return {
    ...entry,
    metadata: { ...entry.metadata },
    sections: { ...entry.sections },
  };
}

function buildPlan(workspace, requestPath, options = {}) {
  const resolved = assertMavtWorkspace(workspace);
  const current = loadKnowledgeEntries(resolved.knowledgeRoot);
  const request = normalizeRequest(requestPath, resolved.knowledgeRoot);
  const byId = new Map(current.map((entry) => [entry.entryId, cloneEntry(entry)]));
  const byPath = new Map(current.map((entry) => [entry.relativePath, entry.entryId]));
  const touched = new Set();
  const changes = [];
  for (const operation of request.operations) {
    const operationId = operation.type === 'ADD' ? operation.entry.entryId : operation.entryId;
    if (touched.has(operationId)) {
      throw managerError('KNOWLEDGE_TRANSACTION_INVALID', `transaction repeats entryId: ${operationId}`);
    }
    touched.add(operationId);
    if (operation.type === 'ADD') {
      if (byId.has(operation.entry.entryId)) {
        throw managerError('KNOWLEDGE_ENTRY_DUPLICATE', `knowledge entry already exists: ${operation.entry.entryId}`);
      }
      const relativePath = `${operation.entry.entryId}.md`;
      if (byPath.has(relativePath) || fs.existsSync(path.join(resolved.knowledgeRoot, relativePath))) {
        throw managerError('KNOWLEDGE_PATH_CONFLICT', `knowledge path already exists: ${relativePath}`);
      }
      const entry = { ...operation.entry, relativePath, absolutePath: path.join(resolved.knowledgeRoot, relativePath) };
      byId.set(entry.entryId, entry);
      byPath.set(relativePath, entry.entryId);
      changes.push({
        type: 'ADD', entryId: entry.entryId, relativePath,
        beforeSha: null, afterSha: entry.contentSha,
        draftPath: operation.draftPath, draftSha: operation.draftSha,
      });
    } else if (operation.type === 'UPDATE') {
      const existing = byId.get(operation.entryId);
      if (!existing) throw managerError('KNOWLEDGE_ENTRY_NOT_FOUND', `knowledge entry does not exist: ${operation.entryId}`);
      if (operation.entry.entryId !== operation.entryId) {
        throw managerError('KNOWLEDGE_ENTRY_ID_CHANGED', `UPDATE cannot change ${operation.entryId} to ${operation.entry.entryId}`);
      }
      const entry = {
        ...operation.entry,
        relativePath: existing.relativePath,
        absolutePath: existing.absolutePath,
      };
      byId.set(entry.entryId, entry);
      changes.push({
        type: 'UPDATE', entryId: entry.entryId, relativePath: entry.relativePath,
        beforeSha: existing.contentSha, afterSha: entry.contentSha,
        draftPath: operation.draftPath, draftSha: operation.draftSha,
      });
    } else {
      const existing = byId.get(operation.entryId);
      if (!existing) throw managerError('KNOWLEDGE_ENTRY_NOT_FOUND', `knowledge entry does not exist: ${operation.entryId}`);
      byId.delete(operation.entryId);
      byPath.delete(existing.relativePath);
      changes.push({
        type: 'DELETE', entryId: existing.entryId, relativePath: existing.relativePath,
        beforeSha: existing.contentSha, afterSha: null,
      });
    }
  }
  const prospective = [...byId.values()].sort((left, right) => left.entryId.localeCompare(right.entryId));
  const summary = validateKnowledgeEntries(prospective, options);
  const warnings = prospective.flatMap((entry) => authoringWarnings(entry, options));
  const currentIndex = current.map((entry) => ({
    entryId: entry.entryId,
    relativePath: entry.relativePath,
    contentSha: entry.contentSha,
  }));
  const normalizedRequest = {
    schemaVersion: 1,
    reason: request.reason,
    operations: request.operations.map((operation) => ({
      type: operation.type,
      ...(operation.entryId ? { entryId: operation.entryId } : {}),
      ...(operation.draftPath ? { draftPath: operation.draftPath, draftSha: operation.draftSha } : {}),
      ...(operation.type === 'ADD' ? { entryId: operation.entry.entryId } : {}),
    })),
  };
  const hashInput = { workspace: resolved.root, currentIndex, request: normalizedRequest, changes };
  return {
    resolved,
    request,
    current,
    prospective,
    publicPlan: {
      schemaVersion: 1,
      status: 'PREPARED',
      workspace: resolved.root,
      requestPath: request.requestPath,
      planHash: hashObject(hashInput),
      currentIndexSha: hashObject(currentIndex),
      reason: request.reason,
      changes,
      validation: {
        ...summary,
        warningCount: warnings.length,
        warnings,
      },
    },
  };
}

function prepareTransaction(workspace, requestPath, options = {}) {
  return buildPlan(workspace, requestPath, options).publicPlan;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function transactionId(maintenanceRoot, planHash, now) {
  const date = now ? new Date(now) : new Date();
  if (Number.isNaN(date.getTime())) throw managerError('KNOWLEDGE_TIME_INVALID', `invalid transaction time: ${now}`);
  const base = `${date.toISOString().replace(/[-:.]/g, '')}-${planHash.slice(0, 12)}`;
  const root = path.join(maintenanceRoot, 'backups');
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(path.join(root, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createBackup(built, options = {}) {
  const id = transactionId(built.resolved.maintenanceRoot, built.publicPlan.planHash, options.now);
  const backupPath = path.join(built.resolved.maintenanceRoot, 'backups', id);
  fs.mkdirSync(path.join(backupPath, 'original'), { recursive: true });
  writeJson(path.join(backupPath, 'request.json'), {
    schemaVersion: 1,
    reason: built.request.reason,
    operations: built.request.operations.map((operation) => ({
      type: operation.type,
      ...(operation.entryId ? { entryId: operation.entryId } : {}),
      ...(operation.draftPath ? { draftPath: operation.draftPath, draftSha: operation.draftSha } : {}),
      ...(operation.type === 'ADD' ? { entryId: operation.entry.entryId } : {}),
    })),
  });
  writeJson(path.join(backupPath, 'plan.json'), built.publicPlan);
  for (const change of built.publicPlan.changes.filter((item) => item.beforeSha)) {
    const source = path.join(built.resolved.knowledgeRoot, change.relativePath);
    const target = path.join(backupPath, 'original', change.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return { transactionId: id, backupPath };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function commitPlan(built) {
  const operationById = new Map(built.request.operations.map((operation) => [
    operation.type === 'ADD' ? operation.entry.entryId : operation.entryId,
    operation,
  ]));
  for (const change of built.publicPlan.changes.filter((item) => item.type !== 'DELETE')) {
    atomicWrite(path.join(built.resolved.knowledgeRoot, change.relativePath), operationById.get(change.entryId).content);
  }
  for (const change of built.publicPlan.changes.filter((item) => item.type === 'DELETE')) {
    fs.unlinkSync(path.join(built.resolved.knowledgeRoot, change.relativePath));
  }
}

function restoreBackup(built, backup) {
  for (const change of built.publicPlan.changes) {
    const target = path.join(built.resolved.knowledgeRoot, change.relativePath);
    const original = path.join(backup.backupPath, 'original', change.relativePath);
    if (change.beforeSha) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(original, target);
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
  validateKnowledgeRoot(built.resolved.knowledgeRoot);
}

function applyTransaction(workspace, requestPath, planHash, options = {}) {
  let built;
  try {
    built = buildPlan(workspace, requestPath, options);
  } catch (error) {
    throw managerError('KNOWLEDGE_PLAN_STALE', `prepared transaction can no longer be reproduced: ${error.message}`, {
      causeCode: error.code || null,
    });
  }
  if (typeof planHash !== 'string' || built.publicPlan.planHash !== planHash) {
    throw managerError('KNOWLEDGE_PLAN_STALE', 'knowledge or draft content changed after the transaction was prepared');
  }
  const backup = createBackup(built, options);
  try {
    commitPlan(built);
    if (options.interruptAfter === 'writes') {
      throw managerError('KNOWLEDGE_TRANSACTION_INTERRUPTED', 'transaction interrupted after knowledge writes');
    }
    const validated = validateKnowledgeRoot(built.resolved.knowledgeRoot, options);
    const result = {
      schemaVersion: 1,
      status: 'APPLIED',
      workspace: built.resolved.root,
      transactionId: backup.transactionId,
      backupPath: backup.backupPath,
      planHash,
      changes: built.publicPlan.changes,
      validation: {
        ...validated.summary,
        warningCount: validated.warnings.length,
        warnings: validated.warnings,
      },
    };
    writeJson(path.join(backup.backupPath, 'result.json'), result);
    return result;
  } catch (error) {
    try {
      restoreBackup(built, backup);
    } catch (restoreError) {
      throw managerError('KNOWLEDGE_ROLLBACK_FAILED', `transaction failed and rollback failed: ${restoreError.message}`, {
        originalCode: error.code || null,
        backupPath: backup.backupPath,
      });
    }
    throw error;
  }
}

module.exports = { applyTransaction, prepareTransaction };

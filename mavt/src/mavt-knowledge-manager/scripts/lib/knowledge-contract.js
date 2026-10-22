'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { managerError } = require('./errors');

const KNOWLEDGE_CONTRACT_VERSION = 1;
const MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024;
const SECTION_NAMES = Object.freeze(['适用范围', '可观察现象', '结论与处理建议', '追溯信息']);
const LIST_META_FIELDS = new Set(['app', 'platform', 'version', 'page', 'operation', 'conflictsWith']);
const PLATFORM_VALUES = new Set(['harmony', 'android', 'ios']);
const APP_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const VERSION_EXACT_PATTERN = /^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9._-]+)?$/;
const VERSION_WILDCARD_PATTERN = /^\d+(?:\.\d+)*\.(?:x|\*)$/i;
const VERSION_RANGE_PATTERN = /^\d+(?:\.\d+)*\s*-\s*\d+(?:\.\d+)*$/;
const META_FIELDS = Object.freeze({
  app: 'app',
  platform: 'platform',
  version: 'version',
  page: 'page',
  operation: 'operation',
  'valid until': 'validUntil',
  'conflicts with': 'conflictsWith',
});

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function contentSha(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function splitValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isVersionExpression(value) {
  const normalized = String(value).trim();
  return VERSION_EXACT_PATTERN.test(normalized)
    || VERSION_WILDCARD_PATTERN.test(normalized)
    || VERSION_RANGE_PATTERN.test(normalized);
}

function parseMetadata(scope) {
  const metadata = {};
  for (const line of scope.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
    if (!match) continue;
    const field = META_FIELDS[normalizeText(match[1])];
    if (!field) continue;
    metadata[field] = LIST_META_FIELDS.has(field) ? splitValues(match[2]) : match[2].trim();
  }
  for (const appId of metadata.app || []) {
    if (!APP_ID_PATTERN.test(appId)) {
      throw managerError('KNOWLEDGE_ENTRY_INVALID', `App must use a stable appId: ${appId}`);
    }
  }
  for (const platform of metadata.platform || []) {
    if (!PLATFORM_VALUES.has(normalizeText(platform))) {
      throw managerError('KNOWLEDGE_ENTRY_INVALID', `Platform must be harmony, android, or ios: ${platform}`);
    }
  }
  for (const version of metadata.version || []) {
    if (!isVersionExpression(version)) {
      throw managerError('KNOWLEDGE_ENTRY_INVALID', `Version is invalid: ${version}`);
    }
  }
  if (metadata.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(metadata.validUntil)) {
    throw managerError('KNOWLEDGE_ENTRY_INVALID', 'Valid until must use YYYY-MM-DD');
  }
  for (const conflictId of metadata.conflictsWith || []) {
    if (!/^K-[A-Za-z0-9][A-Za-z0-9._-]{0,125}$/.test(conflictId)) {
      throw managerError('KNOWLEDGE_ENTRY_INVALID', `Conflicts with must contain a valid K- ID: ${conflictId}`);
    }
  }
  return metadata;
}

function parseKnowledgeEntry(content, source = {}) {
  if (typeof content !== 'string' || !content.trim()) {
    throw managerError('KNOWLEDGE_ENTRY_INVALID', 'knowledge content must be a non-empty string');
  }
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const titleMatch = lines[0]?.match(/^#\s+(K-[A-Za-z0-9][A-Za-z0-9._-]{0,125})\s+(.+?)\s*$/);
  if (!titleMatch) {
    throw managerError('KNOWLEDGE_ENTRY_INVALID', 'first line must be "# K-id title"');
  }
  const sections = {};
  const seen = [];
  let current = null;
  for (const line of lines.slice(1)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (!SECTION_NAMES.includes(current) || sections[current] !== undefined) {
        throw managerError('KNOWLEDGE_ENTRY_INVALID', `unsupported or duplicate section: ${current}`);
      }
      sections[current] = [];
      seen.push(current);
    } else if (current) {
      sections[current].push(line);
    } else if (line.trim()) {
      throw managerError('KNOWLEDGE_ENTRY_INVALID', 'content before the first fixed section is not allowed');
    }
  }
  if (JSON.stringify(seen) !== JSON.stringify(SECTION_NAMES)) {
    throw managerError('KNOWLEDGE_ENTRY_INVALID', `sections must be present in order: ${SECTION_NAMES.join(', ')}`);
  }
  const normalizedSections = {};
  for (const name of SECTION_NAMES) {
    const value = sections[name].join('\n').trim();
    if (!value) throw managerError('KNOWLEDGE_ENTRY_INVALID', `${name} must not be empty`);
    normalizedSections[name] = value;
  }
  return {
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    entryId: titleMatch[1],
    title: titleMatch[2].trim(),
    contentSha: contentSha(content),
    metadata: parseMetadata(normalizedSections['适用范围']),
    sections: normalizedSections,
    relativePath: source.relativePath || null,
    absolutePath: source.absolutePath || null,
    content,
  };
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw managerError('KNOWLEDGE_PATH_INVALID', `knowledge path must be inside ${resolvedRoot}`);
  }
  return { resolvedTarget, relative: relative.replace(/\\/g, '/') };
}

function walkMarkdown(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw managerError('KNOWLEDGE_ROOT_INVALID', `knowledge root is not a directory: ${root}`);
  }
  const files = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw managerError('KNOWLEDGE_PATH_INVALID', `symbolic links are not allowed: ${target}`);
      }
      if (stat.isDirectory()) walk(target);
      else if (stat.isFile() && path.extname(name).toLowerCase() === '.md') files.push(target);
    }
  }
  walk(path.resolve(root));
  return files;
}

function loadKnowledgeEntries(knowledgeRoot) {
  const entries = [];
  const ids = new Map();
  for (const file of walkMarkdown(knowledgeRoot)) {
    const { resolvedTarget, relative } = assertInside(knowledgeRoot, file);
    const stat = fs.statSync(resolvedTarget);
    if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) {
      throw managerError('KNOWLEDGE_ENTRY_TOO_LARGE', `${relative} exceeds ${MAX_KNOWLEDGE_FILE_BYTES} bytes`);
    }
    const entry = parseKnowledgeEntry(fs.readFileSync(resolvedTarget, 'utf8'), {
      relativePath: relative,
      absolutePath: resolvedTarget,
    });
    if (ids.has(entry.entryId)) {
      throw managerError('KNOWLEDGE_ENTRY_DUPLICATE', `${entry.entryId} appears in ${ids.get(entry.entryId)} and ${relative}`);
    }
    ids.set(entry.entryId, relative);
    entries.push(entry);
  }
  return entries.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function isExpired(validUntil, now = new Date()) {
  if (!validUntil) return false;
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw managerError('KNOWLEDGE_TIME_INVALID', `invalid validation time: ${now}`);
  return validUntil < date.toISOString().slice(0, 10);
}

function warning(code, entry, field, message) {
  return { code, entryId: entry.entryId, field, message };
}

function authoringWarnings(entry, options = {}) {
  const warnings = [];
  if (!(entry.metadata.app || []).length) {
    warnings.push(warning('KNOWLEDGE_SCOPE_APP_MISSING', entry, 'App', 'App scope is not declared'));
  }
  if (!(entry.metadata.platform || []).length) {
    warnings.push(warning('KNOWLEDGE_SCOPE_PLATFORM_MISSING', entry, 'Platform', 'Platform scope is not declared'));
  }
  if (isExpired(entry.metadata.validUntil, options.now)) {
    warnings.push(warning('KNOWLEDGE_ENTRY_EXPIRED', entry, 'Valid until', `entry expired on ${entry.metadata.validUntil}`));
  }
  const symptom = normalizeText(entry.sections['可观察现象']).replace(/[\s，。；、,.!?！？：:]/g, '');
  if (symptom.length < 12) {
    warnings.push(warning('KNOWLEDGE_SYMPTOM_TOO_SHORT', entry, '可观察现象', 'observable symptom is shorter than 12 characters'));
  }
  const distinctive = symptom.replace(/页面|界面|显示|正常|内容|当前|出现|可见|存在|没有|未展示|入口|按钮/g, '');
  if (distinctive.length < 4) {
    warnings.push(warning('KNOWLEDGE_SYMPTOM_GENERIC', entry, '可观察现象', 'observable symptom lacks a distinctive business term'));
  }
  if (!/\b\d{4}-\d{2}-\d{2}\b/.test(entry.sections['追溯信息'])) {
    warnings.push(warning('KNOWLEDGE_TRACE_DATE_MISSING', entry, '追溯信息', 'traceability does not contain a YYYY-MM-DD date'));
  }
  return warnings;
}

function validateKnowledgeEntries(entries, options = {}) {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.entryId)) {
      throw managerError('KNOWLEDGE_ENTRY_DUPLICATE', `duplicate knowledge entry ID: ${entry.entryId}`);
    }
    ids.add(entry.entryId);
  }
  for (const entry of entries) {
    for (const conflictId of entry.metadata.conflictsWith || []) {
      if (conflictId === entry.entryId) {
        throw managerError('KNOWLEDGE_CONFLICT_REFERENCE_INVALID', `${entry.entryId} cannot conflict with itself`);
      }
      if (!ids.has(conflictId)) {
        throw managerError('KNOWLEDGE_CONFLICT_REFERENCE_INVALID', `${entry.entryId} references missing conflict entry ${conflictId}`);
      }
    }
  }
  return {
    entryCount: entries.length,
    expiredCount: entries.filter((entry) => isExpired(entry.metadata.validUntil, options.now)).length,
  };
}

function validateKnowledgeRoot(knowledgeRoot, options = {}) {
  const entries = loadKnowledgeEntries(knowledgeRoot);
  return {
    entries,
    summary: validateKnowledgeEntries(entries, options),
    warnings: entries.flatMap((entry) => authoringWarnings(entry, options)),
  };
}

module.exports = {
  KNOWLEDGE_CONTRACT_VERSION,
  MAX_KNOWLEDGE_FILE_BYTES,
  SECTION_NAMES,
  authoringWarnings,
  contentSha,
  isExpired,
  loadKnowledgeEntries,
  parseKnowledgeEntry,
  validateKnowledgeEntries,
  validateKnowledgeRoot,
};

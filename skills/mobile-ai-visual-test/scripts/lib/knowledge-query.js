'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { contractError, ensureArray, ensureId, ensureObject, ensureString } = require('./contract-utils');

const MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024;
const MAX_KNOWLEDGE_CANDIDATES = 5;
const ROOT_NAMESPACES = Object.freeze(['skill', 'workspace']);
const SECTION_NAMES = Object.freeze(['适用范围', '可观察现象', '结论与处理建议', '追溯信息']);
const QUERY_FIELDS = Object.freeze(['platform', 'app', 'version', 'page', 'operation', 'symptom']);
const FIELD_WEIGHTS = Object.freeze({ platform: 12, app: 10, version: 8, page: 8, operation: 6, symptom: 6 });
const LIST_META_FIELDS = new Set(['app', 'platform', 'version', 'page', 'operation', 'conflictsWith']);
const EXACT_META_FIELDS = new Set(['app', 'platform']);
const APP_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const META_FIELDS = Object.freeze({
  app: 'app', platform: 'platform', version: 'version', page: 'page', operation: 'operation',
  'valid until': 'validUntil', 'conflicts with': 'conflictsWith',
});

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function splitValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function contentSha(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function assertInside(root, target, label = 'knowledge path') {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError('KNOWLEDGE_PATH_INVALID', `${label} must be inside ${resolvedRoot}`);
  }
  return { resolved, relative: relative.replace(/\\/g, '/') };
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
  if (metadata.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(metadata.validUntil)) {
    throw contractError('KNOWLEDGE_ENTRY_INVALID', 'Valid until must use YYYY-MM-DD');
  }
  for (const id of metadata.conflictsWith || []) ensureId(id, 'Conflicts with item', 'KNOWLEDGE_ENTRY_INVALID');
  for (const appId of metadata.app || []) {
    if (!APP_ID_PATTERN.test(appId)) {
      throw contractError('KNOWLEDGE_ENTRY_INVALID', `App must use a stable appId such as com.example.app: ${appId}`);
    }
  }
  return metadata;
}

function parseKnowledgeEntry(content, options = {}) {
  ensureString(content, 'knowledge content', 'KNOWLEDGE_ENTRY_INVALID');
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const titleMatch = lines[0]?.match(/^#\s+(K-[A-Za-z0-9][A-Za-z0-9._-]{0,125})\s+(.+?)\s*$/);
  if (!titleMatch) throw contractError('KNOWLEDGE_ENTRY_INVALID', 'first line must be "# K-id title"');
  const sections = {};
  let current = null;
  const seen = [];
  for (const line of lines.slice(1)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (!SECTION_NAMES.includes(current) || sections[current] !== undefined) {
        throw contractError('KNOWLEDGE_ENTRY_INVALID', `unsupported or duplicate section: ${current}`);
      }
      sections[current] = [];
      seen.push(current);
    } else if (current) {
      sections[current].push(line);
    } else if (line.trim()) {
      throw contractError('KNOWLEDGE_ENTRY_INVALID', 'content before the first fixed section is not allowed');
    }
  }
  if (JSON.stringify(seen) !== JSON.stringify(SECTION_NAMES)) {
    throw contractError('KNOWLEDGE_ENTRY_INVALID', `sections must be present in order: ${SECTION_NAMES.join(', ')}`);
  }
  const normalizedSections = {};
  for (const name of SECTION_NAMES) {
    const value = sections[name].join('\n').trim();
    if (!value) throw contractError('KNOWLEDGE_ENTRY_INVALID', `${name} must not be empty`);
    normalizedSections[name] = value;
  }
  const metadata = parseMetadata(normalizedSections['适用范围']);
  return {
    entryId: titleMatch[1],
    title: titleMatch[2].trim(),
    contentSha: contentSha(content),
    metadata,
    sections: normalizedSections,
    sourceNamespace: options.sourceNamespace,
    relativePath: options.relativePath,
    content,
  };
}

function walkMarkdown(root) {
  if (!fs.existsSync(root)) return [];
  if (!fs.statSync(root).isDirectory()) throw contractError('KNOWLEDGE_ROOT_INVALID', `knowledge root is not a directory: ${root}`);
  const files = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw contractError('KNOWLEDGE_PATH_INVALID', `symbolic links are not allowed: ${target}`);
      if (stat.isDirectory()) walk(target);
      else if (stat.isFile() && path.extname(name).toLowerCase() === '.md') files.push(target);
    }
  }
  walk(path.resolve(root));
  return files;
}

function loadKnowledgeEntries(roots) {
  ensureArray(roots, 'knowledge roots', 'KNOWLEDGE_ROOT_INVALID');
  if (roots.length !== ROOT_NAMESPACES.length) throw contractError('KNOWLEDGE_ROOT_INVALID', 'exactly Skill and workspace roots are required');
  const entries = [];
  const ids = new Map();
  roots.forEach((root, index) => {
    ensureString(root, `knowledgeRoots[${index}]`, 'KNOWLEDGE_ROOT_INVALID');
    for (const file of walkMarkdown(root)) {
      const { relative } = assertInside(root, file);
      const stat = fs.statSync(file);
      if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) throw contractError('KNOWLEDGE_ENTRY_TOO_LARGE', `${relative} exceeds ${MAX_KNOWLEDGE_FILE_BYTES} bytes`);
      const entry = parseKnowledgeEntry(fs.readFileSync(file, 'utf8'), { sourceNamespace: ROOT_NAMESPACES[index], relativePath: relative });
      if (ids.has(entry.entryId)) throw contractError('KNOWLEDGE_ENTRY_DUPLICATE', `${entry.entryId} appears in ${ids.get(entry.entryId)} and ${entry.sourceNamespace}/${relative}`);
      ids.set(entry.entryId, `${entry.sourceNamespace}/${relative}`);
      entries.push(entry);
    }
  });
  return entries;
}

function validateKnowledgeRoots(roots, options = {}) {
  const entries = loadKnowledgeEntries(roots);
  const ids = new Set(entries.map((entry) => entry.entryId));
  for (const entry of entries) {
    for (const conflictId of entry.metadata.conflictsWith || []) {
      if (!ids.has(conflictId)) throw contractError('KNOWLEDGE_CONFLICT_REFERENCE_INVALID', `${entry.entryId} references missing conflict entry ${conflictId}`);
      if (conflictId === entry.entryId) throw contractError('KNOWLEDGE_CONFLICT_REFERENCE_INVALID', `${entry.entryId} cannot conflict with itself`);
    }
  }
  const now = options.now || new Date();
  return {
    schemaVersion: 1,
    valid: true,
    entryCount: entries.length,
    expiredCount: entries.filter((entry) => isExpired(entry.metadata.validUntil, now)).length,
    roots: roots.map((root, index) => ({ namespace: ROOT_NAMESPACES[index], path: path.resolve(root) })),
  };
}

function normalizeQuery(value) {
  ensureObject(value, 'knowledge query', 'KNOWLEDGE_QUERY_INVALID');
  const query = {};
  for (const field of QUERY_FIELDS) {
    if (value[field] !== undefined && value[field] !== null && String(value[field]).trim()) query[field] = String(value[field]).trim();
  }
  query.keywords = value.keywords === undefined ? [] : ensureArray(value.keywords, 'keywords', 'KNOWLEDGE_QUERY_INVALID').map((item, index) => ensureString(item, `keywords[${index}]`, 'KNOWLEDGE_QUERY_INVALID').trim());
  if (!QUERY_FIELDS.some((field) => query[field]) && query.keywords.length === 0) throw contractError('KNOWLEDGE_QUERY_INVALID', 'at least one query field is required');
  return query;
}

function fieldText(entry, field) {
  if (field === 'symptom') return entry.sections['可观察现象'];
  const value = entry.metadata[field];
  return Array.isArray(value) ? value.join(' ') : value || entry.sections['适用范围'];
}

function versionMatches(actual, declared) {
  const query = normalizeText(actual);
  const declaredValues = Array.isArray(declared) ? declared : splitValues(declared);
  return declaredValues.some((value) => {
    const pattern = normalizeText(value);
    if (pattern === query || pattern.includes(query) || query.includes(pattern)) return true;
    if (/[x*]/.test(pattern)) {
      const expression = new RegExp(`^${pattern.split(/[x*]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+')}([.-].*)?$`);
      return expression.test(query);
    }
    const range = pattern.match(/^(\d+(?:\.\d+)*)\s*-\s*(\d+(?:\.\d+)*)$/);
    if (range) {
      const numbers = (value) => value.split('.').map(Number);
      const compare = (left, right) => {
        const length = Math.max(left.length, right.length);
        for (let index = 0; index < length; index += 1) {
          const delta = (left[index] || 0) - (right[index] || 0);
          if (delta) return delta;
        }
        return 0;
      };
      const target = numbers(query);
      return target.every(Number.isFinite) && compare(target, numbers(range[1])) >= 0 && compare(target, numbers(range[2])) <= 0;
    }
    return false;
  });
}

function metadataValueMatches(field, actualValue, declaredValue) {
  if (field === 'version') return versionMatches(actualValue, declaredValue);
  const actual = normalizeText(actualValue);
  const expected = normalizeText(declaredValue);
  if (EXACT_META_FIELDS.has(field)) return actual === expected;
  return actual === expected || actual.includes(expected) || expected.includes(actual);
}

function matchScore(entry, query) {
  let metadataScore = 0;
  let lexicalScore = 0;
  const matched = [];
  for (const field of ['platform', 'app', 'version', 'page', 'operation']) {
    if (!query[field]) continue;
    const declared = entry.metadata[field];
    const values = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
    if (values.some((value) => metadataValueMatches(field, query[field], value))) {
      metadataScore += FIELD_WEIGHTS[field];
      matched.push(field);
    }
  }
  if (query.symptom) {
    const needle = normalizeText(query.symptom);
    const haystack = normalizeText(entry.sections['可观察现象']);
    if (haystack.includes(needle) || needle.includes(haystack)) {
      lexicalScore += FIELD_WEIGHTS.symptom;
      matched.push('symptom');
    }
  }
  const searchable = normalizeText([entry.title, ...Object.values(entry.sections)].join('\n'));
  for (const keyword of query.keywords) {
    if (searchable.includes(normalizeText(keyword))) {
      lexicalScore += 2;
      matched.push(`keyword:${keyword}`);
    }
  }
  return { score: metadataScore + lexicalScore, metadataScore, lexicalScore, matched };
}

function metadataCompatible(entry, query) {
  let declaredMatches = 0;
  const mismatches = [];
  for (const field of ['platform', 'app', 'version', 'page', 'operation']) {
    if (!query[field] || entry.metadata[field] === undefined) continue;
    const declared = entry.metadata[field];
    const values = Array.isArray(declared) ? declared : [declared];
    if (values.some((value) => metadataValueMatches(field, query[field], value))) declaredMatches += 1;
    else mismatches.push({ field, query: query[field], declared: values });
  }
  return { compatible: mismatches.length === 0, declaredMatches, mismatches };
}

function snippet(text, needles, limit = 180) {
  const compact = String(text).replace(/\s+/g, ' ').trim();
  const normalized = normalizeText(compact);
  const index = needles.map((item) => normalized.indexOf(normalizeText(item))).filter((item) => item >= 0).sort((a, b) => a - b)[0] || 0;
  const start = Math.max(index - 40, 0);
  const value = compact.slice(start, start + limit);
  return `${start > 0 ? '...' : ''}${value}${start + limit < compact.length ? '...' : ''}`;
}

function isExpired(validUntil, now) {
  if (!validUntil) return false;
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  return validUntil < today;
}

function queryKnowledge(options) {
  const query = normalizeQuery(options.query || {});
  const now = options.now || new Date();
  const needles = [...QUERY_FIELDS.map((field) => query[field]).filter(Boolean), ...query.keywords];
  const evaluated = loadKnowledgeEntries(options.roots).map((entry) => {
    const match = matchScore(entry, query);
    const compatibility = metadataCompatible(entry, query);
    const candidate = {
      entryId: entry.entryId,
      title: entry.title,
      sourceNamespace: entry.sourceNamespace,
      relativePath: entry.relativePath,
      contentSha: entry.contentSha,
      score: match.score,
      matched: match.matched,
      validUntil: entry.metadata.validUntil || null,
      expired: isExpired(entry.metadata.validUntil, now),
      conflictsWith: entry.metadata.conflictsWith || [],
      metadata: {
        app: entry.metadata.app || [],
        platform: entry.metadata.platform || [],
        version: entry.metadata.version || [],
        page: entry.metadata.page || [],
        operation: entry.metadata.operation || [],
        validUntil: entry.metadata.validUntil || null,
        conflictsWith: entry.metadata.conflictsWith || [],
      },
      applicability: entry.sections['适用范围'],
      traceability: entry.sections['追溯信息'],
      snippets: [
        snippet(entry.sections['可观察现象'], needles),
        snippet(entry.sections['结论与处理建议'], needles),
      ],
    };
    if (options.includeContent === true) candidate.snapshotContent = entry.content;
    return { candidate, match, compatibility };
  });
  const ranked = evaluated.filter((item) => item.compatibility.compatible);
  const lexicalMatches = ranked.filter((item) => item.match.lexicalScore > 0);
  const eligible = (lexicalMatches.length > 0
    ? lexicalMatches
    : ranked.filter((item) => item.compatibility.declaredMatches > 0))
    .sort((a, b) => b.match.score - a.match.score || a.candidate.entryId.localeCompare(b.candidate.entryId));
  const candidates = eligible.slice(0, MAX_KNOWLEDGE_CANDIDATES).map((item) => item.candidate);
  const rejected = evaluated.filter((item) => !item.compatibility.compatible);
  const excludedBy = {};
  for (const item of rejected) {
    for (const mismatch of item.compatibility.mismatches) {
      excludedBy[mismatch.field] = (excludedBy[mismatch.field] || 0) + 1;
    }
  }
  const eligibleIds = new Set(eligible.map((item) => item.candidate.entryId));
  const filterDiagnostics = candidates.length === 0 ? {
    scannedCount: evaluated.length,
    compatibleCount: ranked.length,
    eligibleCount: eligible.length,
    noRelevantMatchCount: ranked.filter((item) => !eligibleIds.has(item.candidate.entryId)).length,
    excludedBy,
    rejected: rejected.slice(0, MAX_KNOWLEDGE_CANDIDATES).map((item) => ({
      entryId: item.candidate.entryId,
      title: item.candidate.title,
      mismatches: item.compatibility.mismatches,
    })),
  } : null;
  return {
    schemaVersion: 1,
    query,
    candidates,
    candidateCount: candidates.length,
    truncated: eligible.length > candidates.length,
    filterDiagnostics,
  };
}

module.exports = {
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_CANDIDATES,
  QUERY_FIELDS,
  ROOT_NAMESPACES,
  SECTION_NAMES,
  assertInside,
  contentSha,
  loadKnowledgeEntries,
  normalizeQuery,
  parseKnowledgeEntry,
  queryKnowledge,
  validateKnowledgeRoots,
  versionMatches,
};

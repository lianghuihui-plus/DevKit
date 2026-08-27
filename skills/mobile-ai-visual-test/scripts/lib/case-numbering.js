'use strict';

const fs = require('fs');
const path = require('path');
const { caseContractSha, validateCaseContract } = require('../execution/contracts/case-contract');
const { writeJsonAtomic } = require('./execution-lifecycle');

const CASE_NO_PATTERN = /^\d{3,}$/;

function normalizeCaseNo(value) {
  const match = String(value ?? '').trim().match(/^(?:C)?(\d+)$/i);
  if (!match || Number(match[1]) < 1) return null;
  return String(Number(match[1])).padStart(3, '0');
}

function preferredCaseNo(title) {
  const match = String(title || '').trim().match(/^(\d+)(?:\D|$)/);
  return match ? normalizeCaseNo(match[1]) : null;
}

function currentCaseRecords(workspaceRoot) {
  const root = path.join(path.resolve(workspaceRoot), 'cases');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().map((name) => {
    const caseDir = path.join(root, name);
    if (!fs.statSync(caseDir).isDirectory()) return null;
    const casePath = path.join(caseDir, 'case.json');
    if (!fs.existsSync(casePath)) return null;
    try {
      const caseJson = JSON.parse(fs.readFileSync(casePath, 'utf8'));
      if (caseJson?.schemaVersion !== 2 || !caseJson.identity?.caseKey) return null;
      validateCaseContract(caseJson);
      return { caseDir, casePath, caseJson };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function withCaseNo(caseJson, caseNo) {
  const value = { ...caseJson, identity: { ...caseJson.identity, caseNo } };
  value.contractSha = caseContractSha(value);
  return validateCaseContract(value);
}

function ensureWorkspaceCaseNumbers(workspaceRoot) {
  const records = currentCaseRecords(workspaceRoot);
  const used = new Set();
  const pending = [];
  let max = 0;

  for (const record of records) {
    const normalized = normalizeCaseNo(record.caseJson.identity.caseNo);
    if (normalized && !used.has(normalized)) {
      used.add(normalized);
      max = Math.max(max, Number(normalized));
      if (record.caseJson.identity.caseNo !== normalized) pending.push({ ...record, assigned: normalized });
    } else {
      pending.push({ ...record, preferred: preferredCaseNo(record.caseJson.identity.title) });
    }
  }

  const assigned = [];
  for (const record of pending) {
    let caseNo = record.assigned || record.preferred;
    if (!record.assigned && (!caseNo || used.has(caseNo))) {
      do { max += 1; caseNo = String(max).padStart(3, '0'); } while (used.has(caseNo));
    }
    used.add(caseNo);
    max = Math.max(max, Number(caseNo));
    const caseJson = withCaseNo(record.caseJson, caseNo);
    writeJsonAtomic(record.casePath, caseJson);
    assigned.push({ caseNo, caseKey: caseJson.identity.caseKey, caseDir: record.caseDir });
  }

  return {
    changed: assigned.length > 0,
    assigned,
    cases: currentCaseRecords(workspaceRoot).map((record) => ({
      caseNo: record.caseJson.identity.caseNo,
      caseKey: record.caseJson.identity.caseKey,
      title: record.caseJson.identity.title,
      caseDir: record.caseDir,
    })),
  };
}

function nextCaseNo(workspaceRoot, title = '') {
  const catalog = ensureWorkspaceCaseNumbers(workspaceRoot).cases;
  const used = new Set(catalog.map((item) => item.caseNo));
  const preferred = preferredCaseNo(title);
  if (preferred && !used.has(preferred)) return preferred;
  const max = catalog.reduce((value, item) => Math.max(value, Number(item.caseNo) || 0), 0);
  return String(max + 1).padStart(3, '0');
}

function resolveCaseNo(workspaceRoot, value) {
  const caseNo = normalizeCaseNo(value);
  if (!caseNo || !CASE_NO_PATTERN.test(caseNo)) return null;
  const matches = ensureWorkspaceCaseNumbers(workspaceRoot).cases.filter((item) => item.caseNo === caseNo);
  return matches.length === 1 ? matches[0] : null;
}

module.exports = {
  CASE_NO_PATTERN,
  ensureWorkspaceCaseNumbers,
  nextCaseNo,
  normalizeCaseNo,
  resolveCaseNo,
  withCaseNo,
};

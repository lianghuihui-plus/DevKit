#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { canonicalJson } = require('./execution-environment');

function normalizePreconditionInputs(plan, value = []) {
  if (!Array.isArray(value)) throw new Error('PRECONDITION_INPUT_INVALID: precondition inputs must be an array');
  const planById = new Map((plan?.preconditions || []).map((item) => [item.id, item]));
  const seen = new Set();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !String(raw.id || '').trim()) {
      throw new Error('PRECONDITION_INPUT_INVALID: every input requires an id');
    }
    if (seen.has(raw.id)) throw new Error(`PRECONDITION_INPUT_INVALID: duplicated input ${raw.id}`);
    seen.add(raw.id);
    const planned = planById.get(raw.id);
    if (!planned) throw new Error(`PRECONDITION_INPUT_INVALID: unknown precondition ${raw.id}`);
    if (!['confirm', 'external_setup'].includes(planned.resolution)) {
      throw new Error(`PRECONDITION_INPUT_INVALID: ${planned.resolution} precondition cannot accept external input: ${raw.id}`);
    }
    if (raw.resolution && raw.resolution !== planned.resolution) {
      throw new Error(`PRECONDITION_INPUT_INVALID: resolution mismatch for ${raw.id}`);
    }
    const expectedStatus = planned.resolution === 'confirm' ? 'PASS' : 'PREPARED';
    if (raw.status !== expectedStatus) {
      throw new Error(`PRECONDITION_INPUT_INVALID: ${planned.resolution} ${raw.id} requires ${expectedStatus}`);
    }
    if (!String(raw.reason || '').trim()) throw new Error(`PRECONDITION_INPUT_INVALID: ${raw.id} requires reason`);
    return { id: raw.id, resolution: planned.resolution, status: expectedStatus, reason: String(raw.reason).trim() };
  });
}

function preconditionInputsSha(value) {
  return `precondition-inputs-${crypto.createHash('sha256').update(canonicalJson(value || [])).digest('hex').slice(0, 16)}`;
}

function validateFrozenPreconditionInputs(execution) {
  if (!Array.isArray(execution?.preconditionInputs) || !/^precondition-inputs-[0-9a-f]{16}$/.test(execution.preconditionInputsSha || '')) {
    throw new Error('PRECONDITION_INPUT_INVALID: execution does not contain frozen precondition inputs');
  }
  const normalized = normalizePreconditionInputs(execution.preconditionPlan, execution.preconditionInputs);
  if (preconditionInputsSha(normalized) !== execution.preconditionInputsSha) {
    throw new Error('PRECONDITION_INPUT_CHANGED: precondition input hash mismatch');
  }
  return normalized;
}

module.exports = { normalizePreconditionInputs, preconditionInputsSha, validateFrozenPreconditionInputs };

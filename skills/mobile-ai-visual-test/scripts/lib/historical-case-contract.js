#!/usr/bin/env node
'use strict';

// Read-only compatibility for reports created by the retired fixed-step pipeline.

const crypto = require('crypto');

const VALID_RULE_STATUSES = new Set(['MATCHED', 'SKIPPED', 'HANDLED', 'FAILED', 'BLOCKED', 'UNKNOWN']);
const VALID_RULE_TYPES = new Set(['guard']);
const VALID_RULE_FAILURES = new Set(['BLOCKED', 'UNKNOWN', 'FAIL']);
const VALID_RULE_ACTIONS = new Set(['tap', 'toggle', 'longPress', 'wait', 'back', 'home']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contractError(code, reason) {
  const error = new Error(`${code}: ${reason}`);
  error.failureCode = code;
  return error;
}

function normalizeCaseContract(caseJson = {}) {
  const normalized = { ...caseJson };
  delete normalized.isolation;
  normalized.globalRules = Array.isArray(normalized.globalRules)
    ? normalized.globalRules.map((rule, index) => ({
      ...rule,
      id: rule?.id || `rule-${String(index + 1).padStart(3, '0')}`,
      type: rule?.type || 'guard',
      scope: rule?.scope || 'system_popup',
      appliesTo: rule?.appliesTo || 'any_step',
      priority: Number(rule?.priority ?? (100 - index)),
      maxAttempts: Number(rule?.maxAttempts ?? 1),
      onFailure: String(rule?.onFailure || 'BLOCKED').toUpperCase(),
    }))
    : [];
  normalized.steps = Array.isArray(normalized.steps)
    ? normalized.steps.map((step) => step?.goal === 'input_text'
      ? { ...step, inputMode: step.inputMode || 'replace' }
      : step)
    : normalized.steps;
  return normalized;
}

function validateRuleThen(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.then 必须是对象。`);
  }
  const action = value.action;
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.then.action 必须是对象。`);
  }
  if (!VALID_RULE_ACTIONS.has(action.type)) {
    throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.then.action.type 不支持: ${action.type || 'unknown'}。`);
  }
  if (['tap', 'toggle', 'longPress'].includes(action.type) && !String(action.target || '').trim()) {
    throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.then.action.target 不能为空。`);
  }
  if (action.type === 'wait' && (!Number.isInteger(Number(action.ms)) || Number(action.ms) < 0)) {
    throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.then.action.ms 必须是非负整数。`);
  }
}

function validateGlobalRules(caseJson = {}) {
  const rules = caseJson.globalRules || [];
  if (!Array.isArray(rules)) throw contractError('CASE_GLOBAL_RULE_INVALID', 'globalRules 必须是数组。');
  const ids = new Set();
  for (const [index, rule] of rules.entries()) {
    const label = `globalRules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label} 必须是对象。`);
    if (!String(rule.id || '').trim()) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.id 不能为空。`);
    if (ids.has(rule.id)) throw contractError('CASE_GLOBAL_RULE_INVALID', `规则 id 重复: ${rule.id}。`);
    ids.add(rule.id);
    if (!VALID_RULE_TYPES.has(rule.type)) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.type 必须是 guard。`);
    if (!String(rule.scope || '').trim()) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.scope 不能为空。`);
    if (rule.appliesTo !== 'any_step' && !(Array.isArray(rule.appliesTo) && rule.appliesTo.length && rule.appliesTo.every((item) => typeof item === 'string'))) {
      throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.appliesTo 必须是 any_step 或非空步骤 id 数组。`);
    }
    if (!String(rule.when || '').trim()) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.when 不能为空。`);
    if (!Number.isFinite(Number(rule.priority))) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.priority 必须是数字。`);
    if (!Number.isInteger(rule.maxAttempts) || rule.maxAttempts < 1) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.maxAttempts 必须是正整数。`);
    if (!VALID_RULE_FAILURES.has(rule.onFailure)) throw contractError('CASE_GLOBAL_RULE_INVALID', `${label}.onFailure 必须是 BLOCKED、UNKNOWN 或 FAIL。`);
    validateRuleThen(rule.then, label);
  }
  return rules;
}

function validateCaseExecutionContract(input = {}) {
  const caseJson = normalizeCaseContract(input);
  if (!caseJson || typeof caseJson !== 'object' || Array.isArray(caseJson)) throw contractError('CASE_CONTRACT_INVALID', 'case.json 必须是对象。');
  if (!caseJson.identity?.caseKey || !caseJson.identity?.sourceSha1) throw contractError('CASE_CONTRACT_INVALID', 'case.json 缺少 identity.caseKey 或 identity.sourceSha1。');
  if (!Array.isArray(caseJson.steps) || caseJson.steps.length === 0) throw contractError('CASE_STEPS_REQUIRED', '用例至少需要一个可执行测试步骤。');
  const ids = new Set();
  for (const [index, step] of caseJson.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw contractError('CASE_CONTRACT_INVALID', `steps[${index}] 必须是对象。`);
    if (!String(step.id || '').trim()) throw contractError('CASE_STEP_ID_REQUIRED', `steps[${index}] 缺少 id。`);
    if (ids.has(step.id)) throw contractError('CASE_STEP_ID_DUPLICATED', `步骤 id 重复: ${step.id}`);
    ids.add(step.id);
    if (Number(step.index) !== index + 1) throw contractError('CASE_STEP_INDEX_INVALID', `${step.id} 的 index 必须为 ${index + 1}。`);
    if (!String(step.sourceText || '').trim()) throw contractError('CASE_STEP_SOURCE_REQUIRED', `${step.id} 缺少 sourceText。`);
    if (step.goal === 'input_text') {
      if (!['replace', 'append'].includes(step.inputMode)) throw contractError('CASE_CONTRACT_INVALID', `${step.id} 的 inputMode 仅支持 replace/append。`);
      if (typeof step.value !== 'string' || !step.value.trim()) throw contractError('CASE_INPUT_VALUE_REQUIRED', `${step.id} 无法从原步骤确定目标输入文本，请使用引号明确输入值。`);
    }
  }
  for (const rule of validateGlobalRules(caseJson)) {
    if (Array.isArray(rule.appliesTo)) {
      for (const stepId of rule.appliesTo) if (!ids.has(stepId)) throw contractError('CASE_GLOBAL_RULE_INVALID', `规则 ${rule.id} 引用了不存在的步骤 ${stepId}。`);
    }
  }
  return caseJson;
}

function caseContractSha(input = {}) {
  const caseJson = normalizeCaseContract(input);
  const contract = {
    schemaVersion: caseJson.schemaVersion || 1,
    parserVersion: caseJson.parserVersion || 1,
    sourceSha1: caseJson.identity?.sourceSha1 || '',
    preconditions: Array.isArray(caseJson.preconditions) ? caseJson.preconditions : [],
    steps: Array.isArray(caseJson.steps) ? caseJson.steps.map((step) => ({
      id: step.id,
      index: step.index,
      kind: step.kind,
      goal: step.goal,
      sourceText: step.sourceText,
      target: step.target,
      value: step.value,
      inputMode: step.inputMode,
      expected: step.expected,
      assertions: Array.isArray(step.assertions) ? step.assertions : [],
      hints: Array.isArray(step.hints) ? step.hints : [],
    })) : [],
    globalRules: Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [],
  };
  return `contract-${crypto.createHash('sha1').update(stableJson(contract)).digest('hex').slice(0, 12)}`;
}

module.exports = {
  VALID_RULE_ACTIONS,
  VALID_RULE_FAILURES,
  VALID_RULE_STATUSES,
  caseContractSha,
  normalizeCaseContract,
  stableJson,
  validateCaseExecutionContract,
  validateGlobalRules,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { contractError, ensureArray, ensureId, ensureObject, ensureString } = require('./contract-utils');

const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const VERDICT_BASES = new Set(['DIRECT_EVIDENCE', 'KNOWLEDGE_SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'TECHNICAL_CONSTRAINT']);
const TRACE_TYPES = new Set([
  'understanding', 'planRevision', 'preparationObservation', 'businessObservation', 'businessAction',
  'knowledgeQuery', 'knowledgeAssessment', 'verdictReview', 'timeLimitStop', 'result',
]);

function validateCondition(value, label) {
  ensureObject(value, label, 'AGENT_EVAL_INVALID');
  if (!TRACE_TYPES.has(value.type)) throw contractError('AGENT_EVAL_INVALID', `${label}.type is invalid`);
  if (value.minimum !== undefined && (!Number.isInteger(value.minimum) || value.minimum < 0)) throw contractError('AGENT_EVAL_INVALID', `${label}.minimum is invalid`);
  if (value.maximum !== undefined && (!Number.isInteger(value.maximum) || value.maximum < 0)) throw contractError('AGENT_EVAL_INVALID', `${label}.maximum is invalid`);
  if (value.where !== undefined) ensureObject(value.where, `${label}.where`, 'AGENT_EVAL_INVALID');
  return value;
}

function validateEvalScenario(value) {
  ensureObject(value, 'eval scenario', 'AGENT_EVAL_INVALID');
  if (value.schemaVersion !== 1) throw contractError('AGENT_EVAL_SCHEMA_UNSUPPORTED', 'eval schemaVersion must be 1');
  ensureId(value.id, 'id', 'AGENT_EVAL_INVALID');
  ensureString(value.title, 'title', 'AGENT_EVAL_INVALID');
  ensureString(value.sourceText, 'sourceText', 'AGENT_EVAL_INVALID');
  ensureString(value.initialState, 'initialState', 'AGENT_EVAL_INVALID');
  ensureArray(value.must, 'must', 'AGENT_EVAL_INVALID').forEach((item, index) => validateCondition(item, `must[${index}]`));
  ensureArray(value.mustNot, 'mustNot', 'AGENT_EVAL_INVALID').forEach((item, index) => validateCondition(item, `mustNot[${index}]`));
  ensureObject(value.outcome, 'outcome', 'AGENT_EVAL_INVALID');
  const verdicts = ensureArray(value.outcome.allowedVerdicts, 'outcome.allowedVerdicts', 'AGENT_EVAL_INVALID');
  const bases = ensureArray(value.outcome.allowedVerdictBases, 'outcome.allowedVerdictBases', 'AGENT_EVAL_INVALID');
  if (!verdicts.length || !verdicts.every((item) => VERDICTS.has(item))) throw contractError('AGENT_EVAL_INVALID', 'allowedVerdicts is invalid');
  if (!bases.length || !bases.every((item) => VERDICT_BASES.has(item))) throw contractError('AGENT_EVAL_INVALID', 'allowedVerdictBases is invalid');
  ensureString(value.outcome.rationale, 'outcome.rationale', 'AGENT_EVAL_INVALID');
  for (const condition of [...value.must, ...value.mustNot]) {
    if (condition.type === 'businessAction' && condition.where && Object.keys(condition.where).some((key) => ['index', 'sequence', 'target'].includes(key))) {
      throw contractError('AGENT_EVAL_FIXED_PATH_FORBIDDEN', 'evals cannot require a fixed action path');
    }
  }
  return value;
}

function matchesWhere(event, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = key.split('.').reduce((value, segment) => value?.[segment], event);
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function evaluateCondition(trace, condition) {
  const matches = trace.filter((event) => event.type === condition.type && matchesWhere(event, condition.where));
  const minimum = condition.minimum === undefined ? 1 : condition.minimum;
  const maximum = condition.maximum === undefined ? Number.POSITIVE_INFINITY : condition.maximum;
  return { passed: matches.length >= minimum && matches.length <= maximum, count: matches.length, minimum, maximum };
}

function evaluateTrace(scenario, trace) {
  validateEvalScenario(scenario);
  ensureArray(trace, 'eval trace', 'AGENT_EVAL_TRACE_INVALID');
  trace.forEach((event, index) => {
    ensureObject(event, `trace[${index}]`, 'AGENT_EVAL_TRACE_INVALID');
    if (!TRACE_TYPES.has(event.type)) throw contractError('AGENT_EVAL_TRACE_INVALID', `trace[${index}].type is invalid`);
  });
  const result = trace.filter((event) => event.type === 'result').at(-1);
  const checks = [
    ...scenario.must.map((condition) => ({ kind: 'must', condition, ...evaluateCondition(trace, condition) })),
    ...scenario.mustNot.map((condition) => {
      const evaluated = evaluateCondition(trace, { ...condition, minimum: 0, maximum: condition.maximum ?? 0 });
      return { kind: 'mustNot', condition, ...evaluated };
    }),
  ];
  const outcomePassed = Boolean(result)
    && scenario.outcome.allowedVerdicts.includes(result.verdict)
    && scenario.outcome.allowedVerdictBases.includes(result.verdictBasis);
  return {
    scenarioId: scenario.id,
    passed: checks.every((item) => item.passed) && outcomePassed,
    checks,
    outcome: { passed: outcomePassed, actual: result || null, expected: scenario.outcome },
  };
}

function traceFromExecution(report) {
  const trace = [];
  for (const event of report.events || []) {
    const mapped = {
      caseUnderstood: 'understanding',
      planRevised: 'planRevision',
      knowledgeQuery: 'knowledgeQuery',
      knowledgeAssessment: 'knowledgeAssessment',
      verdictReview: 'verdictReview',
    }[event.type];
    if (mapped) trace.push({ ...event, type: mapped });
    if (event.type === 'observation') trace.push({ ...event, type: event.scope === 'case-prepare' ? 'preparationObservation' : 'businessObservation' });
    if (event.type === 'actionResult' && event.scope === 'case-business') trace.push({ ...event, type: 'businessAction', actionType: event.requestedAction?.type });
  }
  if (report.metrics?.timeLimitStopped) trace.push({ type: 'timeLimitStop' });
  if (report.result) trace.push({ type: 'result', verdict: report.result.verdict, verdictBasis: report.result.verdictBasis });
  return trace;
}

function loadEvalScenarios(root) {
  const dir = path.resolve(root);
  const scenarios = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    validateEvalScenario(value);
    return value;
  });
  const ids = new Set();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw contractError('AGENT_EVAL_INVALID', `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return scenarios;
}

module.exports = { TRACE_TYPES, evaluateTrace, loadEvalScenarios, traceFromExecution, validateEvalScenario };

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { evaluateTrace, loadEvalScenarios, validateEvalScenario } = require('../lib/agent-eval');

const scenarios = loadEvalScenarios(path.join(__dirname, 'evals'));
assert.strictEqual(scenarios.length, 10);
for (const scenario of scenarios) {
  assert.ok(scenario.must.length > 0);
  assert.ok(scenario.outcome.rationale.length > 0);
}

const direct = scenarios.find((item) => item.id === 'target-page-direct');
const directTrace = [
  { type: 'understanding' }, { type: 'preparationObservation' }, { type: 'businessObservation' },
  { type: 'result', verdict: 'PASS', verdictBasis: 'DIRECT_EVIDENCE' },
];
assert.strictEqual(evaluateTrace(direct, directTrace).passed, true);
assert.strictEqual(evaluateTrace(direct, [...directTrace.slice(0, 3), { type: 'businessAction', actionType: 'tap' }, directTrace[3]]).passed, false);

const wrongPlan = scenarios.find((item) => item.id === 'wrong-plan-correction');
assert.strictEqual(evaluateTrace(wrongPlan, [
  { type: 'planRevision' }, { type: 'planRevision' }, { type: 'businessObservation' },
  { type: 'result', verdict: 'PASS', verdictBasis: 'DIRECT_EVIDENCE' },
]).passed, true);
assert.strictEqual(evaluateTrace(wrongPlan, [
  { type: 'planRevision' }, { type: 'businessObservation' },
  { type: 'result', verdict: 'PASS', verdictBasis: 'DIRECT_EVIDENCE' },
]).passed, false);

assert.throws(() => validateEvalScenario({ ...direct, id: 'fixed-path', must: [{ type: 'businessAction', where: { sequence: 1 } }] }), (error) => error?.code === 'AGENT_EVAL_FIXED_PATH_FORBIDDEN');
assert.throws(() => validateEvalScenario({ ...direct, id: 'bad-verdict', outcome: { ...direct.outcome, allowedVerdicts: ['MAYBE'] } }), (error) => error?.code === 'AGENT_EVAL_INVALID');
console.log('agent-eval passed');

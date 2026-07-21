#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateActionExecution } = require('./lib/action-contract');
const { loadCaseExecutionContext } = require('./lib/case-execution-context');
const { operationClass } = require('./lib/next-work-contract');

const MAX_DETERMINISTIC_TRANSITIONS = 100;

function usage() {
  console.error('Usage: execute-next-work.js <next|decide> <case-dir> --platform <platform> --execution-id <id> [--work-token <token> --decision-json <json>]');
  process.exit(2);
}

function parseArgs(args) {
  if (args.length < 2) usage();
  const options = { command: args[0], caseDir: path.resolve(args[1]) };
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--platform') options.platform = args[++i];
    else if (args[i] === '--execution-id') options.executionId = args[++i];
    else if (args[i] === '--work-token') options.workToken = args[++i];
    else if (args[i] === '--decision-json') options.decision = JSON.parse(args[++i]);
    else usage();
  }
  if (!['next', 'decide'].includes(options.command) || !['harmony', 'android', 'ios'].includes(options.platform) || !options.executionId) usage();
  if (options.command === 'decide' && (!options.workToken || !options.decision)) usage();
  return options;
}

function run(script, args) {
  const command = script.endsWith('.sh') ? path.join(__dirname, script) : process.execPath;
  const commandArgs = script.endsWith('.sh') ? args : [path.join(__dirname, script), ...args];
  return childProcess.execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

function base(options) {
  return [options.caseDir, '--platform', options.platform, '--execution-id', options.executionId];
}

function actionArgs(action) {
  const names = { durationMs: 'duration-ms', fromX: 'from-x', fromY: 'from-y', toX: 'to-x', toY: 'to-y', coordinateSource: 'coordinate-source', targetBounds: 'target-bounds', coordinateEvidence: 'coordinate-evidence' };
  const args = ['--type', action.type];
  for (const [key, value] of Object.entries(action)) {
    if (key === 'type' || value === undefined || value === null) continue;
    args.push(`--${names[key] || key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, Array.isArray(value) ? value.join(',') : String(value));
  }
  return args;
}

function record(options, event) {
  return run('run-case.js', [...base(options), '--record-json', JSON.stringify(event)]);
}

function finalize(options, status, reason, extra = []) {
  return run('run-case.js', [...base(options), '--finalize', '--status', status, '--reason', reason, ...extra]);
}

function flowObservationArgs(options, work) {
  const phase = work.phase || (work.type === 'OBSERVE_FLOW_END' ? 'end-check' : work.type === 'OBSERVE_FLOW_ENTRY' ? 'entry-check' : work.type.endsWith('BEFORE') ? 'before' : 'after');
  const args = ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--scope', 'precondition-flow', '--precondition-id', work.preconditionId, '--flow-id', work.flowId, '--phase', phase];
  if (work.flowStepId) args.push('--flow-step-id', work.flowStepId);
  return args;
}

function executeDeterministic(options, work) {
  if (work.type === 'STOP_FINALIZED') return;
  if (work.type === 'OBSERVE_STEP' || work.type === 'OBSERVE_AFTER_ACTION') {
    run('observe.sh', ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--step-id', work.step.id]);
    return;
  }
  if (work.type.startsWith('OBSERVE_FLOW_')) {
    run('observe.sh', flowObservationArgs(options, work));
    return;
  }
  if (work.type === 'EXECUTE_STEP_ACTION') {
    validateActionExecution(work.requestedAction, { platform: options.platform, context: work.type });
    run('action-observe.sh', ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--step-id', work.step.id, ...actionArgs(work.requestedAction)]);
    return;
  }
  if (work.type === 'RECORD_PRECONDITION') {
    record(options, { type: 'precondition', id: work.preconditionId, status: work.status, reason: work.reason, failureCode: work.failureCode || null });
    return;
  }
  if (work.type === 'RECORD_FLOW_PRECONDITION_TERMINAL') {
    const prepared = work.flowStatus === 'COMPLETED';
    record(options, {
      type: 'precondition',
      id: work.preconditionId,
      status: prepared ? 'PREPARED' : 'BLOCKED',
      resolution: 'flow',
      flowId: work.flowId,
      evidenceObservation: work.evidenceObservation || undefined,
      failureCode: prepared ? null : work.failureCode,
      reason: work.reason || `Precondition flow ${work.flowStatus.toLowerCase()}.`,
    });
    return;
  }
  if (work.type === 'RECORD_FLOW_STEP_COMPLETED') {
    record(options, {
      type: 'flow',
      usage: 'precondition',
      preconditionId: work.preconditionId,
      flowId: work.flowId,
      flowStepId: work.flowStepId,
      status: 'STEP_COMPLETED',
      evidenceObservation: work.latestObservation.label,
      reason: 'Flow step completed with after-action observation.',
    });
    return;
  }
  if (work.type === 'FINALIZE_PASS') {
    finalize(options, 'PASS', work.reason || 'All steps passed.');
    return;
  }
  if (work.type === 'FINALIZE_STEP_FAILURE') {
    finalize(options, work.status, work.reason || 'Step assertion failed.', ['--failed-step', work.stepId]);
    return;
  }
  if (work.type === 'FINALIZE_PRECONDITION_BLOCKED') {
    const status = ['FAIL', 'UNKNOWN', 'BLOCKED'].includes(work.status) ? work.status : 'BLOCKED';
    const extra = work.failureCode ? ['--failure-code', work.failureCode] : [];
    finalize(options, status, `Precondition ${work.preconditionId} is ${work.status}.`, extra);
    return;
  }
  throw new Error(`No deterministic executor for ${work.type}`);
}

function decisionRequest(context) {
  const work = context.nextWork;
  const observation = work.latestObservation || null;
  const common = {
    schemaVersion: 1,
    type: work.type,
    workToken: context.workToken,
    executionId: context.executionId,
    screenshotPath: observation?.screenshotPath || null,
    evidenceRef: observation?.evidenceRef || observation?.screenshot || null,
    layoutPath: observation?.layoutPath || null,
  };
  if (work.type === 'DECIDE_FLOW_ENTRY') return { ...common, preconditionId: work.preconditionId, flowId: work.flowId, startCondition: work.startCondition, endCondition: work.endCondition, allowedOutcomes: ['ALREADY_SATISFIED', 'STARTABLE', 'START_MISMATCH', 'OBSERVATION_UNUSABLE'] };
  if (work.type === 'EXECUTE_FLOW_ACTION') return { ...common, preconditionId: work.preconditionId, flowId: work.flowId, flowStepId: work.flowStepId, instruction: work.instruction, requestedAction: work.requestedAction, allowedOutcomes: ['ACT', 'BLOCKED'] };
  if (work.type === 'DECIDE_FLOW_END') return { ...common, preconditionId: work.preconditionId, flowId: work.flowId, endCondition: work.endCondition, allowedOutcomes: ['TARGET_REACHED', 'TARGET_NOT_REACHED', 'OBSERVATION_UNUSABLE'] };
  if (work.type === 'DECIDE_STEP') {
    const allowedOutcomes = ['PASS', 'FAIL', 'ACT', 'BLOCKED'];
    if (work.visualRetryContext?.retryAllowed) allowedOutcomes.push('RETRY_VISUAL_INPUT');
    return { ...common, step: work.step, visualRetryContext: work.visualRetryContext, allowedOutcomes };
  }
  throw new Error(`No DecisionRequest for ${work.type}`);
}

function requireDecision(decision, allowed) {
  if (!decision || typeof decision !== 'object' || !allowed.includes(decision.outcome)) throw new Error(`decision outcome must be one of: ${allowed.join(', ')}`);
  if (!String(decision.reason || '').trim()) throw new Error('decision reason is required');
}

function applyFlowEntryDecision(options, work, decision) {
  requireDecision(decision, ['ALREADY_SATISFIED', 'STARTABLE', 'START_MISMATCH', 'OBSERVATION_UNUSABLE']);
  if (decision.outcome === 'ALREADY_SATISFIED') {
    record(options, { type: 'precondition', id: work.preconditionId, status: 'PASS', resolution: 'already_satisfied', flowId: work.flowId, evidenceObservation: work.latestObservation.label, reason: decision.reason });
    return;
  }
  if (decision.outcome === 'STARTABLE') {
    record(options, { type: 'flow', usage: 'precondition', preconditionId: work.preconditionId, flowId: work.flowId, status: 'STARTED', reason: decision.reason });
    return;
  }
  const failureCode = decision.outcome === 'START_MISMATCH' ? 'PRECONDITION_FLOW_START_MISMATCH' : 'PRECONDITION_FLOW_OBSERVATION_FAILED';
  record(options, { type: 'flow', usage: 'precondition', preconditionId: work.preconditionId, flowId: work.flowId, status: 'BLOCKED', failureCode, evidenceObservation: work.latestObservation.label, reason: decision.reason });
}

function applyFlowActionDecision(options, work, decision) {
  requireDecision(decision, ['ACT', 'BLOCKED']);
  if (decision.outcome === 'BLOCKED') {
    record(options, { type: 'flow', usage: 'precondition', preconditionId: work.preconditionId, flowId: work.flowId, status: 'BLOCKED', failureCode: 'PRECONDITION_FLOW_ACTION_MISMATCH', evidenceObservation: work.latestObservation.label, reason: decision.reason });
    return;
  }
  validateActionExecution(decision.action, { platform: options.platform, context: work.type });
  if (decision.action.type !== work.requestedAction.type) throw new Error('PRECONDITION_FLOW_ACTION_MISMATCH: action type differs from frozen Flow action');
  run('action-observe.sh', ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--scope', 'precondition-flow', '--precondition-id', work.preconditionId, '--flow-id', work.flowId, '--flow-step-id', work.flowStepId, ...actionArgs(decision.action)]);
}

function applyFlowEndDecision(options, work, decision) {
  requireDecision(decision, ['TARGET_REACHED', 'TARGET_NOT_REACHED', 'OBSERVATION_UNUSABLE']);
  const completed = decision.outcome === 'TARGET_REACHED';
  const failureCode = decision.outcome === 'OBSERVATION_UNUSABLE' ? 'PRECONDITION_FLOW_OBSERVATION_FAILED' : 'PRECONDITION_FLOW_TARGET_NOT_REACHED';
  record(options, {
    type: 'flow',
    usage: 'precondition',
    preconditionId: work.preconditionId,
    flowId: work.flowId,
    status: completed ? 'COMPLETED' : 'BLOCKED',
    failureCode: completed ? null : failureCode,
    evidenceObservation: work.latestObservation.label,
    reason: decision.reason,
  });
}

function stepTurn(work, decision, workToken, platform) {
  const allowed = ['PASS', 'FAIL', 'ACT', 'BLOCKED'];
  if (work.visualRetryContext?.retryAllowed) allowed.push('RETRY_VISUAL_INPUT');
  requireDecision(decision, allowed);
  const evidenceRef = work.latestObservation.evidenceRef || work.latestObservation.screenshot;
  if (decision.perception !== undefined && (!decision.perception || typeof decision.perception !== 'object' || Array.isArray(decision.perception))) throw new Error('decision perception must be an object');
  const retryContext = work.visualRetryContext || { attemptCount: 0, retryAllowed: true, requiredRetryOf: null };
  const defaultPerceptionStatus = ['BLOCKED', 'RETRY_VISUAL_INPUT'].includes(decision.outcome) ? 'UNCERTAIN' : 'USABLE';
  const perception = {
    ...(decision.perception || {}),
    type: 'perception',
    status: decision.perception?.status || defaultPerceptionStatus,
    reason: decision.perception?.reason || decision.reason,
  };
  if (decision.outcome === 'RETRY_VISUAL_INPUT') {
    if (!retryContext.retryAllowed) throw new Error('VISUAL_INPUT_RETRY_EXHAUSTED: visual retry is no longer allowed');
    if (!perception.qualityClaim || !perception.attemptId || !perception.presentationMode) {
      throw new Error('RETRY_VISUAL_INPUT requires perception qualityClaim, attemptId, and presentationMode');
    }
    if (!['UNUSABLE', 'UNCERTAIN'].includes(perception.status)) throw new Error('RETRY_VISUAL_INPUT perception status must be UNUSABLE or UNCERTAIN');
  }
  if (retryContext.requiredRetryOf && perception.qualityClaim) {
    if (perception.retryOf !== retryContext.requiredRetryOf || perception.attemptId === retryContext.requiredRetryOf) {
      throw new Error(`VISUAL_INPUT_RETRY_INVALID: quality retry must use retryOf=${retryContext.requiredRetryOf} and a new attemptId`);
    }
  }
  const facts = [perception];
  if (decision.outcome === 'PASS') facts.push({ type: 'assertion', status: 'PASS', reason: decision.reason });
  else if (decision.outcome === 'FAIL') facts.push({ type: 'assertion', status: 'FAIL', reason: decision.reason });
  else if (decision.outcome === 'ACT') {
    validateActionExecution(decision.action, { platform, context: 'step decision action' });
    facts.push({ type: 'decision', decision: 'act', action: decision.action, reason: decision.reason });
  } else if (decision.outcome === 'RETRY_VISUAL_INPUT') {
    facts.push({ type: 'decision', decision: 'retry_visual_input', reason: decision.reason });
  }
  return {
    schemaVersion: 1,
    turnId: turnIdFor(decision, workToken),
    stepId: work.step.id,
    observation: evidenceRef,
    facts,
  };
}

function turnIdFor(decision, workToken) {
  return decision.turnId || `turn-${workToken.slice('work-'.length)}`;
}

function hasRecoveryTurnDraft(context, decision, workToken) {
  const turnId = turnIdFor(decision, workToken);
  const turnKey = crypto.createHash('sha256').update(turnId).digest('hex').slice(0, 24);
  return fs.existsSync(path.join(context.execDir, 'agent', 'turns', `${turnKey}.draft.json`));
}

function applyStepDecision(options, work, decision, workToken) {
  const turn = stepTurn(work, decision, workToken, options.platform);
  run('commit-agent-turn.js', [...base(options), '--turn-json', JSON.stringify(turn)]);
  if (decision.outcome === 'BLOCKED') {
    const failureCode = decision.failureCode || 'PAGE_LOAD_BLOCKED';
    finalize(options, 'BLOCKED', decision.reason, ['--failure-code', failureCode, '--failed-step', work.step.id]);
  }
}

function applyDecision(options, context) {
  const work = context.nextWork;
  if (operationClass(work) !== 'VISUAL_DECISION') throw new Error(`${work.type} does not accept an Agent decision`);
  if (options.workToken !== context.workToken) {
    if (work.type === 'DECIDE_STEP' && hasRecoveryTurnDraft(context, options.decision, options.workToken)) {
      applyStepDecision(options, work, options.decision, options.workToken);
      return;
    }
    throw new Error(`STALE_NEXT_WORK: expected ${context.workToken}`);
  }
  if (work.type === 'DECIDE_FLOW_ENTRY') applyFlowEntryDecision(options, work, options.decision);
  else if (work.type === 'EXECUTE_FLOW_ACTION') applyFlowActionDecision(options, work, options.decision);
  else if (work.type === 'DECIDE_FLOW_END') applyFlowEndDecision(options, work, options.decision);
  else if (work.type === 'DECIDE_STEP') applyStepDecision(options, work, options.decision, context.workToken);
  else throw new Error(`No decision executor for ${work.type}`);
}

function advance(options) {
  if (options.command === 'decide') applyDecision(options, loadCaseExecutionContext(options));
  for (let count = 0; count < MAX_DETERMINISTIC_TRANSITIONS; count++) {
    const context = loadCaseExecutionContext(options);
    const category = operationClass(context.nextWork);
    if (category === 'STOP') {
      return { schemaVersion: 1, status: 'COMPLETED', executionId: context.executionId, resultPath: context.nextWork.resultPath, metricsPath: context.nextWork.metricsPath };
    }
    if (category === 'VISUAL_DECISION') {
      return { schemaVersion: 1, status: 'DECISION_REQUIRED', executionId: context.executionId, decisionRequest: decisionRequest(context) };
    }
    executeDeterministic(options, context.nextWork);
  }
  throw new Error(`CASE_ENGINE_STALLED: exceeded ${MAX_DETERMINISTIC_TRANSITIONS} deterministic transitions`);
}

try {
  console.log(JSON.stringify(advance(parseArgs(process.argv.slice(2))), null, 2));
} catch (error) {
  console.error(error.stderr ? String(error.stderr).trim() : error.message || String(error));
  process.exit(error.status || 1);
}

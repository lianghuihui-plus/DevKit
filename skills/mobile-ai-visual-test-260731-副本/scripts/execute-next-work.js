#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { describeActionConstraints, normalizeActionProposal, validateActionExecution } = require('./lib/action-contract');
const { loadCaseExecutionContext } = require('./lib/case-execution-context');
const { operationClass } = require('./lib/next-work-contract');
const { actionAuthorization, validateStepIntent } = require('./lib/step-intent');
const { ruleAuthorization } = require('./lib/rule-intent');

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

function run(script, args, env = process.env) {
  const command = script.endsWith('.sh') ? path.join(__dirname, script) : process.execPath;
  const commandArgs = script.endsWith('.sh') ? args : [path.join(__dirname, script), ...args];
  return childProcess.execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
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

function actionContractFailure(error) {
  const message = error?.stderr ? String(error.stderr).trim() : error?.message || String(error);
  if (error?.code !== 'ACTION_CONTRACT_INVALID' && !message.includes('ACTION_CONTRACT_INVALID')) return null;
  return {
    code: 'ACTION_CONTRACT_INVALID',
    message,
    field: error?.field,
    received: error?.received,
    allowed: error?.allowed,
    suggestion: error?.suggestion,
  };
}

function inputIntentFailure(field, received, allowed, suggestion) {
  const error = new Error(`ACTION_CONTRACT_INVALID: inputText ${field} does not match the frozen step intent`);
  error.code = 'ACTION_CONTRACT_INVALID';
  error.field = field;
  error.received = received;
  error.allowed = allowed;
  error.suggestion = suggestion;
  return error;
}

function validateActionAgainstStep(action, step, stepIntent) {
  if (action?.type !== 'inputText' || step?.goal !== 'input_text') return action;
  const expectedMode = stepIntent?.inputMode || step.inputMode || 'replace';
  if (action.mode !== expectedMode) {
    throw inputIntentFailure('mode', action.mode, [expectedMode], `use mode=${expectedMode}`);
  }
  if (step.value !== undefined && step.value !== null && String(action.text) !== String(step.value)) {
    throw inputIntentFailure('text', action.text, [String(step.value)], 'use the exact text frozen in the current case step');
  }
  return action;
}

function recordActionRejection(options, work, attemptedAction, failure, phase, workToken, decisionTurnId) {
  const event = {
    type: 'actionRejected',
    source: 'execute-next-work.js',
    workToken,
    observation: work.latestObservation?.evidenceRef || work.latestObservation?.screenshot || null,
    phase,
    failureCode: failure.code || 'ACTION_CONTRACT_INVALID',
    reason: failure.message,
    field: failure.field,
    received: failure.received,
    allowed: failure.allowed,
    suggestion: failure.suggestion,
    attemptedAction: attemptedAction && typeof attemptedAction === 'object' ? attemptedAction : { type: 'unknown' },
    recoverable: true,
    decisionTurnId: decisionTurnId || undefined,
  };
  if (work.step?.id) {
    event.stepId = work.step.id;
    event.intentSha = work.stepIntent.intentSha;
  } else {
    event.scope = 'precondition-flow';
    event.preconditionId = work.preconditionId;
    event.flowId = work.flowId;
    event.flowStepId = work.flowStepId;
  }
  return run('run-case.js', [...base(options), '--record-action-rejection-json', JSON.stringify(event)], {
    ...process.env,
    MAVT_ACTION_REJECTION_WRITER: '1',
  });
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

function executeDeterministic(options, work, workToken) {
  if (work.type === 'STOP_FINALIZED') return;
  if (work.type === 'OBSERVE_STEP' || work.type === 'OBSERVE_AFTER_ACTION' || work.type === 'OBSERVE_AFTER_RULE') {
    run('observe.sh', ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--step-id', work.step.id]);
    return;
  }
  if (work.type.startsWith('OBSERVE_FLOW_')) {
    run('observe.sh', flowObservationArgs(options, work));
    return;
  }
  if (work.type === 'EXECUTE_STEP_ACTION') {
    try {
      const requestedAction = normalizeActionProposal(work.requestedAction, { context: work.type }).action;
      validateActionExecution(requestedAction, { platform: options.platform, scope: 'case-step', context: work.type });
      validateStepIntent(work.step, work.stepIntent);
      validateActionAgainstStep(requestedAction, work.step, work.stepIntent);
      run('action-observe.sh', [
        '--case-dir', options.caseDir,
        '--platform', options.platform,
        '--execution-id', options.executionId,
        '--step-id', work.step.id,
        '--authorization-source', work.authorization.source,
        '--authorization-step-id', work.authorization.stepId,
        '--authorization-intent-sha', work.authorization.intentSha,
        ...actionArgs(requestedAction),
      ]);
    } catch (error) {
      const failure = actionContractFailure(error);
      if (!failure) throw error;
      recordActionRejection(options, work, work.requestedAction, failure, 'execution-entry', workToken, work.decisionTurnId);
    }
    return;
  }
  if (work.type === 'EXECUTE_RULE_ACTION') {
    const requestedAction = normalizeActionProposal(work.requestedAction, { context: work.type }).action;
    validateActionExecution(requestedAction, { platform: options.platform, scope: 'global-rule', context: work.type });
    const authorization = ruleAuthorization(work.rule, work.step.id);
    run('action-observe.sh', [
      '--case-dir', options.caseDir,
      '--platform', options.platform,
      '--execution-id', options.executionId,
      '--scope', 'global-rule',
      '--step-id', work.step.id,
      '--authorization-source', authorization.source,
      '--authorization-step-id', authorization.stepId,
      '--authorization-rule-id', authorization.ruleId,
      '--authorization-rule-sha', authorization.ruleSha,
      ...actionArgs(requestedAction),
    ]);
    return;
  }
  if (work.type === 'RECORD_RULE_HANDLED') {
    record(options, {
      type: 'rule',
      ruleId: work.rule.id,
      ruleScope: work.rule.scope,
      stepId: work.step.id,
      status: 'HANDLED',
      observation: work.latestObservation.evidenceRef,
      reason: '规则动作执行成功，并已完成动作后观察。',
    });
    return;
  }
  if (work.type === 'EXECUTE_FLOW_ACTION') {
    const requestedAction = normalizeActionProposal(work.requestedAction, { context: work.type }).action;
    validateActionExecution(requestedAction, { platform: options.platform, scope: 'precondition-flow', context: work.type });
    run('action-observe.sh', ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--scope', 'precondition-flow', '--precondition-id', work.preconditionId, '--flow-id', work.flowId, '--flow-step-id', work.flowStepId, ...actionArgs(requestedAction)]);
    return;
  }
  if (work.type === 'RECORD_PRECONDITION') {
    record(options, {
      type: 'precondition',
      id: work.preconditionId,
      resolution: work.resolution,
      checkerId: work.checkerId || undefined,
      evidenceRefs: work.evidenceRefs || undefined,
      status: work.status,
      reason: work.reason,
      failureCode: work.failureCode || null,
    });
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
  if (work.type === 'RECORD_FLOW_ACTION_REJECTION_TERMINAL') {
    record(options, {
      type: 'flow',
      usage: 'precondition',
      preconditionId: work.preconditionId,
      flowId: work.flowId,
      flowStepId: work.flowStepId,
      status: 'BLOCKED',
      failureCode: work.failureCode || 'ACTION_CONTRACT_INVALID',
      evidenceObservation: work.latestObservation?.label || undefined,
      reason: work.reason || 'Flow 动作参数连续不符合执行契约。',
    });
    return;
  }
  if (work.type === 'FINALIZE_PASS') {
    finalize(options, 'PASS', work.reason || 'All steps passed.');
    return;
  }
  if (work.type === 'FINALIZE_STEP_FAILURE') {
    const extra = ['--failed-step', work.stepId];
    if (work.failureCode) extra.push('--failure-code', work.failureCode);
    finalize(options, work.status, work.reason || 'Step assertion failed.', extra);
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
  if (work.type === 'DECIDE_FLOW_ACTION') return { ...common, preconditionId: work.preconditionId, flowId: work.flowId, flowStepId: work.flowStepId, instruction: work.instruction, requestedAction: work.requestedAction, actionConstraints: describeActionConstraints(context.platform, 'precondition-flow'), lastActionRejection: work.lastActionRejection || null, allowedOutcomes: ['ACT', 'BLOCKED'] };
  if (work.type === 'DECIDE_FLOW_END') return { ...common, preconditionId: work.preconditionId, flowId: work.flowId, endCondition: work.endCondition, allowedOutcomes: ['TARGET_REACHED', 'TARGET_NOT_REACHED', 'OBSERVATION_UNUSABLE'] };
  if (work.type === 'DECIDE_RULE') return {
    ...common,
    stepId: work.step.id,
    rule: work.rule,
    attemptCount: work.attempts,
    remainingAttempts: work.remainingAttempts,
    actionConstraints: describeActionConstraints(context.platform, 'global-rule'),
    allowedOutcomes: ['MATCHED', 'NOT_MATCHED', 'UNHANDLED_POPUP'],
  };
  if (work.type === 'DECIDE_STEP') {
    const allowedOutcomes = ['PASS', 'FAIL', 'ACT', 'BLOCKED'];
    if (work.visualRetryContext?.retryAllowed) allowedOutcomes.push('RETRY_VISUAL_INPUT');
    const actionConstraints = describeActionConstraints(context.platform, 'case-step');
    if (work.step?.goal === 'input_text') {
      actionConstraints.inputText.expectedMode = work.stepIntent.inputMode;
      if (work.step.value !== undefined) actionConstraints.inputText.expectedText = work.step.value;
    }
    return { ...common, step: work.step, stepIntent: work.stepIntent, visualRetryContext: work.visualRetryContext, actionConstraints, lastActionRejection: work.lastActionRejection || null, allowedOutcomes };
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

function applyFlowActionDecision(options, work, decision, workToken) {
  requireDecision(decision, ['ACT', 'BLOCKED']);
  if (decision.outcome === 'BLOCKED') {
    record(options, { type: 'flow', usage: 'precondition', preconditionId: work.preconditionId, flowId: work.flowId, status: 'BLOCKED', failureCode: 'PRECONDITION_FLOW_ACTION_MISMATCH', evidenceObservation: work.latestObservation.label, reason: decision.reason });
    return;
  }
  let normalized;
  try {
    normalized = normalizeActionProposal(decision.action, { context: work.type });
    validateActionExecution(normalized.action, { platform: options.platform, scope: 'precondition-flow', context: work.type });
  } catch (error) {
    const failure = actionContractFailure(error);
    if (!failure) throw error;
    recordActionRejection(options, work, decision.action, failure, 'decision-validation', workToken);
    return;
  }
  if (normalized.action.type !== work.requestedAction.type) {
    recordActionRejection(options, work, normalized.action, {
      code: 'PRECONDITION_FLOW_ACTION_MISMATCH',
      message: `PRECONDITION_FLOW_ACTION_MISMATCH: action type must remain ${work.requestedAction.type}`,
      field: 'type',
      received: normalized.action.type,
      allowed: [work.requestedAction.type],
      suggestion: `use ${work.requestedAction.type}`,
    }, 'decision-validation', workToken);
    return;
  }
  run('action-observe.sh', ['--case-dir', options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--scope', 'precondition-flow', '--precondition-id', work.preconditionId, '--flow-id', work.flowId, '--flow-step-id', work.flowStepId, ...actionArgs(normalized.action)]);
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

function validateRuleAction(action, rule) {
  const frozen = rule.then.action;
  for (const [field, value] of Object.entries(frozen)) {
    if (JSON.stringify(action[field]) !== JSON.stringify(value)) {
      throw new Error(`ACTION_CONTRACT_INVALID: global rule ${rule.id} action.${field} must remain ${JSON.stringify(value)}`);
    }
  }
}

function applyRuleDecision(options, work, decision) {
  requireDecision(decision, ['MATCHED', 'NOT_MATCHED', 'UNHANDLED_POPUP']);
  if (decision.outcome === 'UNHANDLED_POPUP') {
    record(options, { type: 'rule', ruleId: work.rule.id, ruleScope: work.rule.scope, stepId: work.step.id, status: 'UNKNOWN', observation: work.latestObservation.evidenceRef, reason: decision.reason });
    finalize(options, 'BLOCKED', decision.reason, ['--failure-code', 'UNKNOWN_POPUP', '--failed-step', work.step.id]);
    return;
  }
  if (decision.outcome === 'NOT_MATCHED') {
    record(options, {
      type: 'rule',
      ruleId: work.rule.id,
      ruleScope: work.rule.scope,
      stepId: work.step.id,
      status: 'SKIPPED',
      observation: work.latestObservation.evidenceRef,
      reason: decision.reason,
    });
    return;
  }
  if (work.remainingAttempts <= 0) {
    const status = work.rule.onFailure === 'FAIL' ? 'FAIL' : work.rule.onFailure === 'UNKNOWN' ? 'UNKNOWN' : 'BLOCKED';
    const ruleStatus = status === 'FAIL' ? 'FAILED' : status;
    record(options, { type: 'rule', ruleId: work.rule.id, ruleScope: work.rule.scope, stepId: work.step.id, status: ruleStatus, observation: work.latestObservation.evidenceRef, reason: decision.reason });
    finalize(options, status, `规则 ${work.rule.id} 已达到最大处理次数：${decision.reason}`, ['--failure-code', 'GLOBAL_RULE_FAILED', '--failed-step', work.step.id]);
    return;
  }
  try {
    const normalized = normalizeActionProposal(decision.action, { context: `global rule ${work.rule.id}` }).action;
    validateRuleAction(normalized, work.rule);
    validateActionExecution(normalized, { platform: options.platform, scope: 'global-rule', context: `global rule ${work.rule.id}` });
    record(options, {
      type: 'rule',
      ruleId: work.rule.id,
      ruleScope: work.rule.scope,
      stepId: work.step.id,
      status: 'MATCHED',
      attempt: work.attempts + 1,
      observation: work.latestObservation.evidenceRef,
      action: normalized,
      reason: decision.reason,
    });
  } catch (error) {
    record(options, { type: 'rule', ruleId: work.rule.id, ruleScope: work.rule.scope, stepId: work.step.id, status: 'BLOCKED', observation: work.latestObservation.evidenceRef, reason: error.message || String(error) });
    finalize(options, 'BLOCKED', error.message || String(error), ['--failure-code', 'ACTION_CONTRACT_INVALID', '--failed-step', work.step.id]);
  }
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
    const stepIntent = validateStepIntent(work.step, work.stepIntent);
    if (decision.intentSha !== stepIntent.intentSha) {
      throw new Error(`ACTION_OUTSIDE_CASE_INTENT: ACT must echo intentSha ${stepIntent.intentSha}`);
    }
    const normalized = normalizeActionProposal(decision.action, { context: 'step decision action' });
    validateActionExecution(normalized.action, { platform, scope: 'case-step', context: 'step decision action' });
    validateActionAgainstStep(normalized.action, work.step, stepIntent);
    facts.push({
      type: 'decision',
      decision: 'act',
      action: normalized.action,
      actionNormalizations: normalized.normalizations,
      authorization: actionAuthorization(work.step),
      reason: decision.reason,
    });
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
  let turn;
  try {
    turn = stepTurn(work, decision, workToken, options.platform);
  } catch (error) {
    const failure = actionContractFailure(error);
    if (!failure || decision?.outcome !== 'ACT') throw error;
    let attemptedAction = decision.action;
    try { attemptedAction = normalizeActionProposal(decision.action, { context: 'rejected step action' }).action; } catch (_) { /* preserve raw proposal below */ }
    recordActionRejection(options, work, attemptedAction, failure, 'decision-validation', workToken);
    return false;
  }
  run('commit-agent-turn.js', [...base(options), '--turn-json', JSON.stringify(turn)]);
  if (decision.outcome === 'BLOCKED') {
    const failureCode = decision.failureCode || 'PAGE_LOAD_BLOCKED';
    finalize(options, 'BLOCKED', decision.reason, ['--failure-code', failureCode, '--failed-step', work.step.id]);
  }
  return true;
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
  else if (work.type === 'DECIDE_FLOW_ACTION') applyFlowActionDecision(options, work, options.decision, context.workToken);
  else if (work.type === 'DECIDE_FLOW_END') applyFlowEndDecision(options, work, options.decision);
  else if (work.type === 'DECIDE_RULE') applyRuleDecision(options, work, options.decision);
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
    executeDeterministic(options, context.nextWork, context.workToken);
  }
  throw new Error(`CASE_ENGINE_STALLED: exceeded ${MAX_DETERMINISTIC_TRANSITIONS} deterministic transitions`);
}

try {
  console.log(JSON.stringify(advance(parseArgs(process.argv.slice(2))), null, 2));
} catch (error) {
  console.error(error.stderr ? String(error.stderr).trim() : error.message || String(error));
  process.exit(error.status || 1);
}

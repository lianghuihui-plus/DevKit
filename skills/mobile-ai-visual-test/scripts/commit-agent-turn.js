#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  caseRuntimeDir,
  ensureDir,
  readJson,
  readJsonl,
  writeJson,
} = require('./common');
const { validateActionExecution } = require('./lib/action-contract');
const { canonicalJson } = require('./lib/agent-runtime-contract');

function usage() {
  console.error('Usage: commit-agent-turn.js <case-dir> --platform <harmony|android|ios> --execution-id <id> --turn-json <json>');
  process.exit(2);
}

function parseArgs(args) {
  if (!args.length) usage();
  const options = { caseDir: path.resolve(args[0]) };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': options.platform = args[++i]; break;
      case '--execution-id': options.executionId = args[++i]; break;
      case '--turn-json': options.turnJson = args[++i]; break;
      default: usage();
    }
  }
  if (!['harmony', 'android', 'ios'].includes(options.platform) || !options.executionId || !options.turnJson) usage();
  return options;
}

function eventStepId(event) {
  return event?.stepId || event?.step?.id || '';
}

function normalizeTurn(input, platform) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('turn-json must be an object');
  if (input.schemaVersion !== 1) throw new Error('turn-json schemaVersion must be 1');
  if (!input.turnId || typeof input.turnId !== 'string') throw new Error('turn-json missing turnId');
  if (!input.stepId || typeof input.stepId !== 'string') throw new Error('turn-json missing stepId');
  if (!input.observation || typeof input.observation !== 'string') throw new Error('turn-json missing observation screenshot path');
  if (!Array.isArray(input.facts) || input.facts.length < 1 || input.facts.length > 2) {
    throw new Error('turn-json facts must contain one perception and at most one decision/assertion');
  }
  if (input.facts[0]?.type !== 'perception') throw new Error('turn-json first fact must be perception');
  if (input.facts[1] && !['decision', 'assertion'].includes(input.facts[1].type)) {
    throw new Error('turn-json second fact must be decision or assertion');
  }
  if (!String(input.facts[0].reason || '').trim()) throw new Error('perception reason is required');
  if (input.facts[1]?.type === 'assertion' && input.facts[1].status === 'PASS' && input.facts[0].status !== 'USABLE') {
    throw new Error('PASS assertion requires perception status=USABLE');
  }
  if (input.facts[1]?.type === 'decision' && input.facts[1].decision === 'act') {
    const action = input.facts[1].action || input.facts[1].requestedAction;
    validateActionExecution(action, { platform, context: 'act decision action' });
    input.facts[1].action = action;
    delete input.facts[1].requestedAction;
  }
  return input;
}

function runRecord(options, event) {
  const script = path.join(__dirname, 'run-case.js');
  return childProcess.execFileSync(process.execPath, [
    script,
    options.caseDir,
    '--platform', options.platform,
    '--record-json', JSON.stringify(event),
    '--execution-id', options.executionId,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function existingFactCompatible(existing, fact, turn) {
  if (eventStepId(existing) !== turn.stepId || existing.reason !== fact.reason) return false;
  if (fact.type === 'perception') {
    const statusMatches = existing.status === fact.status || existing.requestedStatus === fact.status;
    const evidence = Array.isArray(existing.evidence) ? existing.evidence : [existing.evidence].filter(Boolean);
    return statusMatches
      && evidence.includes(turn.observation)
      && (existing.attemptId || null) === (fact.attemptId || null)
      && (existing.retryOf || null) === (fact.retryOf || null)
      && (existing.presentationMode || null) === (fact.presentationMode || null)
      && canonicalJson(existing.qualityClaim || null) === canonicalJson(fact.qualityClaim || null);
  }
  if (fact.type === 'assertion') {
    const evidence = Array.isArray(existing.evidence) ? existing.evidence : [existing.evidence].filter(Boolean);
    return existing.status === fact.status && evidence.includes(turn.observation);
  }
  const existingAction = existing.action || existing.requestedAction || null;
  const factAction = fact.action || fact.requestedAction || null;
  return existing.decision === fact.decision && canonicalJson(existingAction) === canonicalJson(factAction);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const turn = normalizeTurn(JSON.parse(options.turnJson), options.platform);
  const runtimeDir = caseRuntimeDir(options.caseDir, options.platform);
  const execDir = path.join(runtimeDir, 'executions', options.executionId);
  const execution = readJson(path.join(execDir, 'execution.json'));
  if (!execution) throw new Error(`Execution was not started: ${options.executionId}`);
  if (execution.finalized) throw new Error(`Execution already finalized: ${options.executionId}`);
  let events = readJsonl(path.join(execDir, 'timeline.jsonl'));
  const latestObservation = events.filter((event) => event.type === 'observation' && eventStepId(event) === turn.stepId).at(-1);
  const latestScreenshot = latestObservation?.artifacts?.screenshot || latestObservation?.observation?.artifacts?.screenshot;
  if (!latestObservation || latestScreenshot !== turn.observation) {
    throw new Error(`ASSERTION_EVIDENCE_REQUIRED: turn observation must equal latest ${turn.stepId} screenshot: ${latestScreenshot || '<none>'}`);
  }

  const turnsDir = path.join(execDir, 'agent', 'turns');
  ensureDir(turnsDir);
  const turnKey = crypto.createHash('sha256').update(turn.turnId).digest('hex').slice(0, 24);
  const draftPath = path.join(turnsDir, `${turnKey}.draft.json`);
  const existingDraft = readJson(draftPath);
  const frozenTurn = { schemaVersion: 1, executionId: options.executionId, platform: options.platform, turn };
  if (existingDraft && canonicalJson(existingDraft) !== canonicalJson(frozenTurn)) {
    throw new Error(`turnId already has a different recovery draft: ${turn.turnId}`);
  }
  if (!existingDraft) writeJson(draftPath, frozenTurn);

  const requestedTypes = new Set(turn.facts.map((fact) => fact.type));
  for (const existing of events.filter((event) => event.turnId === turn.turnId)) {
    if (!requestedTypes.has(existing.type)) {
      throw new Error(`turnId already used by another event type: ${turn.turnId}/${existing.type}`);
    }
  }

  const committed = [];
  const outputs = [];
  for (const factInput of turn.facts) {
    const existing = events.find((event) => event.turnId === turn.turnId && event.type === factInput.type);
    if (existing) {
      if (!existingFactCompatible(existing, factInput, turn)) throw new Error(`turnId already used by a different fact: ${turn.turnId}/${factInput.type}`);
      committed.push(factInput.type);
      continue;
    }
    const event = {
      ...factInput,
      stepId: turn.stepId,
      turnId: turn.turnId,
    };
    if (event.type === 'perception' || event.type === 'assertion') {
      event.evidence = Array.isArray(event.evidence) && event.evidence.length ? event.evidence : [turn.observation];
    }
    outputs.push(runRecord(options, event));
    committed.push(event.type);
    events = readJsonl(path.join(execDir, 'timeline.jsonl'));
    if (process.env.MAVT_SELF_TEST === '1' && process.env.MAVT_SELF_TEST_TURN_INTERRUPT === 'after-first-fact' && outputs.length === 1) {
      throw new Error('MAVT_SELF_TEST_TURN_INTERRUPT: after-first-fact');
    }
  }
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  console.log(JSON.stringify({
    schemaVersion: 1,
    executionId: options.executionId,
    turnId: turn.turnId,
    stepId: turn.stepId,
    committed,
    alreadyCommitted: outputs.length === 0,
    recovered: Boolean(existingDraft),
  }, null, 2));
}

try {
  main();
} catch (error) {
  const stderr = error.stderr ? String(error.stderr).trim() : '';
  console.error(stderr || error.message || String(error));
  process.exit(error.status || 1);
}

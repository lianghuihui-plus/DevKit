#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, readJson, commitEvent, output, main, fail } = require('./lib/common');
const { runContextIds, runContextId } = require('./lib/run-protocol');
const { buildGoalSpecFromArgs, writeGoalArtifacts } = require('./lib/goal-spec');

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.scanMode !== 'goal-directed' || scan.scanScope !== 'targeted') fail('GoalSpec requires goal-directed/targeted Run', 'GOAL_MODE_REQUIRED');
  if (scan.status !== 'CREATED') fail('GoalSpec must be confirmed before scan plan confirmation', 'RUN_STATE_INVALID');
  const contextId = args.context || runContextId(scan); if (!runContextIds(scan).includes(contextId)) fail('Goal context is not planned by this Run', 'CONTEXT_INVALID');
  const { goal, screenshotPath } = buildGoalSpecFromArgs(args, contextId);
  if (scan.parentScanId) {
    const parentGoalPath = path.join(path.dirname(scanDir), scan.parentScanId, 'goal', 'goal.json'); const parentGoal = fs.existsSync(parentGoalPath) ? JSON.parse(fs.readFileSync(parentGoalPath, 'utf8')) : null;
    if (!parentGoal || parentGoal.goalSpecHash !== goal.goalSpecHash) fail('Goal Continuation requires the same goalSpecHash as its parent', 'PARENT_GOAL_MISMATCH');
  }
  writeGoalArtifacts(scanDir, goal, screenshotPath);
  commitEvent(scanDir, 'goalParsed', { goalId: goal.goalId, contextId, resultPolicy: goal.resultPolicy, compatibilityEntry: true }, [
    { path: 'goal/goal.json', op: 'REPLACE', value: readJson(path.join(scanDir, 'goal', 'goal.json')) },
    { path: 'goal/match-result.json', op: 'REPLACE', value: readJson(path.join(scanDir, 'goal', 'match-result.json')) },
    { path: 'goal/verified-paths.json', op: 'REPLACE', value: readJson(path.join(scanDir, 'goal', 'verified-paths.json')) }
  ]);
  output({ schemaVersion: 1, ok: true, goal, requiresUserConfirmation: true });
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, writeJsonAtomic, writeTextAtomic, jsonArg, event, output, main, fail, bool, number, sha256, safeSegment, hashObject } = require('./lib/common');
const { runContextIds, runContextId } = require('./lib/run-protocol');

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.scanMode !== 'goal-directed' || scan.scanScope !== 'targeted') fail('GoalSpec requires goal-directed/targeted Run', 'GOAL_MODE_REQUIRED');
  if (scan.status !== 'CREATED') fail('GoalSpec must be confirmed before scan plan confirmation', 'RUN_STATE_INVALID');
  const description = required(args, 'description'); const screenshot = path.resolve(required(args, 'screenshot'));
  if (!fs.existsSync(screenshot) || !fs.statSync(screenshot).isFile()) fail('Target screenshot does not exist', 'GOAL_SCREENSHOT_MISSING');
  const screenshotBytes = fs.readFileSync(screenshot); if (screenshotBytes.length < 8 || !screenshotBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('Target screenshot must be a PNG file', 'GOAL_SCREENSHOT_INVALID');
  const criteria = jsonArg(args.successCriteria, null, 'successCriteria JSON');
  if (!criteria || !Array.isArray(criteria.requiredTexts) || !criteria.requiredTexts.length) fail('Agent-derived successCriteria.requiredTexts is required', 'GOAL_CRITERIA_REQUIRED');
  const contextId = args.context || runContextId(scan); if (!runContextIds(scan).includes(contextId)) fail('Goal context is not planned by this Run', 'CONTEXT_INVALID');
  const goalDir = path.join(scanDir, 'goal'); fs.mkdirSync(goalDir, { recursive: true });
  if (fs.existsSync(path.join(goalDir, 'goal.json'))) fail('GoalSpec already exists; create a new Run for a different target', 'GOAL_ALREADY_PARSED');
  writeTextAtomic(path.join(goalDir, 'description.txt'), `${description}\n`); const tempTarget = path.join(goalDir, `.target-${process.pid}.tmp`); fs.copyFileSync(screenshot, tempTarget); fs.renameSync(tempTarget, path.join(goalDir, 'target.png'));
  const maxVerifiedPaths = number(args.maxVerifiedPaths, 1, 'maxVerifiedPaths'); if (!Number.isInteger(maxVerifiedPaths) || maxVerifiedPaths < 1) fail('maxVerifiedPaths must be an integer greater than or equal to 1', 'GOAL_POLICY_INVALID');
  const goal = { schemaVersion: 1, goalId: safeSegment(args.goalId || `goal-${hashObject(description).slice(-16)}`, 'goalId'), type: 'target-state', description, referenceScreenshot: 'goal/target.png', referenceScreenshotSha256: sha256(screenshotBytes), contextId,
    successCriteria: { requiredTexts: criteria.requiredTexts, optionalTexts: criteria.optionalTexts || [], layoutAnchors: criteria.layoutAnchors || [], ignoredRegions: criteria.ignoredRegions || [], matchPolicy: 'semantic-structural' },
    resultPolicy: { verifyKnownPathFirst: bool(args.verifyKnownPathFirst, true), maxVerifiedPaths } };
  goal.goalSpecHash = hashObject({ type: goal.type, description: goal.description, referenceScreenshotSha256: goal.referenceScreenshotSha256, contextId: goal.contextId, successCriteria: goal.successCriteria, resultPolicy: goal.resultPolicy });
  if (scan.parentScanId) {
    const parentGoalPath = path.join(path.dirname(scanDir), scan.parentScanId, 'goal', 'goal.json'); const parentGoal = fs.existsSync(parentGoalPath) ? JSON.parse(fs.readFileSync(parentGoalPath, 'utf8')) : null;
    if (!parentGoal || parentGoal.goalSpecHash !== goal.goalSpecHash) fail('Goal Continuation requires the same goalSpecHash as its parent', 'PARENT_GOAL_MISMATCH');
  }
  writeJsonAtomic(path.join(goalDir, 'goal.json'), goal); writeJsonAtomic(path.join(goalDir, 'match-result.json'), { schemaVersion: 1, goalId: goal.goalId, status: 'SEARCHING', matchedVisualStateId: null, matchedReachableStateId: null, verifiedPathIds: [], candidateDecisionIds: [], alternativePathCount: 0, actionsUsed: 0, durationSeconds: 0, evidenceObservationId: null, decisions: [] }); writeJsonAtomic(path.join(goalDir, 'verified-paths.json'), { schemaVersion: 1, goalId: goal.goalId, paths: [] });
  event(scanDir, 'goalParsed', { goalId: goal.goalId, contextId, resultPolicy: goal.resultPolicy }); output({ schemaVersion: 1, ok: true, goal, requiresUserConfirmation: true });
});

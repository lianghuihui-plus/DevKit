'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, writeJsonAtomic, writeTextAtomic, jsonArg, fail, bool, number, sha256, safeSegment, hashObject } = require('./common');

function buildGoalSpecFromArgs(args, contextId) {
  const description = args.description;
  if (description === undefined || description === true || String(description).trim() === '') fail('--description is required for goal-directed Run', 'ARG_REQUIRED');
  const screenshot = args.screenshot;
  if (screenshot === undefined || screenshot === true || String(screenshot).trim() === '') fail('--screenshot is required for goal-directed Run', 'ARG_REQUIRED');
  const screenshotPath = path.resolve(String(screenshot));
  if (!fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) fail('Target screenshot does not exist', 'GOAL_SCREENSHOT_MISSING');
  const screenshotBytes = fs.readFileSync(screenshotPath);
  if (screenshotBytes.length < 8 || !screenshotBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('Target screenshot must be a PNG file', 'GOAL_SCREENSHOT_INVALID');
  const criteria = jsonArg(args.successCriteria, null, 'successCriteria JSON');
  if (!criteria || !Array.isArray(criteria.requiredTexts) || !criteria.requiredTexts.length) fail('Agent-derived successCriteria.requiredTexts is required', 'GOAL_CRITERIA_REQUIRED');
  const maxVerifiedPaths = number(args.maxVerifiedPaths, 1, 'maxVerifiedPaths');
  if (!Number.isInteger(maxVerifiedPaths) || maxVerifiedPaths < 1) fail('maxVerifiedPaths must be an integer greater than or equal to 1', 'GOAL_POLICY_INVALID');
  const goal = {
    schemaVersion: 1,
    goalId: safeSegment(args.goalId || `goal-${hashObject(String(description)).slice(-16)}`, 'goalId'),
    type: 'target-state',
    description: String(description),
    referenceScreenshot: 'goal/target.png',
    referenceScreenshotSha256: sha256(screenshotBytes),
    contextId,
    successCriteria: {
      requiredTexts: criteria.requiredTexts,
      optionalTexts: criteria.optionalTexts || [],
      layoutAnchors: criteria.layoutAnchors || [],
      ignoredRegions: criteria.ignoredRegions || [],
      matchPolicy: 'semantic-structural'
    },
    resultPolicy: { verifyKnownPathFirst: bool(args.verifyKnownPathFirst, true), maxVerifiedPaths }
  };
  goal.goalSpecHash = hashObject({
    type: goal.type,
    description: goal.description,
    referenceScreenshotSha256: goal.referenceScreenshotSha256,
    contextId: goal.contextId,
    successCriteria: goal.successCriteria,
    resultPolicy: goal.resultPolicy
  });
  return { goal, screenshotPath };
}

function goalPlanFromSpec(spec) {
  return {
    goalId: spec.goalId,
    goalSpecHash: spec.goalSpecHash || hashObject({
      description: spec.description,
      contextId: spec.contextId,
      referenceScreenshotSha256: spec.referenceScreenshotSha256,
      successCriteria: spec.successCriteria
    }),
    description: spec.description,
    contextId: spec.contextId,
    referenceScreenshot: spec.referenceScreenshot,
    referenceScreenshotSha256: spec.referenceScreenshotSha256,
    requiredTexts: spec.successCriteria?.requiredTexts || [],
    maxVerifiedPaths: spec.resultPolicy?.maxVerifiedPaths || 1
  };
}

function writeGoalArtifacts(scanDir, goal, screenshotPath) {
  const goalDir = path.join(scanDir, 'goal');
  ensureDir(goalDir);
  if (fs.existsSync(path.join(goalDir, 'goal.json'))) fail('GoalSpec already exists; create a new Run for a different target', 'GOAL_ALREADY_PARSED');
  writeTextAtomic(path.join(goalDir, 'description.txt'), `${goal.description}\n`);
  const tempTarget = path.join(goalDir, `.target-${process.pid}.tmp`);
  fs.copyFileSync(screenshotPath, tempTarget);
  fs.renameSync(tempTarget, path.join(goalDir, 'target.png'));
  writeJsonAtomic(path.join(goalDir, 'goal.json'), goal);
  writeJsonAtomic(path.join(goalDir, 'match-result.json'), { schemaVersion: 1, goalId: goal.goalId, status: 'SEARCHING', matchedVisualStateId: null, matchedReachableStateId: null, verifiedPathIds: [], candidateDecisionIds: [], alternativePathCount: 0, actionsUsed: 0, durationSeconds: 0, evidenceObservationId: null, decisions: [] });
  writeJsonAtomic(path.join(goalDir, 'verified-paths.json'), { schemaVersion: 1, goalId: goal.goalId, paths: [] });
}

module.exports = { buildGoalSpecFromArgs, goalPlanFromSpec, writeGoalArtifacts };

'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, writeJsonAtomic, writeTextAtomic, jsonArg, readJson, fail, bool, number, sha256, safeSegment, hashObject } = require('./common');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(item => String(item).trim()).filter(Boolean);
}

function goalSpecArg(args) {
  const raw = args.goalSpec;
  if (raw === undefined || raw === true || String(raw).trim() === '') return null;
  const text = String(raw);
  const maybePath = path.resolve(text);
  if (fs.existsSync(maybePath) && fs.statSync(maybePath).isFile()) return readJson(maybePath);
  return jsonArg(text, null, '--goal-spec JSON');
}

function parseGoalTextArg(args) {
  if (args.goal === undefined || args.goal === true || String(args.goal).trim() === '') return null;
  const text = String(args.goal).trim();
  if (text.startsWith('{')) return jsonArg(text, null, '--goal JSON');
  return { description: text, rawUserGoal: text };
}

function resolveScreenshot(spec, args) {
  const screenshot = args.screenshot || spec?.screenshot || spec?.evidence?.screenshot || spec?.target?.screenshot || spec?.targetSpec?.screenshot;
  if (screenshot === undefined || screenshot === true || String(screenshot).trim() === '') return { screenshotPath: null, screenshotBytes: null };
  const screenshotPath = path.resolve(String(screenshot));
  if (!fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) fail('Target screenshot does not exist', 'GOAL_SCREENSHOT_MISSING');
  const screenshotBytes = fs.readFileSync(screenshotPath);
  if (screenshotBytes.length < 8 || !screenshotBytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('Target screenshot must be a PNG file', 'GOAL_SCREENSHOT_INVALID');
  return { screenshotPath, screenshotBytes };
}

function normalizeGoalInput(args) {
  const spec = goalSpecArg(args) || parseGoalTextArg(args) || {};
  const criteria = args.successCriteria ? jsonArg(args.successCriteria, null, 'successCriteria JSON') : null;
  const target = spec.targetSpec || spec.target || criteria || {};
  const guide = spec.guideSpec || spec.guide || {};
  const description = spec.description || args.description || spec.name || spec.targetName || null;
  if (!description || String(description).trim() === '') fail('--description or goalSpec.description is required for goal-directed Run', 'ARG_REQUIRED');
  const targetSpec = {
    requiredTexts: asArray(target.requiredTexts),
    optionalTexts: asArray(target.optionalTexts),
    layoutAnchors: asArray(target.layoutAnchors),
    forbiddenTexts: asArray(target.forbiddenTexts),
    ignoredRegions: Array.isArray(target.ignoredRegions) ? target.ignoredRegions : [],
    matchPolicy: target.matchPolicy || 'semantic-structural'
  };
  if (!targetSpec.requiredTexts.length) fail('TargetSpec requires at least one strong matching evidence in requiredTexts', 'GOAL_CRITERIA_REQUIRED');
  const guideSpec = {
    routeHints: asArray(guide.routeHints),
    preferredTexts: asArray(guide.preferredTexts),
    semanticHints: asArray(guide.semanticHints),
    strictness: ['loose', 'medium', 'strict'].includes(guide.strictness) ? guide.strictness : 'medium',
    rawUserGoal: spec.rawUserGoal || spec.userInput || args.goal || null
  };
  return { spec, description: String(description), guideSpec, targetSpec };
}

function buildGoalSpecFromArgs(args, contextId) {
  const { spec, description, guideSpec, targetSpec } = normalizeGoalInput(args);
  const { screenshotPath, screenshotBytes } = resolveScreenshot(spec, args);
  const maxVerifiedPaths = number(args.maxVerifiedPaths ?? spec.resultPolicy?.maxVerifiedPaths, 1, 'maxVerifiedPaths');
  if (!Number.isInteger(maxVerifiedPaths) || maxVerifiedPaths < 1) fail('maxVerifiedPaths must be an integer greater than or equal to 1', 'GOAL_POLICY_INVALID');
  const referenceScreenshotSha256 = screenshotBytes ? sha256(screenshotBytes) : null;
  const goal = {
    schemaVersion: 2,
    goalId: safeSegment(args.goalId || spec.goalId || `goal-${hashObject(String(description)).slice(-16)}`, 'goalId'),
    type: 'guided-target',
    description,
    inputKind: referenceScreenshotSha256 ? 'guided-screenshot' : 'guided-semantic',
    referenceScreenshot: referenceScreenshotSha256 ? 'goal/target.png' : null,
    referenceScreenshotSha256,
    contextId,
    guideSpec,
    targetSpec,
    successCriteria: targetSpec,
    resultPolicy: { verifyKnownPathFirst: bool(args.verifyKnownPathFirst ?? spec.resultPolicy?.verifyKnownPathFirst, true), maxVerifiedPaths }
  };
  goal.semanticGoalHash = hashObject({
    type: goal.type,
    description: goal.description,
    contextId: goal.contextId,
    guideSpec: goal.guideSpec,
    targetSpec: goal.targetSpec
  });
  goal.goalSpecHash = hashObject({
    type: goal.type,
    description: goal.description,
    inputKind: goal.inputKind,
    referenceScreenshotSha256: goal.referenceScreenshotSha256,
    contextId: goal.contextId,
    guideSpec: goal.guideSpec,
    targetSpec: goal.targetSpec,
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
      guideSpec: spec.guideSpec || null,
      targetSpec: spec.targetSpec || spec.successCriteria
    }),
    type: spec.type || 'target-state',
    inputKind: spec.inputKind || (spec.referenceScreenshotSha256 ? 'guided-screenshot' : 'guided-semantic'),
    description: spec.description,
    contextId: spec.contextId,
    referenceScreenshot: spec.referenceScreenshot || null,
    referenceScreenshotSha256: spec.referenceScreenshotSha256 || null,
    guideSpec: spec.guideSpec || null,
    targetSpec: spec.targetSpec || spec.successCriteria || null,
    requiredTexts: spec.targetSpec?.requiredTexts || spec.successCriteria?.requiredTexts || [],
    maxVerifiedPaths: spec.resultPolicy?.maxVerifiedPaths || 1
  };
}

function writeGoalArtifacts(scanDir, goal, screenshotPath) {
  const goalDir = path.join(scanDir, 'goal');
  ensureDir(goalDir);
  if (fs.existsSync(path.join(goalDir, 'goal.json'))) fail('GoalSpec already exists; create a new Run for a different target', 'GOAL_ALREADY_PARSED');
  writeTextAtomic(path.join(goalDir, 'description.txt'), `${goal.description}\n`);
  if (screenshotPath) {
    const tempTarget = path.join(goalDir, `.target-${process.pid}.tmp`);
    fs.copyFileSync(screenshotPath, tempTarget);
    fs.renameSync(tempTarget, path.join(goalDir, 'target.png'));
  }
  writeJsonAtomic(path.join(goalDir, 'goal.json'), goal);
  writeJsonAtomic(path.join(goalDir, 'match-result.json'), { schemaVersion: 1, goalId: goal.goalId, status: 'SEARCHING', matchedVisualStateId: null, matchedReachableStateId: null, verifiedPathIds: [], candidateDecisionIds: [], alternativePathCount: 0, actionsUsed: 0, durationSeconds: 0, evidenceObservationId: null, decisions: [] });
  writeJsonAtomic(path.join(goalDir, 'verified-paths.json'), { schemaVersion: 1, goalId: goal.goalId, paths: [] });
}

module.exports = { buildGoalSpecFromArgs, goalPlanFromSpec, writeGoalArtifacts };

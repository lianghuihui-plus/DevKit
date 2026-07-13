#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  classifyPrecondition,
  normalizePlatform,
  readJson,
  workspaceRoot,
} = require('./common');

const FLOW_SCHEMA_VERSION = 2;
const FLOW_USAGE = 'precondition';
const UNIVERSAL_PLATFORM = 'universal';
const SUPPORTED_PLATFORMS = new Set(['harmony', 'android', 'ios']);
const VALID_ACTIONS = new Set(['launchApp', 'tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait']);
const VALID_COORDINATE_SOURCES = new Set(['layout', 'visual', 'pixel', 'flow']);
const MAX_ACTIONS_PER_FLOW = 5;
const MAX_ACTIONS_PER_CASE = 12;
const DESTRUCTIVE_PATTERN = /(清数据|卸载|真实支付|支付完成|真实扣款|删除|发布|修改真实|线上|生产|删除资料)/i;

function trimFlowName(value) {
  return String(value || '').trim();
}

function sha1BufferParts(parts) {
  const hash = crypto.createHash('sha1');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function safeRelativePath(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]+/).includes('..');
}

function referenceImagePaths(flow) {
  return [flow.startCondition?.referenceImage, flow.endCondition?.referenceImage]
    .filter(Boolean);
}

function flowAssetSha(flowJsonPath, flow) {
  const parts = [fs.readFileSync(flowJsonPath)];
  for (const relative of referenceImagePaths(flow).sort()) {
    if (!safeRelativePath(relative)) throw new Error(`Invalid Flow referenceImage path: ${relative}`);
    const file = path.join(path.dirname(flowJsonPath), relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Flow referenceImage does not exist: ${file}`);
    }
    parts.push(relative, fs.readFileSync(file));
  }
  return `flow-asset-${sha1BufferParts(parts).slice(0, 12)}`;
}

function validateCondition(condition, label, flowJsonPath) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new Error(`${flowJsonPath}: ${label} must be an object`);
  }
  if (!trimFlowName(condition.description)) {
    throw new Error(`${flowJsonPath}: ${label}.description is required`);
  }
  if (condition.referenceImage && !safeRelativePath(condition.referenceImage)) {
    throw new Error(`${flowJsonPath}: ${label}.referenceImage must be a safe relative path`);
  }
}

function finiteNumber(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function positiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function validateCoordinateAction(action, label, flowJsonPath) {
  const hasTarget = Boolean(trimFlowName(action.target));
  const hasX = action.x !== undefined;
  const hasY = action.y !== undefined;
  if (!hasTarget && !hasX && !hasY) {
    throw new Error(`${flowJsonPath}: ${label} requires target or x/y coordinates`);
  }
  if (hasX !== hasY || (hasX && (!finiteNumber(action.x) || !finiteNumber(action.y)))) {
    throw new Error(`${flowJsonPath}: ${label} coordinates require finite x and y`);
  }
  if (!hasX) return;
  if (!VALID_COORDINATE_SOURCES.has(action.coordinateSource)) {
    throw new Error(`${flowJsonPath}: ${label} coordinates require coordinateSource layout, visual, pixel, or flow`);
  }
  if (!trimFlowName(action.coordinateEvidence)) {
    throw new Error(`${flowJsonPath}: ${label} coordinates require coordinateEvidence`);
  }
  if (['visual', 'pixel', 'flow'].includes(action.coordinateSource) &&
    (!Array.isArray(action.targetBounds) || action.targetBounds.length !== 4 || !action.targetBounds.every(finiteNumber))) {
    throw new Error(`${flowJsonPath}: ${label} ${action.coordinateSource} coordinates require targetBounds [x1,y1,x2,y2]`);
  }
}

function validateFlowAction(action, label, flowJsonPath) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new Error(`${flowJsonPath}: ${label} must be an object`);
  }
  if (!VALID_ACTIONS.has(action.type)) throw new Error(`${flowJsonPath}: unsupported ${label}.type: ${action.type}`);
  if (['tap', 'toggle', 'longPress'].includes(action.type)) validateCoordinateAction(action, label, flowJsonPath);
  if (action.type === 'longPress' && action.durationMs !== undefined && !positiveInteger(action.durationMs)) {
    throw new Error(`${flowJsonPath}: ${label}.durationMs must be a positive integer`);
  }
  if (action.type === 'inputText') {
    if (!trimFlowName(action.target)) throw new Error(`${flowJsonPath}: ${label}.target is required for inputText`);
    if (typeof action.text !== 'string' || action.text.length === 0) throw new Error(`${flowJsonPath}: ${label}.text is required for inputText`);
  }
  if (action.type === 'swipe') {
    for (const field of ['fromX', 'fromY', 'toX', 'toY']) {
      if (!finiteNumber(action[field])) throw new Error(`${flowJsonPath}: ${label}.${field} is required for swipe`);
    }
    if (action.velocity !== undefined && !positiveInteger(action.velocity)) {
      throw new Error(`${flowJsonPath}: ${label}.velocity must be a positive integer`);
    }
  }
  if (action.type === 'wait') {
    if (!positiveInteger(action.ms)) throw new Error(`${flowJsonPath}: ${label}.ms must be a positive integer for wait`);
    if (!trimFlowName(action.reason)) throw new Error(`${flowJsonPath}: ${label}.reason is required for wait`);
  }
  if (action.type === 'launchApp' && !trimFlowName(action.reason)) {
    throw new Error(`${flowJsonPath}: ${label}.reason is required for launchApp`);
  }
}

function validateFlow(flow, flowJsonPath, expectedPlatform) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) throw new Error(`${flowJsonPath}: flow.json must be an object`);
  if (flow.schemaVersion !== FLOW_SCHEMA_VERSION) throw new Error(`${flowJsonPath}: schemaVersion must be ${FLOW_SCHEMA_VERSION}`);
  if (!trimFlowName(flow.id)) throw new Error(`${flowJsonPath}: id is required`);
  if (!trimFlowName(flow.name)) throw new Error(`${flowJsonPath}: name is required`);
  if (flow.usage !== FLOW_USAGE) throw new Error(`${flowJsonPath}: usage must be ${FLOW_USAGE}`);
  const platform = flow.platform === UNIVERSAL_PLATFORM ? UNIVERSAL_PLATFORM : normalizePlatform(flow.platform);
  if (!platform) throw new Error(`${flowJsonPath}: platform must be universal, harmony, android, or ios`);
  if (platform !== expectedPlatform) throw new Error(`${flowJsonPath}: platform ${flow.platform} does not match directory platform ${expectedPlatform}`);
  validateCondition(flow.startCondition, 'startCondition', flowJsonPath);
  validateCondition(flow.endCondition, 'endCondition', flowJsonPath);
  if (trimFlowName(flow.startCondition.description) === trimFlowName(flow.endCondition.description)) {
    throw new Error(`${flowJsonPath}: startCondition and endCondition must be distinguishable`);
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) throw new Error(`${flowJsonPath}: steps must contain at least one action`);
  if (flow.steps.length > MAX_ACTIONS_PER_FLOW) {
    throw new Error(`PRECONDITION_FLOW_BUDGET_EXCEEDED: ${flowJsonPath}: steps exceed ${MAX_ACTIONS_PER_FLOW}`);
  }
  const ids = new Set();
  for (const [index, step] of flow.steps.entries()) {
    const label = `steps[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${flowJsonPath}: ${label} must be an object`);
    if (!trimFlowName(step.id)) throw new Error(`${flowJsonPath}: ${label}.id is required`);
    if (ids.has(step.id)) throw new Error(`${flowJsonPath}: duplicate Flow step id: ${step.id}`);
    ids.add(step.id);
    if (!trimFlowName(step.instruction)) throw new Error(`${flowJsonPath}: ${label}.instruction is required`);
    validateFlowAction(step.action, `${label}.action`, flowJsonPath);
    const safetyText = [step.instruction, step.action.target, step.action.text, step.action.reason].filter(Boolean).join(' ');
    if (DESTRUCTIVE_PATTERN.test(safetyText)) throw new Error(`${flowJsonPath}: unsafe Flow action is not allowed: ${safetyText}`);
  }
  flowAssetSha(flowJsonPath, flow);
  return flow;
}

function loadVariant(flowJsonPath, root, expectedPlatform, businessDir) {
  const flow = readJson(flowJsonPath, null);
  validateFlow(flow, flowJsonPath, expectedPlatform);
  return {
    flowId: flow.id,
    name: trimFlowName(flow.name),
    usage: flow.usage,
    platform: expectedPlatform,
    flowPath: path.relative(root, flowJsonPath).replace(/\\/g, '/'),
    flowSha1: flowAssetSha(flowJsonPath, flow),
    businessDir: path.basename(businessDir),
    flow,
  };
}

function loadBusinessFlow(root, businessDir, platform) {
  const universalPath = path.join(businessDir, 'flow.json');
  const platformPath = path.join(businessDir, platform, 'flow.json');
  const universal = fs.existsSync(universalPath)
    ? loadVariant(universalPath, root, UNIVERSAL_PLATFORM, businessDir)
    : null;
  const specific = fs.existsSync(platformPath)
    ? loadVariant(platformPath, root, platform, businessDir)
    : null;
  if (universal && specific && universal.name !== specific.name) {
    throw new Error(`${businessDir}: platform Flow name must match universal Flow name: ${specific.name} != ${universal.name}`);
  }
  return specific || universal;
}

function loadPreconditionFlows(cwd, platform) {
  const normalizedPlatform = normalizePlatform(platform);
  if (!normalizedPlatform || !SUPPORTED_PLATFORMS.has(normalizedPlatform)) {
    throw new Error('Precondition Flow loading requires --platform <harmony|android|ios>');
  }
  const root = workspaceRoot(cwd);
  const flowsRoot = path.join(root, 'flows', 'preconditions');
  if (!fs.existsSync(flowsRoot)) return { workspaceRoot: root, flowsRoot, platform: normalizedPlatform, flows: [], byName: new Map() };
  const flows = [];
  for (const name of fs.readdirSync(flowsRoot).sort()) {
    const businessDir = path.join(flowsRoot, name);
    if (!fs.statSync(businessDir).isDirectory()) continue;
    const selected = loadBusinessFlow(root, businessDir, normalizedPlatform);
    if (selected) flows.push(selected);
  }
  const byName = new Map();
  for (const item of flows) {
    if (byName.has(item.name)) {
      const previous = byName.get(item.name);
      throw new Error(`PRECONDITION_FLOW_AMBIGUOUS: duplicate Flow name for ${normalizedPlatform}: ${item.name}; ${previous.flowPath}, ${item.flowPath}`);
    }
    byName.set(item.name, item);
  }
  return { workspaceRoot: root, flowsRoot, platform: normalizedPlatform, flows, byName };
}

function planEntry(precondition, flowIndex) {
  const text = String(precondition.text || '');
  const matched = flowIndex.byName.get(trimFlowName(text));
  if (matched) {
    return {
      id: precondition.id,
      text,
      checkMode: precondition.checkMode || '',
      resolution: 'flow',
      status: 'READY',
      category: 'flow',
      defaultResolution: 'flow',
      flowId: matched.flowId,
      flowName: matched.name,
      flowPath: matched.flowPath,
      flowSha1: matched.flowSha1,
      flowPlatform: matched.platform,
      flow: matched.flow,
    };
  }
  const classification = classifyPrecondition(precondition);
  const resolution = classification.status === 'READY'
    ? 'framework'
    : classification.status === 'CONFIRM'
      ? 'confirm'
      : classification.status === 'NEEDS_SETUP' || classification.status === 'UNKNOWN'
        ? 'external_setup'
        : 'unsupported';
  return {
    id: precondition.id,
    text,
    checkMode: precondition.checkMode || '',
    resolution,
    ...classification,
  };
}

function planHashInput(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    platform: plan.platform,
    preconditions: plan.preconditions.map((item) => ({
      id: item.id,
      text: item.text,
      checkMode: item.checkMode,
      resolution: item.resolution,
      status: item.status,
      category: item.category,
      flowId: item.flowId,
      flowName: item.flowName,
      flowPath: item.flowPath,
      flowSha1: item.flowSha1,
      flowPlatform: item.flowPlatform,
    })),
  };
}

function buildPreconditionPlan(caseJson, cwd, platform) {
  const flowIndex = loadPreconditionFlows(cwd, platform);
  const plan = {
    schemaVersion: 1,
    platform: flowIndex.platform,
    preconditions: (Array.isArray(caseJson.preconditions) ? caseJson.preconditions : [])
      .map((item) => planEntry(item, flowIndex)),
  };
  const plannedActions = plan.preconditions
    .filter((item) => item.resolution === 'flow')
    .reduce((total, item) => total + item.flow.steps.length, 0);
  if (plannedActions > MAX_ACTIONS_PER_CASE) {
    throw new Error(`PRECONDITION_FLOW_BUDGET_EXCEEDED: case precondition Flow actions exceed ${MAX_ACTIONS_PER_CASE}: ${plannedActions}`);
  }
  plan.preconditionPlanSha = `precondition-plan-${sha1BufferParts([JSON.stringify(planHashInput(plan))]).slice(0, 12)}`;
  return plan;
}

function planFlowSummaries(plan) {
  return plan.preconditions
    .filter((item) => item.resolution === 'flow')
    .map((item) => ({
      preconditionId: item.id,
      flowId: item.flowId,
      flowName: item.flowName,
      flowPath: item.flowPath,
      flowSha1: item.flowSha1,
      flowPlatform: item.flowPlatform,
    }));
}

module.exports = {
  FLOW_SCHEMA_VERSION,
  MAX_ACTIONS_PER_CASE,
  MAX_ACTIONS_PER_FLOW,
  buildPreconditionPlan,
  loadPreconditionFlows,
  planFlowSummaries,
  trimFlowName,
  validateFlow,
  validateFlowAction,
};

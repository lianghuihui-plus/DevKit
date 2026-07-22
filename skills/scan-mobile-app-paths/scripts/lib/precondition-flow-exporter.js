'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fail, ensureDir, readJson, writeJsonAtomic, sha256, hashObject, slug, safeSegment } = require('./common');
const { edgeReplayabilityReason } = require('./replayability');

const MAX_FLOW_STEPS = 5;
const FLOW_USAGE = 'precondition';
const FLOW_SCHEMA_VERSION = 2;
const SUPPORTED_PLATFORMS = new Set(['harmony', 'android', 'ios', 'universal']);
const DESTRUCTIVE_PATTERN = /(支付|付款|购买|充值|转账|注销账号|删除账号|永久删除|删除|发布|发送给|提交审核|密码|验证码|银行卡|身份证|clear\s+(app\s+)?data|uninstall|pay|payment|purchase|buy|delete|publish|password|otp)/i;
const FLOW_ACTION_TYPES = new Set(['tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home']);

function checksum(value) { return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validBounds(value) { return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1]; }
function center(bounds) { return { x: Math.round((bounds[0] + bounds[2]) / 2), y: Math.round((bounds[1] + bounds[3]) / 2) }; }
function trim(value) { return String(value || '').trim(); }

function graphIndex(graph) {
  return {
    logicalById: new Map((graph.logicalScreens || []).map(item => [item.id, item])),
    visualById: new Map((graph.visualStates || []).map(item => [item.id, item])),
    stateById: new Map((graph.reachableStates || []).map(item => [item.id, item])),
    edgeById: new Map((graph.edges || []).map(item => [item.id, item]))
  };
}

function logicalForState(index, stateId) {
  const state = index.stateById.get(stateId);
  const visual = state && index.visualById.get(state.visualStateId);
  return visual && index.logicalById.get(visual.logicalScreenKey);
}

function pathEdges(graph, pathItem) {
  const index = graphIndex(graph);
  return (pathItem.edgeIds || []).map(edgeId => index.edgeById.get(edgeId)).filter(Boolean);
}

function edgeActionType(action = {}) {
  if (action.type === 'keyEvent' && String(action.key || '').toUpperCase() === 'BACK') return 'back';
  if (action.type === 'keyEvent' && String(action.key || '').toUpperCase() === 'HOME') return 'home';
  return action.type;
}

function actionSafetyText(action = {}) {
  return [action.target, action.text, action.value, action.selector?.text, action.selector?.accessibilityLabel, action.selector?.resourceId, action.reason].filter(Boolean).join(' ');
}

function unsupportedActionReason(action = {}) {
  const type = edgeActionType(action);
  if (!FLOW_ACTION_TYPES.has(type)) return `UNSUPPORTED_ACTION_${String(action.type || 'UNKNOWN').toUpperCase()}`;
  if (DESTRUCTIVE_PATTERN.test(actionSafetyText(action))) return 'UNSAFE_ACTION_TEXT';
  if (['tap', 'toggle', 'longPress'].includes(type)) {
    if (!actionTarget(action)) return 'SEMANTIC_TARGET_MISSING';
  }
  if (type === 'inputText') {
    if (!trim(action.target)) return 'INPUT_TARGET_MISSING';
    if (typeof (action.text ?? action.value) !== 'string' || !String(action.text ?? action.value).length) return 'INPUT_TEXT_MISSING';
  }
  if (type === 'swipe') {
    return 'SWIPE_REQUIRES_DEVICE_BOUND_COORDINATES';
  }
  return null;
}

function summarizePathExportability(graph, pathItem, { manual = pathItem.manualExport === true } = {}) {
  const index = graphIndex(graph);
  const reasons = [];
  const warnings = [];
  const edgeIds = pathItem.edgeIds || [];
  if (!edgeIds.length) reasons.push('FLOW_PATH_EMPTY');
  if (edgeIds.length > MAX_FLOW_STEPS) reasons.push('FLOW_PATH_TOO_LONG');
  let cursor = graph.reachableStates?.find(state => Number(state.depth?.pathDepth || 0) === 0)?.id || null;
  for (const edgeId of edgeIds) {
    const edge = index.edgeById.get(edgeId);
    if (!edge) { reasons.push(`EDGE_MISSING:${edgeId}`); continue; }
    if (cursor && edge.fromReachableStateId !== cursor) reasons.push(`PATH_NOT_CONTIGUOUS:${edge.id}`);
    cursor = edge.toReachableStateId;
    const actionReason = unsupportedActionReason(edge.intent || {});
    if (actionReason) reasons.push(`${actionReason}:${edge.id}`);
    const replayReason = edgeReplayabilityReason(edge);
    const manualReviewable = manual && ['EDGE_LOCATOR_NOT_PORTABLE', 'EDGE_LOCATOR_UNRESOLVED', 'EDGE_LOCATOR_NOT_RESOLVED', 'EDGE_REPLAY_REPLAY_UNSTABLE', 'EDGE_REPLAY_INVALIDATED'].includes(replayReason);
    if (replayReason && manualReviewable) warnings.push(`${replayReason}:${edge.id}`);
    else if (replayReason) reasons.push(`${replayReason}:${edge.id}`);
    const replayStatus = edge.verification?.replayStatus || 'UNVERIFIED';
    if (replayStatus !== 'COLD_REPLAY_VERIFIED') warnings.push(`EDGE_NOT_COLD_REPLAY_VERIFIED:${edge.id}`);
    if (edge.locatorQuality === 'SEMANTIC_WITH_FALLBACK') warnings.push(`EDGE_HAS_COORDINATE_EVIDENCE_FALLBACK:${edge.id}`);
  }
  if (cursor !== pathItem.terminalReachableStateId) reasons.push('PATH_TERMINAL_MISMATCH');
  return { exportable: reasons.length === 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)] };
}

function actionTarget(action = {}) {
  return trim(action.target || action.selector?.text || action.selector?.accessibilityLabel || action.selector?.resourceId);
}

function instructionFor(action = {}) {
  const type = edgeActionType(action);
  const target = actionTarget(action);
  if (type === 'tap') return target ? `点击${target}` : '点击指定位置';
  if (type === 'toggle') return target ? `切换${target}` : '切换指定开关';
  if (type === 'longPress') return target ? `长按${target}` : '长按指定位置';
  if (type === 'inputText') return `在${target}输入文本`;
  if (type === 'swipe') return '滑动页面';
  if (type === 'back') return '返回上一页';
  if (type === 'home') return '返回系统桌面';
  return '执行操作';
}

function coordinateFields(edge, pathItem) {
  const evidence = edge.locatorEvidence || {};
  const bounds = validBounds(evidence.fallbackBounds) ? evidence.fallbackBounds.map(Number) : null;
  if (bounds) {
    return { ...center(bounds), coordinateSource: 'flow', targetBounds: bounds, coordinateEvidence: `SMAP verified path ${pathItem.id}, edge ${edge.id}` };
  }
  if (Number.isFinite(Number(evidence.tapPoint?.x)) && Number.isFinite(Number(evidence.tapPoint?.y))) {
    return { x: Number(evidence.tapPoint.x), y: Number(evidence.tapPoint.y), coordinateSource: 'locatorEvidence', coordinateEvidence: `SMAP verified path ${pathItem.id}, edge ${edge.id}` };
  }
  return {};
}

function flowActionFor(edge, pathItem, { includeCoordinates = false } = {}) {
  const source = edge.intent || {};
  const type = edgeActionType(source);
  if (type === 'back' || type === 'home') return { type };
  if (type === 'swipe') return { type, fromX: Number(source.fromX), fromY: Number(source.fromY), toX: Number(source.toX), toY: Number(source.toY), ...(source.velocity ? { velocity: Number(source.velocity) } : {}) };
  if (type === 'inputText') return { type, target: actionTarget(source), text: String(source.text ?? source.value) };
  const action = { type };
  const target = actionTarget(source);
  if (target) action.target = target;
  if (type === 'longPress' && source.durationMs) action.durationMs = Number(source.durationMs);
  if (includeCoordinates) Object.assign(action, coordinateFields(edge, pathItem));
  return action;
}

function conditionDescription(kind, logical) {
  const name = trim(logical?.name) || (kind === 'start' ? '起点页面' : '目标页面');
  return kind === 'start'
    ? `当前位于${name}，页面展示稳定可识别的${name}内容。`
    : `当前位于${name}，页面展示稳定可识别的${name}内容。`;
}

function buildFlowFromPath({ graph, pathItem, name, business, flowId, platform = 'harmony', startDescription = null, endDescription = null, includeCoordinates = false }) {
  if (!SUPPORTED_PLATFORMS.has(platform)) fail('Flow export platform must be harmony, android, ios or universal', 'FLOW_PLATFORM_INVALID');
  const flowName = trim(name);
  if (!flowName) fail('--name is required', 'ARG_REQUIRED');
  const businessId = business ? safeSegment(business, 'business') : slug(flowName, 'precondition-flow');
  const summary = summarizePathExportability(graph, pathItem);
  if (!summary.exportable) fail('Selected path cannot be exported as a precondition Flow', 'FLOW_PATH_NOT_EXPORTABLE', 2, { reasons: summary.reasons, warnings: summary.warnings });
  const index = graphIndex(graph);
  const edges = pathEdges(graph, pathItem);
  const firstEdge = edges[0];
  const lastEdge = edges.at(-1);
  const startLogical = logicalForState(index, firstEdge.fromReachableStateId);
  const endLogical = logicalForState(index, pathItem.terminalReachableStateId);
  const startText = trim(startDescription) || conditionDescription('start', startLogical);
  let endText = trim(endDescription) || conditionDescription('end', endLogical);
  if (startText === endText) endText = `${endText}（Flow 终点状态）`;
  const flow = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: flowId || `flow-${businessId}`,
    name: flowName,
    usage: FLOW_USAGE,
    platform,
    startCondition: { description: startText, referenceImage: 'assets/start.png' },
    endCondition: { description: endText, referenceImage: 'assets/end.png' },
    steps: edges.map((edge, index) => ({
      id: `flow-step-${String(index + 1).padStart(3, '0')}`,
      instruction: instructionFor(edge.intent),
      action: flowActionFor(edge, pathItem, { includeCoordinates })
    }))
  };
  return {
    flow,
    business: businessId,
    platform,
    source: {
      pathId: pathItem.id,
      terminalReachableStateId: pathItem.terminalReachableStateId,
      contextId: graph.contextId,
      startObservationRef: { runId: firstEdge.evidence?.sourceRunId || firstEdge.provenance?.at(-1)?.runId || null, observationId: firstEdge.evidence?.beforeObservationId || null },
      endObservationRef: { runId: lastEdge.evidence?.sourceRunId || lastEdge.provenance?.at(-1)?.runId || null, observationId: lastEdge.evidence?.afterObservationId || null },
      warnings: summary.warnings
    }
  };
}

function candidateForPath(graph, pathItem) {
  const index = graphIndex(graph);
  const terminal = index.stateById.get(pathItem.terminalReachableStateId);
  const logical = logicalForState(index, pathItem.terminalReachableStateId);
  const edges = pathEdges(graph, pathItem);
  const summary = summarizePathExportability(graph, pathItem);
  return {
    pathId: pathItem.id,
    contextId: graph.contextId,
    terminalReachableStateId: pathItem.terminalReachableStateId,
    terminalLogicalScreenId: logical?.id || null,
    terminalName: logical?.name || terminal?.id || pathItem.terminalReachableStateId,
    stepCount: edges.length,
    edgeIds: pathItem.edgeIds || [],
    exportable: summary.exportable,
    reasons: summary.reasons,
    warnings: summary.warnings,
    steps: edges.map(edge => ({ edgeId: edge.id, type: edgeActionType(edge.intent), target: actionTarget(edge.intent), replayStatus: edge.verification?.replayStatus || 'UNVERIFIED', locatorQuality: edge.locatorQuality || null }))
  };
}

function listPathCandidates(graph) {
  return (graph.paths || [])
    .map(pathItem => candidateForPath(graph, pathItem))
    .sort((a, b) => Number(b.exportable) - Number(a.exportable) || a.stepCount - b.stepCount || a.terminalName.localeCompare(b.terminalName) || a.pathId.localeCompare(b.pathId));
}

function selectPath(graph, selector = {}) {
  const paths = graph.paths || [];
  let matches = paths;
  if (selector.pathId) matches = matches.filter(item => item.id === selector.pathId);
  if (selector.terminalReachableStateId) matches = matches.filter(item => item.terminalReachableStateId === selector.terminalReachableStateId);
  if (selector.logicalScreenId || selector.logicalName) {
    const index = graphIndex(graph);
    matches = matches.filter(item => {
      const logical = logicalForState(index, item.terminalReachableStateId);
      if (selector.logicalScreenId && logical?.id !== selector.logicalScreenId) return false;
      if (selector.logicalName && trim(logical?.name) !== trim(selector.logicalName)) return false;
      return true;
    });
  }
  if (!matches.length) fail('No path matches the requested selector', 'FLOW_PATH_NOT_FOUND');
  if (matches.length > 1) fail('Multiple paths match the requested selector', 'FLOW_PATH_AMBIGUOUS', 2, { candidates: matches.map(item => candidateForPath(graph, item)) });
  return matches[0];
}

function flowOutputLayout(workspace, business, platform) {
  const workspaceRoot = path.resolve(workspace);
  const businessDir = path.join(workspaceRoot, safeSegment(business, 'business'));
  const flowDir = platform === 'universal' ? businessDir : path.join(businessDir, platform);
  return { workspaceRoot, businessDir, flowDir, assetsDir: path.join(flowDir, 'assets'), flowJsonPath: path.join(flowDir, 'flow.json') };
}

function copyAtomic(source, target) {
  ensureDir(path.dirname(target));
  const temp = `${target}.tmp-${process.pid}-${hashObject([source, target]).slice(-8)}`;
  fs.writeFileSync(temp, fs.readFileSync(source), { mode: 0o600 });
  fs.renameSync(temp, target);
}

function observationScreenshot(appMapRoot, ref, label) {
  if (!ref?.runId || !ref?.observationId) fail(`Missing ${label} observation evidence for Flow reference image`, 'FLOW_EVIDENCE_MISSING');
  const runId = safeSegment(ref.runId, `${label} runId`);
  const observationId = safeSegment(ref.observationId, `${label} observationId`);
  const file = path.join(appMapRoot, 'runs', runId, 'evidence', 'observations', observationId, 'screenshot.png');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Missing ${label} screenshot evidence: ${file}`, 'FLOW_EVIDENCE_MISSING');
  return file;
}

function selectedFlowFiles(workspaceRoot, platform) {
  const flowsRoot = workspaceRoot;
  if (!fs.existsSync(flowsRoot)) return [];
  const files = [];
  for (const business of fs.readdirSync(flowsRoot).sort()) {
    const businessDir = path.join(flowsRoot, business);
    if (!fs.statSync(businessDir).isDirectory()) continue;
    const universal = path.join(businessDir, 'flow.json');
    const specific = path.join(businessDir, platform, 'flow.json');
    if (fs.existsSync(specific)) files.push(specific);
    else if (fs.existsSync(universal)) files.push(universal);
  }
  return files;
}

function assertNoDuplicateName(workspaceRoot, platform, flowName, outputPath) {
  for (const file of selectedFlowFiles(workspaceRoot, platform)) {
    if (path.resolve(file) === path.resolve(outputPath)) continue;
    const flow = readJson(file, null);
    if (trim(flow?.name) === trim(flowName)) fail(`Duplicate precondition Flow name for ${platform}: ${flowName}`, 'FLOW_NAME_DUPLICATE', 2, { existingFlowPath: file });
  }
}

function validateWithTargetLoader(workspaceRoot, platform) {
  const loader = path.join(workspaceRoot, 'scripts', 'flow', 'load-precondition-flows.js');
  if (!fs.existsSync(loader)) return { skipped: true, reasonCode: 'TARGET_LOADER_NOT_FOUND' };
  const result = spawnSync(process.execPath, [loader, '--cwd', workspaceRoot, '--platform', platform === 'universal' ? 'harmony' : platform], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) fail('Target precondition Flow loader rejected exported assets', 'FLOW_TARGET_VALIDATION_FAILED', 2, { stderr: result.stderr.trim(), stdout: result.stdout.trim() });
  return { skipped: false, result: JSON.parse(result.stdout) };
}

function writeFlowAssets({ appMapRoot, workspace, exportPlan, overwrite = false, validateTarget = true }) {
  const { flow, business, platform, source } = exportPlan;
  const layout = flowOutputLayout(workspace, business, platform);
  if (fs.existsSync(layout.flowJsonPath) && !overwrite) fail(`Flow already exists: ${layout.flowJsonPath}`, 'FLOW_OUTPUT_EXISTS');
  assertNoDuplicateName(layout.workspaceRoot, platform === 'universal' ? 'harmony' : platform, flow.name, layout.flowJsonPath);
  ensureDir(layout.assetsDir);
  copyAtomic(observationScreenshot(appMapRoot, source.startObservationRef, 'start'), path.join(layout.assetsDir, 'start.png'));
  copyAtomic(observationScreenshot(appMapRoot, source.endObservationRef, 'end'), path.join(layout.assetsDir, 'end.png'));
  writeJsonAtomic(layout.flowJsonPath, flow);
  const validation = validateTarget ? validateWithTargetLoader(layout.workspaceRoot, platform) : { skipped: true, reasonCode: 'VALIDATION_DISABLED' };
  return { ok: true, flowPath: layout.flowJsonPath, assets: [path.join(layout.assetsDir, 'start.png'), path.join(layout.assetsDir, 'end.png')], validation };
}

module.exports = {
  MAX_FLOW_STEPS,
  checksum,
  clone,
  graphIndex,
  summarizePathExportability,
  candidateForPath,
  listPathCandidates,
  selectPath,
  buildFlowFromPath,
  flowOutputLayout,
  writeFlowAssets
};

#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  className,
  displayAction,
  displayDecision,
  displayEventType,
  displayFailureCode,
  displayPreconditionMode,
  displayStatus,
  displayStepGoal,
  escapeHtml,
  formatActionSummary,
  formatCell,
  formatDisplayTime,
  formatDuration,
} = require('./display-format');

const WORKSPACE_TYPE = 'mobile-ai-visual-test-workspace';
const PRECONDITION_STATUS_PRIORITY = {
  READY: 1,
  CONFIRM: 2,
  NEEDS_SETUP: 3,
  UNKNOWN: 4,
  UNSUPPORTED: 5,
};
const PRECONDITION_STATUS_LABELS = {
  READY: '可执行',
  CONFIRM: '需确认',
  NEEDS_SETUP: '需准备',
  UNKNOWN: '待判断',
  UNSUPPORTED: '不支持',
};

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function caseContractSha(caseJson = {}) {
  const contract = {
    sourceSha1: caseJson.identity?.sourceSha1 || '',
    preconditions: Array.isArray(caseJson.preconditions) ? caseJson.preconditions : [],
    globalRules: Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [],
  };
  if (caseJson.isolation && typeof caseJson.isolation === 'object') {
    contract.isolation = caseJson.isolation;
  }
  const stepHints = Array.isArray(caseJson.steps)
    ? caseJson.steps
      .map((step) => ({
        id: step.id,
        hints: Array.isArray(step.hints) ? step.hints.filter(Boolean) : [],
      }))
      .filter((item) => item.id && item.hints.length)
    : [];
  if (stepHints.length) contract.stepHints = stepHints;
  return `contract-${sha1(stableJson(contract)).slice(0, 12)}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(readText(file));
}

function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

function appendJsonl(file, data) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(data)}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return readText(file)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function slugify(text) {
  const ascii = text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return ascii || 'case';
}

function formatLocalIso(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offsetMins = String(absOffset % 60).padStart(2, '0');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMins}`;
}

function nowIso() {
  return formatLocalIso();
}

function pad3(index) {
  return String(index).padStart(3, '0');
}

function workspaceMarkerPath(root) {
  return path.join(root, 'workspace.json');
}

function isIgnorableWorkspaceEntry(name) {
  return name === '.DS_Store';
}

function isWorkspaceEmpty(root) {
  return fs.readdirSync(root).filter((name) => !isIgnorableWorkspaceEntry(name)).length === 0;
}

function readWorkspaceConfig(root) {
  const config = readJson(workspaceMarkerPath(root), null);
  return config && config.type === WORKSPACE_TYPE ? config : null;
}

function containsCaseJson(casesDir) {
  if (!fs.existsSync(casesDir) || !fs.statSync(casesDir).isDirectory()) return false;
  return fs.readdirSync(casesDir).some((name) => {
    const caseDir = path.join(casesDir, name);
    return fs.statSync(caseDir).isDirectory() && fs.existsSync(path.join(caseDir, 'case.json'));
  });
}

function hasWorkspaceShape(root) {
  const casesDir = path.join(root, 'cases');
  const flowsDir = path.join(root, 'flows');
  const hasCases = fs.existsSync(casesDir) && fs.statSync(casesDir).isDirectory();
  const hasFlows = fs.existsSync(flowsDir) && fs.statSync(flowsDir).isDirectory();
  const hasIndex = fs.existsSync(path.join(root, 'index.html'));
  return (hasCases && (hasFlows || hasIndex || containsCaseJson(casesDir))) || (hasFlows && hasIndex);
}

function initializeWorkspace(root) {
  const createdAt = nowIso();
  ensureDir(path.join(root, 'cases'));
  ensureDir(path.join(root, 'flows'));
  writeJson(workspaceMarkerPath(root), {
    schemaVersion: 1,
    type: WORKSPACE_TYPE,
    name: path.basename(root),
    createdAt,
    updatedAt: createdAt,
  });
  renderIndexForRoot(root);
}

function workspaceRoot(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root)) {
    throw new Error(`工作空间目录不存在: ${root}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`工作空间路径不是目录: ${root}`);
  }
  if (readWorkspaceConfig(root)) return root;
  if (isWorkspaceEmpty(root)) {
    initializeWorkspace(root);
    return root;
  }
  if (hasWorkspaceShape(root)) {
    initializeWorkspace(root);
    return root;
  }
  throw new Error(`当前目录不是 mobile-ai-visual-test 工作空间: ${root}。请进入空目录，或进入已有测试工作空间目录后重新执行 skill。`);
}

function casesRoot(cwd = process.cwd()) {
  return path.join(workspaceRoot(cwd), 'cases');
}

const PLATFORM_ORDER = ['android', 'ios', 'harmony'];

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return PLATFORM_ORDER.includes(platform) ? platform : '';
}

function platformSortIndex(value) {
  const index = PLATFORM_ORDER.indexOf(normalizePlatform(value));
  return index >= 0 ? index : PLATFORM_ORDER.length;
}

function casePlatformDir(caseDir, platform) {
  const normalized = normalizePlatform(platform);
  if (!normalized) throw new Error(`无效平台: ${platform}`);
  return path.join(caseDir, 'platforms', normalized);
}

function caseRuntimeDir(caseDir, platform = '') {
  const normalized = normalizePlatform(platform);
  return normalized ? casePlatformDir(caseDir, normalized) : caseDir;
}

function platformStatePath(caseDir, platform = '') {
  return path.join(caseRuntimeDir(caseDir, platform), 'state.json');
}

function normalizeCaseNo(value) {
  const match = String(value || '').trim().match(/^C(\d+)$/i);
  return match ? `C${String(Number(match[1])).padStart(3, '0')}` : '';
}

function caseNoNumber(value) {
  const match = normalizeCaseNo(value).match(/^C(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function readCaseEntries(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((caseDir) => fs.statSync(caseDir).isDirectory())
    .map((caseDir) => {
      const caseJson = readJson(path.join(caseDir, 'case.json'), null);
      return caseJson ? { caseDir, caseJson } : null;
    })
    .filter(Boolean);
}

function nextCaseNo(root) {
  const max = readCaseEntries(root).reduce((acc, entry) => {
    const fromJson = caseNoNumber(entry.caseJson.identity?.caseNo);
    const fromDir = caseNoNumber(path.basename(entry.caseDir).split('__')[0]);
    return Math.max(acc, fromJson, fromDir);
  }, 0);
  return `C${String(max + 1).padStart(3, '0')}`;
}

function caseDirectoryName(caseJson = {}) {
  const identity = caseJson.identity || {};
  const parts = [
    normalizeCaseNo(identity.caseNo),
    slugify(identity.title || 'case'),
    identity.caseKey,
  ].filter(Boolean);
  return parts.join('__');
}

function desiredCaseDir(root, caseJson) {
  return path.join(root, caseDirectoryName(caseJson));
}

function syncCaseDirectory(root, currentDir, caseJson) {
  const expectedPrefix = `${normalizeCaseNo(caseJson.identity?.caseNo)}__`;
  if (!expectedPrefix || path.basename(currentDir).startsWith(expectedPrefix)) return currentDir;
  const targetDir = desiredCaseDir(root, caseJson);
  if (path.resolve(currentDir) === path.resolve(targetDir)) return currentDir;
  if (fs.existsSync(targetDir)) throw new Error(`目标用例目录已存在: ${targetDir}`);
  ensureDir(path.dirname(targetDir));
  fs.renameSync(currentDir, targetDir);
  return targetDir;
}

function extractTitle(markdown, file) {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : path.basename(file, path.extname(file));
}

function sectionLines(markdown, headingNames) {
  const lines = markdown.split(/\r?\n/);
  const headings = headingNames.map((name) => name.toLowerCase());
  let active = false;
  const out = [];
  for (const line of lines) {
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[2].trim().toLowerCase();
      active = headings.includes(name);
      continue;
    }
    if (active) out.push(line);
  }
  return out;
}

function parsePreconditions(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/^[（(]\d+[）)]\s*/, '')
      .replace(/^[一二三四五六七八九十]+[、.)]\s*/, '')
      .trim())
    .filter(Boolean);
}

function parseOrderedSteps(lines) {
  return lines
    .map((line) => line.match(/^\s*\d+[.)、]\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

function classifyStep(text) {
  if (/打开.*App|启动.*App|拉起/.test(text)) return { kind: 'action', goal: 'launch_app' };
  if (/开关|toggle/i.test(text) || /(切换|开启|关闭|启用|禁用).*(功能|权限|模式|选项|设置|通知)/.test(text)) return { kind: 'action', goal: 'toggle', target: extractQuoted(text) };
  if (/长按|long\s*press/i.test(text)) return { kind: 'action', goal: 'long_press', target: extractQuoted(text) };
  if (/点击|点按|选择/.test(text)) return { kind: 'action', goal: 'tap', target: extractQuoted(text) };
  if (/输入|填写/.test(text)) return { kind: 'action', goal: 'input_text', value: extractValue(text), target: extractInputTarget(text) };
  if (/滑动|上滑|下滑|左滑|右滑/.test(text)) return { kind: 'action', goal: 'swipe' };
  if (/返回/.test(text)) return { kind: 'action', goal: 'back' };
  if (/等待/.test(text)) return { kind: 'action', goal: 'wait' };
  const assertion = /(预期|应该|应当|验证|确认|看到|显示|不存在|进入|保持|成功|失败)/.test(text);
  if (assertion) {
    return {
      kind: 'assertion',
      assertions: [text.replace(/^(预期|应该|应当|验证|确认)\s*/, '')],
    };
  }
  return { kind: 'action', goal: 'unknown' };
}

function extractQuoted(text) {
  const match = text.match(/[「“"]([^」”"]+)[」”"]/);
  return match ? match[1] : undefined;
}

function extractValue(text) {
  const quoted = extractQuoted(text);
  if (quoted) return quoted;
  const match = text.match(/(?:输入|填写)\s*([A-Za-z0-9_@.+-]+)/);
  return match ? match[1] : undefined;
}

function extractInputTarget(text) {
  if (/手机号|手机/.test(text)) return '手机号输入框';
  if (/验证码/.test(text)) return '验证码输入框';
  if (/密码/.test(text)) return '密码输入框';
  return undefined;
}

function parseMarkdownCase(file, cwd = process.cwd(), options = {}) {
  const abs = path.resolve(file);
  const markdown = options.markdown ?? readText(abs);
  const title = extractTitle(markdown, abs);
  const caseKey = options.caseKey || `ck-${sha1(abs).slice(0, 12)}`;
  const sourceSha1 = `source-${sha1(markdown).slice(0, 12)}`;
  const preconditions = parsePreconditions(sectionLines(markdown, ['前置条件', 'preconditions'])).map((text, idx) => ({
    id: `pre-${pad3(idx + 1)}`,
    text,
    checkMode: inferPreconditionMode(text),
    hints: [],
  }));
  const steps = parseOrderedSteps(sectionLines(markdown, ['步骤', 'steps'])).map((sourceText, idx) => ({
    id: `step-${pad3(idx + 1)}`,
    index: idx + 1,
    sourceText,
    hints: [],
    ...classifyStep(sourceText),
  }));
  const root = workspaceRoot(cwd);
  const caseDir = path.join(root, 'cases', `${slugify(title)}__${caseKey}`);
  return {
    caseDir,
    sourceMarkdown: markdown,
    caseJson: {
      schemaVersion: 1,
      identity: {
        caseKey,
        title,
        importSource: options.importSource || abs,
        sourceSnapshot: 'source.md',
        sourceSha1,
        sourceUpdatedAt: options.sourceUpdatedAt ?? formatLocalIso(fs.statSync(abs).mtime),
        sourceMode: options.sourceMode || 'external',
      },
      preconditions,
      steps,
      isolation: {
        requireCleanRestart: 'auto',
      },
      globalRules: [],
      sourceChanged: false,
      staleNotes: [],
    },
  };
}

function inferPreconditionMode(text) {
  if (/已安装|设备已连接|App\s*已安装/.test(text)) return 'auto_check';
  if (/已登录|未登录|登录|账号|手机号|验证码|密码|会员|权限|角色|灰度/.test(text)) return 'manual_context';
  return 'manual_context';
}

function normalizePreconditionText(value) {
  return String(value || '')
    .trim()
    .replace(/[。；;，,\s]+$/g, '')
    .replace(/\s+/g, ' ');
}

function classifyPrecondition(item) {
  const text = normalizePreconditionText(item.text || item);
  const checkMode = String(item.checkMode || '');
  if (/真实支付|支付完成|真实扣款|清数据|卸载|删除|发布|修改真实|线上|生产|删除资料/.test(text) || checkMode === 'unsupported') {
    return {
      category: 'unsupported',
      status: 'UNSUPPORTED',
      defaultResolution: 'skip_or_user_handles_outside_execution',
    };
  }
  if (/短信|审核|第三方|风控|推送|邮件|支付/.test(text)) {
    return {
      category: 'external_dependency',
      status: 'UNKNOWN',
      defaultResolution: 'user_confirm_or_skip',
    };
  }
  if (/已登录|未登录|登录|账号|手机号|验证码|密码|会员|权限|角色|灰度/.test(text) || checkMode === 'auto_prepare') {
    return {
      category: 'account',
      status: 'CONFIRM',
      defaultResolution: 'user_confirmed',
    };
  }
  if (/订单|草稿|余额|数据|商品|活动|资源|记录|内容|作品|列表.*有|已有/.test(text)) {
    return {
      category: 'business_data',
      status: 'NEEDS_SETUP',
      defaultResolution: 'setup_required',
    };
  }
  if (/App\s*已安装|已安装|设备已连接|网络正常|网络可用|截图|控件树/.test(text) || checkMode === 'auto_check') {
    return {
      category: 'platform',
      status: 'READY',
      defaultResolution: 'framework_checked',
    };
  }
  return {
    category: 'manual',
    status: 'CONFIRM',
    defaultResolution: 'user_confirmed',
  };
}

function worsePreconditionStatus(left, right) {
  return PRECONDITION_STATUS_PRIORITY[left] >= PRECONDITION_STATUS_PRIORITY[right] ? left : right;
}

function displayPreconditionStatus(status) {
  return PRECONDITION_STATUS_LABELS[status] || status || '-';
}

function isolationRequirementFromNote(note = {}) {
  const text = String(note.text || '');
  const type = String(note.type || '');
  if (type === 'isolation') {
    if (/不要求|不需要|无需|允许降级|可降级|false|optional/i.test(text)) return false;
    if (/必须|要求|需要|强制|true|required/i.test(text)) return true;
  }
  if (!/(冷启动|重启|重新启动|隔离|clean\s*restart|cold\s*start)/i.test(text)) return null;
  if (/不要求|不需要|无需|允许降级|可降级|不必/.test(text)) return false;
  if (/必须|要求|需要|强制/.test(text)) return true;
  return null;
}

function reapplyNotes(caseJson, notes, options = {}) {
  const staleNotes = [];
  for (const note of notes) {
    if (note.source !== 'conversation' || note.stale) continue;
    const isolationRequirement = isolationRequirementFromNote(note);
    if (isolationRequirement !== null) {
      caseJson.isolation = {
        ...(caseJson.isolation || {}),
        requireCleanRestart: isolationRequirement,
        reason: note.text,
      };
      continue;
    }
    const target = findStepForNote(caseJson, note, options);
    if (target) {
      target.hints = Array.from(new Set([...(target.hints || []), note.text]));
    } else {
      staleNotes.push({ ...note, stale: true, applied: false, reason: `无法匹配 ${note.appliesTo || '目标步骤'}` });
    }
  }
  caseJson.staleNotes = staleNotes;
  return caseJson;
}

function findStepForNote(caseJson, note, options = {}) {
  if (note.appliesTo) {
    const exact = caseJson.steps.find((step) => step.id === note.appliesTo);
    if (exact && (!options.strictStepText || !note.stepSourceText || exact.sourceText === note.stepSourceText)) {
      return exact;
    }
  }
  const targetText = note.text || '';
  return caseJson.steps.find((step) => {
    return (step.target && (targetText.includes(step.target) || step.target.includes(targetText))) ||
      (step.goal === 'input_text' && /输入框|输入/.test(targetText) && step.target && targetText.includes(step.target.replace('输入框', ''))) ||
      (step.sourceText && targetText.includes(step.sourceText.slice(0, 8)));
  });
}

function latestExecutionDir(caseDir) {
  const execRoot = path.join(caseDir, 'executions');
  if (!fs.existsSync(execRoot)) return null;
  const names = fs.readdirSync(execRoot).filter((name) => fs.statSync(path.join(execRoot, name)).isDirectory()).sort();
  return names.length ? path.join(execRoot, names[names.length - 1]) : null;
}

function latestResultExecutionDir(caseDir) {
  const execRoot = path.join(caseDir, 'executions');
  if (!fs.existsSync(execRoot)) return null;
  const names = fs.readdirSync(execRoot)
    .filter((name) => {
      const execDir = path.join(execRoot, name);
      return fs.statSync(execDir).isDirectory() && fs.existsSync(path.join(execDir, 'result.json'));
    })
    .sort();
  return names.length ? path.join(execRoot, names[names.length - 1]) : null;
}

function caseRootFromCaseDir(caseDir) {
  return path.dirname(path.dirname(caseDir));
}

function reportSourceSha(report = {}) {
  return report.result?.sourceSha1 ||
    report.metrics?.sourceSha1 ||
    report.events?.find((event) => event.sourceSha1)?.sourceSha1 ||
    '';
}

function reportCaseContractSha(report = {}) {
  return report.result?.caseContractSha ||
    report.metrics?.caseContractSha ||
    report.events?.find((event) => event.caseContractSha)?.caseContractSha ||
    '';
}

function reportMatchesCaseSource(caseJson, report = {}, options = {}) {
  const caseSha = caseJson.identity?.sourceSha1 || '';
  const sourceSha = reportSourceSha(report);
  const expectedContractSha = caseContractSha(caseJson);
  const actualContractSha = reportCaseContractSha(report);
  if (actualContractSha && actualContractSha !== expectedContractSha) return false;
  const actualPlanSha = report.result?.preconditionPlanSha || report.metrics?.preconditionPlanSha || '';
  if (actualPlanSha && options.caseDir && options.platform) {
    try {
      const { buildPreconditionPlan } = require('./precondition-flow');
      const currentPlan = buildPreconditionPlan(caseJson, caseRootFromCaseDir(options.caseDir), options.platform);
      if (currentPlan.preconditionPlanSha !== actualPlanSha) return false;
    } catch {
      return false;
    }
  }
  if (actualContractSha) return true;
  const hasRules = Array.isArray(caseJson.globalRules) && caseJson.globalRules.length > 0;
  if (hasRules) return false;
  return !caseSha || !sourceSha || caseSha === sourceSha;
}

function readCaseRuntimeSummary(caseDir, caseJson, platform = '') {
  const runtimeDir = caseRuntimeDir(caseDir, platform);
  const state = readJson(path.join(runtimeDir, 'state.json'), {});
  const latest = latestResultExecutionDir(runtimeDir);
  const result = latest ? readJson(path.join(latest, 'result.json'), null) : null;
  const metrics = latest ? readJson(path.join(latest, 'metrics.json'), null) : null;
  const current = reportMatchesCaseSource(caseJson, { result, metrics }, { caseDir, platform });
  const currentResult = current ? result : null;
  const currentMetrics = current ? metrics : null;
  const status = currentResult?.status || (!result ? state.latestStatus : 'NOT_RUN') || 'NOT_RUN';
  const steps = currentMetrics?.steps;
  return {
    platform: platform || state.environment?.platform || '',
    runtimeDir,
    status,
    latestExecutionId: currentResult?.executionId || (!result ? state.latestExecutionId : '') || '',
    startedAt: currentResult?.startedAt || '',
    endedAt: currentResult?.endedAt || '',
    durationMs: currentMetrics?.durationMs,
    stepsSummary: steps ? `${steps.passed || 0}/${steps.total || 0}` : `${caseJson.steps?.length || 0}`,
    failureCode: currentResult?.failureCode || (!result ? state.latestFailureCode : '') || '',
    failedStep: currentResult?.failedStep || '',
    reason: currentResult?.reason || (!result ? state.latestReason : '') || '',
    updatedAt: currentResult?.endedAt || state.environmentConfirmedAt || caseJson.identity?.sourceUpdatedAt || '',
    contextPath: path.join(runtimeDir, 'CONTEXT.html'),
  };
}

function collectCasePlatforms(caseDir, caseJson) {
  const platformsDir = path.join(caseDir, 'platforms');
  const platformItems = [];
  if (fs.existsSync(platformsDir)) {
    for (const name of fs.readdirSync(platformsDir).sort()) {
      if (!normalizePlatform(name)) continue;
      const runtimeDir = path.join(platformsDir, name);
      if (!fs.statSync(runtimeDir).isDirectory()) continue;
      platformItems.push(readCaseRuntimeSummary(caseDir, caseJson, name));
    }
  }
  return platformItems.sort((a, b) => platformSortIndex(a.platform) - platformSortIndex(b.platform));
}

function collectIndexCases(rootDir) {
  const casesRoot = path.join(rootDir, 'cases');
  if (!fs.existsSync(casesRoot)) return [];
  return fs.readdirSync(casesRoot)
    .map((name) => path.join(casesRoot, name))
    .filter((caseDir) => fs.statSync(caseDir).isDirectory())
    .map((caseDir) => {
      const caseJson = readJson(path.join(caseDir, 'case.json'), {});
      const platformItems = collectCasePlatforms(caseDir, caseJson);
      const legacy = readCaseRuntimeSummary(caseDir, caseJson, '');
      const primary = aggregateCaseSummary(platformItems, legacy);
      return {
        caseDir,
        caseNo: caseJson.identity?.caseNo || '',
        title: caseJson.identity?.title || path.basename(caseDir),
        caseKey: caseJson.identity?.caseKey || '',
        preconditions: Array.isArray(caseJson.preconditions) ? caseJson.preconditions : [],
        platforms: platformItems.map((item) => ({
          ...item,
          contextHref: path.relative(rootDir, item.contextPath).replace(/\\/g, '/'),
        })),
        status: primary.status,
        latestExecutionId: primary.latestExecutionId,
        startedAt: primary.startedAt,
        endedAt: primary.endedAt,
        durationMs: primary.durationMs,
        stepsSummary: primary.stepsSummary,
        failureCode: primary.failureCode,
        failedStep: primary.failedStep,
        reason: primary.reason,
        updatedAt: primary.updatedAt,
        contextHref: path.relative(rootDir, path.join(caseDir, 'CONTEXT.html')).replace(/\\/g, '/'),
      };
    })
    .sort((a, b) => {
      const noA = caseNoNumber(a.caseNo);
      const noB = caseNoNumber(b.caseNo);
      if (noA || noB) return (noA || Number.MAX_SAFE_INTEGER) - (noB || Number.MAX_SAFE_INTEGER);
      return a.title.localeCompare(b.title, 'zh-CN');
    });
}

function indexPreconditionClass(item = {}) {
  return className(classifyPrecondition(item).status);
}

function indexPreconditionShortText(text = '') {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized;
}

function renderIndexPreconditionTags(preconditions = []) {
  if (!preconditions.length) {
    return `<div class="case-preconditions empty">
      <span class="case-precondition-label">前置条件</span>
      <div class="precondition-tags"><span class="precondition-tag none">无</span></div>
    </div>`;
  }
  const visible = preconditions.slice(0, 5);
  const tags = visible.map((item) => {
    const classification = classifyPrecondition(item);
    const statusText = displayPreconditionStatus(classification.status);
    const modeText = displayPreconditionMode(item.checkMode);
    const text = item.text || item.id || '';
    return `<span class="precondition-tag ${escapeHtml(indexPreconditionClass(item))}" title="${escapeHtml(`${statusText} / ${modeText}: ${text}`)}">
      <b>${escapeHtml(statusText)}</b><em>${escapeHtml(indexPreconditionShortText(text))}</em>
    </span>`;
  }).join('');
  const more = preconditions.length > visible.length
    ? `<span class="precondition-tag more" title="${escapeHtml(`还有 ${preconditions.length - visible.length} 条前置条件`)}">+${escapeHtml(preconditions.length - visible.length)}</span>`
    : '';
  return `<div class="case-preconditions">
    <span class="case-precondition-label">前置条件</span>
    <div class="precondition-tags">${tags}${more}</div>
  </div>`;
}

function aggregateCaseSummary(platformItems = [], legacy) {
  if (!platformItems.length) return legacy;
  const status = aggregateStatus(platformItems.map((item) => item.status || 'NOT_RUN'));
  const statusSource = platformItems.find((item) => item.status === status) ||
    latestRuntimeSummary(platformItems.filter((item) => item.status && item.status !== 'NOT_RUN')) ||
    platformItems[0];
  const timeSource = latestRuntimeSummary(platformItems) || statusSource;
  return {
    ...statusSource,
    status,
    latestExecutionId: timeSource.latestExecutionId || statusSource.latestExecutionId,
    startedAt: timeSource.startedAt || statusSource.startedAt,
    endedAt: timeSource.endedAt || statusSource.endedAt,
    updatedAt: timeSource.updatedAt || statusSource.updatedAt,
  };
}

function aggregateStatus(statuses = []) {
  if (!statuses.length || statuses.every((status) => status === 'NOT_RUN')) return 'NOT_RUN';
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  if (statuses.includes('NOT_RUN')) return 'NOT_RUN';
  if (statuses.every((status) => status === 'PASS')) return 'PASS';
  return 'UNKNOWN';
}

function latestRuntimeSummary(items = []) {
  return items
    .filter(Boolean)
    .slice()
    .sort((a, b) => new Date(b.endedAt || b.updatedAt || 0).getTime() - new Date(a.endedAt || a.updatedAt || 0).getTime())[0] || null;
}

function renderIndexForRoot(rootDir) {
  const cases = collectIndexCases(rootDir);
  const indexPath = path.join(rootDir, 'index.html');
  writeText(indexPath, renderIndexHtml(rootDir, cases));
  return indexPath;
}

function refreshIndexForCase(caseDir) {
  return renderIndexForRoot(caseRootFromCaseDir(caseDir));
}

function readLatestExecutionReport(caseDir, options = {}) {
  const runtimeDir = caseRuntimeDir(caseDir, options.platform);
  const latest = latestResultExecutionDir(runtimeDir) || latestExecutionDir(runtimeDir);
  return {
    latest,
    result: latest ? readJson(path.join(latest, 'result.json'), null) : null,
    metrics: latest ? readJson(path.join(latest, 'metrics.json'), null) : null,
    events: latest ? readJsonl(path.join(latest, 'timeline.jsonl')) : [],
  };
}

function writeCaseReports(caseDir, caseJson, state = {}, notes = [], report = null, options = {}) {
  const runtimeDir = caseRuntimeDir(caseDir, options.platform);
  const rawReport = report || readLatestExecutionReport(caseDir, options);
  const sourceMatches = reportMatchesCaseSource(caseJson, rawReport, { caseDir, platform: options.platform });
  const latestReport = sourceMatches ? rawReport : { latest: rawReport.latest, result: null, metrics: null, events: [] };
  const reportState = sourceMatches ? state : {
    ...state,
    latestStatus: 'NOT_RUN',
    latestExecutionId: '',
    latestFailedStep: null,
    latestFailureCode: null,
    contractMismatch: Boolean(rawReport.result || rawReport.metrics || rawReport.events?.length),
  };
  writeText(path.join(runtimeDir, 'CONTEXT.md'), renderContext(caseJson, reportState, latestReport.result, latestReport.metrics, notes, latestReport.events));
  if (options.platform) {
    writeText(path.join(runtimeDir, 'CONTEXT.html'), renderContextHtml(caseJson, reportState, latestReport.result, latestReport.metrics, notes, latestReport.events, { runtimeDir, executionDir: latestReport.latest }));
    writeText(path.join(caseDir, 'CONTEXT.html'), renderCaseOverviewHtml(caseDir, caseJson, notes));
  } else {
    writeText(path.join(runtimeDir, 'CONTEXT.html'), renderCaseOverviewHtml(caseDir, caseJson, notes));
  }
  return {
    context: path.join(runtimeDir, 'CONTEXT.md'),
    contextHtml: path.join(runtimeDir, 'CONTEXT.html'),
  };
}

function writePlatformCaseReports(caseDir, caseJson, notes = []) {
  const platformsDir = path.join(caseDir, 'platforms');
  if (!fs.existsSync(platformsDir)) return [];
  const reports = [];
  for (const name of fs.readdirSync(platformsDir).sort()) {
    const platform = normalizePlatform(name);
    if (!platform) continue;
    const runtimeDir = path.join(platformsDir, name);
    if (!fs.statSync(runtimeDir).isDirectory()) continue;
    const state = readJson(path.join(runtimeDir, 'state.json'), {});
    reports.push(writeCaseReports(caseDir, caseJson, state, notes, null, { platform }));
  }
  return reports;
}

function summarizeTimeline(events = []) {
  const summary = {
    observations: events.filter((event) => event.type === 'observation'),
    actions: events.filter((event) => event.type === 'actionResult'),
    decisions: events.filter((event) => event.type === 'decision'),
    rules: events.filter((event) => event.type === 'rule'),
    flows: events.filter((event) => event.type === 'flow'),
    assertions: events.filter((event) => event.type === 'assertion'),
    preconditions: events.filter((event) => event.type === 'precondition'),
  };
  summary.latestObservation = summary.observations[summary.observations.length - 1] || null;
  return summary;
}

function dependencyItems(state = {}) {
  const dependencies = state.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return [];
  return Object.values(dependencies).filter((item) => item && typeof item === 'object');
}

function dependencyStatusText(item = {}) {
  if (item.ok === true) return 'READY';
  if (item.ok === false) return 'MISSING';
  return 'UNKNOWN';
}

function renderContext(caseJson, state = {}, result = null, metrics = null, notes = [], events = []) {
  const lines = [];
  lines.push(`# ${caseJson.identity.title}`);
  lines.push('');
  lines.push(`状态：${state.latestStatus || result?.status || 'NOT_RUN'}`);
  if (state.latestExecutionId) lines.push(`最近执行：${state.latestExecutionId}`);
  if (caseJson.identity.caseNo) lines.push(`编号：${caseJson.identity.caseNo}`);
  lines.push(`导入来源：${caseJson.identity.importSource || caseJson.identity.sourceFile || '未知'}`);
  if (caseJson.identity.sourceSnapshot) lines.push(`用例快照：${caseJson.identity.sourceSnapshot}`);
  lines.push(`sourceSha1：${caseJson.identity.sourceSha1}`);
  lines.push('');
  lines.push('## 当前结论');
  lines.push(result ? `${result.reason || result.status}` : '尚未执行。');
  lines.push('');
  lines.push('## 执行环境');
  const env = state.environment || result?.environment || {};
  if (Object.keys(env).length) {
    const ordered = ['platform', 'device', 'appId', 'entry', 'bundleName', 'abilityName', 'screen'];
    const keys = [...ordered.filter((key) => key in env), ...Object.keys(env).filter((key) => !ordered.includes(key))];
    for (const key of keys) {
      const value = env[key];
      lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
  } else {
    lines.push('- 未确认。');
  }
  lines.push('');
  lines.push('## 平台依赖');
  const dependencies = dependencyItems(state);
  if (dependencies.length) {
    for (const item of dependencies) {
      const details = [
        item.required ? 'required' : '',
        item.stage,
        item.prepared ? 'prepared' : '',
        item.installed === true ? 'installed' : item.installed === false ? 'not-installed' : '',
        item.enabled === true ? 'enabled' : item.enabled === false ? 'not-enabled' : '',
      ].filter(Boolean).join(', ');
      lines.push(`- ${item.id || item.name || 'dependency'}: ${dependencyStatusText(item)}${details ? ` (${details})` : ''}`);
    }
  } else {
    lines.push('- 无必需依赖。');
  }
  lines.push('');
  lines.push('## 步骤进度');
  const failedStep = result?.failedStep;
  for (const step of caseJson.steps) {
    const mark = failedStep === step.id ? '[!]' : result?.status === 'PASS' ? '[x]' : '[ ]';
    lines.push(`- ${mark} ${step.index}. ${step.sourceText}`);
  }
  const globalRules = Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [];
  const ruleEvents = events.filter((event) => event.type === 'rule');
  if (globalRules.length || ruleEvents.length) {
    lines.push('');
    lines.push('## 全局规则');
    if (globalRules.length) {
      for (const rule of globalRules) {
        const appliesTo = Array.isArray(rule.appliesTo) ? rule.appliesTo.join(', ') : rule.appliesTo || 'any_step';
        const when = typeof rule.when === 'object' ? JSON.stringify(rule.when) : rule.when;
        lines.push(`- ${rule.id || '-'}：${rule.type || '-'} / ${rule.scope || '-'} / appliesTo=${appliesTo} / priority=${rule.priority ?? 0}`);
        if (when) lines.push(`  - when：${when}`);
      }
    } else {
      lines.push('- 未定义。');
    }
    if (ruleEvents.length) {
      lines.push('');
      lines.push('### 规则执行事实');
      for (const event of ruleEvents) {
        lines.push(`- ${formatDisplayTime(event.time)}：${event.ruleId} ${event.status}${event.stepId ? ` / ${event.stepId}` : ''}${event.reason ? ` / ${event.reason}` : ''}`);
      }
    }
  }
  const flowFacts = events.filter((event) => event.type === 'flow' || event.scope === 'precondition-flow');
  if (flowFacts.length) {
    lines.push('');
    lines.push('## 前置条件 Flow');
    for (const event of flowFacts) {
      const factStatus = event.type === 'observation'
        ? `${event.phase || 'observation'}${event.ok === false || event.failureCode ? ' / OBSERVATION_FAILED' : ''}`
        : event.type === 'actionResult'
          ? `${event.action || '-'} / ${event.ok ? 'ACTION_OK' : 'ACTION_FAILED'}`
          : event.status;
      const parts = [
        event.flowId,
        factStatus,
        event.preconditionId,
        event.flowStepId,
        event.failureCode,
        event.reason,
      ].filter(Boolean);
      lines.push(`- ${formatDisplayTime(event.time)}：${parts.join(' / ')}`);
    }
  }
  if (result?.evidence) {
    lines.push('');
    lines.push('## 失败现场');
    for (const item of result.evidence) lines.push(`- ${item}`);
  }
  if (metrics) {
    lines.push('');
    lines.push('## 执行统计');
    lines.push(`- 本次耗时：${formatDuration(metrics.durationMs || 0)}`);
    if (metrics.steps) lines.push(`- 步骤：${metrics.steps.passed || 0}/${metrics.steps.total || 0} 通过，${metrics.steps.failed || 0} 失败，${metrics.steps.unknown || 0} 未知，${metrics.steps.skipped || 0} 跳过`);
    if (metrics.preconditions) lines.push(`- 前置条件：${metrics.preconditions.passed || 0}/${metrics.preconditions.total || 0} 通过，${metrics.preconditions.prepared || 0} 已准备，${metrics.preconditions.blocked || 0} 阻塞，${metrics.preconditions.failed || 0} 失败，${metrics.preconditions.unknown || 0} 未知`);
    if (metrics.actions) lines.push(`- 动作：${metrics.actions.total || 0} 次，点击 ${metrics.actions.tap || 0} 次，开关 ${metrics.actions.toggle || 0} 次，长按 ${metrics.actions.longPress || 0} 次，输入 ${metrics.actions.inputText || 0} 次，拉起 App ${metrics.actions.launchApp || 0} 次，冷启动 App ${metrics.actions.restartApp || 0} 次`);
    if (metrics.flows) lines.push(`- 前置条件 Flow：计划 ${metrics.flows.planned || 0} 个，动作 ${metrics.flows.actions || 0} 次，完成 ${metrics.flows.completed || 0} 个，已满足 ${metrics.flows.alreadySatisfied || 0} 个，失败 ${metrics.flows.failed || 0} 个，阻塞 ${metrics.flows.blocked || 0} 个`);
    if (metrics.stability) {
      const isolationText = metrics.stability.isolationCompromised
        ? `，隔离降级${metrics.stability.isolationRequired ? '（冷启动敏感）' : ''}${metrics.stability.isolationReason ? `：${metrics.stability.isolationReason}` : ''}`
        : '，隔离正常';
      const relaunchAttemptCount = metrics.stability.appRelaunchAttemptCount ?? metrics.stability.appRelaunchCount ?? 0;
      const relaunchSuccessCount = metrics.stability.appRelaunchSuccessCount ?? metrics.stability.appRelaunchCount ?? 0;
      lines.push(`- 稳定性：离开目标 App ${metrics.stability.appForegroundLossCount || 0} 次，拉起尝试 ${relaunchAttemptCount} 次，成功拉起 ${relaunchSuccessCount} 次，冷启动失败 ${metrics.stability.restartFailureCount || 0} 次，已处理弹窗 ${metrics.stability.knownPopupHandledCount || 0} 次${isolationText}`);
    }
    if (metrics.artifacts) lines.push(`- 证据：截图 ${metrics.artifacts.screenshots || 0} 张，控件树 ${metrics.artifacts.layouts || 0} 份，日志 ${metrics.artifacts.logs || 0} 份`);
    if (metrics.eventCounts) {
      const eventSummary = Object.entries(metrics.eventCounts).map(([key, value]) => `${key} ${value}`).join('，');
      lines.push(`- 事件：${eventSummary || '无'}`);
    }
    lines.push(`- 统计源：executions/${metrics.executionId}/metrics.json`);
  }
  const timeline = summarizeTimeline(events);
  if (events.length) {
    lines.push('');
    lines.push('## 执行事实');
    lines.push(`- timeline：executions/${metrics?.executionId || state.latestExecutionId}/timeline.jsonl`);
    lines.push(`- observation：${timeline.observations.length} 条，action：${timeline.actions.length} 条，decision：${timeline.decisions.length} 条，rule：${timeline.rules.length} 条，flow：${timeline.flows.length} 条，assertion：${timeline.assertions.length} 条`);
    if (timeline.latestObservation) {
      const observation = timeline.latestObservation.observation || timeline.latestObservation;
      if (observation.app) {
        lines.push(`- 最近前台：${observation.app.foregroundApp || '未知'}${observation.app.entry ? ` / ${observation.app.entry}` : ''}${observation.app.inTargetApp === false ? '（非目标应用）' : ''}`);
      }
      const artifacts = observation.artifacts || {};
      const evidence = [artifacts.screenshot, artifacts.layout].filter(Boolean);
      if (evidence.length) lines.push(`- 最近证据：${evidence.join('，')}`);
    }
  }
  const conversationNotes = notes.filter((note) => note.source === 'conversation');
  if (conversationNotes.length) {
    lines.push('');
    lines.push('## 用户补充');
    for (const note of conversationNotes) lines.push(`- ${formatDisplayTime(note.time)}：${note.text}${note.stale ? '（已失效）' : ''}`);
  }
  const showSourceChangeWarning = !result && (state.contractMismatch || caseJson.sourceChanged || caseJson.staleNotes?.length);
  if (showSourceChangeWarning) {
    lines.push('');
    lines.push('## 源用例变更');
    lines.push('- 检测到 Markdown 内容、执行契约或前置条件 Flow 已变化，旧执行结果已隐藏。');
    if (caseJson.staleNotes?.length) {
      lines.push('');
      lines.push('## 失效补充');
      for (const note of caseJson.staleNotes) lines.push(`- ${formatDisplayTime(note.time)}：${note.text}\n  - 原因：${note.reason}`);
    }
  }
  lines.push('');
  lines.push('## 下次执行依据');
  lines.push('- 使用 `case.json` 的最新步骤和 hints。');
  lines.push('- 每次执行都会从第 1 步完整重跑。');
  return `${lines.join('\n')}\n`;
}

function eventStepId(event) {
  if (event.stepId || event.step?.id || event.observation?.stepId) return event.stepId || event.step?.id || event.observation?.stepId;
  const label = event.label || event.observation?.label || '';
  if (isFlowObservation(event, label)) return '';
  const match = String(label).match(/(?:^|[-_])(step-\d{3})(?:[-_]|$)/);
  return match ? match[1] : '';
}

function isFlowObservation(event, label = event.label || event.observation?.label || '') {
  if (event.type !== 'observation') return false;
  if (event.scope === 'precondition-flow' || event.observation?.scope === 'precondition-flow') return true;
  if (event.flowId || event.flowStepId || event.observation?.flowId || event.observation?.flowStepId) return true;
  const text = String(label);
  return /(?:^|[-_])flow[-_]step[-_]\d{3}(?:[-_]|$)/.test(text) ||
    /(?:^|[-_])(?:before|after)[-_]flow(?:[-_]|$)/.test(text);
}

function eventAction(event) {
  return event.action?.type || event.action || '';
}

function assertionEvidenceText(event) {
  const refs = [
    ...(Array.isArray(event.evidence) ? event.evidence : []),
    typeof event.evidence === 'string' ? event.evidence : '',
    event.evidenceObservation || '',
    ...(Array.isArray(event.evidenceObservations) ? event.evidenceObservations : []),
  ].filter(Boolean);
  return refs.length ? `；证据：${refs.join('，')}` : '';
}

function eventSummary(event) {
  if (event.type === 'executionStart') return `开始执行 ${event.executionId || ''}`.trim();
  if (event.type === 'precondition') return `${displayStatus(event.status)} ${event.reason || event.text || ''}`.trim();
  if (event.type === 'observation') return event.label || '截图观察';
  if (event.type === 'perception') return event.pageState || event.summary || '页面理解';
  if (event.type === 'decision') return `决策：${displayDecision(event.decision)}${event.reason ? `，${event.reason}` : ''}`;
  if (event.type === 'rule') return `${event.ruleId || '-'} ${event.status || ''}${event.reason ? `：${event.reason}` : ''}`.trim();
  if (event.type === 'flow') return `${event.flowId || '-'} ${event.status || ''}${event.preconditionId ? ` / ${event.preconditionId}` : ''}${event.flowStepId ? ` / ${event.flowStepId}` : ''}${event.reason ? `：${event.reason}` : ''}`.trim();
  if (event.type === 'actionResult') return `${displayAction(eventAction(event))}${event.ok ? '成功' : '失败'}${event.error ? `：${event.error}` : ''}`;
  if (event.type === 'assertion') return `${displayStatus(event.status)}${event.reason ? `：${event.reason}` : ''}${assertionEvidenceText(event)}`;
  if (event.type === 'result') return `${displayStatus(event.status)}${event.reason ? `：${event.reason}` : ''}`;
  return event.reason || displayStatus(event.status) || '';
}

function deriveStepStatuses(caseJson, result, events) {
  const statuses = new Map(caseJson.steps.map((step) => [step.id, 'PENDING']));
  for (const event of events) {
    const stepId = eventStepId(event);
    if (!stepId || !statuses.has(stepId)) continue;
    if (event.type === 'assertion') {
      statuses.set(stepId, event.status || 'UNKNOWN');
    } else if (event.type === 'decision' && event.decision === 'blocked') {
      statuses.set(stepId, 'BLOCKED');
    } else if (event.type === 'actionResult' && event.ok === false) {
      statuses.set(stepId, 'FAIL');
    }
  }
  if (result?.status === 'PASS') {
    for (const step of caseJson.steps) statuses.set(step.id, 'PASS');
  }
  if (result?.failedStep && statuses.has(result.failedStep)) {
    statuses.set(result.failedStep, result.status === 'BLOCKED' ? 'BLOCKED' : result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAIL');
  }
  return statuses;
}

function executionRelativePath(executionId, artifactPath) {
  if (!executionId || !artifactPath) return '';
  return `executions/${executionId}/${String(artifactPath).replace(/\\/g, '/')}`;
}

function renderContextHtml(caseJson, state = {}, result = null, metrics = null, notes = [], events = [], options = {}) {
  const status = result?.status || state.latestStatus || 'NOT_RUN';
  const executionId = result?.executionId || metrics?.executionId || state.latestExecutionId || events.find((event) => event.executionId)?.executionId || '';
  const env = state.environment || result?.environment || {};
  const stepStatuses = deriveStepStatuses(caseJson, result, events);
  const observations = events.filter((event) => event.type === 'observation');
  const screenshots = observations
    .map((event) => {
      const observation = event.observation || event;
      const src = executionRelativePath(executionId, observation.artifacts?.screenshot);
      return src ? { src, label: observation.label || 'observe', time: observation.time || event.time || '' } : null;
    })
    .filter(Boolean);
  const stepById = new Map(caseJson.steps.map((step) => [step.id, step]));
  let lightboxImageIndex = 0;
  function artifactLinkLabel(artifactPath, fallbackIndex = 0) {
    const name = path.basename(String(artifactPath || '')).toLowerCase();
    if (name.includes('aa-dump')) return 'Ability状态';
    if (name.includes('activity-dump')) return 'Activity状态';
    if (name.includes('window-dump')) return '窗口信息';
    if (name.includes('pidof')) return '进程状态';
    if (name.includes('hilog') || name.includes('logcat')) return '系统日志';
    return fallbackIndex ? `诊断日志 ${fallbackIndex}` : '诊断日志';
  }
  function renderArtifactLinks(artifacts = {}) {
    const logs = Array.isArray(artifacts.logs) ? artifacts.logs : [];
    return [
      artifacts.layout ? `<a href="${escapeHtml(executionRelativePath(executionId, artifacts.layout))}">控件树</a>` : '',
      ...logs.map((log, idx) => `<a href="${escapeHtml(executionRelativePath(executionId, log))}">${escapeHtml(artifactLinkLabel(log, idx + 1))}</a>`),
    ].filter(Boolean).join('');
  }
  function renderScreenshotCard(event) {
    const observation = event.observation || event;
    const artifacts = observation.artifacts || {};
    const screenshot = executionRelativePath(executionId, artifacts.screenshot);
    if (!screenshot) return '';
    const imageIndex = lightboxImageIndex++;
    const artifactLinks = renderArtifactLinks(artifacts);
    return `<div class="shot-card">
        <div class="shot-head">
          <div class="shot-label">${escapeHtml(observation.label || '截图观察')}</div>
          <div class="shot-time">${escapeHtml(formatDisplayTime(observation.time || event.time))}</div>
        </div>
        <div class="shot-body">
          <div class="shot-visual">
            <button type="button" class="shot-trigger" data-lightbox-index="${escapeHtml(imageIndex)}" data-lightbox-src="${escapeHtml(screenshot)}" data-lightbox-title="${escapeHtml(observation.label || '截图观察')}" data-lightbox-time="${escapeHtml(formatDisplayTime(observation.time || event.time))}">
              <img class="shot-thumb" src="${escapeHtml(screenshot)}" alt="${escapeHtml(observation.label || '截图')}">
            </button>
          </div>
          <div class="shot-links">${artifactLinks || '-'}</div>
        </div>
      </div>`;
  }
  function buildObservationGroups() {
    const groups = new Map();
    for (const event of observations) {
      const observation = event.observation || event;
      if (!observation.artifacts?.screenshot) continue;
      const stepId = eventStepId(event) || 'unlinked';
      if (!groups.has(stepId)) groups.set(stepId, []);
      groups.get(stepId).push(event);
    }
    return groups;
  }
  const timelineRows = events.slice(-80);
  const environmentRows = Object.keys(env).length
    ? Object.entries(env).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(formatCell(value))}</td></tr>`).join('\n')
    : '<tr><td colspan="2">未确认</td></tr>';
  const dependencyCards = dependencyItems(state).length
    ? dependencyItems(state).map((item) => {
      const rows = [
        ['ID', item.id || '-'],
        ['状态', dependencyStatusText(item)],
        ['阶段', item.stage || '-'],
        ['必需', item.required ? '是' : '否'],
        ['详情', item.currentInputMethod || item.packageName || '-'],
        ['包名', item.packageName || '-'],
        ['IME', item.imeId || '-'],
      ];
      return `<div class="dependency-card">
        <h3>${escapeHtml(item.name || item.id || '平台依赖')}</h3>
        <table><tbody>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(formatCell(value))}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }).join('\n')
    : '<p class="empty">无必需依赖。</p>';
  const evidenceCount = metrics?.artifacts
    ? `截图 ${metrics.artifacts.screenshots || 0} / 控件树 ${metrics.artifacts.layouts || 0}`
    : `截图 ${screenshots.length}`;
  const metricCards = [
    ['步骤', metrics?.steps ? `${metrics.steps.passed || 0}/${metrics.steps.total || 0}` : `${caseJson.steps.length}`],
    ['操作次数', formatActionSummary(metrics?.actions)],
    ['证据', evidenceCount],
    ['隔离', metrics?.stability ? (metrics.stability.isolationCompromised ? '降级' : '正常') : '-'],
  ].map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('\n');
  const failedAssertion = [...events].reverse().find((event) => (
    event.type === 'assertion' &&
    (!result?.failedStep || eventStepId(event) === result.failedStep) &&
    event.status !== 'PASS'
  ));
  const observationGroups = buildObservationGroups();
  function renderStepRelatedFacts(stepId) {
    const facts = events
      .filter((event) => event.type !== 'observation' && eventStepId(event) === stepId)
      .slice(-5)
      .map((event) => `<li><span>${escapeHtml(displayEventType(event.type))}</span>${escapeHtml(eventSummary(event) || '-')}</li>`)
      .join('');
    return facts ? `<ul class="step-facts">${facts}</ul>` : '';
  }
  const stepReviewCards = caseJson.steps.map((step) => {
    const itemStatus = stepStatuses.get(step.id) || 'PENDING';
    const hints = (step.hints || []).join('；');
    const failedReason = step.id === result?.failedStep ? (failedAssertion?.reason || result?.reason || '') : '';
    const eventsForStep = observationGroups.get(step.id) || [];
    const shotCards = eventsForStep.map(renderScreenshotCard).filter(Boolean).join('');
    const cardClass = [
      'step-review-card',
      step.id === result?.failedStep ? 'failed' : '',
    ].filter(Boolean).join(' ');
    return `<article class="${cardClass.trim()}">
      <div class="step-review-main">
        <div class="step-review-head">
          <div class="step-review-title">
            <span>${escapeHtml(step.id)}</span>
            <strong>${escapeHtml(step.index)}. ${escapeHtml(step.sourceText)}</strong>
          </div>
          <div class="step-review-badges">
            <span class="pill ${escapeHtml(className(itemStatus))}">${escapeHtml(displayStatus(itemStatus))}</span>
            <span class="step-kind">${escapeHtml(displayStepGoal(step.goal || step.kind || '-'))}</span>
          </div>
        </div>
        ${hints ? `<div class="step-hints">提示：${escapeHtml(hints)}</div>` : ''}
        ${failedReason ? `<div class="step-failure">失败原因：${escapeHtml(failedReason)}</div>` : ''}
        ${renderStepRelatedFacts(step.id)}
      </div>
      ${shotCards ? `<div class="step-shot-row"><div class="shot-strip">${shotCards}</div></div>` : ''}
    </article>`;
  }).join('\n');
  const unlinkedObservationEvents = [
    ...(observationGroups.get('unlinked') || []),
    ...Array.from(observationGroups.keys())
      .filter((stepId) => stepId !== 'unlinked' && !stepById.has(stepId))
      .flatMap((stepId) => observationGroups.get(stepId) || []),
  ].filter((event) => event.scope !== 'precondition-flow');
  const unlinkedObservationSection = unlinkedObservationEvents.length
    ? `<details class="unlinked-observations">
    <summary>未关联观察</summary>
    <div class="shot-strip">${unlinkedObservationEvents.map(renderScreenshotCard).filter(Boolean).join('')}</div>
  </details>`
    : '';
  const globalRules = Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [];
  const ruleEvents = events.filter((event) => event.type === 'rule');
  const flowEvents = events.filter((event) => event.type === 'flow' || event.scope === 'precondition-flow');
  const flowObservationEvents = flowEvents.filter((event) => event.type === 'observation');
  const flowShotCards = flowObservationEvents.map(renderScreenshotCard).filter(Boolean).join('');
  const globalRuleRows = globalRules.length
    ? globalRules.map((rule) => {
      const appliesTo = Array.isArray(rule.appliesTo) ? rule.appliesTo.join(', ') : rule.appliesTo || 'any_step';
      const when = typeof rule.when === 'object' ? JSON.stringify(rule.when) : rule.when;
      return `<tr>
        <td>${escapeHtml(rule.id || '-')}</td>
        <td>${escapeHtml(rule.scope || '-')}</td>
        <td>${escapeHtml(appliesTo)}</td>
        <td>${escapeHtml(rule.priority ?? 0)}</td>
        <td>${escapeHtml(when || '-')}</td>
      </tr>`;
    }).join('\n')
    : '<tr><td colspan="5">无</td></tr>';
  const ruleEventRows = ruleEvents.length
    ? ruleEvents.map((event) => `<tr>
        <td>${escapeHtml(formatDisplayTime(event.time))}</td>
        <td>${escapeHtml(event.ruleId || '-')}</td>
        <td>${escapeHtml(event.status || '-')}</td>
        <td>${escapeHtml(eventStepId(event) || '-')}</td>
        <td>${escapeHtml(event.reason || '-')}</td>
      </tr>`).join('\n')
    : '<tr><td colspan="5">暂无规则执行事实。</td></tr>';
  const flowRows = flowEvents.length
    ? flowEvents.map((event) => {
      const status = event.type === 'observation'
        ? `${event.phase || 'observation'}${event.ok === false || event.failureCode ? ' / FAILED' : ''}`
        : event.type === 'actionResult'
          ? `${event.action || '-'} / ${event.ok ? 'OK' : 'FAILED'}`
          : event.status || '-';
      return `<tr>
        <td>${escapeHtml(formatDisplayTime(event.time))}</td>
        <td>${escapeHtml(event.flowId || '-')}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(event.flowStepId || '-')}</td>
        <td>${escapeHtml(event.preconditionId || '-')}</td>
        <td>${escapeHtml(event.reason || event.failureCode || event.label || '-')}</td>
      </tr>`;
    }).join('\n')
    : '<tr><td colspan="6">暂无前置条件 Flow 执行事实。</td></tr>';
  const preconditionRows = (caseJson.preconditions || []).length
    ? caseJson.preconditions.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.text)}</td><td>${escapeHtml(displayPreconditionMode(item.checkMode))}</td></tr>`).join('\n')
    : '<tr><td colspan="3">无</td></tr>';
  const preconditionSummary = (caseJson.preconditions || []).length
    ? `<section class="precondition-summary">
    <h2>前置条件</h2>
    <div class="precondition-list">${caseJson.preconditions.map((item) => `<div class="precondition-item">
        <div>
          <span>${escapeHtml(item.id)}</span>
          <p>${escapeHtml(item.text)}</p>
        </div>
        <strong>${escapeHtml(displayPreconditionMode(item.checkMode))}</strong>
      </div>`).join('\n')}</div>
  </section>`
    : `<section class="precondition-summary">
    <h2>前置条件</h2>
    <p class="empty">无</p>
  </section>`;
  const observationRows = observations.length
    ? observations.map((event) => {
      const observation = event.observation || event;
      const artifacts = observation.artifacts || {};
      const links = [
        artifacts.screenshot && `<a href="${escapeHtml(executionRelativePath(executionId, artifacts.screenshot))}">截图</a>`,
        renderArtifactLinks(artifacts),
      ].filter(Boolean).join(' ');
      return `<tr>
        <td>${escapeHtml(formatDisplayTime(observation.time || event.time))}</td>
        <td>${escapeHtml(observation.label || '-')}</td>
        <td>${escapeHtml(observation.app?.foregroundApp || '-')}</td>
        <td>${links || '-'}</td>
      </tr>`;
    }).join('\n')
    : '<tr><td colspan="4">暂无截图观察。</td></tr>';
  const timelineTableRows = timelineRows.length
    ? timelineRows.map((event) => `<tr>
        <td>${escapeHtml(formatDisplayTime(event.time))}</td>
        <td>${escapeHtml(displayEventType(event.type))}</td>
        <td>${escapeHtml(eventStepId(event) || '-')}</td>
        <td>${escapeHtml(eventSummary(event) || '-')}</td>
      </tr>`).join('\n')
    : '<tr><td colspan="4">暂无执行事件。</td></tr>';
  const noteRows = notes.filter((note) => note.source === 'conversation').length
    ? notes.filter((note) => note.source === 'conversation').map((note) => `<tr>
        <td>${escapeHtml(formatDisplayTime(note.time))}</td>
        <td>${escapeHtml(note.appliesTo || '-')}</td>
        <td>${escapeHtml(note.stale ? '失效' : '生效')}</td>
        <td>${escapeHtml(note.text || '')}</td>
      </tr>`).join('\n')
    : '<tr><td colspan="4">无</td></tr>';
  const eventCounts = metrics?.eventCounts
    ? Object.entries(metrics.eventCounts).map(([key, value]) => `<tr><td>${escapeHtml(displayEventType(key))}</td><td>${escapeHtml(value)}</td></tr>`).join('\n')
    : '<tr><td colspan="2">暂无</td></tr>';
  const finalShot = screenshots[screenshots.length - 1] || null;
  const failureEvidence = result && result.status !== 'PASS'
    ? `<section class="failure-evidence">
    <div>
      <h2>失败证据</h2>
      <p class="failure-text">${escapeHtml(failedAssertion?.reason || result.reason || '暂无失败原因。')}</p>
      <div class="failure-meta">
        <span>步骤 ${escapeHtml(result.failedStep || '-')}</span>
        <span>${escapeHtml(displayFailureCode(result.failureCode) || displayStatus(result.status))}</span>
      </div>
    </div>
    ${finalShot ? `<a class="failure-shot" href="${escapeHtml(finalShot.src)}"><img src="${escapeHtml(finalShot.src)}" alt="${escapeHtml(finalShot.label)}"></a>` : '<p class="empty">暂无失败截图。</p>'}
  </section>`
    : '';
  const conclusionItems = [
    ['执行结果', displayFailureCode(result?.failureCode) || displayStatus(status), result?.failureCode || ''],
    ['失败步骤', result?.failedStep || '-'],
    ['耗时', metrics ? formatDuration(metrics.durationMs || 0) : '-'],
    ['执行结束', formatDisplayTime(result?.endedAt)],
  ].map(([label, value, code]) => `<div class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${code ? `<small class="fact-code">${escapeHtml(code)}</small>` : ''}</div>`).join('\n');
  const headerTime = result?.startedAt || result?.endedAt
    ? `${formatDisplayTime(result?.startedAt)} - ${formatDisplayTime(result?.endedAt)}`
    : '尚未执行';
  const showSourceChangeWarning = !result && (state.contractMismatch || caseJson.sourceChanged || caseJson.staleNotes?.length);
  const sourceChangeBanner = showSourceChangeWarning
    ? `<div class="source-warning">源用例、执行契约或前置条件 Flow 已变更，当前报告只展示与最新 sourceSha1、caseContractSha 和 preconditionPlanSha 匹配的执行结果。</div>`
    : '';
  const isolationBanner = metrics?.stability?.isolationCompromised
    ? `<div class="isolation-warning">本次执行未完成干净冷启动隔离${metrics.stability.isolationRequired ? '，且用例依赖冷启动语义' : ''}：${escapeHtml(metrics.stability.isolationReason || 'App 重启失败，执行结果可信度已降级。')}</div>`
    : '';
  const sourceChangeSection = showSourceChangeWarning
    ? `<section>
    <h2>源用例变更</h2>
    <p class="empty">Markdown 内容、执行契约或前置条件 Flow 已变化，当前报告只展示与最新 sourceSha1、caseContractSha 和 preconditionPlanSha 匹配的执行结果。</p>
    ${(caseJson.staleNotes || []).length ? `<div class="table-wrap"><table>
      <thead><tr><th style="width:210px">时间</th><th>补充</th><th>原因</th></tr></thead>
      <tbody>${caseJson.staleNotes.map((note) => `<tr><td>${escapeHtml(formatDisplayTime(note.time))}</td><td>${escapeHtml(note.text || '')}</td><td>${escapeHtml(note.reason || '')}</td></tr>`).join('\n')}</tbody>
    </table></div>` : ''}
  </section>`
    : '';
  const technicalRows = [
    ['executionId', executionId || '-'],
    ['sourceSha1', caseJson.identity.sourceSha1 || '-'],
    ['caseKey', caseJson.identity.caseKey || '-'],
    ['sourceSnapshot', caseJson.identity.sourceSnapshot || '-'],
  ].map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(caseJson.identity.title)} - 测试报告</title>
  <style>
    :root { color-scheme: light; --bg:#f5fbff; --surface:#ffffff; --surface-soft:#f8fcff; --surface-tint:#eef8ff; --text:#111827; --muted:#5f6f86; --line:#d8e8f6; --accent:#0ea5e9; --accent-strong:#0284c7; --accent-soft:#e0f2fe; --pass:#059669; --pass-soft:#ecfdf5; --pass-line:#86efac; --fail:#dc2626; --fail-soft:#fef2f2; --fail-line:#fca5a5; --blocked:#b7791f; --blocked-soft:#fffbeb; --blocked-line:#fde68a; --unknown:#64748b; --unknown-soft:#f1f5f9; --shadow:0 12px 34px rgba(15, 55, 90, .08); }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #eef8ff 0, var(--bg) 230px); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 24px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; padding: 18px 0 4px; }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
    a { color: var(--accent-strong); text-decoration: none; font-weight: 600; }
    a:hover { color: #0369a1; text-decoration: underline; text-underline-offset: 3px; }
    .muted { color: var(--muted); }
    .status { display: inline-flex; align-items: center; min-width: 104px; justify-content: center; padding: 7px 12px; border-radius: 8px; color: #fff; font-weight: 700; letter-spacing: 0; box-shadow: 0 8px 18px rgba(2, 132, 199, .12); }
    .status.pass { background: var(--pass); }
    .status.fail { background: var(--fail); }
    .status.blocked { background: var(--blocked); }
    .status.unknown, .status.not_run { background: var(--unknown); }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric, section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .metric { padding: 12px 14px; background: var(--surface-soft); }
    .metric span { display:block; color: var(--muted); font-size: 12px; }
    .metric strong { display:block; margin-top: 3px; font-size: 20px; }
    section { padding: 16px; margin-top: 14px; overflow: hidden; }
    .hero-section { display: block; }
    .conclusion { min-width: 0; }
    .conclusion h2 { margin-bottom: 8px; }
    .conclusion .summary { margin: 12px 0 0; }
    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .fact { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
    .fact span { display: block; color: var(--muted); font-size: 12px; }
    .fact strong { display: block; margin-top: 3px; font-size: 14px; word-break: break-word; }
    .fact small { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; word-break: break-word; }
    .source-warning { margin: -4px 0 14px; padding: 10px 12px; border: 1px solid var(--blocked-line); border-radius: 8px; background: var(--blocked-soft); color: #7c4a03; font-weight: 700; }
    .isolation-warning { margin: -4px 0 14px; padding: 10px 12px; border: 1px solid var(--blocked-line); border-radius: 8px; background: var(--blocked-soft); color: #7c4a03; font-weight: 800; }
    .evidence-card { display: block; min-width: 0; color: var(--text); font-weight: 500; }
    .evidence-card:hover { text-decoration: none; }
    .evidence-card img { width: 100%; aspect-ratio: 9 / 14; object-fit: cover; border: 1px solid var(--line); border-radius: 8px; background: #10151f; box-shadow: 0 8px 18px rgba(15, 23, 42, .12); }
    .evidence-card.final-shot img { border-color: var(--accent); box-shadow: 0 10px 24px rgba(14, 165, 233, .2); }
    .evidence-card span { display: block; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .evidence-card.final-shot span::after { content: "最终"; margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); font-size: 11px; font-weight: 700; }
    .evidence-card small { display: block; color: var(--muted); font-size: 12px; }
    .failure-evidence { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 260px); gap: 16px; align-items: start; border-color: var(--fail-line); background: linear-gradient(90deg, var(--fail-soft), var(--surface) 46%); }
    .failure-evidence h2 { color: var(--fail); }
    .failure-text { margin: 0; color: #7f1d1d; font-size: 15px; line-height: 1.6; font-weight: 700; }
    .failure-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .failure-meta span { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #fff; border: 1px solid var(--fail-line); color: var(--fail); font-size: 12px; font-weight: 800; }
    .failure-shot img { width: 100%; aspect-ratio: 9 / 14; object-fit: cover; border: 1px solid var(--fail-line); border-radius: 8px; background: #10151f; box-shadow: 0 10px 24px rgba(220, 38, 38, .16); }
    .precondition-summary { border-color: #bae6fd; background: linear-gradient(90deg, #f0f9ff, var(--surface) 42%); }
    .precondition-list { display: grid; gap: 10px; }
    .precondition-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 12px; align-items: center; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.72); }
    .precondition-item span { display: block; color: var(--accent-strong); font-size: 12px; font-weight: 800; }
    .precondition-item p { margin: 3px 0 0; color: #243447; line-height: 1.55; }
    .precondition-item strong { padding: 3px 8px; border: 1px solid #bae6fd; border-radius: 999px; background: #fff; color: var(--accent-strong); font-size: 12px; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; overflow: hidden; border-radius: 8px; }
    th, td { padding: 8px 10px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; word-break: break-word; }
    .step-table td { vertical-align: middle; }
    thead th, tbody th { color: var(--muted); font-weight: 600; }
    thead th { border-top: 0; background: var(--surface-tint); }
    tbody tr:nth-child(even) td { background: var(--surface-soft); }
    .pill { display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .pill.pass { color: var(--pass); background: var(--pass-soft); border-color: var(--pass-line); }
    .pill.fail { color: var(--fail); background: var(--fail-soft); border-color: var(--fail-line); }
    .pill.blocked { color: var(--blocked); background: var(--blocked-soft); border-color: var(--blocked-line); }
    .pill.unknown, .pill.pending { color: var(--unknown); background: var(--unknown-soft); border-color: #cbd5e1; }
    .step-review-list { display: grid; gap: 12px; }
    .step-review-card { padding: 15px 16px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: 0 6px 18px rgba(15, 55, 90, .045); }
    .step-review-card.failed { border-color: var(--fail-line); background: linear-gradient(90deg, var(--fail-soft), #fff 34%); }
    .step-review-main { min-width: 0; }
    .step-review-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 0; }
    .step-review-title { min-width: 0; display: grid; gap: 4px; }
    .step-review-title span { color: var(--accent-strong); font-size: 13px; font-weight: 900; }
    .step-review-title strong { color: var(--text); font-size: 15px; line-height: 1.55; }
    .step-review-badges { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    .step-kind { padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font-size: 13px; font-weight: 800; white-space: nowrap; }
    .step-facts { display: grid; gap: 5px; margin: 10px 0 0; padding: 0; list-style: none; color: #334155; font-size: 14px; line-height: 1.45; }
    .step-facts li { display: flex; gap: 8px; align-items: baseline; min-width: 0; font-size: 14px; line-height: 1.45; }
    .step-facts span { flex: 0 0 auto; color: var(--muted); font-size: 14px; line-height: 1.45; font-weight: 800; }
    .step-hints { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .step-shot-row { margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--line); }
    .shot-strip { display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch; }
    .shot-card { flex: 0 0 320px; width: 320px; max-width: 100%; height: 224px; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: 0 8px 20px rgba(15, 55, 90, .055); }
    .shot-head { min-width: 0; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .shot-body { min-width: 0; display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 12px; align-items: start; }
    .shot-visual { min-width: 0; }
    .shot-trigger { display: block; width: 84px; padding: 0; border: 0; background: transparent; cursor: zoom-in; text-align: left; }
    .shot-thumb { width: 84px; height: 126px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); background: #10151f; box-shadow: 0 8px 18px rgba(15, 23, 42, .12); }
    .shot-label { min-width: 0; color: var(--text); font-size: 13px; font-weight: 900; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .shot-time { min-width: 0; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .shot-links { display: grid; align-content: start; gap: 4px; min-width: 0; color: var(--muted); font-size: 12px; }
    .shot-links a { display: flex; align-items: center; width: 100%; min-height: 22px; padding: 0 8px; border: 1px solid #d8e8f6; border-radius: 6px; background: var(--surface-soft); color: var(--accent-strong); font-size: 12px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .unlinked-observations { margin-top: 12px; padding: 12px; border: 1px dashed #cbd5e1; border-radius: 8px; background: var(--unknown-soft); }
    .unlinked-observations > summary { cursor: pointer; color: var(--muted); font-weight: 900; list-style: none; }
    .unlinked-observations > summary::-webkit-details-marker { display: none; }
    .failed-step-row td { background: #fffafa; border-top-color: #fee2e2; }
    .step-failure { margin-top: 9px; padding: 8px 10px; border: 1px solid #fee2e2; border-radius: 6px; background: #fff; color: #991b1b; font-size: 13px; font-weight: 700; }
    .evidence-chain { display: grid; gap: 12px; }
    .evidence-item { padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
    .evidence-item.failed-step-row { border-color: #fee2e2; background: #fffafa; }
    .evidence-step { display: flex; gap: 8px; align-items: baseline; margin-bottom: 10px; }
    .evidence-step span { flex: 0 0 auto; color: var(--muted); font-size: 12px; font-weight: 800; }
    .evidence-step strong { min-width: 0; color: var(--text); font-size: 14px; }
    .table-wrap { width: 100%; overflow-x: auto; }
    .table-wrap table { min-width: 680px; }
    .reason { margin: 0 0 12px; padding: 10px 12px; background: var(--accent-soft); border: 1px solid #bae6fd; border-radius: 8px; color: #0f3d5c; }
    .empty { color: var(--muted); margin: 0; }
    .debug-details { margin-top: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); overflow: hidden; }
    .debug-details > summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; cursor: pointer; list-style: none; padding: 14px 16px; color: var(--text); font-size: 17px; font-weight: 800; }
    .debug-details > summary small { min-width: 0; color: var(--muted); font-size: 13px; font-weight: 600; text-align: right; }
    .debug-details > summary::-webkit-details-marker { display: none; }
    .debug-details > summary::after { content: "展开"; flex: 0 0 auto; color: var(--muted); font-size: 12px; font-weight: 600; }
    .debug-details[open] > summary::after { content: "收起"; }
    .debug-details[open] > summary { border-bottom: 1px solid var(--line); }
    .debug-content { display: grid; gap: 12px; padding: 14px; background: linear-gradient(180deg, #f8fcff, #fff); }
    .debug-overview { display: grid; grid-template-columns: minmax(240px, 1.08fr) minmax(210px, .92fr) minmax(260px, 1.18fr) minmax(160px, .62fr); gap: 12px; align-items: start; }
    .debug-section { margin: 0; padding: 14px; box-shadow: none; background: rgba(255,255,255,.86); }
    .debug-section.compact { min-width: 0; }
    .debug-section h2 { margin-bottom: 10px; font-size: 15px; }
    .dependency-list { display: grid; gap: 10px; }
    .dependency-card { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
    .dependency-card h3 { margin: 0 0 8px; color: var(--text); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
    .dependency-card table { border-radius: 6px; background: #fff; }
    .dependency-card th { width: 58px; color: var(--muted); white-space: nowrap; }
    .dependency-card td { overflow-wrap: anywhere; word-break: break-word; }
    .debug-section table { font-size: 13px; border: 1px solid var(--line); }
    .debug-section th, .debug-section td { padding: 8px 10px; }
    .debug-section .table-wrap table { min-width: 620px; }
    .debug-section.compact .table-wrap table { min-width: 0; }
    .shot-lightbox[hidden] { display: none; }
    .shot-lightbox { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 28px; background: rgba(15, 23, 42, .72); }
    .shot-lightbox-panel { width: min(980px, 100%); max-height: calc(100vh - 56px); display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border-radius: 8px; background: #fff; box-shadow: 0 24px 70px rgba(0,0,0,.28); }
    .shot-lightbox-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .shot-lightbox-title { min-width: 0; }
    .shot-lightbox-title strong, .shot-lightbox-title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .shot-lightbox-title span { color: var(--muted); font-size: 12px; }
    .shot-lightbox-close { width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 6px; background: #fff; cursor: pointer; font-size: 20px; line-height: 1; }
    .shot-lightbox-body { position: relative; min-height: 0; height: min(78vh, 860px); overflow: hidden; background: #0f172a; text-align: center; }
    .shot-lightbox-body img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .shot-lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 40px; height: 56px; border: 1px solid rgba(255,255,255,.42); border-radius: 8px; background: rgba(15, 23, 42, .68); color: #fff; cursor: pointer; font-size: 28px; line-height: 1; }
    .shot-lightbox-nav.prev { left: 12px; }
    .shot-lightbox-nav.next { right: 12px; }
    .shot-lightbox-nav:disabled { opacity: .35; cursor: default; }
    @media (max-width: 1020px) { .debug-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 760px) { main { width: calc(100vw - 20px); margin-top: 14px; } header, .grid { display:block; } .summary, .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .failure-evidence, .precondition-item, .debug-overview { grid-template-columns: 1fr; } .precondition-item strong { justify-self: start; } .step-review-head { flex-direction: column; align-items: flex-start; } .step-review-badges { flex-wrap: wrap; } .debug-details > summary { align-items: flex-start; flex-wrap: wrap; } .debug-details > summary small { text-align: left; } h1 { font-size: 22px; } section { padding: 12px; } .shot-lightbox { padding: 10px; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(caseJson.identity.title)}</h1>
      <div class="muted">编号：${escapeHtml(caseJson.identity.caseNo || '-')} · 执行：${escapeHtml(headerTime)}</div>
    </div>
    <span class="status ${escapeHtml(className(status))}">${escapeHtml(displayStatus(status))}</span>
  </header>
  ${sourceChangeBanner}
  ${isolationBanner}

  <section class="hero-section">
    <div class="conclusion">
      <h2>执行结论</h2>
      <p class="reason">${escapeHtml(result?.reason || '尚未执行。')}</p>
      <div class="facts">${conclusionItems}</div>
      <div class="summary">${metricCards}</div>
    </div>
  </section>

  ${failureEvidence}

  ${preconditionSummary}

  <section class="step-review-section">
    <h2>步骤复盘</h2>
    <div class="step-review-list">${stepReviewCards}</div>
    ${unlinkedObservationSection}
  </section>

  <details class="debug-details">
    <summary><span>调试信息</span><small>环境、事件、时间线和原始证据链接</small></summary>
    <div class="debug-content">
      <div class="debug-overview">
        <section class="debug-section compact">
          <h2>技术标识</h2>
          <div class="table-wrap"><table><tbody>${technicalRows}</tbody></table></div>
        </section>
        <section class="debug-section compact">
        <h2>执行环境</h2>
        <div class="table-wrap"><table><tbody>${environmentRows}</tbody></table></div>
      </section>
        <section class="debug-section compact">
        <h2>平台依赖</h2>
        <div class="dependency-list">${dependencyCards}</div>
      </section>
        <section class="debug-section compact">
        <h2>事件统计</h2>
        <div class="table-wrap"><table><tbody>${eventCounts}</tbody></table></div>
      </section>
      </div>

      <section class="debug-section">
      <h2>观察记录</h2>
      <div class="table-wrap"><table>
          <thead><tr><th style="width:210px">时间</th><th style="width:170px">标签</th><th style="width:180px">前台</th><th>证据</th></tr></thead>
          <tbody>${observationRows}</tbody>
        </table></div>
    </section>

      <section class="debug-section">
      <h2>全局规则</h2>
      <div class="table-wrap"><table>
          <thead><tr><th style="width:130px">ID</th><th style="width:150px">范围</th><th style="width:160px">适用步骤</th><th style="width:90px">优先级</th><th>条件</th></tr></thead>
          <tbody>${globalRuleRows}</tbody>
        </table></div>
      <div class="table-wrap"><table style="margin-top:12px">
          <thead><tr><th style="width:210px">时间</th><th style="width:130px">规则</th><th style="width:100px">状态</th><th style="width:110px">步骤</th><th>原因</th></tr></thead>
          <tbody>${ruleEventRows}</tbody>
        </table></div>
    </section>

      <section class="debug-section">
      <h2>前置条件 Flow</h2>
      <div class="table-wrap"><table>
          <thead><tr><th style="width:210px">时间</th><th style="width:170px">Flow</th><th style="width:110px">状态</th><th style="width:130px">Flow 步骤</th><th style="width:110px">前置条件</th><th>原因</th></tr></thead>
          <tbody>${flowRows}</tbody>
        </table></div>
      ${flowShotCards ? `<div class="shot-strip" style="margin-top:12px">${flowShotCards}</div>` : ''}
    </section>

      <section class="debug-section">
      <h2>前置条件</h2>
      <div class="table-wrap"><table>
          <thead><tr><th style="width:100px">ID</th><th>内容</th><th style="width:140px">模式</th></tr></thead>
          <tbody>${preconditionRows}</tbody>
        </table></div>
    </section>

      <section class="debug-section">
      <h2>执行时间线</h2>
      <div class="table-wrap"><table>
          <thead><tr><th style="width:210px">时间</th><th style="width:130px">类型</th><th style="width:110px">步骤</th><th>摘要</th></tr></thead>
          <tbody>${timelineTableRows}</tbody>
        </table></div>
    </section>

      <section class="debug-section">
      <h2>用户补充</h2>
      <div class="table-wrap"><table>
          <thead><tr><th style="width:210px">时间</th><th style="width:120px">步骤</th><th style="width:90px">状态</th><th>内容</th></tr></thead>
          <tbody>${noteRows}</tbody>
        </table></div>
    </section>
    </div>
  </details>

  ${sourceChangeSection}
  <div class="shot-lightbox" hidden>
    <div class="shot-lightbox-panel" role="dialog" aria-modal="true" aria-label="截图预览">
      <div class="shot-lightbox-head">
        <div class="shot-lightbox-title">
          <strong></strong>
          <span></span>
        </div>
        <button type="button" class="shot-lightbox-close" aria-label="关闭">×</button>
      </div>
      <div class="shot-lightbox-body">
        <button type="button" class="shot-lightbox-nav prev" aria-label="上一张">‹</button>
        <img alt="截图预览">
        <button type="button" class="shot-lightbox-nav next" aria-label="下一张">›</button>
      </div>
    </div>
  </div>
</main>
<script>
(() => {
  const lightbox = document.querySelector('.shot-lightbox');
  if (!lightbox) return;
  const image = lightbox.querySelector('img');
  const title = lightbox.querySelector('.shot-lightbox-title strong');
  const time = lightbox.querySelector('.shot-lightbox-title span');
  const prevButton = lightbox.querySelector('.shot-lightbox-nav.prev');
  const nextButton = lightbox.querySelector('.shot-lightbox-nav.next');
  const triggers = Array.from(document.querySelectorAll('[data-lightbox-src]'));
  let currentIndex = 0;
  const show = (index) => {
    if (!triggers.length) return;
    currentIndex = Math.max(0, Math.min(index, triggers.length - 1));
    const button = triggers[currentIndex];
    image.src = button.dataset.lightboxSrc || '';
    title.textContent = button.dataset.lightboxTitle || '截图';
    time.textContent = (button.dataset.lightboxTime || '') + (triggers.length > 1 ? ' · ' + (currentIndex + 1) + '/' + triggers.length : '');
    prevButton.disabled = currentIndex === 0;
    nextButton.disabled = currentIndex === triggers.length - 1;
    lightbox.hidden = false;
  };
  const close = () => {
    lightbox.hidden = true;
    image.removeAttribute('src');
  };
  triggers.forEach((button, index) => {
    button.addEventListener('click', () => {
      show(Number(button.dataset.lightboxIndex || index));
    });
  });
  prevButton?.addEventListener('click', () => show(currentIndex - 1));
  nextButton?.addEventListener('click', () => show(currentIndex + 1));
  lightbox.querySelector('.shot-lightbox-close')?.addEventListener('click', close);
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) close();
  });
  document.addEventListener('keydown', (event) => {
    if (lightbox.hidden) return;
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft') show(currentIndex - 1);
    if (event.key === 'ArrowRight') show(currentIndex + 1);
  });
})();
</script>
</body>
</html>
`;
}

function displayPlatform(value) {
  const labels = {
    harmony: 'Harmony',
    android: 'Android',
    ios: 'iOS',
  };
  return labels[value] || value || '-';
}

function platformConclusion(platform = {}) {
  if (platform.status === 'FAIL') {
    return platform.reason || displayFailureCode(platform.failureCode) || platform.failedStep || platform.failureCode || '失败';
  }
  if (platform.status === 'BLOCKED') {
    return platform.reason || displayFailureCode(platform.failureCode) || platform.failedStep || platform.failureCode || '阻塞';
  }
  if (platform.status === 'UNKNOWN') {
    return platform.reason || displayFailureCode(platform.failureCode) || platform.failureCode || '证据不足';
  }
  if (platform.status === 'PASS') return '全部步骤通过';
  return '未执行';
}

function renderCaseOverviewHtml(caseDir, caseJson, notes = []) {
  const platforms = collectCasePlatforms(caseDir, caseJson);
  const aggregate = aggregateCaseSummary(platforms, readCaseRuntimeSummary(caseDir, caseJson, ''));
  const statusClass = className(aggregate.status || 'NOT_RUN');
  const platformCards = platforms.length
    ? platforms.map((platform) => {
      const itemClass = className(platform.status || 'NOT_RUN');
      const duration = platform.durationMs !== null && platform.durationMs !== undefined ? formatDuration(platform.durationMs) : '-';
      const resultText = displayFailureCode(platform.failureCode) || displayStatus(platform.status);
      const href = path.relative(caseDir, platform.contextPath).replace(/\\/g, '/');
      const reportLink = fs.existsSync(platform.contextPath) && platform.status !== 'NOT_RUN'
        ? `<a class="platform-report-link" href="${escapeHtml(href)}">查看报告</a>`
        : '<span class="platform-report-link disabled">未执行</span>';
      const reasonText = platform.reason || platformConclusion(platform);
      return `<article class="platform-report-card ${escapeHtml(itemClass)}">
        <div class="platform-report-head">
          <div class="platform-report-title">
            <strong>${escapeHtml(displayPlatform(platform.platform))}</strong>
            <span class="pill ${escapeHtml(itemClass)}">${escapeHtml(displayStatus(platform.status))}</span>
          </div>
          ${reportLink}
        </div>
        <div class="platform-report-result">
          <span>执行结果</span>
          <b>${escapeHtml(resultText)}</b>
        </div>
        <p>${escapeHtml(reasonText || '暂无执行结论。')}</p>
        <div class="platform-report-meta">
          <div><span>步骤</span><b>${escapeHtml(platform.stepsSummary || '-')}</b></div>
          <div><span>耗时</span><b>${escapeHtml(duration)}</b></div>
          <div><span>开始</span><b>${escapeHtml(formatDisplayTime(platform.startedAt))}</b></div>
          <div><span>结束</span><b>${escapeHtml(formatDisplayTime(platform.endedAt || platform.updatedAt))}</b></div>
        </div>
      </article>`;
    }).join('\n')
    : '<p class="empty">暂无平台执行记录。</p>';
  const preconditionRows = (caseJson.preconditions || []).length
    ? caseJson.preconditions.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.text)}</td><td>${escapeHtml(displayPreconditionMode(item.checkMode))}</td></tr>`).join('\n')
    : '<tr><td colspan="3">无</td></tr>';
  const stepRows = (caseJson.steps || []).length
    ? caseJson.steps.map((step) => `<tr><td>${escapeHtml(step.index)}</td><td>${escapeHtml(step.id)}</td><td>${escapeHtml(step.sourceText)}</td><td>${escapeHtml(displayStepGoal(step.goal || step.kind || '-'))}</td></tr>`).join('\n')
    : '<tr><td colspan="4">无</td></tr>';
  const globalRules = Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [];
  const ruleRows = globalRules.length
    ? globalRules.map((rule) => {
      const appliesTo = Array.isArray(rule.appliesTo) ? rule.appliesTo.join(', ') : rule.appliesTo || 'any_step';
      const when = typeof rule.when === 'object' ? JSON.stringify(rule.when) : rule.when;
      return `<tr><td>${escapeHtml(rule.id || '-')}</td><td>${escapeHtml(rule.scope || '-')}</td><td>${escapeHtml(appliesTo)}</td><td>${escapeHtml(when || '-')}</td></tr>`;
    }).join('\n')
    : '<tr><td colspan="4">无</td></tr>';
  const noteRows = notes.filter((note) => note.source === 'conversation').length
    ? notes.filter((note) => note.source === 'conversation').map((note) => `<tr>
        <td>${escapeHtml(formatDisplayTime(note.time))}</td>
        <td>${escapeHtml(note.appliesTo || '-')}</td>
        <td>${escapeHtml(note.stale ? '失效' : '生效')}</td>
        <td>${escapeHtml(note.text || '')}</td>
      </tr>`).join('\n')
    : '<tr><td colspan="4">无</td></tr>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(caseJson.identity.title)} - 多平台用例详情</title>
  <style>
    :root { color-scheme: light; --bg:#f5fbff; --surface:#ffffff; --surface-soft:#f8fcff; --surface-tint:#eef8ff; --text:#111827; --muted:#5f6f86; --line:#d8e8f6; --accent:#0ea5e9; --accent-strong:#0284c7; --accent-soft:#e0f2fe; --pass:#059669; --pass-soft:#ecfdf5; --pass-line:#86efac; --fail:#dc2626; --fail-soft:#fef2f2; --fail-line:#fca5a5; --blocked:#b7791f; --blocked-soft:#fffbeb; --blocked-line:#fde68a; --unknown:#64748b; --unknown-soft:#f1f5f9; --shadow:0 12px 34px rgba(15, 55, 90, .08); }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #eef8ff 0, var(--bg) 230px); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 24px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; padding: 18px 0 4px; }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 17px; }
    a { color: var(--accent-strong); text-decoration: none; font-weight: 700; }
    a:hover { color: #0369a1; text-decoration: underline; text-underline-offset: 3px; }
    .muted { color: var(--muted); }
    .back-link { display:inline-flex; margin-bottom: 8px; font-size: 13px; }
    .status { display: inline-flex; min-width: 104px; justify-content: center; padding: 7px 12px; border-radius: 8px; color: #fff; font-weight: 800; }
    .status.pass { background: var(--pass); }
    .status.fail { background: var(--fail); }
    .status.blocked { background: var(--blocked); }
    .status.unknown, .status.not_run { background: var(--unknown); }
    section, .platform-report-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    section { padding: 16px; margin-top: 14px; overflow: hidden; }
    .platform-report-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .platform-report-card { position: relative; min-width: 0; padding: 14px; overflow: hidden; }
    .platform-report-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--unknown); }
    .platform-report-card.pass { border-color: var(--pass-line); background: var(--pass-soft); }
    .platform-report-card.pass::before { background: var(--pass); }
    .platform-report-card.fail { border-color: var(--fail-line); background: var(--fail-soft); }
    .platform-report-card.fail::before { background: var(--fail); }
    .platform-report-card.blocked { border-color: var(--blocked-line); background: var(--blocked-soft); }
    .platform-report-card.blocked::before { background: var(--blocked); }
    .platform-report-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-left: 4px; }
    .platform-report-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .platform-report-title strong { color: #172033; font-size: 16px; }
    .platform-report-result { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; gap: 8px; margin-top: 14px; padding-left: 4px; color: #243447; }
    .platform-report-result span { color: var(--muted); font-size: 12px; font-weight: 800; white-space: nowrap; }
    .platform-report-result b { min-width: 0; font-size: 15px; font-weight: 900; overflow-wrap: anywhere; }
    .platform-report-card p { min-height: 44px; margin: 10px 0 12px; padding-left: 4px; color: #334155; font-size: 13px; font-weight: 700; line-height: 1.55; }
    .platform-report-meta { display: grid; grid-template-columns: 80px 88px minmax(180px, 1fr) minmax(180px, 1fr); gap: 8px; }
    .platform-report-meta div { min-width: 0; padding: 8px 10px; border: 1px solid rgba(203, 213, 225, .78); border-radius: 6px; background: rgba(255, 255, 255, .66); }
    .platform-report-meta span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; }
    .platform-report-meta b { display: block; margin-top: 2px; color: #334155; font-size: 12px; font-weight: 900; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .platform-report-link { justify-self: end; padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .platform-report-link.disabled { color: var(--muted); cursor: default; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; overflow: hidden; border-radius: 8px; }
    th, td { padding: 8px 10px; border-top: 1px solid var(--line); text-align: left; vertical-align: middle; word-break: break-word; }
    thead th { border-top: 0; background: var(--surface-tint); color: var(--muted); font-weight: 600; }
    tbody tr:nth-child(even) td { background: var(--surface-soft); }
    .table-wrap { width: 100%; overflow-x: auto; }
    .table-wrap table { min-width: 780px; }
    .pill { display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .pill.pass { color: var(--pass); background: var(--pass-soft); border-color: var(--pass-line); }
    .pill.fail { color: var(--fail); background: var(--fail-soft); border-color: var(--fail-line); }
    .pill.blocked { color: var(--blocked); background: var(--blocked-soft); border-color: var(--blocked-line); }
    .pill.unknown, .pill.not_run, .pill.pending { color: var(--unknown); background: var(--unknown-soft); border-color: #cbd5e1; }
    .empty { color: var(--muted); margin: 0; }
    @media (max-width: 900px) { .platform-report-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 760px) { main { width: calc(100vw - 20px); margin-top: 14px; } header { display:block; } h1 { font-size: 22px; } section { padding: 12px; } .platform-report-grid, .platform-report-meta { grid-template-columns: 1fr; } .platform-report-head { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
<main>
  <a class="back-link" href="../../index.html">返回总览</a>
  <header>
    <div>
      <h1>${escapeHtml(caseJson.identity.title)}</h1>
      <div class="muted">多平台用例详情 · 编号：${escapeHtml(caseJson.identity.caseNo || '-')} · ${escapeHtml(caseJson.identity.caseKey || '-')}</div>
    </div>
    <span class="status ${escapeHtml(statusClass)}">${escapeHtml(displayStatus(aggregate.status))}</span>
  </header>

  <section>
    <h2>平台执行概览</h2>
    <div class="platform-report-grid">${platformCards}</div>
  </section>

  <section>
    <h2>共享前置条件</h2>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:100px">ID</th><th>内容</th><th style="width:140px">模式</th></tr></thead>
      <tbody>${preconditionRows}</tbody>
    </table></div>
  </section>

  <section>
    <h2>共享用例步骤</h2>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:60px">#</th><th style="width:100px">ID</th><th>内容</th><th style="width:120px">类型</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table></div>
  </section>

  <section>
    <h2>全局规则</h2>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:120px">ID</th><th style="width:140px">范围</th><th style="width:140px">适用步骤</th><th>条件</th></tr></thead>
      <tbody>${ruleRows}</tbody>
    </table></div>
  </section>

  <section>
    <h2>用户补充</h2>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:180px">时间</th><th style="width:120px">步骤</th><th style="width:90px">状态</th><th>内容</th></tr></thead>
      <tbody>${noteRows}</tbody>
    </table></div>
  </section>
</main>
</body>
</html>
`;
}

function renderIndexHtml(rootDir, cases = []) {
  const total = cases.length;
  const platformStats = summarizeIndexPlatforms(cases);
  const platformSummary = `<div class="platform-overview">${platformStats.map((item) => `<section class="platform-overview-card">
        <div class="platform-overview-head">
          <span>${escapeHtml(displayPlatform(item.platform))}</span>
          <span class="platform-pass-rate"><em>通过率</em><b>${escapeHtml(item.passRate)}</b></span>
        </div>
        <div class="platform-status-grid">
          <div class="total"><span>用例</span><b>${escapeHtml(item.total)}</b></div>
          <div class="pass"><span>通过</span><b>${escapeHtml(item.pass)}</b></div>
          <div class="fail"><span>失败</span><b>${escapeHtml(item.fail)}</b></div>
          <div class="blocked"><span>阻塞</span><b>${escapeHtml(item.blocked)}</b></div>
          <div class="unknown"><span>未知</span><b>${escapeHtml(item.unknown)}</b></div>
          <div class="not-run"><span>未执行</span><b>${escapeHtml(item.notRun)}</b></div>
        </div>
      </section>`).join('\n')}</div>`;
  const cards = cases.length
    ? cases.map((item, index) => {
      const statusClass = className(item.status);
      const caseNo = item.caseNo || `#${index + 1}`;
      const platforms = Array.isArray(item.platforms) ? item.platforms : [];
      const preconditionTags = renderIndexPreconditionTags(item.preconditions || []);
      const platformDetails = platforms.length
        ? `<details class="platform-details">
          <summary>
            <span>平台概览</span>
            <div class="platform-brief-list">${platforms.map((platform) => {
          const platformStatusClass = className(platform.status);
          const platformDuration = platform.durationMs !== null && platform.durationMs !== undefined ? formatDuration(platform.durationMs) : '-';
          return `<span class="platform-brief ${escapeHtml(platformStatusClass)}">
            <span class="platform-brief-head"><b>${escapeHtml(displayPlatform(platform.platform))}</b><em>${escapeHtml(displayStatus(platform.status))}</em><small>${escapeHtml(platform.stepsSummary || '-')} · ${escapeHtml(platformDuration)}</small></span>
          </span>`;
        }).join('')}</div>
            <em class="details-toggle">展开平台详情</em>
          </summary>
          <div class="platform-detail-list">${platforms.map((platform) => {
          const platformStatusClass = className(platform.status);
          const platformDuration = platform.durationMs !== null && platform.durationMs !== undefined ? formatDuration(platform.durationMs) : '-';
          let platformResult = '等待执行';
          if (platform.status === 'FAIL') {
            platformResult = displayFailureCode(platform.failureCode) || platform.reason || platform.failedStep || platform.failureCode || '失败';
          } else if (platform.status === 'BLOCKED') {
            platformResult = displayFailureCode(platform.failureCode) || platform.reason || platform.failedStep || platform.failureCode || '阻塞';
          } else if (platform.status === 'UNKNOWN') {
            platformResult = displayFailureCode(platform.failureCode) || platform.reason || platform.failureCode || '证据不足';
          } else if (platform.status === 'PASS') {
            platformResult = '全部步骤通过';
          }
          const reasonText = platform.reason || platformConclusion(platform);
          const reportAction = platform.status === 'NOT_RUN'
            ? '<span class="platform-report-link disabled">未执行</span>'
            : `<a class="platform-report-link" href="${escapeHtml(platform.contextHref)}">查看报告</a>`;
          return `<article class="platform-detail-card ${escapeHtml(platformStatusClass)}">
            <div class="platform-detail-main">
              <div class="platform-detail-title">
                <strong>${escapeHtml(displayPlatform(platform.platform))}</strong>
                <span class="pill ${escapeHtml(platformStatusClass)}">${escapeHtml(displayStatus(platform.status))}</span>
              </div>
              <div class="platform-result"><span>执行结果</span><b>${escapeHtml(platformResult)}</b></div>
              ${reportAction}
            </div>
            <div class="platform-reason"><span>摘要</span><b>${escapeHtml(reasonText)}</b></div>
            <div class="platform-detail-meta">
              <div><span>步骤</span><b>${escapeHtml(platform.stepsSummary || '-')}</b></div>
              <div><span>耗时</span><b>${escapeHtml(platformDuration)}</b></div>
              <div class="platform-time"><span>开始</span><b>${escapeHtml(formatDisplayTime(platform.startedAt))}</b></div>
              <div class="platform-time"><span>结束</span><b>${escapeHtml(formatDisplayTime(platform.endedAt || platform.updatedAt))}</b></div>
            </div>
          </article>`;
        }).join('')}</div>
        </details>`
        : `<div class="platform-details empty-panel"><p>暂无平台执行记录</p></div>`;
      return `<div class="case-card ${escapeHtml(statusClass)}">
        <div class="case-header">
          <div class="case-kicker">
            <span class="case-no">${escapeHtml(caseNo)}</span>
            <span class="pill ${escapeHtml(statusClass)}">${escapeHtml(displayStatus(item.status))}</span>
          </div>
          <h2><a href="${escapeHtml(item.contextHref)}">${escapeHtml(item.title)}</a></h2>
          <a class="case-open" href="${escapeHtml(item.contextHref)}">查看多端详情</a>
        </div>
        ${preconditionTags}
        ${platformDetails}
      </div>`;
    }).join('\n')
    : '<p class="empty">暂无用例。</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 视觉测试总览</title>
  <style>
    :root { color-scheme: light; --bg:#f5fbff; --surface:#ffffff; --surface-soft:#f8fcff; --surface-tint:#eef8ff; --text:#111827; --muted:#5f6f86; --line:#d8e8f6; --accent:#0ea5e9; --accent-strong:#0284c7; --accent-soft:#e0f2fe; --pass:#059669; --pass-soft:#ecfdf5; --pass-line:#86efac; --fail:#dc2626; --fail-soft:#fef2f2; --fail-line:#fca5a5; --blocked:#b7791f; --blocked-soft:#fffbeb; --blocked-line:#fde68a; --unknown:#64748b; --unknown-soft:#f1f5f9; --shadow:0 12px 34px rgba(15, 55, 90, .08); }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #eef8ff 0, var(--bg) 230px); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 24px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; padding: 18px 0 4px; }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
    a { color: var(--accent-strong); text-decoration: none; font-weight: 600; }
    a:hover { color: #0369a1; text-decoration: underline; text-underline-offset: 3px; }
    .muted { color: var(--muted); }
    .small { margin-top: 2px; font-size: 12px; font-weight: 400; }
    .overview-panel { display: grid; grid-template-columns: minmax(240px, .85fr) minmax(0, 1.8fr); gap: 12px; margin-bottom: 16px; }
    .overview-primary { min-height: 104px; padding: 16px 18px; border: 1px solid #bae6fd; border-radius: 8px; background: linear-gradient(135deg, #ffffff 0%, #e0f2fe 100%); box-shadow: var(--shadow); }
    .overview-primary span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; }
    .overview-primary strong { display: block; margin-top: 2px; color: var(--text); font-size: 34px; line-height: 1; }
    .overview-primary small { display: block; margin-top: 10px; color: var(--accent-strong); font-size: 13px; font-weight: 800; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(96px, 1fr)); gap: 10px; }
    .metric, section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .metric { padding: 12px 14px; background: var(--surface-soft); }
    .metric.fail { border-color: var(--fail-line); background: var(--fail-soft); }
    .metric.blocked { border-color: var(--blocked-line); background: var(--blocked-soft); }
    .metric.pass { border-color: var(--pass-line); background: var(--pass-soft); }
    .metric span { display:block; color: var(--muted); font-size: 12px; }
    .metric strong { display:block; margin-top: 3px; font-size: 20px; }
    .platform-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 18px; }
    .platform-overview-card { min-height: 132px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
    .platform-overview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .platform-overview-head span { color: var(--muted); font-size: 13px; font-weight: 800; }
    .platform-pass-rate { display: inline-flex; flex: 0 0 auto; align-items: baseline; gap: 6px; min-height: 28px; padding: 4px 9px; border: 1px solid #bae6fd; border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); }
    .platform-pass-rate em { color: var(--muted); font-size: 11px; font-style: normal; font-weight: 800; }
    .platform-pass-rate b { color: var(--accent-strong); font-size: 15px; line-height: 1; font-variant-numeric: tabular-nums; }
    .platform-status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .platform-status-grid div { min-width: 0; padding: 9px 10px; border: 1px solid #e2edf7; border-radius: 6px; background: var(--surface-soft); }
    .platform-status-grid span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; white-space: nowrap; }
    .platform-status-grid b { display: block; margin-top: 3px; color: #172033; font-size: 18px; line-height: 1.1; }
    .platform-status-grid .total b { color: var(--accent-strong); }
    .platform-status-grid .pass b { color: var(--pass); }
    .platform-status-grid .fail b { color: var(--fail); }
    .platform-status-grid .blocked b { color: var(--blocked); }
    .platform-status-grid .unknown b, .platform-status-grid .not-run b { color: var(--unknown); }
    section { padding: 16px; overflow: hidden; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; overflow: hidden; border-radius: 8px; }
    th, td { padding: 8px 10px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; word-break: break-word; }
    thead th { border-top: 0; background: var(--surface-tint); color: var(--muted); font-weight: 600; }
    tbody tr:nth-child(even) td { background: var(--surface-soft); }
    .pill { display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .pill.pass { color: var(--pass); background: var(--pass-soft); border-color: var(--pass-line); }
    .pill.fail { color: var(--fail); background: var(--fail-soft); border-color: var(--fail-line); }
    .pill.blocked { color: var(--blocked); background: var(--blocked-soft); border-color: var(--blocked-line); }
    .pill.unknown, .pill.not_run, .pill.pending { color: var(--unknown); background: var(--unknown-soft); border-color: #cbd5e1; }
    .case-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .case-card { position: relative; display: block; min-height: 128px; padding: 16px 18px 15px 22px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); overflow: hidden; }
    .case-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 5px; background: var(--unknown); }
    .case-card.pass::before { background: var(--pass); }
    .case-card.fail::before { background: var(--fail); }
    .case-card.blocked::before { background: var(--blocked); }
    .case-card.fail { border-color: #fecaca; background: linear-gradient(90deg, #fff7f7 0, var(--surface) 52px); }
    .case-card.blocked { border-color: #fde68a; background: linear-gradient(90deg, #fffbeb 0, var(--surface) 52px); }
    .case-card.pass { border-color: #bbf7d0; }
    .case-card:hover { transform: translateY(-1px); border-color: #bae6fd; box-shadow: 0 16px 40px rgba(15, 55, 90, .12); }
    .case-header { display: flex; min-width: 0; align-items: center; gap: 14px; }
    .case-kicker { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 8px; min-width: 104px; }
    .case-no { color: var(--accent-strong); font-weight: 800; }
    .case-card h2 { min-width: 0; margin: 0; font-size: 16px; line-height: 1.38; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .case-open { flex: 0 0 auto; margin-left: auto; padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .case-preconditions { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; margin-top: 11px; min-width: 0; }
    .case-precondition-label { color: var(--muted); font-size: 12px; font-weight: 800; line-height: 28px; white-space: nowrap; }
    .precondition-tags { display: flex; flex-wrap: wrap; gap: 7px; min-width: 0; }
    .precondition-tag { display: inline-flex; align-items: center; min-width: 0; max-width: 260px; height: 28px; padding: 0 9px; border: 1px solid #cbd5e1; border-radius: 6px; background: var(--unknown-soft); color: #334155; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .precondition-tag b { flex: 0 0 auto; margin-right: 6px; font-size: 11px; color: inherit; }
    .precondition-tag em { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-style: normal; color: #1f2937; }
    .precondition-tag.ready { border-color: #bfdbfe; background: #eff6ff; color: #1d4ed8; }
    .precondition-tag.confirm { border-color: #bae6fd; background: #f0f9ff; color: var(--accent-strong); }
    .precondition-tag.needs_setup { border-color: var(--blocked-line); background: var(--blocked-soft); color: var(--blocked); }
    .precondition-tag.unknown { border-color: #cbd5e1; background: var(--unknown-soft); color: var(--unknown); }
    .precondition-tag.unsupported { border-color: var(--fail-line); background: var(--fail-soft); color: var(--fail); }
    .precondition-tag.none, .precondition-tag.more { max-width: none; color: var(--muted); background: #fff; }
    .case-conclusion { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px; min-width: 0; margin-top: 11px; color: #243447; font-size: 14px; line-height: 1.5; }
    .case-conclusion span { color: var(--muted); font-size: 12px; font-weight: 700; line-height: 1.75; }
    .case-conclusion strong { min-width: 0; color: #243447; font-size: 14px; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .platform-details { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
    .platform-details summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; cursor: pointer; list-style: none; }
    .platform-details summary::-webkit-details-marker { display: none; }
    .platform-details summary > span { color: var(--muted); font-size: 12px; font-weight: 800; white-space: nowrap; }
    .details-toggle { color: var(--accent-strong); font-size: 12px; font-style: normal; font-weight: 800; white-space: nowrap; }
    .platform-details[open] .details-toggle::before { content: "收起"; }
    .platform-details[open] .details-toggle { font-size: 0; }
    .platform-details[open] .details-toggle::before { font-size: 12px; }
    .platform-brief-list { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
    .platform-brief { display: inline-grid; gap: 4px; min-height: 32px; min-width: 188px; max-width: 240px; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: var(--muted); font-size: 12px; font-weight: 800; }
    .platform-brief-head { display: grid; grid-template-columns: minmax(68px, auto) auto minmax(70px, 1fr); align-items: center; gap: 7px; min-width: 0; }
    .platform-brief b { color: #243447; }
    .platform-brief em { font-style: normal; white-space: nowrap; }
    .platform-brief small { color: var(--muted); font-size: 11px; font-weight: 800; text-align: right; white-space: nowrap; }
    .platform-brief.pass { color: var(--pass); border-color: var(--pass-line); background: var(--pass-soft); }
    .platform-brief.fail { color: var(--fail); border-color: var(--fail-line); background: var(--fail-soft); }
    .platform-brief.blocked { color: var(--blocked); border-color: var(--blocked-line); background: var(--blocked-soft); }
    .platform-brief.unknown, .platform-brief.not_run { color: var(--unknown); border-color: #cbd5e1; background: var(--unknown-soft); }
    .platform-detail-list { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 10px; }
    .platform-detail-card { display: grid; grid-template-columns: 1fr; gap: 8px; align-items: stretch; padding: 10px 12px; border: 1px solid #dbeafe; border-radius: 8px; background: #fff; }
    .platform-detail-card.pass { border-color: var(--pass-line); background: var(--pass-soft); }
    .platform-detail-card.fail { border-color: var(--fail-line); background: var(--fail-soft); }
    .platform-detail-card.blocked { border-color: var(--blocked-line); background: var(--blocked-soft); }
    .platform-detail-main { display: grid; grid-template-columns: minmax(112px, auto) minmax(260px, 1fr) auto; align-items: center; gap: 12px; min-width: 0; }
    .platform-detail-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .platform-detail-title strong { color: #172033; font-size: 13px; }
    .platform-result { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; color: #243447; font-size: 13px; font-weight: 800; overflow: visible; white-space: normal; }
    .platform-result span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .platform-result b { min-width: 0; overflow-wrap: anywhere; }
    .platform-reason { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; align-items: start; color: #334155; font-size: 12px; line-height: 1.45; }
    .platform-reason span { color: var(--muted); font-weight: 700; }
    .platform-reason b { min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
    .platform-report-link { justify-self: end; padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .platform-report-link.disabled { color: var(--muted); cursor: default; }
    .platform-detail-meta { display: grid; grid-template-columns: 76px 92px minmax(220px, 1fr) minmax(220px, 1fr); gap: 8px 14px; align-items: center; min-width: 0; padding-top: 2px; }
    .platform-detail-meta div { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; }
    .platform-detail-meta span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .platform-detail-meta b { color: #334155; font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .empty-panel p { margin: 0; color: var(--muted); font-size: 12px; }
    @media (max-width: 1060px) { .platform-status-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .platform-detail-meta { grid-template-columns: 76px 92px minmax(220px, 1fr) minmax(220px, 1fr); } }
    @media (max-width: 760px) { main { width: calc(100vw - 20px); margin-top: 14px; } .platform-overview { grid-template-columns: 1fr; } h1 { font-size: 22px; } section { padding: 12px; } .case-header { align-items: flex-start; flex-direction: column; gap: 8px; } .case-open { margin-left: 0; } .case-kicker { min-width: 0; } .case-card h2 { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; } .case-preconditions { grid-template-columns: 1fr; gap: 6px; } .case-precondition-label { line-height: 1.2; } .precondition-tag { max-width: 100%; } .platform-details summary { grid-template-columns: 1fr; align-items: start; } .details-toggle { justify-self: start; } .platform-detail-main { grid-template-columns: 1fr; } .platform-report-link { justify-self: start; } .platform-detail-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); } .platform-time { grid-column: 1 / -1; } }
    @media (max-width: 520px) { .platform-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .platform-detail-meta { grid-template-columns: 1fr; } .platform-detail-meta div { white-space: normal; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>AI 视觉测试总览</h1>
      <div class="muted">${escapeHtml(rootDir)} · ${escapeHtml(formatDisplayTime(formatLocalIso()))}</div>
    </div>
  </header>
  ${platformSummary}
  <div class="case-grid">${cards}</div>
</main>
</body>
</html>
`;
}
function summarizeIndexPlatforms(cases = []) {
  const ordered = PLATFORM_ORDER;
  const stats = new Map(ordered.map((platform) => [
    platform,
    { platform, total: 0, executed: 0, pass: 0, fail: 0, blocked: 0, unknown: 0, notRun: 0 },
  ]));
  for (const item of cases) {
    for (const platform of item.platforms || []) {
      const key = normalizePlatform(platform.platform);
      if (!key || !stats.has(key)) continue;
      const stat = stats.get(key);
      stat.total += 1;
      if (platform.status && platform.status !== 'NOT_RUN') stat.executed += 1;
      if (platform.status === 'PASS') stat.pass += 1;
      if (platform.status === 'FAIL') stat.fail += 1;
      if (platform.status === 'BLOCKED') stat.blocked += 1;
      if (platform.status === 'UNKNOWN') stat.unknown += 1;
      if (!platform.status || platform.status === 'NOT_RUN') stat.notRun += 1;
    }
  }
  return ordered.map((platform) => stats.get(platform))
    .map((item) => ({
      ...item,
      passRate: item.executed ? `${Math.round((item.pass / item.executed) * 100)}%` : '-',
    }));
}

module.exports = {
  appendJsonl,
  caseContractSha,
  caseDirectoryName,
  casePlatformDir,
  classifyPrecondition,
  caseRootFromCaseDir,
  caseRuntimeDir,
  casesRoot,
  ensureDir,
  formatLocalIso,
  formatDuration,
  collectIndexCases,
  refreshIndexForCase,
  renderIndexForRoot,
  latestExecutionDir,
  nowIso,
  parseMarkdownCase,
  readJson,
  readCaseEntries,
  readJsonl,
  readText,
  reapplyNotes,
  renderContext,
  renderContextHtml,
  renderIndexHtml,
  displayFailureCode,
  readLatestExecutionReport,
  summarizeTimeline,
  sha1,
  slugify,
  desiredCaseDir,
  nextCaseNo,
  normalizeCaseNo,
  normalizePlatform,
  normalizePreconditionText,
  platformStatePath,
  PRECONDITION_STATUS_PRIORITY,
  syncCaseDirectory,
  worsePreconditionStatus,
  workspaceRoot,
  writeCaseReports,
  writePlatformCaseReports,
  writeJson,
  writeText,
  hasWorkspaceShape,
};

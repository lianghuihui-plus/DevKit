#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  return `contract-${sha1(stableJson({
    sourceSha1: caseJson.identity?.sourceSha1 || '',
    globalRules: Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [],
  })).slice(0, 12)}`;
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

function workspaceRoot(cwd = process.cwd()) {
  return path.join(cwd, 'ai-visual-test');
}

function casesRoot(cwd = process.cwd()) {
  return path.join(workspaceRoot(cwd), 'cases');
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

function parseBullets(lines) {
  return lines
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
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
  const preconditions = parseBullets(sectionLines(markdown, ['前置条件', 'preconditions'])).map((text, idx) => ({
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
      globalRules: [],
      sourceChanged: false,
      staleNotes: [],
    },
  };
}

function inferPreconditionMode(text) {
  if (/已安装|设备已连接|App\s*已安装/.test(text)) return 'auto_check';
  if (/未登录/.test(text)) return 'auto_check';
  if (/已登录|登录/.test(text)) return 'auto_prepare';
  if (/账号|手机号|验证码|密码/.test(text)) return 'manual_context';
  return 'manual_context';
}

function reapplyNotes(caseJson, notes, options = {}) {
  const staleNotes = [];
  for (const note of notes) {
    if (note.source !== 'conversation' || note.stale) continue;
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

function reportMatchesCaseSource(caseJson, report = {}) {
  const caseSha = caseJson.identity?.sourceSha1 || '';
  const sourceSha = reportSourceSha(report);
  const expectedContractSha = caseContractSha(caseJson);
  const actualContractSha = reportCaseContractSha(report);
  if (actualContractSha) return actualContractSha === expectedContractSha;
  const hasRules = Array.isArray(caseJson.globalRules) && caseJson.globalRules.length > 0;
  if (hasRules) return false;
  return !caseSha || !sourceSha || caseSha === sourceSha;
}

function collectIndexCases(rootDir) {
  const casesRoot = path.join(rootDir, 'cases');
  if (!fs.existsSync(casesRoot)) return [];
  return fs.readdirSync(casesRoot)
    .map((name) => path.join(casesRoot, name))
    .filter((caseDir) => fs.statSync(caseDir).isDirectory())
    .map((caseDir) => {
      const caseJson = readJson(path.join(caseDir, 'case.json'), {});
      const state = readJson(path.join(caseDir, 'state.json'), {});
      const latest = latestResultExecutionDir(caseDir);
      const result = latest ? readJson(path.join(latest, 'result.json'), null) : null;
      const metrics = latest ? readJson(path.join(latest, 'metrics.json'), null) : null;
      const current = reportMatchesCaseSource(caseJson, { result, metrics });
      const currentResult = current ? result : null;
      const currentMetrics = current ? metrics : null;
      const status = currentResult?.status || (!result ? state.latestStatus : 'NOT_RUN') || 'NOT_RUN';
      const steps = currentMetrics?.steps;
      return {
        caseDir,
        caseNo: caseJson.identity?.caseNo || '',
        title: caseJson.identity?.title || path.basename(caseDir),
        caseKey: caseJson.identity?.caseKey || '',
        status,
        latestExecutionId: currentResult?.executionId || (!result ? state.latestExecutionId : '') || '',
        durationMs: currentMetrics?.durationMs,
        stepsSummary: steps ? `${steps.passed || 0}/${steps.total || 0}` : `${caseJson.steps?.length || 0}`,
        failureCode: currentResult?.failureCode || (!result ? state.latestFailureCode : '') || '',
        updatedAt: currentResult?.endedAt || state.environmentConfirmedAt || caseJson.identity?.sourceUpdatedAt || '',
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

function renderIndexForRoot(rootDir) {
  const cases = collectIndexCases(rootDir);
  const indexPath = path.join(rootDir, 'index.html');
  writeText(indexPath, renderIndexHtml(rootDir, cases));
  return indexPath;
}

function refreshIndexForCase(caseDir) {
  return renderIndexForRoot(caseRootFromCaseDir(caseDir));
}

function readLatestExecutionReport(caseDir) {
  const latest = latestResultExecutionDir(caseDir) || latestExecutionDir(caseDir);
  return {
    latest,
    result: latest ? readJson(path.join(latest, 'result.json'), null) : null,
    metrics: latest ? readJson(path.join(latest, 'metrics.json'), null) : null,
    events: latest ? readJsonl(path.join(latest, 'timeline.jsonl')) : [],
  };
}

function writeCaseReports(caseDir, caseJson, state = {}, notes = [], report = null) {
  const rawReport = report || readLatestExecutionReport(caseDir);
  const sourceMatches = reportMatchesCaseSource(caseJson, rawReport);
  const latestReport = sourceMatches ? rawReport : { latest: rawReport.latest, result: null, metrics: null, events: [] };
  const reportState = sourceMatches ? state : {
    ...state,
    latestStatus: 'NOT_RUN',
    latestExecutionId: '',
    latestFailedStep: null,
    latestFailureCode: null,
  };
  writeText(path.join(caseDir, 'CONTEXT.md'), renderContext(caseJson, reportState, latestReport.result, latestReport.metrics, notes, latestReport.events));
  writeText(path.join(caseDir, 'CONTEXT.html'), renderContextHtml(caseJson, reportState, latestReport.result, latestReport.metrics, notes, latestReport.events));
  return {
    context: path.join(caseDir, 'CONTEXT.md'),
    contextHtml: path.join(caseDir, 'CONTEXT.html'),
  };
}

function summarizeTimeline(events = []) {
  const summary = {
    observations: events.filter((event) => event.type === 'observation'),
    actions: events.filter((event) => event.type === 'actionResult'),
    decisions: events.filter((event) => event.type === 'decision'),
    rules: events.filter((event) => event.type === 'rule'),
    flowScans: events.filter((event) => event.type === 'flowScan'),
    flows: events.filter((event) => event.type === 'flow'),
    assertions: events.filter((event) => event.type === 'assertion'),
    preconditions: events.filter((event) => event.type === 'precondition'),
  };
  summary.latestObservation = summary.observations[summary.observations.length - 1] || null;
  return summary;
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
  const flowScanEvents = events.filter((event) => event.type === 'flowScan');
  const flowEvents = events.filter((event) => event.type === 'flow');
  if (flowScanEvents.length || flowEvents.length) {
    lines.push('');
    lines.push('## 业务路径 Flow');
    for (const event of flowScanEvents) {
      const matched = Array.isArray(event.matchedFlowIds) && event.matchedFlowIds.length ? ` / matched=${event.matchedFlowIds.join(', ')}` : '';
      lines.push(`- ${formatDisplayTime(event.time)}：Flow 扫描 / ${event.status} / candidates=${event.candidateCount ?? 0}${matched}${event.stepId ? ` / ${event.stepId}` : ''}${event.reason ? ` / ${event.reason}` : ''}`);
    }
    for (const event of flowEvents) {
      const parts = [
        event.flowId,
        event.status,
        event.flowStepId,
        event.stepId,
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
    if (metrics.preconditions) lines.push(`- 前置条件：${metrics.preconditions.passed || 0}/${metrics.preconditions.total || 0} 通过，${metrics.preconditions.failed || 0} 失败`);
    if (metrics.actions) lines.push(`- 动作：${metrics.actions.total || 0} 次，点击 ${metrics.actions.tap || 0} 次，开关 ${metrics.actions.toggle || 0} 次，输入 ${metrics.actions.inputText || 0} 次，拉起 App ${metrics.actions.launchApp || 0} 次`);
    if (metrics.flows) lines.push(`- Flow：事件 ${metrics.flows.totalEvents || 0} 条，完成 ${metrics.flows.completed || 0} 个，失败 ${metrics.flows.failed || 0} 个，阻塞 ${metrics.flows.blocked || 0} 个`);
    if (metrics.stability) lines.push(`- 稳定性：离开目标 App ${metrics.stability.appForegroundLossCount || 0} 次，重新拉起 ${metrics.stability.appRelaunchCount || 0} 次，已处理弹窗 ${metrics.stability.knownPopupHandledCount || 0} 次`);
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
    lines.push(`- observation：${timeline.observations.length} 条，action：${timeline.actions.length} 条，decision：${timeline.decisions.length} 条，rule：${timeline.rules.length} 条，flowScan：${timeline.flowScans.length} 条，flow：${timeline.flows.length} 条，assertion：${timeline.assertions.length} 条`);
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
  if (caseJson.sourceChanged || caseJson.staleNotes?.length) {
    lines.push('');
    lines.push('## 源用例变更');
    lines.push('- 检测到 Markdown 内容已变化，已重新生成 case.json。');
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function className(value) {
  return String(value || 'UNKNOWN').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

const STATUS_LABELS = {
  PASS: '通过',
  FAIL: '失败',
  BLOCKED: '阻塞',
  UNKNOWN: '未知',
  NOT_RUN: '未执行',
  PENDING: '待执行',
  PREPARED: '已准备',
};

const EVENT_LABELS = {
  executionStart: '开始执行',
  environmentProbe: '环境探测',
  precondition: '前置条件',
  observation: '截图观察',
  perception: '页面理解',
  decision: '执行决策',
  rule: '规则命中',
  flowScan: 'Flow 扫描',
  flow: '业务路径 Flow',
  actionResult: '操作结果',
  assertion: '断言结果',
  popup: '弹窗处理',
  appForeground: '前台状态',
  budgetExceeded: '预算超限',
  result: '执行结果',
};

const DECISION_LABELS = {
  act: '执行操作',
  assert_pass: '断言通过',
  assert_fail: '断言失败',
  wait: '等待',
  blocked: '阻塞',
};

const ACTION_LABELS = {
  launchApp: '启动应用',
  tap: '点击',
  toggle: '切换开关',
  inputText: '输入文本',
  swipe: '滑动',
  back: '返回',
  home: '回到桌面',
  wait: '等待',
};

const STEP_GOAL_LABELS = {
  launch_app: '启动应用',
  tap: '点击',
  toggle: '切换开关',
  input_text: '输入文本',
  swipe: '滑动',
  back: '返回',
  wait: '等待',
  unknown: '操作',
  action: '操作',
  assertion: '断言',
};

const PRECONDITION_MODE_LABELS = {
  auto_check: '自动检查',
  auto_prepare: '自动准备',
  manual_context: '上下文',
  unsupported: '不支持',
};

function displayStatus(value) {
  return STATUS_LABELS[value] || value || '-';
}

function displayEventType(value) {
  return EVENT_LABELS[value] || value || '-';
}

function displayDecision(value) {
  return DECISION_LABELS[value] || value || '-';
}

function displayAction(value) {
  return ACTION_LABELS[value] || value || '-';
}

function formatActionSummary(actions) {
  if (!actions) return '-';
  const parts = [
    ['点击', actions.tap],
    ['开关', actions.toggle],
    ['输入', actions.inputText],
    ['滑动', actions.swipe],
    ['返回', actions.back],
    ['启动', actions.launchApp],
    ['等待', actions.wait],
  ]
    .filter(([, count]) => count)
    .map(([label, count]) => `${label} ${count}`);
  return `${actions.total || 0} 次${parts.length ? `（${parts.join('，')}）` : ''}`;
}

function displayStepGoal(value) {
  return STEP_GOAL_LABELS[value] || value || '-';
}

function displayPreconditionMode(value) {
  return PRECONDITION_MODE_LABELS[value] || value || '-';
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return value < 10000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDisplayTime(value) {
  if (!value) return '-';
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/);
  return match ? `${match[1]} ${match[2]}` : text;
}

function formatCell(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function eventStepId(event) {
  if (event.stepId || event.step?.id) return event.stepId || event.step?.id;
  const label = event.label || event.observation?.label || '';
  if (isFlowObservation(event, label)) return '';
  const match = String(label).match(/(?:^|[-_])(step-\d{3})(?:[-_]|$)/);
  return match ? match[1] : '';
}

function isFlowObservation(event, label = event.label || event.observation?.label || '') {
  if (event.type !== 'observation') return false;
  if (event.scope === 'flowRecording' || event.observation?.scope === 'flowRecording') return true;
  if (event.flowId || event.flowStepId || event.recordingId || event.observation?.flowId || event.observation?.flowStepId || event.observation?.recordingId) return true;
  const text = String(label);
  return /(?:^|[-_])flow[-_]step[-_]\d{3}(?:[-_]|$)/.test(text) ||
    /(?:^|[-_])(?:before|after)[-_]flow(?:[-_]|$)/.test(text);
}

function eventAction(event) {
  return event.action?.type || event.action || '';
}

function eventSummary(event) {
  if (event.type === 'executionStart') return `开始执行 ${event.executionId || ''}`.trim();
  if (event.type === 'precondition') return `${displayStatus(event.status)} ${event.reason || event.text || ''}`.trim();
  if (event.type === 'observation') return event.label || '截图观察';
  if (event.type === 'perception') return event.pageState || event.summary || '页面理解';
  if (event.type === 'decision') return `决策：${displayDecision(event.decision)}${event.reason ? `，${event.reason}` : ''}`;
  if (event.type === 'rule') return `${event.ruleId || '-'} ${event.status || ''}${event.reason ? `：${event.reason}` : ''}`.trim();
  if (event.type === 'flowScan') return `Flow 扫描 ${event.status || ''} / candidates=${event.candidateCount ?? 0}${Array.isArray(event.matchedFlowIds) && event.matchedFlowIds.length ? ` / matched=${event.matchedFlowIds.join(', ')}` : ''}${event.reason ? `：${event.reason}` : ''}`.trim();
  if (event.type === 'flow') return `${event.flowId || '-'} ${event.status || ''}${event.flowStepId ? ` / ${event.flowStepId}` : ''}${event.reason ? `：${event.reason}` : ''}`.trim();
  if (event.type === 'actionResult') return `${displayAction(eventAction(event))}${event.ok ? '成功' : '失败'}${event.error ? `：${event.error}` : ''}`;
  if (event.type === 'assertion') return `${displayStatus(event.status)}${event.reason ? `：${event.reason}` : ''}`;
  if (event.type === 'result') return `${displayStatus(event.status)}${event.reason ? `：${event.reason}` : ''}`;
  return event.reason || displayStatus(event.status) || '';
}

function deriveStepStatuses(caseJson, result, events) {
  const statuses = new Map(caseJson.steps.map((step) => [step.id, 'PENDING']));
  const stepById = new Map(caseJson.steps.map((step) => [step.id, step]));
  for (const event of events) {
    const stepId = eventStepId(event);
    if (!stepId || !statuses.has(stepId)) continue;
    const step = stepById.get(stepId);
    if (event.type === 'assertion') {
      statuses.set(stepId, event.status || 'UNKNOWN');
    } else if (event.type === 'decision' && event.decision === 'blocked') {
      statuses.set(stepId, 'BLOCKED');
    } else if (event.type === 'actionResult' && !stepRequiresAssertion(step)) {
      statuses.set(stepId, event.ok === false ? 'FAIL' : 'PASS');
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

function stepRequiresAssertion(step) {
  return step?.kind === 'assertion' || (Array.isArray(step?.assertions) && step.assertions.length > 0);
}

function executionRelativePath(executionId, artifactPath) {
  if (!executionId || !artifactPath) return '';
  return `executions/${executionId}/${String(artifactPath).replace(/\\/g, '/')}`;
}

function renderContextHtml(caseJson, state = {}, result = null, metrics = null, notes = [], events = []) {
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
  function renderScreenshotCard(event) {
    const observation = event.observation || event;
    const artifacts = observation.artifacts || {};
    const screenshot = executionRelativePath(executionId, artifacts.screenshot);
    const layout = executionRelativePath(executionId, artifacts.layout);
    const logs = Array.isArray(artifacts.logs) ? artifacts.logs : [];
    if (!screenshot) return '';
    const links = [
      layout && `<a href="${escapeHtml(layout)}">控件树</a>`,
      ...logs.slice(0, 2).map((log, idx) => `<a href="${escapeHtml(executionRelativePath(executionId, log))}">日志${idx + 1}</a>`),
    ].filter(Boolean).join(' ');
    return `<div class="shot-card">
        <a href="${escapeHtml(screenshot)}"><img class="shot-thumb" src="${escapeHtml(screenshot)}" alt="${escapeHtml(observation.label || '截图')}"></a>
        <div class="shot-label">${escapeHtml(observation.label || '截图观察')}</div>
        <div class="shot-time">${escapeHtml(formatDisplayTime(observation.time || event.time))}</div>
        <div class="shot-links">${links || '-'}</div>
      </div>`;
  }
  function buildScreenshotEvidenceRows() {
    const groups = new Map();
    for (const event of observations) {
      const observation = event.observation || event;
      if (!observation.artifacts?.screenshot) continue;
      const stepId = eventStepId(event) || 'unlinked';
      if (!groups.has(stepId)) groups.set(stepId, []);
      groups.get(stepId).push(event);
    }
    const ordered = [
      ...caseJson.steps.map((step) => step.id).filter((stepId) => groups.has(stepId)),
      ...(groups.has('unlinked') ? ['unlinked'] : []),
      ...Array.from(groups.keys()).filter((stepId) => stepId !== 'unlinked' && !stepById.has(stepId)),
    ];
    if (!ordered.length) return '<tr><td colspan="3">暂无截图证据。</td></tr>';
    return ordered.map((stepId) => {
      const step = stepById.get(stepId);
      const eventsForStep = groups.get(stepId) || [];
      const title = step ? `${step.index}. ${step.sourceText}` : stepId === 'unlinked' ? '未关联步骤' : stepId;
      const stepLabel = step ? step.id : '-';
      return `<tr>
        <td>${escapeHtml(stepLabel)}</td>
        <td>${escapeHtml(title)}</td>
        <td><div class="shot-strip">${eventsForStep.map(renderScreenshotCard).filter(Boolean).join('')}</div></td>
      </tr>`;
    }).join('\n');
  }
  const timelineRows = events.slice(-80);
  const environmentRows = Object.keys(env).length
    ? Object.entries(env).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(formatCell(value))}</td></tr>`).join('\n')
    : '<tr><td colspan="2">未确认</td></tr>';
  const metricCards = [
    ['耗时', metrics ? formatDuration(metrics.durationMs || 0) : '-'],
    ['步骤', metrics?.steps ? `${metrics.steps.passed || 0}/${metrics.steps.total || 0}` : `${caseJson.steps.length}`],
    ['操作次数', formatActionSummary(metrics?.actions)],
    ['截图', metrics?.artifacts ? metrics.artifacts.screenshots || 0 : screenshots.length],
    ['失败步骤', result?.failedStep || '-'],
  ].map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('\n');
  const stepRows = caseJson.steps.map((step) => {
    const itemStatus = stepStatuses.get(step.id) || 'PENDING';
    const hints = (step.hints || []).join('；');
    return `<tr>
      <td>${escapeHtml(step.index)}</td>
      <td><span class="pill ${escapeHtml(className(itemStatus))}">${escapeHtml(displayStatus(itemStatus))}</span></td>
      <td><div>${escapeHtml(step.sourceText)}</div>${hints ? `<div class="step-hints">提示：${escapeHtml(hints)}</div>` : ''}</td>
      <td>${escapeHtml(displayStepGoal(step.goal || step.kind || '-'))}</td>
    </tr>`;
  }).join('\n');
  const screenshotEvidenceRows = buildScreenshotEvidenceRows();
  const globalRules = Array.isArray(caseJson.globalRules) ? caseJson.globalRules : [];
  const ruleEvents = events.filter((event) => event.type === 'rule');
  const flowScanEvents = events.filter((event) => event.type === 'flowScan');
  const flowEvents = events.filter((event) => event.type === 'flow');
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
  const flowRows = flowScanEvents.length || flowEvents.length
    ? [
      ...flowScanEvents.map((event) => `<tr>
        <td>${escapeHtml(formatDisplayTime(event.time))}</td>
        <td>${escapeHtml(Array.isArray(event.matchedFlowIds) && event.matchedFlowIds.length ? event.matchedFlowIds.join(', ') : '-')}</td>
        <td>${escapeHtml(`扫描/${event.status || '-'}`)}</td>
        <td>${escapeHtml(`候选 ${event.candidateCount ?? 0}`)}</td>
        <td>${escapeHtml(eventStepId(event) || '-')}</td>
        <td>${escapeHtml(event.reason || '-')}</td>
      </tr>`),
      ...flowEvents.map((event) => `<tr>
        <td>${escapeHtml(formatDisplayTime(event.time))}</td>
        <td>${escapeHtml(event.flowId || '-')}</td>
        <td>${escapeHtml(event.status || '-')}</td>
        <td>${escapeHtml(event.flowStepId || '-')}</td>
        <td>${escapeHtml(eventStepId(event) || '-')}</td>
        <td>${escapeHtml(event.reason || event.failureCode || '-')}</td>
      </tr>`),
    ].join('\n')
    : '<tr><td colspan="6">暂无业务路径执行事实。</td></tr>';
  const preconditionRows = (caseJson.preconditions || []).length
    ? caseJson.preconditions.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.text)}</td><td>${escapeHtml(displayPreconditionMode(item.checkMode))}</td></tr>`).join('\n')
    : '<tr><td colspan="3">无</td></tr>';
  const observationRows = observations.length
    ? observations.map((event) => {
      const observation = event.observation || event;
      const artifacts = observation.artifacts || {};
      const links = [
        artifacts.screenshot && `<a href="${escapeHtml(executionRelativePath(executionId, artifacts.screenshot))}">截图</a>`,
        artifacts.layout && `<a href="${escapeHtml(executionRelativePath(executionId, artifacts.layout))}">控件树</a>`,
        ...(Array.isArray(artifacts.logs) ? artifacts.logs.map((log, idx) => `<a href="${escapeHtml(executionRelativePath(executionId, log))}">日志${idx + 1}</a>`) : []),
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
  const sourceChangeSection = caseJson.sourceChanged || caseJson.staleNotes?.length
    ? `<section>
    <h2>源用例变更</h2>
    <p class="empty">Markdown 内容已变化，当前报告只展示与最新 sourceSha1 匹配的执行结果。</p>
    ${(caseJson.staleNotes || []).length ? `<table>
      <thead><tr><th style="width:210px">时间</th><th>补充</th><th>原因</th></tr></thead>
      <tbody>${caseJson.staleNotes.map((note) => `<tr><td>${escapeHtml(formatDisplayTime(note.time))}</td><td>${escapeHtml(note.text || '')}</td><td>${escapeHtml(note.reason || '')}</td></tr>`).join('\n')}</tbody>
    </table>` : ''}
  </section>`
    : '';
  const eventCounts = metrics?.eventCounts
    ? Object.entries(metrics.eventCounts).map(([key, value]) => `<tr><td>${escapeHtml(displayEventType(key))}</td><td>${escapeHtml(value)}</td></tr>`).join('\n')
    : '<tr><td colspan="2">暂无</td></tr>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(caseJson.identity.title)} - 测试报告</title>
  <style>
    :root { color-scheme: light; --line:#d8dee8; --muted:#647084; --text:#18202f; --bg:#f6f8fb; --panel:#fff; --pass:#11733a; --fail:#b42318; --blocked:#875a00; --unknown:#5b6472; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 24px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 17px; }
    a { color: #145fb5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .muted { color: var(--muted); }
    .status { display: inline-flex; align-items: center; min-width: 104px; justify-content: center; padding: 7px 12px; border-radius: 6px; color: #fff; font-weight: 700; letter-spacing: 0; }
    .status.pass, .pill.pass { background: var(--pass); color: #fff; }
    .status.fail, .pill.fail { background: var(--fail); color: #fff; }
    .status.blocked, .pill.blocked { background: var(--blocked); color: #fff; }
    .status.unknown, .status.not_run, .pill.unknown, .pill.pending { background: var(--unknown); color: #fff; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .metric { padding: 12px 14px; }
    .metric span { display:block; color: var(--muted); font-size: 12px; }
    .metric strong { display:block; margin-top: 3px; font-size: 20px; }
    section { padding: 16px; margin-top: 14px; overflow: hidden; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 8px 10px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; word-break: break-word; }
    thead th, tbody th { color: var(--muted); font-weight: 600; }
    thead th { border-top: 0; background: #f0f3f7; }
    .pill { display: inline-flex; padding: 2px 7px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .step-hints { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .shot-strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
    .shot-card { flex: 0 0 88px; }
    .shot-thumb { width: 88px; height: 128px; object-fit: cover; border-radius: 4px; border: 1px solid var(--line); background: #10151f; }
    .shot-label { margin-top: 4px; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .shot-time, .shot-links { margin-top: 1px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .shot-links a { margin-right: 8px; }
    .reason { margin: 0 0 12px; padding: 10px 12px; background: #eef3f8; border-radius: 6px; }
    .empty { color: var(--muted); margin: 0; }
    @media (max-width: 760px) { main { width: calc(100vw - 20px); margin-top: 14px; } header, .grid { display:block; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } h1 { font-size: 22px; } section { padding: 12px; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(caseJson.identity.title)}</h1>
      <div class="muted">编号：${escapeHtml(caseJson.identity.caseNo || '-')} · 最近执行：${escapeHtml(executionId || '无')} · sourceSha1：${escapeHtml(caseJson.identity.sourceSha1)}</div>
    </div>
    <span class="status ${escapeHtml(className(status))}">${escapeHtml(displayStatus(status))}</span>
  </header>

  <p class="reason">${escapeHtml(result?.reason || '尚未执行。')}</p>
  <div class="summary">${metricCards}</div>

  <div class="grid">
    <section>
      <h2>执行环境</h2>
      <table><tbody>${environmentRows}</tbody></table>
    </section>
    <section>
      <h2>事件统计</h2>
      <table><tbody>${eventCounts}</tbody></table>
    </section>
  </div>

  <section>
    <h2>步骤</h2>
    <table>
      <thead><tr><th style="width:54px">#</th><th style="width:96px">状态</th><th>内容</th><th style="width:120px">类型</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table>
  </section>

  <section>
    <h2>截图证据</h2>
    <table>
      <thead><tr><th style="width:110px">步骤</th><th style="width:280px">内容</th><th>截图</th></tr></thead>
      <tbody>${screenshotEvidenceRows}</tbody>
    </table>
  </section>

  <section>
    <h2>观察记录</h2>
    <table>
      <thead><tr><th style="width:210px">时间</th><th style="width:170px">标签</th><th style="width:180px">前台</th><th>证据</th></tr></thead>
      <tbody>${observationRows}</tbody>
    </table>
  </section>

  <section>
    <h2>全局规则</h2>
    <table>
      <thead><tr><th style="width:130px">ID</th><th style="width:150px">范围</th><th style="width:160px">适用步骤</th><th style="width:90px">优先级</th><th>条件</th></tr></thead>
      <tbody>${globalRuleRows}</tbody>
    </table>
    <table style="margin-top:12px">
      <thead><tr><th style="width:210px">时间</th><th style="width:130px">规则</th><th style="width:100px">状态</th><th style="width:110px">步骤</th><th>原因</th></tr></thead>
      <tbody>${ruleEventRows}</tbody>
    </table>
  </section>

  <section>
    <h2>业务路径 Flow</h2>
    <table>
      <thead><tr><th style="width:210px">时间</th><th style="width:170px">Flow</th><th style="width:110px">状态</th><th style="width:130px">Flow 步骤</th><th style="width:110px">用例步骤</th><th>原因</th></tr></thead>
      <tbody>${flowRows}</tbody>
    </table>
  </section>

  <section>
    <h2>前置条件</h2>
    <table>
      <thead><tr><th style="width:100px">ID</th><th>内容</th><th style="width:140px">模式</th></tr></thead>
      <tbody>${preconditionRows}</tbody>
    </table>
  </section>

  <section>
    <h2>执行时间线</h2>
    <table>
      <thead><tr><th style="width:210px">时间</th><th style="width:130px">类型</th><th style="width:110px">步骤</th><th>摘要</th></tr></thead>
      <tbody>${timelineTableRows}</tbody>
    </table>
  </section>

  <section>
    <h2>用户补充</h2>
    <table>
      <thead><tr><th style="width:210px">时间</th><th style="width:120px">步骤</th><th style="width:90px">状态</th><th>内容</th></tr></thead>
      <tbody>${noteRows}</tbody>
    </table>
  </section>

  ${sourceChangeSection}
</main>
</body>
</html>
`;
}

function renderIndexHtml(rootDir, cases = []) {
  const counts = cases.reduce((acc, item) => {
    const status = item.status || 'NOT_RUN';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const total = cases.length;
  const summary = [
    ['用例数', total],
    ['通过', counts.PASS || 0],
    ['失败', counts.FAIL || 0],
    ['阻塞', counts.BLOCKED || 0],
    ['未知', counts.UNKNOWN || 0],
    ['未执行', counts.NOT_RUN || 0],
  ].map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('\n');
  const rows = cases.length
    ? cases.map((item, index) => `<tr>
        <td>${escapeHtml(item.caseNo || `#${index + 1}`)}</td>
        <td><span class="pill ${escapeHtml(className(item.status))}">${escapeHtml(displayStatus(item.status))}</span></td>
        <td><a href="${escapeHtml(item.contextHref)}">${escapeHtml(item.title)}</a><div class="muted small">${escapeHtml(item.caseKey || '')}</div></td>
        <td>${escapeHtml(item.latestExecutionId || '-')}</td>
        <td>${escapeHtml(item.durationMs !== null && item.durationMs !== undefined ? formatDuration(item.durationMs) : '-')}</td>
        <td>${escapeHtml(item.stepsSummary || '-')}</td>
        <td>${escapeHtml(item.failureCode || '-')}</td>
        <td>${escapeHtml(formatDisplayTime(item.updatedAt))}</td>
      </tr>`).join('\n')
    : '<tr><td colspan="8">暂无用例。</td></tr>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 视觉测试总览</title>
  <style>
    :root { color-scheme: light; --line:#d8dee8; --muted:#647084; --text:#18202f; --bg:#f6f8fb; --panel:#fff; --pass:#11733a; --fail:#b42318; --blocked:#875a00; --unknown:#5b6472; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 24px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
    a { color: #145fb5; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .muted { color: var(--muted); }
    .small { margin-top: 2px; font-size: 12px; font-weight: 400; }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(110px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .metric { padding: 12px 14px; }
    .metric span { display:block; color: var(--muted); font-size: 12px; }
    .metric strong { display:block; margin-top: 3px; font-size: 20px; }
    section { padding: 16px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 8px 10px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; word-break: break-word; }
    thead th { border-top: 0; background: #f0f3f7; color: var(--muted); font-weight: 600; }
    .pill { display: inline-flex; padding: 2px 7px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; }
    .pill.pass { background: var(--pass); }
    .pill.fail { background: var(--fail); }
    .pill.blocked { background: var(--blocked); }
    .pill.unknown, .pill.not_run, .pill.pending { background: var(--unknown); }
    @media (max-width: 760px) { main { width: calc(100vw - 20px); margin-top: 14px; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } h1 { font-size: 22px; } section { padding: 12px; } }
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
  <div class="summary">${summary}</div>
  <section>
    <table>
      <thead><tr><th style="width:78px">编号</th><th style="width:90px">状态</th><th>用例</th><th style="width:190px">最近执行</th><th style="width:90px">耗时</th><th style="width:120px">步骤</th><th style="width:150px">失败码</th><th style="width:210px">更新时间</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
</main>
</body>
</html>
`;
}

module.exports = {
  appendJsonl,
  caseContractSha,
  caseDirectoryName,
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
  readLatestExecutionReport,
  summarizeTimeline,
  sha1,
  slugify,
  desiredCaseDir,
  nextCaseNo,
  normalizeCaseNo,
  syncCaseDirectory,
  workspaceRoot,
  writeCaseReports,
  writeJson,
  writeText,
};

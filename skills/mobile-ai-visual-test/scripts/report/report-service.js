'use strict';

const fs = require('fs');
const path = require('path');
const { escapeHtml, formatDisplayTime, formatDuration } = require('../lib/display-format');
const { readExecutionReport, selectExecutionDir } = require('../lib/execution-reader');
const { validateCaseContract } = require('../execution/contracts/case-contract');
const { renderCurrentContextHtml, renderCurrentContextMarkdown, renderSourceMarkdown } = require('./current-report');
const { renderIndexArtifacts } = require('./index-renderer');
const { reportRendererInfo } = require('./renderer-manifest');
const { publishReportBundle } = require('./report-publisher');
const { assertWorkspace } = require('../lib/workspace');
const { ensureWorkspaceCaseNumbers } = require('../lib/case-numbering');

const PLATFORM_ORDER = ['android', 'ios', 'harmony'];
const PLATFORM_LABELS = Object.freeze({ android: 'Android', ios: 'iOS', harmony: 'HarmonyOS' });
const STATUS_LABELS = Object.freeze({
  PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', UNKNOWN: '无法判断', INCONCLUSIVE: '无法判断',
  RUNNING: '执行中', ABANDONED: '执行已废弃', PENDING_PUBLICATION: '待发布', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复',
  NEEDS_RERUN: '需重新执行', NOT_RUN: '未执行', CANCELLED: '已取消',
});

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return PLATFORM_ORDER.includes(platform) ? platform : '';
}

function caseRuntimeDir(caseDir, platform = '') {
  const normalized = normalizePlatform(platform);
  return normalized ? path.join(caseDir, 'platforms', normalized) : caseDir;
}

function caseRootFromCaseDir(caseDir) {
  return path.dirname(path.dirname(caseDir));
}

function caseNoNumber(value) {
  const match = String(value || '').trim().match(/^(?:C)?(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function readLatestExecutionReport(caseDir, options = {}) {
  const runtimeDir = caseRuntimeDir(caseDir, options.platform);
  const selected = selectExecutionDir(runtimeDir);
  return selected ? readExecutionReport(selected.execDir) : null;
}

function runtimeSummary(caseDir, platform, report = null, currentCase = null) {
  report = report || readLatestExecutionReport(caseDir, { platform });
  if (!report) return null;
  const display = report.display || {};
  currentCase = currentCase || validateCaseContract(readJson(path.join(caseDir, 'case.json')));
  const sourceCurrent = report.execution?.sourceSha === currentCase.identity.sourceSha;
  return {
    platform,
    status: sourceCurrent ? (display.status === 'INCONCLUSIVE' ? 'UNKNOWN' : display.status || 'NOT_RUN') : 'NEEDS_RERUN',
    verdict: sourceCurrent ? display.verdict || null : null,
    verdictBasis: sourceCurrent ? display.verdictBasis || null : null,
    executionStatus: sourceCurrent ? display.executionStatus || null : null,
    latestExecutionId: report.execution?.executionId || '',
    startedAt: display.startedAt || '',
    endedAt: display.endedAt || '',
    updatedAt: display.endedAt || display.startedAt || '',
    durationMs: display.durationMs ?? null,
    reason: sourceCurrent ? display.summary || '' : '用例原文已更新，已有执行结果不再代表当前用例',
    failureCode: sourceCurrent ? display.failureCode || '' : 'CASE_SOURCE_CHANGED',
    currentMetrics: sourceCurrent ? report.metrics || null : null,
    sourceCurrent,
    schemaFamily: report.schemaFamily,
    contextPath: path.join(caseRuntimeDir(caseDir, platform), 'CONTEXT.html'),
  };
}

function buildCaseReportProjection(caseDir, suppliedCaseJson = null) {
  const caseJson = suppliedCaseJson || validateCaseContract(readJson(path.join(caseDir, 'case.json')));
  const platformsDir = path.join(caseDir, 'platforms');
  const reports = new Map();
  if (fs.existsSync(platformsDir)) {
    for (const platform of fs.readdirSync(platformsDir).map(normalizePlatform).filter(Boolean)) {
      const report = readLatestExecutionReport(caseDir, { platform });
      if (report) reports.set(platform, report);
    }
  }
  const platforms = [...reports.entries()].map(([platform, report]) => runtimeSummary(caseDir, platform, report, caseJson))
    .filter(Boolean)
    .sort((left, right) => PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform));
  return { caseDir, caseJson, reports, platforms };
}

function collectCasePlatforms(caseDir) {
  return buildCaseReportProjection(caseDir).platforms;
}

function aggregateStatus(platforms) {
  const statuses = platforms.map((entry) => entry.status);
  if (!statuses.length) return 'NOT_RUN';
  for (const status of ['FAIL', 'BLOCKED', 'RUNNING', 'FINALIZATION_RECOVERY_REQUIRED', 'PENDING_PUBLICATION', 'CANCELLED', 'NEEDS_RERUN', 'UNKNOWN', 'ABANDONED']) {
    if (statuses.includes(status)) return status === 'FINALIZATION_RECOVERY_REQUIRED' ? 'RUNNING' : status;
  }
  return statuses.every((status) => status === 'PASS') ? 'PASS' : 'NOT_RUN';
}

function latestSummary(platforms) {
  return platforms.slice().sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0] || null;
}

function aggregateCase(platforms) {
  const status = aggregateStatus(platforms);
  const statusSource = platforms.find((entry) => entry.status === status) || latestSummary(platforms);
  const timeSource = latestSummary(platforms) || statusSource;
  return {
    ...(statusSource || {}), status,
    latestExecutionId: timeSource?.latestExecutionId || '',
    startedAt: timeSource?.startedAt || '',
    endedAt: timeSource?.endedAt || '',
    updatedAt: timeSource?.updatedAt || '',
  };
}

function reportErrorModel(rootDir, caseDir, error) {
  const caseJson = readJson(path.join(caseDir, 'case.json'), {});
  return {
    caseDir,
    caseNo: caseJson.identity?.caseNo || '',
    caseKey: caseJson.identity?.caseKey || '',
    title: caseJson.identity?.title || path.basename(caseDir),
    platforms: [], status: 'REPORT_ERROR', verdict: null, reason: error.message || String(error),
    reportErrorCode: error.code || 'REPORT_DATA_INVALID',
    contextHref: path.relative(rootDir, path.join(caseDir, 'CONTEXT.html')).replace(/\\/g, '/'),
  };
}

function publishReportError(caseDir, item) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(item.title)} · 报告数据异常</title><style>body{margin:0;background:#f5f7f9;color:#20262d;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(760px,calc(100% - 32px));margin:48px auto;padding:24px;border:1px solid #dfe4e9;border-left:4px solid #b7791f;background:#fff}h1{margin:0 0 18px;font-size:22px}.status{color:#9c640c;font-weight:800}</style></head><body><main><h1>${escapeHtml(item.title)}</h1><p class="status">报告数据异常</p><p>${escapeHtml(item.reason)}</p></main></body></html>`;
  publishReportBundle(caseDir, { 'CONTEXT.md': `# ${item.title}\n\n报告数据异常：${item.reason}\n`, 'CONTEXT.html': html }, {
    schemaVersion: 1, scope: 'case', platform: null, executionId: null, reportErrorCode: item.reportErrorCode, ...reportRendererInfo(),
  });
}

function collectIndexCases(rootDir, options = {}) {
  const casesDir = path.join(rootDir, 'cases');
  if (!fs.existsSync(casesDir)) return [];
  return fs.readdirSync(casesDir).map((name) => path.join(casesDir, name))
    .filter((caseDir) => fs.statSync(caseDir).isDirectory())
    .map((caseDir) => {
      if (options.errors?.has(caseDir)) return options.errors.get(caseDir);
      try {
        const projection = options.projections?.get(path.resolve(caseDir)) || buildCaseReportProjection(caseDir);
        const caseJson = projection.caseJson;
        const platforms = projection.platforms.map((entry) => ({
          ...entry,
          contextHref: path.relative(rootDir, entry.contextPath).replace(/\\/g, '/'),
        }));
        const aggregate = aggregateCase(platforms);
        return {
          caseDir,
          caseNo: caseJson.identity.caseNo || '',
          title: caseJson.identity.title,
          caseKey: caseJson.identity.caseKey,
          platforms,
          ...aggregate,
          contextHref: path.relative(rootDir, path.join(caseDir, 'CONTEXT.html')).replace(/\\/g, '/'),
        };
      } catch (error) {
        const item = reportErrorModel(rootDir, caseDir, error);
        if (options.publishErrors) publishReportError(caseDir, item);
        return item;
      }
    }).sort((left, right) => {
      const leftNo = caseNoNumber(left.caseNo);
      const rightNo = caseNoNumber(right.caseNo);
      return leftNo || rightNo
        ? (leftNo || Number.MAX_SAFE_INTEGER) - (rightNo || Number.MAX_SAFE_INTEGER)
        : left.title.localeCompare(right.title, 'zh-CN');
    });
}

function rootOverview(caseDir, caseJson, suppliedPlatforms = null) {
  const sourceFile = path.join(caseDir, 'source.md');
  const source = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : '';
  const platforms = suppliedPlatforms || collectCasePlatforms(caseDir);
  const rows = platforms.length ? platforms.map((entry) => `<a class="run" href="${escapeHtml(path.relative(caseDir, entry.contextPath).replace(/\\/g, '/'))}"><span>${escapeHtml(PLATFORM_LABELS[entry.platform])}</span><b>${escapeHtml(STATUS_LABELS[entry.status] || entry.status)}</b><small>${escapeHtml(entry.reason || '查看执行详情')} · ${escapeHtml(formatDuration(entry.durationMs))}</small></a>`).join('') : '<p class="empty">该用例尚未执行。</p>';
  const title = `${caseJson.identity.caseNo ? `${caseJson.identity.caseNo} ` : ''}${caseJson.identity.title}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{--line:#dfe4e9;--muted:#66717d;--accent:#176b70}*{box-sizing:border-box}body{margin:0;background:#f5f7f9;color:#20262d;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(980px,calc(100% - 32px));margin:28px auto 60px}header{padding:20px 0;border-bottom:1px solid var(--line)}h1{margin:0;font-size:24px;letter-spacing:0}header p{margin:5px 0 0;color:var(--muted)}section{padding:22px 0;border-bottom:1px solid var(--line)}h2{margin:0 0 13px;font-size:16px}.source{padding:16px 18px;border:1px solid var(--line);border-left:4px solid var(--accent);background:#fff;overflow-wrap:anywhere}.source>:first-child{margin-top:0}.source>:last-child{margin-bottom:0}.runs{display:grid;gap:8px}.run{display:grid;grid-template-columns:120px 100px minmax(0,1fr);gap:12px;padding:12px 14px;border:1px solid var(--line);background:#fff;color:inherit;text-decoration:none}.run b{color:var(--accent)}.run small{color:var(--muted)}.empty{color:var(--muted)}@media(max-width:640px){.run{grid-template-columns:1fr}.run>*{display:block}}</style></head><body><main><header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(caseJson.identity.caseKey)}</p></header><section><h2>原始用例</h2><div class="source">${renderSourceMarkdown(source)}</div></section><section><h2>平台执行</h2><div class="runs">${rows}</div></section></main></body></html>`;
  const markdown = [`# ${title}`, '', `- 用例标识：${caseJson.identity.caseKey}`, '', '## 原始用例', '', source, '', '## 平台执行', ''];
  if (platforms.length) platforms.forEach((entry) => markdown.push(`- ${PLATFORM_LABELS[entry.platform]}：${STATUS_LABELS[entry.status] || entry.status}，${entry.reason || '-'}`));
  else markdown.push('- 尚未执行');
  return { html, markdown: `${markdown.join('\n')}\n` };
}

function writeCaseReports(caseDir, caseJson, _state = {}, _notes = [], report = null, options = {}) {
  validateCaseContract(caseJson);
  const runtimeDir = caseRuntimeDir(caseDir, options.platform);
  let contextMarkdown;
  let contextHtml;
  let executionId = null;
  if (options.platform) {
    const current = report || readLatestExecutionReport(caseDir, options);
    if (!current || current.schemaFamily !== 'current') throw new Error(`CURRENT_EXECUTION_REQUIRED: ${options.platform}`);
    const snapshot = current.snapshot ? {
      ...current.snapshot,
      identity: { ...current.snapshot.identity, ...(caseJson.identity.caseNo ? { caseNo: caseJson.identity.caseNo } : {}) },
    } : caseJson;
    contextMarkdown = renderCurrentContextMarkdown(snapshot, current);
    contextHtml = renderCurrentContextHtml(snapshot, current);
    executionId = current.execution?.executionId || null;
  } else {
    const overview = rootOverview(caseDir, caseJson, options.platforms || null);
    contextMarkdown = overview.markdown;
    contextHtml = overview.html;
  }
  publishReportBundle(runtimeDir, { 'CONTEXT.md': contextMarkdown, 'CONTEXT.html': contextHtml }, {
    schemaVersion: 1, scope: options.platform ? 'platform-case' : 'case', platform: options.platform || null,
    executionId, ...reportRendererInfo(),
  });
  return { context: path.join(runtimeDir, 'CONTEXT.md'), contextHtml: path.join(runtimeDir, 'CONTEXT.html') };
}

function writePlatformCaseReports(caseDir, caseJson, suppliedProjection = null) {
  const projection = suppliedProjection || buildCaseReportProjection(caseDir, caseJson);
  return projection.platforms.map((entry) => writeCaseReports(caseDir, caseJson, {}, [], projection.reports.get(entry.platform), {
    platform: entry.platform, skipRootOverview: true,
  }));
}

function assertIndexLinks(rootDir, cases) {
  for (const href of cases.flatMap((item) => [item.contextHref, ...(item.platforms || []).map((entry) => entry.contextHref)]).filter(Boolean)) {
    const target = path.resolve(rootDir, href);
    if (!target.startsWith(`${path.resolve(rootDir)}${path.sep}`) || !fs.existsSync(target)) throw new Error(`REPORT_LINK_TARGET_MISSING: ${href}`);
  }
}

function renderIndexForRoot(rootDir) {
  ensureWorkspaceCaseNumbers(rootDir);
  const casesDir = path.join(rootDir, 'cases');
  const errors = new Map();
  const projections = new Map();
  if (fs.existsSync(casesDir)) {
    for (const name of fs.readdirSync(casesDir)) {
      const caseDir = path.join(casesDir, name);
      if (!fs.statSync(caseDir).isDirectory()) continue;
      try {
        const caseJson = validateCaseContract(readJson(path.join(caseDir, 'case.json')));
        const projection = buildCaseReportProjection(caseDir, caseJson);
        projections.set(path.resolve(caseDir), projection);
        writePlatformCaseReports(caseDir, caseJson, projection);
        writeCaseReports(caseDir, caseJson, {}, [], null, { platforms: projection.platforms });
      } catch (error) {
        const item = reportErrorModel(rootDir, caseDir, error);
        publishReportError(caseDir, item);
        errors.set(caseDir, item);
      }
    }
  }
  const cases = collectIndexCases(rootDir, { errors, projections, publishErrors: true });
  assertIndexLinks(rootDir, cases);
  return renderIndexArtifacts(rootDir, cases);
}

function refreshBatchIndex(rootDir, targetCaseDirs) {
  ensureWorkspaceCaseNumbers(rootDir);
  const targets = new Set(targetCaseDirs.map((caseDir) => path.resolve(caseDir)));
  const errors = new Map();
  const projections = new Map();
  for (const caseDir of targets) {
    try {
      const caseJson = validateCaseContract(readJson(path.join(caseDir, 'case.json')));
      const projection = buildCaseReportProjection(caseDir, caseJson);
      projections.set(path.resolve(caseDir), projection);
      writePlatformCaseReports(caseDir, caseJson, projection);
      writeCaseReports(caseDir, caseJson, {}, [], null, { platforms: projection.platforms });
    } catch (error) {
      const item = reportErrorModel(rootDir, caseDir, error);
      publishReportError(caseDir, item);
      errors.set(caseDir, item);
    }
  }
  const cases = collectIndexCases(rootDir, { errors, projections, publishErrors: true });
  const selected = cases.filter((item) => targets.has(path.resolve(item.caseDir)));
  if (selected.length !== targets.size || selected.some((item) => item.status === 'REPORT_ERROR')) {
    const error = new Error('batch target reports are incomplete');
    error.code = 'REPORT_PUBLICATION_INCOMPLETE';
    throw error;
  }
  assertIndexLinks(rootDir, selected);
  return renderIndexArtifacts(rootDir, cases);
}

function refreshCommittedCaseReports(caseDir, platform) {
  const rootDir = caseRootFromCaseDir(caseDir);
  ensureWorkspaceCaseNumbers(rootDir);
  let itemError = null;
  const projections = new Map();
  try {
    const caseJson = validateCaseContract(readJson(path.join(caseDir, 'case.json')));
    const projection = buildCaseReportProjection(caseDir, caseJson);
    projections.set(path.resolve(caseDir), projection);
    writeCaseReports(caseDir, caseJson, {}, [], projection.reports.get(platform), { platform, skipRootOverview: true });
    writeCaseReports(caseDir, caseJson, {}, [], null, { platforms: projection.platforms });
  } catch (error) {
    itemError = reportErrorModel(rootDir, caseDir, error);
    publishReportError(caseDir, itemError);
  }
  const errors = itemError ? new Map([[caseDir, itemError]]) : new Map();
  const cases = collectIndexCases(rootDir, { errors, projections });
  assertIndexLinks(rootDir, cases);
  const indexHtml = renderIndexArtifacts(rootDir, cases);
  return {
    status: itemError ? 'REPORT_ERROR' : 'UPDATED', platform, indexHtml,
    caseNo: itemError?.caseNo || cases.find((entry) => entry.caseDir === caseDir)?.caseNo || null,
    caseKey: itemError?.caseKey || cases.find((entry) => entry.caseDir === caseDir)?.caseKey || null,
    caseContextHtml: path.join(caseDir, 'CONTEXT.html'),
    platformContextHtml: path.join(caseRuntimeDir(caseDir, platform), 'CONTEXT.html'),
    ...(itemError ? { errorCode: itemError.reportErrorCode, reason: itemError.reason } : {}),
  };
}

function rebuildCaseDerivedArtifacts(caseDir, { refreshIndex = true, scope = 'all', platform = null } = {}) {
  const caseJson = validateCaseContract(readJson(path.join(caseDir, 'case.json')));
  if (!['all', 'platform', 'index'].includes(scope)) throw new Error(`Unsupported derived artifact scope: ${scope}`);
  const platformReports = scope === 'all' ? writePlatformCaseReports(caseDir, caseJson)
    : scope === 'platform' && platform ? [writeCaseReports(caseDir, caseJson, {}, [], null, { platform, skipRootOverview: true })] : [];
  const rootReport = scope === 'index' ? null : writeCaseReports(caseDir, caseJson);
  const indexHtml = refreshIndex ? renderIndexForRoot(assertWorkspace(caseRootFromCaseDir(caseDir), { allowTest: true }).root) : null;
  return { platformReports, rootReport, indexHtml };
}

module.exports = {
  caseRootFromCaseDir,
  caseRuntimeDir,
  buildCaseReportProjection,
  collectIndexCases,
  normalizePlatform,
  readLatestExecutionReport,
  rebuildCaseDerivedArtifacts,
  refreshCommittedCaseReports,
  refreshBatchIndex,
  renderIndexForRoot,
  writeCaseReports,
  writePlatformCaseReports,
};

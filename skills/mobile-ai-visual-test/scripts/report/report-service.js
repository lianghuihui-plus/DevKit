'use strict';

const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('../lib/display-format');
const { readExecutionReport, selectExecutionDir } = require('../lib/execution-reader');
const { validateCaseContract } = require('../execution/contracts/case-contract');
const { renderCurrentContextHtml, renderCurrentContextMarkdown, renderSourceMarkdown } = require('./current-report');
const { buildExecutionNarrative } = require('./execution-narrative');
const { renderIndexArtifacts } = require('./index-renderer');
const { reportRendererInfo } = require('./renderer-manifest');
const { publishReportBundle } = require('./report-publisher');
const { assertWorkspace } = require('../lib/workspace');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { deriveExecutionTiming } = require('../lib/execution-timing');
const { recoverRetryRequiredPublications } = require('./publication-state');

const PLATFORM_ORDER = ['android', 'ios', 'harmony'];

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

function canonicalExistingPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
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
  if (report.readability !== 'READABLE') {
    return {
      platform,
      status: display.status,
      verdict: null,
      verdictBasis: null,
      executionStatus: null,
      latestExecutionId: report.execution?.executionId || '',
      startedAt: display.startedAt || '',
      endedAt: display.endedAt || '',
      updatedAt: display.endedAt || display.startedAt || '',
      durationMs: null,
      durationBasis: 'EXECUTION_TOTAL',
      phaseDurations: null,
      reason: display.summary || '',
      failureCode: display.failureCode || '',
      currentMetrics: null,
      coverage: '-',
      recordingStatus: 'UNAVAILABLE',
      sourceCurrent: null,
      readability: report.readability,
      schemaFamily: report.schemaFamily,
      contextPath: path.join(caseRuntimeDir(caseDir, platform), 'CONTEXT.html'),
    };
  }
  const narrative = buildExecutionNarrative(report);
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
    durationBasis: display.durationBasis || 'EXECUTION_TOTAL',
    phaseDurations: display.phaseDurations || null,
    reason: sourceCurrent ? display.summary || '' : '用例原文已更新，已有执行结果不再代表当前用例',
    failureCode: sourceCurrent ? display.failureCode || '' : 'CASE_SOURCE_CHANGED',
    currentMetrics: sourceCurrent ? report.metrics || null : null,
    coverage: sourceCurrent ? `${narrative.coverage.covered}/${narrative.coverage.total}` : '-',
    recordingStatus: sourceCurrent ? narrative.recordingStatus : 'UNAVAILABLE',
    sourceCurrent,
    readability: report.readability,
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
  const readable = platforms.filter((entry) => entry.readability === 'READABLE');
  const considered = readable.length ? readable : platforms;
  const status = readable.length
    ? aggregateStatus(readable)
    : platforms.some((entry) => entry.readability === 'DATA_INVALID')
      ? 'REPORT_DATA_INVALID'
      : platforms.some((entry) => entry.readability === 'FORMAT_UNSUPPORTED') ? 'NEEDS_RERUN' : 'NOT_RUN';
  const statusSource = considered.find((entry) => entry.status === status) || latestSummary(considered);
  const timeSource = latestSummary(considered) || statusSource;
  return {
    ...(statusSource || {}), status,
    latestExecutionId: timeSource?.latestExecutionId || '',
    startedAt: timeSource?.startedAt || '',
    endedAt: timeSource?.endedAt || '',
    updatedAt: timeSource?.updatedAt || '',
  };
}

function unavailablePlatformReport(caseJson, platform, report) {
  const display = report.display || {};
  const title = `${caseJson.identity.caseNo ? `${caseJson.identity.caseNo} ` : ''}${caseJson.identity.title}`;
  const status = display.status === 'NEEDS_RERUN' ? '需重新执行' : '报告数据异常';
  const reason = display.summary || '执行数据不可读取';
  const markdown = `# ${title}\n\n- 平台：${platform}\n- 状态：${status}\n- 原因：${reason}\n`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(status)}</title><style>body{margin:0;background:#f5f7f9;color:#20262d;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(760px,calc(100% - 32px));margin:48px auto;padding:24px;border:1px solid #dfe4e9;border-left:4px solid #b7791f;background:#fff}h1{margin:0 0 18px;font-size:22px}.status{color:#9c640c;font-weight:800}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(platform)}</p><p class="status">${escapeHtml(status)}</p><p>${escapeHtml(reason)}</p></main></body></html>`;
  return { markdown, html };
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
        const sourceText = fs.readFileSync(path.join(caseDir, 'source.md'), 'utf8');
        const sourceSummary = sourceText.split(/\r?\n/).map((line) => line.trim())
          .find((line) => line && !line.startsWith('#')) || '';
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
          sourceSummary,
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

function rootOverview(caseDir, caseJson) {
  const sourceFile = path.join(caseDir, 'source.md');
  const source = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : '';
  const title = `${caseJson.identity.caseNo ? `${caseJson.identity.caseNo} ` : ''}${caseJson.identity.title}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--surface-2:#f8fafb;--text:#17212b;--text-2:#3e4b59;--muted:#74808d;--line:#dce2e7;--line-strong:#c6cfd7;--accent:#0e6873;--ink:#1d2935}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;letter-spacing:0}a{color:inherit;text-decoration:none}.product-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:58px;padding:8px clamp(18px,3vw,48px);border-bottom:1px solid #22313f;background:#17232e;color:#dbe4ea}.product-brand{display:flex;align-items:center;gap:10px}.product-brand>span{display:grid;place-items:center;width:34px;height:34px;border-radius:6px;background:#dff1ef;color:#125d66;font-size:12px;font-weight:900}.product-brand b,.product-brand small,.product-bar>div b,.product-bar>div small{display:block}.product-brand small,.product-bar>div small{color:#8fa0ad;font-size:10px}.product-bar>div{text-align:right}.workspace{width:min(1500px,100%);min-height:calc(100vh - 58px);margin:0 auto;padding:24px clamp(18px,3vw,48px) 60px}.case-content-page{max-width:900px;margin:0 auto}.case-content-page>header{display:grid;grid-template-columns:130px 1fr;align-items:center;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--line-strong)}.back-button{display:inline-flex;align-items:center;gap:7px;color:var(--text-2);font-size:11px;font-weight:750}.back-button i{font-style:normal;font-size:17px}.case-content-page header span{color:var(--muted);font-size:10px}.case-content-page header h1{margin:2px 0 0;font-size:21px;overflow-wrap:anywhere}.case-only-meta{display:grid;grid-template-columns:repeat(4,1fr);margin-top:16px;border:1px solid var(--line);background:white}.case-only-meta>span{min-width:0;padding:11px 13px;border-right:1px solid var(--line)}.case-only-meta>span:last-child{border-right:0}.case-only-meta small,.case-only-meta b{display:block}.case-only-meta small{color:var(--muted);font-size:9px}.case-only-meta b{margin-top:2px;font-size:11px;overflow-wrap:anywhere}.case-document.full{margin-top:12px;padding:34px 54px 50px;border:1px solid var(--line);background:white;overflow-wrap:anywhere}.case-document h1{margin:0 0 22px;font-size:20px}.case-document h2{margin:28px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line);font-size:15px}.case-document h2:first-child{margin-top:0}.case-document h3{margin:20px 0 8px;font-size:14px}.case-document p,.case-document li{color:var(--text-2)}.case-document code{padding:1px 4px;background:var(--surface-2);font-size:12px}.case-document pre{padding:12px;background:var(--ink);color:#e8edf1;overflow:auto}.case-document img{max-width:100%}@media(max-width:620px){.product-bar>div{display:none}.workspace{padding:16px 10px 36px}.case-content-page>header{grid-template-columns:1fr}.case-only-meta{grid-template-columns:1fr 1fr}.case-only-meta>span:nth-child(2){border-right:0}.case-only-meta>span{border-bottom:1px solid var(--line)}.case-document.full{padding:24px 20px}}
</style></head><body><div class="product-shell"><header class="product-bar"><a class="product-brand" href="../../index.html"><span>MV</span><div><b>MAVT</b><small>移动端 AI 视觉测试</small></div></a><div><b>用例工作区</b><small>只读用例内容</small></div></header><main class="workspace"><div class="case-content-page"><header><a class="back-button" href="../../index.html"><i>←</i>返回总览</a><div><span>用例 ${escapeHtml(caseJson.identity.caseNo || '-')} · 用例内容</span><h1>${escapeHtml(caseJson.identity.title)}</h1></div></header><div class="case-only-meta"><span><small>用例编号</small><b>${escapeHtml(caseJson.identity.caseNo || '-')}</b></span><span><small>caseKey</small><b>${escapeHtml(caseJson.identity.caseKey)}</b></span><span><small>sourceSha</small><b>${escapeHtml(caseJson.identity.sourceSha)}</b></span><span><small>导入来源</small><b>${escapeHtml(caseJson.identity.importSource?.path || '-')}</b></span></div><article class="case-document full"><h2>原始用例</h2>${renderSourceMarkdown(source)}</article></div></main></div></body></html>`;
  const markdown = [`# ${title}`, '', `- 用例标识：${caseJson.identity.caseKey}`, '', '## 原始用例', '', source];
  return { html, markdown: `${markdown.join('\n')}\n` };
}

function recordCaseReportPublicationTiming(caseDir, report, options = {}) {
  if (!report?.completion || !report.execution?.batchId || !report.execution?.endedAt) return null;
  const sidecarPath = path.join(caseRootFromCaseDir(caseDir), 'runs', report.execution.batchId, 'report-publication.json');
  let sidecar;
  try {
    sidecar = readJson(sidecarPath, {
      schemaVersion: 1,
      batchId: report.execution.batchId,
      status: 'PENDING',
      attempts: [],
      caseTimings: {},
    });
  } catch {
    return null;
  }
  const existing = sidecar.caseTimings?.[report.execution.executionId];
  if (existing?.caseReportPublishedAt) return existing;
  const caseReportPublishedAt = options.now || new Date().toISOString();
  const timing = deriveExecutionTiming(report.execution, report.metrics, { caseReportPublishedAt });
  const entry = { caseReportPublishedAt, reportPublicationDelayMs: timing.phases.reportPublicationDelayMs };
  writeJsonAtomic(sidecarPath, {
    ...sidecar,
    schemaVersion: 1,
    attempts: Array.isArray(sidecar.attempts) ? sidecar.attempts : [],
    caseTimings: { ...(sidecar.caseTimings || {}), [report.execution.executionId]: entry },
    ...(sidecar.publications ? { publications: sidecar.publications } : {}),
  });
  return entry;
}

function writeCaseReports(caseDir, caseJson, _state = {}, _notes = [], report = null, options = {}) {
  validateCaseContract(caseJson);
  const runtimeDir = caseRuntimeDir(caseDir, options.platform);
  const publishBundle = options.publishBundle || publishReportBundle;
  let contextMarkdown;
  let contextHtml;
  let executionId = null;
  let current = null;
  let snapshot = null;
  let needsPublicationTiming = false;
  if (options.platform) {
    current = report || readLatestExecutionReport(caseDir, options);
    if (!current) throw new Error(`CURRENT_EXECUTION_REQUIRED: ${options.platform}`);
    if (current.readability !== 'READABLE') {
      const unavailable = unavailablePlatformReport(caseJson, options.platform, current);
      contextMarkdown = unavailable.markdown;
      contextHtml = unavailable.html;
      executionId = current.execution?.executionId || null;
    } else {
      let publication = null;
      if (current.execution?.batchId) {
        try {
          publication = readJson(path.join(caseRootFromCaseDir(caseDir), 'runs', current.execution.batchId, 'report-publication.json'), null);
        } catch {
          publication = null;
        }
      }
      const existingPublication = publication?.caseTimings?.[current.execution.executionId]
        || publication?.publications?.[current.execution.executionId];
      needsPublicationTiming = Boolean(current.completion && current.execution?.endedAt
        && !existingPublication?.caseReportPublishedAt);
      snapshot = current.snapshot ? {
        ...current.snapshot,
        identity: { ...current.snapshot.identity, ...(caseJson.identity.caseNo ? { caseNo: caseJson.identity.caseNo } : {}) },
      } : caseJson;
      contextMarkdown = renderCurrentContextMarkdown(snapshot, current);
      contextHtml = renderCurrentContextHtml(snapshot, current);
      executionId = current.execution?.executionId || null;
    }
  } else {
    const overview = rootOverview(caseDir, caseJson, options.platforms || null);
    contextMarkdown = overview.markdown;
    contextHtml = overview.html;
  }
  const metadata = {
    schemaVersion: 1, scope: options.platform ? 'platform-case' : 'case', platform: options.platform || null,
    executionId, ...reportRendererInfo(),
  };
  publishBundle(runtimeDir, { 'CONTEXT.md': contextMarkdown, 'CONTEXT.html': contextHtml }, metadata);
  if (needsPublicationTiming && recordCaseReportPublicationTiming(caseDir, current, options)) {
    current = readExecutionReport(current.latest);
    contextMarkdown = renderCurrentContextMarkdown(snapshot, current);
    contextHtml = renderCurrentContextHtml(snapshot, current);
    publishBundle(runtimeDir, { 'CONTEXT.md': contextMarkdown, 'CONTEXT.html': contextHtml }, metadata);
  }
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
        writePlatformCaseReports(caseDir, caseJson, projection);
        const publishedProjection = buildCaseReportProjection(caseDir, caseJson);
        projections.set(path.resolve(caseDir), publishedProjection);
        writeCaseReports(caseDir, caseJson, {}, [], null, { platforms: publishedProjection.platforms });
      } catch (error) {
        const item = reportErrorModel(rootDir, caseDir, error);
        publishReportError(caseDir, item);
        errors.set(caseDir, item);
      }
    }
  }
  const cases = collectIndexCases(rootDir, { errors, projections, publishErrors: true });
  assertIndexLinks(rootDir, cases);
  const indexPath = renderIndexArtifacts(rootDir, cases);
  recoverRetryRequiredPublications(rootDir);
  return indexPath;
}

function refreshBatchIndex(rootDir, targetCaseDirs) {
  const targets = new Set(targetCaseDirs.map((caseDir) => path.resolve(caseDir)));
  const targetIdentities = new Set([...targets].map(canonicalExistingPath));
  const errors = new Map();
  const projections = new Map();
  for (const caseDir of targets) {
    try {
      const caseJson = validateCaseContract(readJson(path.join(caseDir, 'case.json')));
      const projection = buildCaseReportProjection(caseDir, caseJson);
      writePlatformCaseReports(caseDir, caseJson, projection);
      const publishedProjection = buildCaseReportProjection(caseDir, caseJson);
      projections.set(path.resolve(caseDir), publishedProjection);
      writeCaseReports(caseDir, caseJson, {}, [], null, { platforms: publishedProjection.platforms });
    } catch (error) {
      const item = reportErrorModel(rootDir, caseDir, error);
      publishReportError(caseDir, item);
      errors.set(caseDir, item);
    }
  }
  const cases = collectIndexCases(rootDir, { errors, projections, publishErrors: true });
  const selected = cases.filter((item) => targetIdentities.has(canonicalExistingPath(item.caseDir)));
  if (selected.length !== targetIdentities.size || selected.some((item) => item.status === 'REPORT_ERROR')) {
    const error = new Error('batch target reports are incomplete');
    error.code = 'REPORT_PUBLICATION_INCOMPLETE';
    throw error;
  }
  assertIndexLinks(rootDir, selected);
  return renderIndexArtifacts(rootDir, cases);
}

function refreshCommittedCaseReports(caseDir, platform) {
  const rootDir = caseRootFromCaseDir(caseDir);
  let itemError = null;
  const projections = new Map();
  try {
    const caseJson = validateCaseContract(readJson(path.join(caseDir, 'case.json')));
    const projection = buildCaseReportProjection(caseDir, caseJson);
    writeCaseReports(caseDir, caseJson, {}, [], projection.reports.get(platform), { platform, skipRootOverview: true });
    const publishedProjection = buildCaseReportProjection(caseDir, caseJson);
    projections.set(path.resolve(caseDir), publishedProjection);
    writeCaseReports(caseDir, caseJson, {}, [], null, { platforms: publishedProjection.platforms });
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

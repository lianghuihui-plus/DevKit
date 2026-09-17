'use strict';

const fs = require('fs');
const path = require('path');
const {
  className,
  escapeHtml,
  formatDisplayTime,
  formatDuration,
} = require('../lib/display-format');

const PLATFORM_LABELS = Object.freeze({ harmony: 'HarmonyOS', android: 'Android', ios: 'iOS' });
const VERDICT_LABELS = Object.freeze({ RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布', PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断', UNKNOWN: '无法判断', CANCELLED: '已取消', NEEDS_RERUN: '需重新执行', ABANDONED: '执行已废弃', NOT_RUN: '无法执行', PENDING: '未执行', REPORT_ERROR: '报告数据异常', REPORT_DATA_INVALID: '报告数据异常' });
const DASHBOARD_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'RUNNING', 'FINALIZATION_RECOVERY_REQUIRED', 'PENDING_PUBLICATION', 'CANCELLED', 'NEEDS_RERUN', 'ABANDONED', 'REPORT_ERROR', 'NOT_RUN', 'PENDING']);
const BASIS_LABELS = Object.freeze({ DIRECT_EVIDENCE: '直接证据', INSUFFICIENT_EVIDENCE: '证据不足', TECHNICAL_CONSTRAINT: '技术约束' });
const EXECUTION_STATUS_LABELS = Object.freeze({ RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布', COMPLETED: '执行完成', CANCELLED: '已取消', TECHNICALLY_BLOCKED: '技术阻塞', NOT_RUN: '未进入实际执行', STOPPED_BY_BUDGET: '达到时限', INTERRUPTED: '执行中断' });
const BATCH_STATUS_LABELS = Object.freeze({ INITIALIZING: '待启动', RUNNING: '执行中', FINALIZING: '收尾中', CANCELLING: '取消收尾中', BLOCKING: '阻塞收尾中', CANCELLED: '已取消', COMPLETED: '已完成', BLOCKED: '已停止', DEGRADED: '已停止' });
const WARM_STATUS_LABELS = Object.freeze({ INITIALIZING: '待启动', READY: '已就绪', DEGRADED: '已停止', CLOSED: '已关闭' });
const INTERACTION_POLICY_LABELS = Object.freeze({ UNATTENDED: '无人值守' });

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function displayPlatform(value) {
  return PLATFORM_LABELS[value] || (value ? '未知平台' : '-');
}

function effectiveVerdict(item = {}) {
  if (item.verdict === 'INCONCLUSIVE' || item.status === 'UNKNOWN') return 'INCONCLUSIVE';
  if (item.status === 'REPORT_DATA_INVALID') return 'REPORT_ERROR';
  return item.verdict || item.status || 'PENDING';
}

function verdictLabel(value) {
  return VERDICT_LABELS[value] || (value ? '未知结论' : '-');
}

function dashboardVerdict(item = {}) {
  const value = effectiveVerdict(item);
  return DASHBOARD_STATUSES.has(value) ? value : 'REPORT_ERROR';
}

function basisLabel(value) {
  return BASIS_LABELS[value] || (value ? '未知依据' : '-');
}

function executionStatusLabel(value) {
  return EXECUTION_STATUS_LABELS[value] || (value ? '未知状态' : '-');
}

function latestRunControl(rootDir) {
  const environment = readJson(path.join(rootDir, 'environment-confirmation.json'), null);
  const runsRoot = path.join(rootDir, 'runs');
  const candidates = [];
  if (fs.existsSync(runsRoot)) {
    for (const name of fs.readdirSync(runsRoot)) {
      const batchDir = path.join(runsRoot, name);
      if (!fs.statSync(batchDir).isDirectory()) continue;
      const request = readJson(path.join(batchDir, 'execution-request.json'), null);
      const state = readJson(path.join(batchDir, 'batch.json'), null);
      if (!request && !state) continue;
      candidates.push({
        batchId: request?.batchId || state?.batchId || name,
        request,
        state,
        time: request?.requestedAt || state?.updatedAt || state?.createdAt || '',
      });
    }
  }
  candidates.sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0));
  return { environment, latest: candidates[0] || null, runCount: candidates.length };
}

function controlStage(value) {
  const environment = value.environment;
  const latest = value.latest;
  const request = latest?.request;
  const state = latest?.state;
  const completed = state?.cases?.filter((item) => item.status === 'COMPLETED').length || 0;
  const total = state?.cases?.length || request?.targets?.length || 0;
  const environmentDetail = environment
    ? `${displayPlatform(environment.binding?.platform)} · ${environment.binding?.deviceId || '-'} · ${environment.binding?.appId || '-'}`
    : '等待用户确认设备与 App';
  const requestDetail = request
    ? `${request.mode === 'BATCH' ? '批量' : '单用例'} · ${request.targets?.length || 0} 个目标 · ${INTERACTION_POLICY_LABELS[request.interactionPolicy] || (request.interactionPolicy ? '未知交互策略' : '-')}`
    : environment ? '等待用户明确执行范围' : '环境确认后才能创建';
  const batchDetail = state
    ? `${BATCH_STATUS_LABELS[state.status] || '未知状态'} · ${completed}/${total} 已提交`
    : request ? '执行已授权，等待初始化' : '尚未创建批次';
  const warm = state?.warmSession;
  const warmDetail = warm
    ? `代次 ${warm.generation || 0} · 启动 ${warm.appStartCount || 0} · 恢复 ${warm.recoveryCount || 0}`
    : '批次启动后建立暖会话';
  return [
    { number: '01', label: '环境确认', value: environment ? '已确认' : '待确认', detail: environmentDetail, state: environment ? 'ready' : 'idle' },
    { number: '02', label: '执行授权', value: request ? (request.mode === 'BATCH' ? '批量执行' : '单用例执行') : '待指令', detail: requestDetail, state: request ? 'ready' : 'idle' },
    { number: '03', label: '批次进度', value: state ? (BATCH_STATUS_LABELS[state.status] || '未知状态') : '未开始', detail: batchDetail, state: state?.status === 'COMPLETED' ? 'ready' : ['BLOCKED', 'DEGRADED', 'CANCELLED'].includes(state?.status) ? 'stopped' : state ? 'active' : 'idle' },
    { number: '04', label: '暖会话', value: warm ? (WARM_STATUS_LABELS[warm.status] || '未知状态') : '未建立', detail: warmDetail, state: warm?.status === 'READY' ? 'active' : warm?.status === 'CLOSED' ? 'ready' : 'idle' },
  ];
}

function summarize(cases) {
  const verdicts = cases.map(dashboardVerdict);
  const currentRuns = cases.flatMap((item) => item.platforms || []);
  return {
    total: cases.length,
    pass: verdicts.filter((value) => value === 'PASS').length,
    fail: verdicts.filter((value) => value === 'FAIL').length,
    blocked: verdicts.filter((value) => value === 'BLOCKED').length,
    inconclusive: verdicts.filter((value) => value === 'INCONCLUSIVE').length,
    pendingPublication: verdicts.filter((value) => value === 'PENDING_PUBLICATION').length,
    cancelled: verdicts.filter((value) => value === 'CANCELLED').length,
    needsRerun: verdicts.filter((value) => value === 'NEEDS_RERUN').length,
    notRun: verdicts.filter((value) => value === 'NOT_RUN').length,
    pending: verdicts.filter((value) => value === 'PENDING').length,
    reportError: verdicts.filter((value) => value === 'REPORT_ERROR').length,
    directEvidence: currentRuns.filter((item) => item.verdictBasis === 'DIRECT_EVIDENCE').length,
    warmReuse: currentRuns.filter((item) => item.currentMetrics?.warmSessionReused).length,
    recoveries: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.executionRecoveryCount || 0), 0),
    timeLimitStops: currentRuns.filter((item) => item.currentMetrics?.timeLimitStopped).length,
    agentDecisions: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.counts?.agentDecisions || 0), 0),
    narrativeGaps: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.counts?.narrativeGaps || 0), 0),
    knowledgeQueries: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.counts?.knowledgeQueries || 0), 0),
  };
}

function platformSummary(cases) {
  const rows = new Map(['harmony', 'android', 'ios'].map((platform) => [platform, {
    platform, total: cases.length, executed: 0, pass: 0, fail: 0, blocked: 0, inconclusive: 0, notRun: 0, pending: cases.length,
  }]));
  for (const item of cases) {
    for (const platform of item.platforms || []) {
      if (!rows.has(platform.platform)) continue;
      const row = rows.get(platform.platform);
      const verdict = dashboardVerdict(platform);
      if (verdict === 'PENDING') continue;
      row.pending = Math.max(0, row.pending - 1);
      if (verdict === 'NOT_RUN') {
        row.notRun += 1;
        continue;
      }
      row.executed += 1;
      if (verdict === 'PASS') row.pass += 1;
      if (verdict === 'FAIL') row.fail += 1;
      if (verdict === 'BLOCKED') row.blocked += 1;
      if (verdict === 'INCONCLUSIVE') row.inconclusive += 1;
    }
  }
  return [...rows.values()];
}

function percentage(count, total) {
  return total ? `${Math.round((count / total) * 100)}%` : '0%';
}

function averageDuration(platforms) {
  const values = platforms.map((platform) => platform.durationMs).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

const PLATFORM_ORDER = ['harmony', 'android', 'ios'];
const PLATFORM_TOKENS = Object.freeze({ harmony: 'OH', android: 'AND', ios: 'iOS' });

function metricValue(value) {
  return Number.isFinite(value) ? String(value) : '-';
}

function renderStatus(value) {
  return `<span class="status ${escapeHtml(className(value))}">${escapeHtml(verdictLabel(value))}</span>`;
}

function renderPlatformRun(platform) {
  const verdict = dashboardVerdict(platform);
  const counts = platform.currentMetrics?.counts || {};
  const executionState = executionStatusLabel(platform.executionStatus);
  const unavailable = platform.readability && platform.readability !== 'READABLE';
  const detail = unavailable ? platform.reason || executionState : `${executionState} · ${basisLabel(platform.verdictBasis)}`;
  return `<article class="platform-run ${escapeHtml(platform.platform)}" data-platform-run="${escapeHtml(platform.platform)}">
    <div class="run-platform"><span class="platform-token">${escapeHtml(PLATFORM_TOKENS[platform.platform] || '?')}</span><div><b>${escapeHtml(displayPlatform(platform.platform))}</b><small>${escapeHtml(detail)}</small></div></div>
    ${renderStatus(verdict)}
    <dl><div class="time-metric"><dt>用例总耗时</dt><dd>${escapeHtml(formatDuration(platform.durationMs))}</dd></div><div class="time-metric"><dt>开始时间</dt><dd>${escapeHtml(formatDisplayTime(platform.startedAt))}</dd></div><div class="time-metric"><dt>结束时间</dt><dd>${escapeHtml(formatDisplayTime(platform.endedAt))}</dd></div><div><dt>动作 / 观察</dt><dd>${metricValue(counts.actions)} / ${metricValue(counts.observations)}</dd></div><div><dt>验证点</dt><dd>${escapeHtml(platform.coverage || '-')}</dd></div><div><dt>恢复</dt><dd>${metricValue(platform.currentMetrics?.executionRecoveryCount)}</dd></div></dl>
    <a class="report-button" href="${escapeHtml(platform.contextHref)}" title="查看 ${escapeHtml(displayPlatform(platform.platform))} 执行报告" aria-label="查看执行报告"><span aria-hidden="true">↗</span></a>
  </article>`;
}

function casePlatformVerdicts(platforms) {
  const byPlatform = new Map(platforms.map((platform) => [platform.platform, dashboardVerdict(platform)]));
  return PLATFORM_ORDER.map((platform) => byPlatform.get(platform) || 'PENDING');
}

function caseFilterVerdicts(item) {
  const verdicts = (item.platforms || []).map((platform) => dashboardVerdict(platform));
  return [...new Set(verdicts.length ? verdicts : [dashboardVerdict(item)])];
}

function caseFilterPlatforms(platforms) {
  return [...new Set(platforms.map((platform) => platform.platform).filter((platform) => PLATFORM_ORDER.includes(platform)))];
}

function caseFilterResults(platforms) {
  return platforms
    .filter((platform) => PLATFORM_ORDER.includes(platform.platform))
    .map((platform) => `${platform.platform}:${dashboardVerdict(platform)}`);
}

function renderCase(item, index) {
  const platforms = (item.platforms || []).filter((platform) => dashboardVerdict(platform) !== 'PENDING')
    .sort((left, right) => PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform));
  const verdicts = casePlatformVerdicts(item.platforms || []);
  const count = (status) => verdicts.filter((value) => value === status).length;
  const summary = item.status === 'REPORT_ERROR'
    ? `报告数据异常：${item.reason || '无法读取执行数据'}`
    : item.status === 'REPORT_DATA_INVALID'
      ? `报告数据异常：${item.reason || '当前执行数据损坏'}`
    : item.status === 'NEEDS_RERUN'
      ? `需重新执行：${item.reason || '用例原文已更新'}`
    : item.sourceSummary || '原始用例内容已收录';
  const statusValues = caseFilterVerdicts(item).join(' ');
  const platformValues = caseFilterPlatforms(item.platforms || []).join(' ');
  const resultValues = caseFilterResults(item.platforms || []).join(' ');
  return `<section class="case-row" data-case-status="${escapeHtml(statusValues)}" data-case-platforms="${escapeHtml(platformValues)}" data-case-results="${escapeHtml(resultValues)}" data-case-search="${escapeHtml(`${item.caseNo || ''} ${item.title} ${item.caseKey || ''}`.toLowerCase())}">
    <div class="case-common">
      <div class="case-order">${String(index + 1).padStart(2, '0')}</div>
      <div class="case-copy"><span>用例 ${escapeHtml(item.caseNo || String(index + 1).padStart(3, '0'))} · ${escapeHtml(item.caseKey || '-')}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(summary)}</p></div>
      <div class="common-stats"><span class="common-stat"><small>三端统计</small><b>${count('PASS')} 通 · ${count('FAIL')} 失 · ${count('BLOCKED')} 阻 · ${count('INCONCLUSIVE')} 无法判断 · ${count('NOT_RUN')} 无法执行 · ${count('PENDING')} 未执行</b></span><span class="common-stat"><small>平均耗时</small><b>${escapeHtml(formatDuration(averageDuration(platforms)))}</b></span></div>
      <a class="icon-button" href="${escapeHtml(item.contextHref)}" title="查看用例内容" aria-label="查看用例内容"><span aria-hidden="true">▤</span></a>
    </div>
    ${platforms.length ? `<div class="platform-runs">${platforms.map(renderPlatformRun).join('')}</div>` : ''}
  </section>`;
}

function renderCurrentIndexHtml(rootDir, cases = []) {
  const control = latestRunControl(rootDir);
  const orderedCases = cases.slice();
  const summary = summarize(orderedCases);
  const platforms = platformSummary(orderedCases);
  const filterCount = (status) => orderedCases.filter((item) => caseFilterVerdicts(item).includes(status)).length;
  const filters = [
    ['ALL', '全部', summary.total],
    ['PASS', '通过', filterCount('PASS')],
    ['FAIL', '失败', filterCount('FAIL')],
    ['BLOCKED', '阻塞', filterCount('BLOCKED')],
    ['INCONCLUSIVE', '无法判断', filterCount('INCONCLUSIVE')],
    ['NOT_RUN', '无法执行', filterCount('NOT_RUN')],
    ['PENDING', '未执行', filterCount('PENDING')],
  ];
  const platformFilters = [
    ['ALL', '全部平台', summary.total],
    ...PLATFORM_ORDER.map((platform) => [
      platform,
      displayPlatform(platform),
      orderedCases.filter((item) => caseFilterPlatforms(item.platforms || []).includes(platform)).length,
    ]),
  ];
  const batchName = control.latest?.batchId || '暂无批次';
  const generatedAt = formatDisplayTime(new Date().toISOString());
  const cards = orderedCases.length ? orderedCases.map(renderCase).join('\n') : '<p class="empty">暂无用例。</p>';
  const platformCards = platforms.map((item) => {
    const rates = [
      ['通过', item.pass, 'pass', 'bar-pass'],
      ['失败', item.fail, 'fail', 'bar-fail'],
      ['阻塞', item.blocked, 'blocked', 'bar-blocked'],
      ['无法判断', item.inconclusive, 'inconclusive', 'bar-inconclusive'],
      ['无法执行', item.notRun, 'not-run', 'bar-not-run'],
      ['未执行', item.pending, 'pending', 'bar-pending'],
    ];
    return `<article class="platform-summary ${escapeHtml(item.platform)}"><div class="platform-summary-head"><span class="platform-token">${escapeHtml(PLATFORM_TOKENS[item.platform])}</span><b>${escapeHtml(displayPlatform(item.platform))}</b><strong>${item.executed}/${item.total}</strong></div><div class="stacked-bar" aria-hidden="true">${rates.map(([,count,,bar]) => `<i class="${bar}" style="width:${percentage(count,item.total)}"></i>`).join('')}</div><div class="summary-counts">${rates.map(([label,count,tone]) => `<span class="${tone}"><small>${label}</small><b>${count}</b><em>${percentage(count,item.total)}</em></span>`).join('')}</div></article>`;
  }).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>移动端 AI 视觉测试</title>
  <style>
    :root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--surface-2:#f8fafb;--text:#17212b;--text-2:#3e4b59;--muted:#74808d;--line:#dce2e7;--line-strong:#c6cfd7;--ink:#1d2935;--accent:#0e6873;--accent-soft:#e8f4f4;--pass:#16835c;--pass-soft:#eaf7f1;--fail:#cb4343;--fail-soft:#fff0f0;--blocked:#a4670b;--blocked-soft:#fff6df;--pending:#53657a;--pending-soft:#eef1f5;--harmony:#16808a;--android:#397357;--ios:#475a72;--shadow:0 2px 8px rgba(25,37,50,.05)}
    *{box-sizing:border-box}html{min-width:320px;background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;letter-spacing:0}button,input{font:inherit;letter-spacing:0}a{color:inherit;text-decoration:none}[hidden]{display:none!important}.product-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:58px;padding:8px clamp(18px,3vw,48px);border-bottom:1px solid #22313f;background:#17232e;color:#dbe4ea}.product-bar b,.product-bar small{display:block}.product-bar small{color:#8fa0ad;font-size:10px}.product-brand{display:flex;align-items:center;gap:10px}.product-brand>span{display:grid;place-items:center;width:34px;height:34px;border-radius:6px;background:#dff1ef;color:#125d66;font-size:12px;font-weight:900}.product-bar>div{text-align:right}.workspace{width:min(1500px,100%);min-height:calc(100vh - 58px);margin:0 auto;padding:24px clamp(18px,3vw,48px) 60px}.page-head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:12px}.eyebrow{color:var(--accent);font-size:11px;font-weight:800}.page-head h1{margin:3px 0 0;font-size:24px;line-height:1.2}.batch-meta{text-align:right}.batch-meta span,.batch-meta b,.batch-meta small{display:block}.batch-meta span,.batch-meta small{color:var(--muted);font-size:10px}.batch-meta b{font-size:12px;overflow-wrap:anywhere}
    .summary-matrix{display:grid;grid-template-columns:180px repeat(3,minmax(250px,1fr));border:1px solid var(--line);border-radius:7px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}.matrix-intro{display:flex;flex-direction:column;justify-content:center;padding:15px 18px;border-right:1px solid var(--line)}.matrix-intro span{color:var(--muted);font-size:11px}.matrix-intro strong{margin:1px 0;font-size:30px;line-height:1}.matrix-intro small{color:var(--muted);font-size:10px}.platform-summary{min-width:0;padding:12px 14px;border-right:1px solid var(--line)}.platform-summary:last-child{border-right:0}.platform-summary-head{display:flex;align-items:center;gap:7px}.platform-summary-head b{font-size:12px}.platform-summary-head strong{margin-left:auto;font-size:17px}.platform-token{display:grid;place-items:center;width:30px;height:24px;border:1px solid currentColor;border-radius:4px;color:var(--harmony);font-size:9px;font-weight:900}.android .platform-token{color:var(--android)}.ios .platform-token{color:var(--ios)}.stacked-bar{display:flex;width:100%;height:6px;margin-top:9px;overflow:hidden;background:#e7ebef}.stacked-bar i{display:block;height:100%}.bar-pass{background:var(--pass)}.bar-fail{background:var(--fail)}.bar-blocked{background:#d29736}.bar-inconclusive{background:#8794a3}.bar-not-run{background:#c58b38}.bar-pending{background:#dfe4e8}.summary-counts{display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-top:8px}.summary-counts span{display:grid;grid-template-columns:auto 1fr;column-gap:4px;align-items:baseline;color:var(--muted);font-size:9px}.summary-counts small{grid-column:1/-1}.summary-counts b{color:var(--text);font-size:13px}.summary-counts em{font-size:8px;font-style:normal}
    .content-section{margin-top:20px}.section-title{display:flex;align-items:end;justify-content:space-between;margin-bottom:9px}.section-title h2{margin:0;font-size:16px}.section-title span,.filter-result{color:var(--muted);font-size:11px}.list-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin-bottom:10px}.filter-group{display:inline-flex;min-width:0;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);overflow:hidden}.filter-button{min-height:34px;padding:5px 11px;border:0;border-right:1px solid var(--line);background:transparent;color:var(--text-2);cursor:pointer;font-size:11px;white-space:nowrap}.filter-button:last-child{border-right:0}.filter-button:hover{background:var(--surface-2)}.filter-button.active{background:var(--ink);color:white}.filter-button b{margin-left:5px}.search{width:min(270px,32vw);height:36px;margin-left:auto;padding:0 10px;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px}.search:focus{border-color:var(--accent);outline:2px solid #cce4e4}
    .case-list{display:grid;gap:9px}.case-row{border:1px solid var(--line);border-radius:7px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}.case-common{display:grid;grid-template-columns:34px minmax(260px,1.6fr) minmax(250px,.9fr) 34px;gap:12px;align-items:center;min-height:74px;padding:10px 12px}.case-order{color:#a0aab4;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.case-copy{min-width:0}.case-copy span{color:var(--muted);font-size:9px}.case-copy h3{margin:1px 0 2px;font-size:13px;overflow-wrap:anywhere}.case-copy p{margin:0;color:var(--text-2);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.common-stats{display:grid;grid-template-columns:minmax(180px,1fr) 90px;border-left:1px solid var(--line)}.common-stat{min-width:0;padding-left:13px}.common-stat small,.common-stat b{display:block}.common-stat small{color:var(--muted);font-size:8px}.common-stat b{margin-top:2px;font-size:10px;overflow-wrap:anywhere}.icon-button,.report-button{display:grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid var(--line-strong);border-radius:5px;background:white;color:var(--accent);font-weight:800}.icon-button:hover,.report-button:hover{border-color:var(--accent);background:var(--accent-soft)}.platform-runs{padding:0 12px 7px 58px;border-top:1px solid var(--line);background:var(--surface-2)}.platform-run{position:relative;display:grid;grid-template-columns:150px 70px minmax(680px,1fr) 36px;gap:12px;align-items:center;min-height:64px;padding:8px 0;border-bottom:1px solid var(--line)}.platform-run:last-child{border-bottom:0}.run-platform{display:flex;align-items:center;gap:8px}.run-platform b,.run-platform small{display:block}.run-platform b{font-size:11px}.run-platform small{color:var(--muted);font-size:8px}.status{display:inline-flex;align-items:center;justify-content:center;width:max-content;min-height:23px;padding:2px 7px;border:1px solid var(--line-strong);border-radius:4px;background:var(--pending-soft);color:var(--pending);font-size:9px;font-weight:800}.status.pass{border-color:#a9d8c4;background:var(--pass-soft);color:var(--pass)}.status.fail{border-color:#efb5b5;background:var(--fail-soft);color:var(--fail)}.status.blocked{border-color:#e8cd94;background:var(--blocked-soft);color:var(--blocked)}.platform-run dl{display:grid;grid-template-columns:minmax(10ch,12ch) repeat(2,minmax(calc(19ch + 16px),1fr)) repeat(3,minmax(64px,.45fr));margin:0}.platform-run dl div{min-width:0;padding:0 8px;border-left:1px solid var(--line)}.platform-run dt{color:var(--muted);font-size:8px}.platform-run dd{margin:2px 0 0;font:9px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}.empty,.filter-empty{margin:0;padding:16px;color:var(--muted);text-align:center}.filter-empty{border:1px dashed var(--line-strong);background:var(--surface)}
    @media(max-width:1180px){.summary-matrix{grid-template-columns:150px repeat(3,minmax(205px,1fr))}.common-stats{grid-template-columns:1fr;gap:4px}.platform-run{grid-template-columns:150px 70px minmax(520px,1fr) 36px}.platform-run dl{grid-template-columns:minmax(10ch,12ch) repeat(2,minmax(calc(19ch + 16px),1fr))}.platform-run dl div:nth-child(n+4){margin-top:7px}}
    @media(max-width:860px){.workspace{padding:16px 12px 40px}.summary-matrix{grid-template-columns:1fr}.matrix-intro,.platform-summary{border-right:0;border-bottom:1px solid var(--line)}.platform-summary:last-child{border-bottom:0}.matrix-intro{flex-direction:row;align-items:baseline;gap:8px}.case-common{grid-template-columns:28px minmax(0,1fr) auto 32px}.common-stats{grid-column:2/-1;grid-row:2;grid-template-columns:1fr 1fr;padding-left:0;border-left:0}.platform-runs{padding-left:42px}.platform-run{grid-template-columns:1fr auto;padding:9px 0}.platform-run dl{grid-column:1/-1}.platform-run .report-button{position:absolute;right:0}.product-bar>div{display:none}}
    @media(max-width:620px){.workspace{padding-inline:10px}.page-head{align-items:start}.page-head h1{font-size:20px}.batch-meta{max-width:132px}.list-toolbar{align-items:stretch;flex-wrap:wrap}.filter-group{width:100%;overflow-x:auto}.filter-button{flex:1 0 auto;padding-inline:9px}.search{order:2;width:100%;margin-left:0}.case-common{grid-template-columns:24px minmax(0,1fr) auto;gap:8px}.case-common>.icon-button{grid-column:3;grid-row:2;justify-self:end}.common-stats{grid-column:2}.platform-runs{padding-left:34px}.platform-run dl{grid-template-columns:1fr}.platform-run dl div{display:grid;grid-template-columns:minmax(88px,1fr) auto;align-items:baseline}.platform-run dl div:nth-child(n+2){margin-top:7px}.platform-run dd{margin:0;text-align:right}}
  </style>
</head>
<body><div class="product-shell"><header class="product-bar"><a class="product-brand" href="index.html"><span>MV</span><div><b>MAVT</b><small>移动端 AI 视觉测试</small></div></a><div><b>报告工作区</b><small>${escapeHtml(path.basename(rootDir))}</small></div></header><main class="workspace"><header class="page-head"><div><span class="eyebrow">Dashboard / 最新批次</span><h1>测试执行总览</h1></div><div class="batch-meta"><span>批次</span><b>${escapeHtml(batchName)}</b><small>${escapeHtml(generatedAt)}</small></div></header><section class="summary-matrix"><div class="matrix-intro"><span>三平台执行分布</span><strong>${summary.total}</strong><small>用例总数</small></div>${platformCards}</section><section class="content-section"><div class="section-title"><div><h2>用例执行情况</h2><span>最近一次执行批次</span></div><p class="filter-result" aria-live="polite">显示 ${summary.total} / ${summary.total}</p></div><div class="list-toolbar"><div class="filter-group" role="group" aria-label="筛选用例状态">${filters.map(([value,label,count],index) => `<button type="button" class="filter-button${index===0?' active':''}" data-case-filter="${value}" aria-pressed="${index===0?'true':'false'}">${label}<b>${count}</b></button>`).join('')}</div><div class="filter-group" role="group" aria-label="筛选执行平台">${platformFilters.map(([value,label,count],index) => `<button type="button" class="filter-button${index===0?' active':''}" data-platform-filter="${value}" aria-pressed="${index===0?'true':'false'}">${label}<b>${count}</b></button>`).join('')}</div><input class="search" type="search" aria-label="搜索用例" placeholder="搜索用例编号、名称或标识"></div><div class="case-list">${cards}</div>${cases.length?'<p class="filter-empty" hidden>没有符合条件的用例。</p>':''}</section></main></div><script>
(() => {
  const statusButtons = Array.from(document.querySelectorAll('[data-case-filter]'));
  const platformButtons = Array.from(document.querySelectorAll('[data-platform-filter]'));
  const cards = Array.from(document.querySelectorAll('[data-case-status]'));
  const search = document.querySelector('.search');
  const result = document.querySelector('.filter-result');
  const empty = document.querySelector('.filter-empty');
  const storageKey = 'mavt-dashboard-filters:' + (globalThis.location?.pathname || 'index.html');
  const readSavedFilters = () => {
    try {
      const value = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };
  const savedFilters = readSavedFilters();
  const hasStatus = (value) => statusButtons.some((button) => button.dataset.caseFilter === value);
  const hasPlatform = (value) => platformButtons.some((button) => button.dataset.platformFilter === value);
  let selectedStatus = hasStatus(savedFilters.status) ? savedFilters.status : 'ALL';
  let selectedPlatform = hasPlatform(savedFilters.platform) ? savedFilters.platform : 'ALL';
  if (search && typeof savedFilters.query === 'string') search.value = savedFilters.query;
  const saveFilters = () => {
    try {
      globalThis.sessionStorage?.setItem(storageKey, JSON.stringify({
        status: selectedStatus,
        platform: selectedPlatform,
        query: search?.value || '',
      }));
    } catch {}
  };
  const apply = () => {
    const query = (search?.value || '').trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const statuses = (card.dataset.caseStatus || '').split(' ').filter(Boolean);
      const platforms = (card.dataset.casePlatforms || '').split(' ').filter(Boolean);
      const results = (card.dataset.caseResults || '').split(' ').filter(Boolean);
      const matchesStatus = selectedStatus === 'ALL' || statuses.includes(selectedStatus);
      const matchesPlatform = selectedPlatform === 'ALL' || platforms.includes(selectedPlatform);
      const matchesCombined = selectedStatus === 'ALL' || selectedPlatform === 'ALL'
        || results.includes(selectedPlatform + ':' + selectedStatus);
      const matchesSearch = !query || (card.dataset.caseSearch || '').includes(query);
      card.hidden = !(matchesStatus && matchesPlatform && matchesCombined && matchesSearch);
      for (const run of card.querySelectorAll('[data-platform-run]')) {
        run.hidden = selectedPlatform !== 'ALL' && run.dataset.platformRun !== selectedPlatform;
      }
      if (!card.hidden) visible += 1;
    }
    for (const button of statusButtons) {
      const active = button.dataset.caseFilter === selectedStatus;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    for (const button of platformButtons) {
      const active = button.dataset.platformFilter === selectedPlatform;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (result) result.textContent = '显示 ' + visible + ' / ' + cards.length;
    if (empty) empty.hidden = visible !== 0;
    saveFilters();
  };
  for (const button of statusButtons) button.addEventListener('click', () => { selectedStatus = button.dataset.caseFilter || 'ALL'; apply(); });
  for (const button of platformButtons) button.addEventListener('click', () => { selectedPlatform = button.dataset.platformFilter || 'ALL'; apply(); });
  search?.addEventListener('input', apply);
  apply();
})();
</script></body></html>\n`;
}

module.exports = {
  effectiveVerdict,
  latestRunControl,
  renderCurrentIndexHtml,
  summarize,
};

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
const VERDICT_LABELS = Object.freeze({ RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布', PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断', UNKNOWN: '无法判断', NOT_RUN: '未执行', REPORT_ERROR: '报告数据异常' });
const BASIS_LABELS = Object.freeze({ DIRECT_EVIDENCE: '直接证据', KNOWLEDGE_SUPPORTED: '知识支持', INSUFFICIENT_EVIDENCE: '证据不足', TECHNICAL_CONSTRAINT: '技术约束' });
const EXECUTION_STATUS_LABELS = Object.freeze({ RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布', COMPLETED: '执行完成', TECHNICALLY_BLOCKED: '技术阻塞', STOPPED_BY_BUDGET: '达到时限', INTERRUPTED: '执行中断' });
const BATCH_STATUS_LABELS = Object.freeze({ INITIALIZING: '待启动', RUNNING: '执行中', COMPLETED: '已完成', BLOCKED: '已停止', DEGRADED: '已停止' });
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
  if (item.status === 'FINALIZATION_RECOVERY_REQUIRED') return 'RUNNING';
  return item.verdict || item.status || 'NOT_RUN';
}

function verdictLabel(value) {
  return VERDICT_LABELS[value] || (value ? '未知结论' : '-');
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
    { number: '03', label: '批次进度', value: state ? (BATCH_STATUS_LABELS[state.status] || '未知状态') : '未开始', detail: batchDetail, state: state?.status === 'COMPLETED' ? 'ready' : state?.status === 'BLOCKED' || state?.status === 'DEGRADED' ? 'stopped' : state ? 'active' : 'idle' },
    { number: '04', label: '暖会话', value: warm ? (WARM_STATUS_LABELS[warm.status] || '未知状态') : '未建立', detail: warmDetail, state: warm?.status === 'READY' ? 'active' : warm?.status === 'CLOSED' ? 'ready' : 'idle' },
  ];
}

function summarize(cases) {
  const verdicts = cases.map(effectiveVerdict);
  const currentRuns = cases.flatMap((item) => item.platforms || []);
  return {
    total: cases.length,
    pass: verdicts.filter((value) => value === 'PASS').length,
    fail: verdicts.filter((value) => value === 'FAIL').length,
    blocked: verdicts.filter((value) => value === 'BLOCKED').length,
    inconclusive: verdicts.filter((value) => value === 'INCONCLUSIVE').length,
    pendingPublication: verdicts.filter((value) => value === 'PENDING_PUBLICATION').length,
    notRun: verdicts.filter((value) => value === 'NOT_RUN').length,
    reportError: verdicts.filter((value) => value === 'REPORT_ERROR').length,
    directEvidence: currentRuns.filter((item) => item.verdictBasis === 'DIRECT_EVIDENCE').length,
    knowledgeSupported: currentRuns.filter((item) => item.verdictBasis === 'KNOWLEDGE_SUPPORTED').length,
    preparationActions: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.counts?.preparationActions || 0), 0),
    warmReuse: currentRuns.filter((item) => item.currentMetrics?.warmSessionReused).length,
    recoveries: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.recoveryCount || 0), 0),
    timeLimitStops: currentRuns.filter((item) => item.currentMetrics?.timeLimitStopped).length,
    planRevisions: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.counts?.planRevisions || 0), 0),
    knowledgeQueries: currentRuns.reduce((sum, item) => sum + (item.currentMetrics?.counts?.knowledgeQueries || 0), 0),
  };
}

function platformSummary(cases) {
  const rows = new Map(['harmony', 'android', 'ios'].map((platform) => [platform, { platform, total: 0, pass: 0, fail: 0, blocked: 0, inconclusive: 0 }]));
  for (const item of cases) {
    for (const platform of item.platforms || []) {
      if (!rows.has(platform.platform)) continue;
      const row = rows.get(platform.platform);
      const verdict = effectiveVerdict(platform);
      row.total += 1;
      if (verdict === 'PASS') row.pass += 1;
      if (verdict === 'FAIL') row.fail += 1;
      if (verdict === 'BLOCKED') row.blocked += 1;
      if (verdict === 'INCONCLUSIVE') row.inconclusive += 1;
    }
  }
  return [...rows.values()];
}

function platformActivity(platform) {
  const metrics = platform.currentMetrics || {};
  const counts = metrics.counts || {};
  return `计划 ${counts.planRevisions || 0} · 知识 ${counts.knowledgeQueries || 0} · 恢复 ${metrics.recoveryCount || 0}`;
}

function renderPlatformBreakdown(platforms) {
  if (platforms.length <= 1) return '';
  const rows = platforms.map((platform) => {
    const verdict = effectiveVerdict(platform);
    const basis = basisLabel(platform.verdictBasis);
    const executionState = executionStatusLabel(platform.executionStatus);
    return `<div class="platform-breakdown-row">
      <div class="platform-cell"><span>平台</span><b>${escapeHtml(displayPlatform(platform.platform))}</b></div>
      <div class="platform-cell"><span>平台结果</span><div class="platform-result"><span class="verdict ${escapeHtml(className(verdict))}">${escapeHtml(verdictLabel(verdict))}</span>${executionState !== '-' ? `<small>${escapeHtml(executionState)}</small>` : ''}</div></div>
      <div class="platform-cell"><span>结论依据</span><b>${escapeHtml(basis)}</b></div>
      <div class="platform-cell activity-cell"><span>Agent 轨迹</span><b>${escapeHtml(platformActivity(platform))}</b></div>
      <div class="platform-cell"><span>耗时</span><b>${escapeHtml(formatDuration(platform.durationMs))}</b></div>
      <div class="platform-cell report-cell"><span>报告</span><a class="report-link" href="${escapeHtml(platform.contextHref)}">查看报告</a></div>
    </div>`;
  }).join('');
  return `<div class="platform-breakdown"><div class="platform-breakdown-title">平台明细</div>${rows}</div>`;
}

function renderCase(item, index) {
  const verdict = effectiveVerdict(item);
  const platforms = item.platforms || [];
  const executedPlatforms = platforms.filter((platform) => effectiveVerdict(platform) !== 'NOT_RUN');
  const hasExecution = verdict !== 'NOT_RUN';
  const hasMultiplePlatforms = executedPlatforms.length > 1;
  const primary = executedPlatforms.find((platform) => effectiveVerdict(platform) === verdict) || executedPlatforms[0] || null;
  const summary = item.reason || '暂无结论摘要';
  const executionState = executionStatusLabel(item.executionStatus);
  const platformValue = executedPlatforms.length > 1
    ? `${executedPlatforms.length} 个平台`
    : primary ? displayPlatform(primary.platform) : '-';
  const basis = basisLabel(item.verdictBasis);
  const facts = hasExecution && !hasMultiplePlatforms ? `<div class="case-facts">
    <div class="case-fact"><span>执行平台</span><b>${escapeHtml(platformValue)}</b></div>
    <div class="case-fact"><span>结论依据</span><b>${escapeHtml(basis)}</b></div>
    <div class="case-fact activity-fact"><span>Agent 轨迹</span><b>${escapeHtml(primary ? platformActivity(primary) : '-')}</b></div>
    <div class="case-fact"><span>耗时</span><b>${escapeHtml(formatDuration(item.durationMs))}</b></div>
    ${primary ? `<div class="case-fact report-fact"><span>执行报告</span><a class="report-link" href="${escapeHtml(primary.contextHref)}">查看报告</a></div>` : ''}
  </div>` : '';
  return `<article class="case-row ${escapeHtml(className(verdict))}${hasExecution ? ' executed' : ' not-executed'}" data-case-status="${escapeHtml(verdict)}" data-case-search="${escapeHtml(`${item.caseNo || ''} ${item.title} ${item.caseKey || ''}`.toLowerCase())}">
    <div class="case-primary">
      <div class="case-heading"><span>用例 ${escapeHtml(item.caseNo || String(index + 1).padStart(3, '0'))}</span><h3>${escapeHtml(item.title)}</h3></div>
      <div class="case-actions"><div class="case-status"><span class="verdict ${escapeHtml(className(verdict))}">${escapeHtml(verdictLabel(verdict))}</span>${hasMultiplePlatforms ? `<small>${executedPlatforms.length} 个平台</small>` : hasExecution && executionState !== '-' ? `<small>${escapeHtml(executionState)}</small>` : ''}</div><a class="case-detail" href="${escapeHtml(item.contextHref)}" aria-label="查看 ${escapeHtml(item.title)} 用例详情">查看详情</a></div>
      ${hasExecution ? `<p class="case-conclusion">${escapeHtml(summary)}</p>` : ''}
      <small class="case-identity">${escapeHtml(item.caseKey || '-')} · ${escapeHtml(formatDisplayTime(item.endedAt || item.updatedAt))}</small>
    </div>
    ${facts}
    ${renderPlatformBreakdown(executedPlatforms)}
  </article>`;
}

function renderCurrentIndexHtml(rootDir, cases = []) {
  const control = latestRunControl(rootDir);
  const orderedCases = cases.slice();
  const stages = controlStage(control);
  const summary = summarize(orderedCases);
  const platforms = platformSummary(orderedCases);
  const filters = [
    ['ALL', '全部', summary.total],
    ['PASS', '通过', summary.pass],
    ['FAIL', '失败', summary.fail],
    ['BLOCKED', '阻塞', summary.blocked],
    ['INCONCLUSIVE', '无法判断', summary.inconclusive],
    ['PENDING_PUBLICATION', '待发布', summary.pendingPublication],
    ['NOT_RUN', '未执行', summary.notRun],
    ['REPORT_ERROR', '报告异常', summary.reportError],
  ];
  const batchName = control.latest?.batchId || '暂无批次';
  const runCountText = control.runCount ? `累计 ${control.runCount} 个批次` : '尚无执行批次';
  const generatedAt = formatDisplayTime(new Date().toISOString());
  const cards = orderedCases.length ? orderedCases.map(renderCase).join('\n') : '<p class="empty">暂无用例。</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>移动端 AI 视觉测试</title>
  <style>
    :root{color-scheme:light;--bg:#f3f4f6;--surface:#fff;--surface-soft:#f8fafc;--text:#18202b;--muted:#667085;--line:#d9dee7;--line-strong:#c5ccd8;--accent:#1769aa;--pass:#147a55;--pass-soft:#edf8f3;--fail:#c23b3b;--fail-soft:#fff1f1;--blocked:#9a6515;--blocked-soft:#fff8e8;--inconclusive:#596579;--inconclusive-soft:#f1f3f6;--active:#0f7490;--shadow:0 4px 14px rgba(21,31,45,.06)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}button,input{font:inherit}main{width:min(1320px,calc(100vw - 32px));margin:0 auto 48px}
    .topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:24px 0 18px;border-bottom:1px solid var(--line-strong)}.brand span{display:block;color:var(--active);font-size:12px;font-weight:800;text-transform:uppercase}.brand h1{margin:3px 0 0;font-size:24px;line-height:1.25}.workspace-meta{min-width:0;text-align:right}.workspace-meta b,.workspace-meta span{display:block;overflow-wrap:anywhere}.workspace-meta b{font-size:13px}.workspace-meta span{color:var(--muted);font-size:12px}
    .control-band{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}.stage{position:relative;min-width:0;padding:15px 16px;border-right:1px solid var(--line)}.stage:last-child{border-right:0}.stage-head{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;font-weight:700}.stage-number{display:grid;place-items:center;width:23px;height:23px;border:1px solid var(--line-strong);border-radius:50%;font-size:10px}.stage.ready .stage-number{border-color:var(--pass);color:var(--pass)}.stage.active .stage-number{border-color:var(--active);color:var(--active)}.stage.stopped .stage-number{border-color:var(--fail);color:var(--fail)}.stage strong{display:block;margin-top:8px;font-size:16px}.stage p{min-height:40px;margin:3px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
    .section{margin-top:18px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:9px}.section-head h2{margin:0;font-size:16px}.section-head p{margin:0;color:var(--muted);font-size:12px}.outcome-band{display:grid;grid-template-columns:1.25fr repeat(5,minmax(94px,1fr));border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.outcome-main,.outcome-metric{min-height:92px;padding:15px 16px;border-right:1px solid var(--line)}.outcome-metric:last-child{border-right:0}.outcome-main span,.outcome-metric span{display:block;color:var(--muted);font-size:12px}.outcome-main strong{display:block;margin-top:4px;font-size:30px;line-height:1}.outcome-main small{display:block;margin-top:7px;color:var(--muted)}.outcome-metric b{display:block;margin-top:7px;font-size:23px}.outcome-metric.pass b{color:var(--pass)}.outcome-metric.fail b{color:var(--fail)}.outcome-metric.blocked b{color:var(--blocked)}.outcome-metric.inconclusive b{color:var(--inconclusive)}
    .signal-band{display:grid;grid-template-columns:1.1fr 1fr;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.signals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:14px 16px;border-right:1px solid var(--line)}.signal{min-width:0;padding-right:12px}.signal span{display:block;color:var(--muted);font-size:11px}.signal b{display:block;margin-top:3px;font-size:18px}.platform-table{padding:10px 16px}.platform-table-head,.platform-table-row{display:grid;grid-template-columns:minmax(90px,1fr) repeat(5,48px);gap:8px;align-items:center}.platform-table-head{color:var(--muted);font-size:10px}.platform-table-row{min-height:27px;border-top:1px solid #edf0f4;font-size:12px}.platform-table-row b{font-size:12px}.platform-table-row span:not(:first-child),.platform-table-head span:not(:first-child){text-align:right}
    .toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px}.filter-group{display:inline-flex;flex-wrap:wrap;border:1px solid var(--line-strong);border-radius:7px;overflow:hidden}.filter-button{min-height:34px;padding:6px 10px;border:0;border-right:1px solid var(--line);background:var(--surface);color:#3f4958;cursor:pointer;font-size:12px;font-weight:700}.filter-button:last-child{border-right:0}.filter-button:hover{background:var(--surface-soft)}.filter-button.active{background:#263342;color:#fff}.filter-button b{margin-left:3px}.search{width:min(300px,100%);height:36px;padding:7px 10px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);color:var(--text)}.search:focus{border-color:var(--accent);outline:2px solid rgba(23,105,170,.12)}.filter-result{color:var(--muted);font-size:12px;white-space:nowrap}
    .case-list{display:grid;gap:9px}.case-row{position:relative;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}.case-row[hidden]{display:none}.case-row:before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--inconclusive)}.case-row.pass:before{background:var(--pass)}.case-row.fail:before{background:var(--fail)}.case-row.blocked:before{background:var(--blocked)}.case-primary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 18px;padding:14px 16px 13px 20px}.case-heading{display:flex;align-items:baseline;gap:9px;min-width:0}.case-heading>span{flex:0 0 auto;color:var(--muted);font-size:11px;font-weight:800}.case-heading h3{min-width:0;margin:0;font-size:15px;overflow-wrap:anywhere}.case-actions{display:flex;align-items:flex-start;gap:12px}.case-status{display:flex;align-items:center;gap:7px}.case-status small{color:var(--muted);font-size:10px;white-space:nowrap}.case-conclusion{grid-column:1/-1;margin:2px 0 0;color:#344054;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.case-identity{grid-column:1/-1;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.verdict{display:inline-flex;align-items:center;min-height:26px;padding:3px 8px;border:1px solid var(--line-strong);border-radius:5px;background:var(--inconclusive-soft);color:var(--inconclusive);font-size:12px;font-weight:800}.verdict.pass{border-color:#a9d8c4;background:var(--pass-soft);color:var(--pass)}.verdict.fail{border-color:#efb5b5;background:var(--fail-soft);color:var(--fail)}.verdict.blocked{border-color:#e8cd94;background:var(--blocked-soft);color:var(--blocked)}.case-detail,.report-link{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:5px 9px;border:1px solid var(--line-strong);border-radius:6px;background:#fff;font-size:12px;font-weight:800;white-space:nowrap}.case-facts{display:grid;grid-template-columns:120px 130px minmax(200px,1fr) 100px 100px;padding:0 16px 0 20px;border-top:1px solid #edf0f4;background:#fafbfc}.case-fact{min-width:0;padding:10px 12px 11px 0}.case-fact+.case-fact{padding-left:14px;border-left:1px solid #e5e9ef}.case-fact>span{display:block;color:var(--muted);font-size:10px}.case-fact>b{display:block;margin-top:4px;font-size:12px;line-height:1.45;overflow-wrap:anywhere}.report-fact .report-link{margin-top:4px}.platform-breakdown{border-top:1px solid #e1e6ed;padding:0 16px 8px 20px;background:#f7f9fb}.platform-breakdown-title{padding:9px 0 6px;color:var(--muted);font-size:10px;font-weight:800}.platform-breakdown-row{display:grid;grid-template-columns:100px 150px 120px minmax(180px,1fr) 90px 90px;gap:12px;align-items:start;min-height:64px;padding:9px 0;border-top:1px solid #e5e9ef}.platform-cell{min-width:0}.platform-cell>span{display:block;color:var(--muted);font-size:10px}.platform-cell>b{display:block;margin-top:4px;font-size:12px;line-height:1.45;overflow-wrap:anywhere}.platform-result{display:flex;align-items:center;gap:6px;margin-top:4px}.platform-result small{color:var(--muted);font-size:10px}.report-cell .report-link{margin-top:4px}.not-executed .case-primary{min-height:76px;align-content:center}.empty,.filter-empty{margin:0;padding:16px;color:var(--muted);text-align:center}.filter-empty{border:1px dashed var(--line-strong);border-radius:8px;background:var(--surface)}
    @media(max-width:980px){.control-band{grid-template-columns:repeat(2,minmax(0,1fr))}.stage:nth-child(2){border-right:0}.stage:nth-child(-n+2){border-bottom:1px solid var(--line)}.outcome-band{grid-template-columns:repeat(3,1fr)}.outcome-main{grid-column:1/-1;border-right:0;border-bottom:1px solid var(--line)}.outcome-metric:nth-child(4){border-right:0}.signal-band{grid-template-columns:1fr}.signals{border-right:0;border-bottom:1px solid var(--line)}.case-facts{grid-template-columns:110px 120px minmax(170px,1fr) 88px 94px}}
    @media(max-width:700px){main{width:calc(100vw - 20px)}.topbar{display:block;padding-top:16px}.workspace-meta{margin-top:9px;text-align:left}.control-band{grid-template-columns:1fr}.stage{border-right:0;border-bottom:1px solid var(--line)}.stage:nth-child(2){border-right:0}.stage:last-child{border-bottom:0}.stage p{min-height:0}.outcome-band{grid-template-columns:repeat(2,1fr)}.outcome-main{grid-column:1/-1}.outcome-metric{border-bottom:1px solid var(--line)}.outcome-metric:nth-child(odd){border-right:0}.outcome-metric:last-child{border-bottom:0}.signals{grid-template-columns:repeat(2,1fr);gap:12px}.platform-table-head,.platform-table-row{grid-template-columns:minmax(74px,1fr) repeat(5,minmax(24px,auto));gap:5px}.toolbar{align-items:stretch;flex-direction:column}.filter-group{display:grid;grid-template-columns:repeat(3,1fr)}.filter-button{border-bottom:1px solid var(--line)}.search{width:100%}.case-primary{grid-template-columns:minmax(0,1fr) auto;gap:8px 10px;padding:13px 12px 12px 17px}.case-heading{grid-column:1/-1}.case-actions{grid-column:1/-1;justify-content:space-between}.case-facts{grid-template-columns:1fr 1fr;padding:0 12px 6px 17px}.case-fact{padding:9px 8px 8px 0}.case-fact+.case-fact{padding-left:0;border-left:0}.activity-fact{grid-column:1/-1}.platform-breakdown{padding:0 12px 8px 17px}.platform-breakdown-row{grid-template-columns:1fr 1fr;gap:12px 18px;padding:11px 0}.activity-cell{grid-column:1/-1}.section-head{display:block}.section-head>p{margin-top:3px}}
  </style>
</head>
<body><main>
  <header class="topbar"><div class="brand"><span>Agent 无人值守执行</span><h1>移动端 AI 视觉测试</h1></div><div class="workspace-meta"><b>${escapeHtml(path.basename(rootDir))}</b><span>${escapeHtml(rootDir)} · ${escapeHtml(generatedAt)}</span></div></header>
  <section class="section run-control-section"><div class="section-head"><div><h2>当前运行</h2><p>仅展示最近一次执行批次的环境、授权和进度</p></div><p>${escapeHtml(batchName)} · ${escapeHtml(runCountText)}</p></div><div class="control-band" aria-label="运行控制状态">${stages.map((stage) => `<div class="stage ${escapeHtml(stage.state)}"><div class="stage-head"><span class="stage-number">${stage.number}</span><span>${escapeHtml(stage.label)}</span></div><strong>${escapeHtml(stage.value)}</strong><p>${escapeHtml(stage.detail)}</p></div>`).join('')}</div></section>
  <section class="section"><div class="section-head"><div><h2>结果概览</h2><p>按最终结论统计，不按固定步骤归约</p></div><p>${escapeHtml(batchName)}</p></div><div class="outcome-band"><div class="outcome-main"><span>用例总数</span><strong>${summary.total}</strong><small>${summary.total - summary.notRun - summary.reportError} 个已有执行结论</small></div><div class="outcome-metric pass"><span>通过</span><b>${summary.pass}</b></div><div class="outcome-metric fail"><span>失败</span><b>${summary.fail}</b></div><div class="outcome-metric blocked"><span>阻塞</span><b>${summary.blocked}</b></div><div class="outcome-metric inconclusive"><span>无法判断</span><b>${summary.inconclusive}</b></div><div class="outcome-metric"><span>未执行</span><b>${summary.notRun}</b></div></div></section>
  <section class="section"><div class="section-head"><div><h2>Agent 执行信号</h2><p>结论依据、动态计划、知识调查与暖会话</p></div></div><div class="signal-band"><div class="signals"><div class="signal"><span>直接证据</span><b>${summary.directEvidence}</b></div><div class="signal"><span>知识支持</span><b>${summary.knowledgeSupported}</b></div><div class="signal"><span>计划修订</span><b>${summary.planRevisions}</b></div><div class="signal"><span>知识查询</span><b>${summary.knowledgeQueries}</b></div><div class="signal"><span>准备动作</span><b>${summary.preparationActions}</b></div><div class="signal"><span>暖状态复用</span><b>${summary.warmReuse}</b></div><div class="signal"><span>受控恢复</span><b>${summary.recoveries}</b></div><div class="signal"><span>时限停止</span><b>${summary.timeLimitStops}</b></div></div><div class="platform-table"><div class="platform-table-head"><span>平台</span><span>执行</span><span>通过</span><span>失败</span><span>阻塞</span><span>待定</span></div>${platforms.map((item) => `<div class="platform-table-row"><b>${escapeHtml(displayPlatform(item.platform))}</b><span>${item.total}</span><span>${item.pass}</span><span>${item.fail}</span><span>${item.blocked}</span><span>${item.inconclusive}</span></div>`).join('')}</div></div></section>
  <section class="section"><div class="section-head"><div><h2>用例结果</h2><p class="filter-result" aria-live="polite">显示 ${summary.total} / ${summary.total}</p></div></div><div class="toolbar"><div class="filter-group" role="group" aria-label="筛选最终结果">${filters.map(([value,label,count],index) => `<button type="button" class="filter-button${index === 0 ? ' active' : ''}" data-case-filter="${value}" aria-pressed="${index === 0 ? 'true' : 'false'}">${label}<b>${count}</b></button>`).join('')}</div><input class="search" type="search" aria-label="搜索用例" placeholder="搜索用例编号、名称或标识"></div><div class="case-list">${cards}</div>${cases.length ? '<p class="filter-empty" hidden>没有符合条件的用例。</p>' : ''}</section>
</main><script>
(() => {
  const buttons = Array.from(document.querySelectorAll('[data-case-filter]'));
  const cards = Array.from(document.querySelectorAll('[data-case-status]'));
  const search = document.querySelector('.search');
  const result = document.querySelector('.filter-result');
  const empty = document.querySelector('.filter-empty');
  let selected = 'ALL';
  const apply = () => {
    const query = (search?.value || '').trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const matchesStatus = selected === 'ALL' || card.dataset.caseStatus === selected;
      const matchesSearch = !query || (card.dataset.caseSearch || '').includes(query);
      card.hidden = !(matchesStatus && matchesSearch);
      if (!card.hidden) visible += 1;
    }
    for (const button of buttons) {
      const active = button.dataset.caseFilter === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (result) result.textContent = '显示 ' + visible + ' / ' + cards.length;
    if (empty) empty.hidden = visible !== 0;
  };
  for (const button of buttons) button.addEventListener('click', () => { selected = button.dataset.caseFilter || 'ALL'; apply(); });
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

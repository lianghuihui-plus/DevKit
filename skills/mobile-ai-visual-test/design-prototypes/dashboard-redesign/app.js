'use strict';

const platforms = {
  harmony: { label: 'HarmonyOS', short: 'HM', className: 'harmony' },
  android: { label: 'Android', short: 'AN', className: 'android' },
  ios: { label: 'iOS', short: 'iOS', className: 'ios' },
};

const verdicts = {
  PASS: { label: '通过', short: '通' },
  FAIL: { label: '失败', short: '失' },
  BLOCKED: { label: '阻塞', short: '阻' },
  INCONCLUSIVE: { label: '无法判断', short: '无法' },
  NOT_RUN: { label: '未执行', short: '未' },
};

const cases = [
  {
    no: '001', caseKey: 'ck-a14f09c3e672', title: '手机号验证码登录成功', summary: '手机号验证码登录链路完成，登录态和用户身份均已确认。',
    platforms: {
      harmony: { verdict: 'PASS', duration: '01:48', start: '2026-09-02 09:31:05', end: '2026-09-02 09:32:53', actions: 7, checks: '3/3', executionStatus: '执行完成', basis: '直接证据', recoveries: 0 },
      android: { verdict: 'PASS', duration: '01:35', start: '2026-09-02 09:36:12', end: '2026-09-02 09:37:47', actions: 7, checks: '3/3', executionStatus: '执行完成', basis: '直接证据', recoveries: 0 },
      ios: { verdict: 'FAIL', duration: '02:12', start: '2026-09-02 09:41:20', end: '2026-09-02 09:43:32', actions: 8, checks: '2/3', executionStatus: '执行完成', basis: '直接证据', recoveries: 1 },
    },
  },
  {
    no: '002', caseKey: 'ck-61bfac9c228e', title: '首次启动时展示隐私政策弹窗', summary: '初始状态无法满足首次安装条件，执行在准备阶段停止。',
    platforms: {
      harmony: { verdict: 'BLOCKED', duration: '00:42', start: '2026-09-02 09:47:03', end: '2026-09-02 09:47:45', actions: 2, checks: '0/2', executionStatus: '技术阻塞', basis: '证据不足', recoveries: 0 },
      android: { verdict: 'PASS', duration: '00:58', start: '2026-09-02 09:51:18', end: '2026-09-02 09:52:16', actions: 3, checks: '2/2', executionStatus: '执行完成', basis: '直接证据', recoveries: 0 },
    },
  },
  {
    no: '003', caseKey: 'ck-947ed260c115', title: '搜索不存在的课程并返回空状态', summary: 'iOS 已验证空状态，其余平台未执行且不在列表中占位。',
    platforms: {
      ios: { verdict: 'PASS', duration: '01:16', start: '2026-09-02 10:02:40', end: '2026-09-02 10:03:56', actions: 5, checks: '2/2', executionStatus: '执行完成', basis: '直接证据', recoveries: 0 },
    },
  },
  {
    no: '004', caseKey: 'ck-c4b58925ef7a', title: '弱网下提交作品后恢复上传', summary: 'HarmonyOS 证据不足，Android 与 iOS 尚未执行。',
    platforms: {
      harmony: { verdict: 'INCONCLUSIVE', duration: '04:26', start: '2026-09-02 10:08:11', end: '2026-09-02 10:12:37', actions: 12, checks: '2/3', executionStatus: '执行完成', basis: '证据不足', recoveries: 1 },
    },
  },
  {
    no: '005', caseKey: 'ck-6dc70ae83193', title: '游客访问个人中心时展示登录引导并保持返回路径', summary: 'HarmonyOS 通过，Android 未出现预期登录引导。',
    platforms: {
      harmony: { verdict: 'PASS', duration: '00:49', start: '2026-09-02 10:22:16', end: '2026-09-02 10:23:05', actions: 4, checks: '2/2', executionStatus: '执行完成', basis: '直接证据', recoveries: 0 },
      android: { verdict: 'FAIL', duration: '01:03', start: '2026-09-02 10:26:31', end: '2026-09-02 10:27:34', actions: 5, checks: '1/2', executionStatus: '执行完成', basis: '直接证据', recoveries: 0 },
    },
  },
];

const platformStats = {
  harmony: { total: 5, PASS: 2, FAIL: 0, BLOCKED: 1, INCONCLUSIVE: 1, NOT_RUN: 1 },
  android: { total: 5, PASS: 2, FAIL: 1, BLOCKED: 0, INCONCLUSIVE: 0, NOT_RUN: 2 },
  ios: { total: 5, PASS: 1, FAIL: 1, BLOCKED: 0, INCONCLUSIVE: 0, NOT_RUN: 3 },
};

const app = document.querySelector('#app');
let activeReportPlatform = 'harmony';

function icon(name, label = '') {
  const paths = {
    arrowLeft: '<path d="m15 18-6-6 6-6"/><path d="M21 12H9"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/>',
    maximize: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>${label ? `<span>${label}</span>` : ''}`;
}

function badge(verdict, compact = false) {
  const item = verdicts[verdict] || verdicts.NOT_RUN;
  return `<span class="status status-${verdict.toLowerCase()}"><i></i>${compact ? item.short : item.label}</span>`;
}

function shell(content) {
  return `<div class="product-shell">
    <header class="product-bar"><a href="#overview" class="product-brand"><span>MV</span><div><b>MAVT</b><small>移动端 AI 视觉测试</small></div></a><div><b>报告工作区</b><small>workspace/mobile-regression</small></div></header>
    <main class="workspace">${content}</main>
  </div>`;
}

function pageHeader(title, eyebrow = '批次执行结果', meta = true) {
  return `<header class="page-head"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1></div>${meta ? `<div class="batch-meta"><span>批次</span><b>RUN-2026-0902-01</b><small>更新于 10:27:34</small></div>` : ''}</header>`;
}

function stackedBar(stats) {
  return `<div class="stacked-bar" aria-label="结果占比">
    ${['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN'].map(key => `<i class="bar-${key.toLowerCase().replace('_', '-')}" style="width:${stats[key] / stats.total * 100}%"></i>`).join('')}
  </div>`;
}

function platformOverviewA() {
  return `<section class="summary-matrix">
    <div class="matrix-intro"><span>已执行 / 全部</span><strong>9 / 15</strong><small>共 5 条用例 · 3 个平台</small></div>
    ${Object.entries(platformStats).map(([key, stats]) => `<article class="platform-summary ${key}">
      <div class="platform-summary-head"><span class="platform-token">${platforms[key].short}</span><b>${platforms[key].label}</b><strong>${stats.total - stats.NOT_RUN} / ${stats.total}</strong></div>
      ${stackedBar(stats)}
      <div class="summary-counts">${['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN'].map(status => `<span class="count-${status.toLowerCase().replace('_', '-')}"><b>${stats[status]}</b>${verdicts[status].label}<small>${Math.round(stats[status] / stats.total * 100)}%</small></span>`).join('')}</div>
    </article>`).join('')}
  </section>`;
}

function filters(extra = '', counts = { ALL: 5, PASS: 4, FAIL: 2, BLOCKED: 1, INCONCLUSIVE: 1, NOT_RUN: 4 }) {
  return `<div class="list-toolbar">
    <div class="segmented" role="group" aria-label="状态筛选">
      ${[['ALL','全部'],['PASS','通过'],['FAIL','失败'],['BLOCKED','阻塞'],['INCONCLUSIVE','无法判断'],['NOT_RUN','未执行']].map(([value,label], index) => `<button class="filter-btn ${index === 0 ? 'active' : ''}" data-filter="${value}">${label}<b>${counts[value]}</b></button>`).join('')}
    </div>
    ${extra}
    <label class="search-box">${icon('search')}<input type="search" placeholder="搜索编号或用例名称" aria-label="搜索用例"></label>
  </div>`;
}

function commonCase(item, index) {
  const values = Object.values(item.platforms);
  const count = status => values.filter(run => run.verdict === status).length;
  const notRun = Object.keys(platforms).length - values.length;
  const avgSeconds = Math.round(values.reduce((sum, run) => {
    const [m, s] = run.duration.split(':').map(Number); return sum + m * 60 + s;
  }, 0) / values.length);
  return `<div class="case-common">
    <div class="case-order">${String(index + 1).padStart(2, '0')}</div>
    <div class="case-copy"><span>用例 ${item.no} · ${item.caseKey}</span><h3>${item.title}</h3><p>${item.summary}</p></div>
    <div class="common-stats"><span><small>三端统计</small><b>${count('PASS')} 通 · ${count('FAIL')} 失 · ${count('BLOCKED')} 阻 · ${count('INCONCLUSIVE')} 无法 · ${notRun} 未</b></span><span><small>平均耗时</small><b>${Math.floor(avgSeconds/60).toString().padStart(2,'0')}:${(avgSeconds%60).toString().padStart(2,'0')}</b></span></div>
    <a class="icon-button" href="#case-content" title="查看用例内容" aria-label="查看用例内容">${icon('file')}</a>
  </div>`;
}

function platformRun(key, run, mode = 'row') {
  return `<article class="platform-run ${key} ${mode}">
    <div class="run-platform"><span class="platform-token">${platforms[key].short}</span><div><b>${platforms[key].label}</b><small>${run.executionStatus} · ${run.basis}</small></div></div>
    ${badge(run.verdict)}
    <dl><div><dt>耗时</dt><dd>${run.duration}</dd></div><div><dt>开始时间</dt><dd>${run.start}</dd></div><div><dt>结束时间</dt><dd>${run.end}</dd></div><div><dt>动作 / 观察</dt><dd>${run.actions} / ${run.actions + 1}</dd></div><div><dt>验证点</dt><dd>${run.checks}</dd></div><div><dt>恢复</dt><dd>${run.recoveries}</dd></div></dl>
    <a class="report-button" href="#report-${key}">${icon('external','报告')}</a>
  </article>`;
}

function caseRowsA() {
  return `<div class="case-list matrix-list">${cases.map((item, index) => {
    const statuses = Object.values(item.platforms).map(run => run.verdict);
    if (Object.keys(item.platforms).length < Object.keys(platforms).length) statuses.push('NOT_RUN');
    return `<section class="case-row" data-status="${[...new Set(statuses)].join(' ')}" data-search="${item.no.toLowerCase()} ${item.title.toLowerCase()}">${commonCase(item,index)}<div class="platform-runs">${Object.entries(item.platforms).map(([key,run])=>platformRun(key,run)).join('')}</div></section>`;
  }).join('')}</div><p class="empty-result" hidden>没有符合条件的用例。</p>`;
}

function overviewA() {
  return shell(`${pageHeader('测试执行总览')}
    ${platformOverviewA()}
    <section class="content-section"><div class="section-title"><div><h2>用例执行情况</h2><span>最近一次执行批次</span></div><b class="visible-count">5 / 5</b></div>${filters()}${caseRowsA()}</section>`);
}

const reportSteps = [
  { no: 1, status: 'done', title: '确认登录页初始状态', type: '观察', purpose: '验证当前位于手机号登录入口，避免在错误页面继续执行。', expected: '出现手机号输入框、验证码输入框和登录按钮。', result: '页面结构与用例前置条件一致。', check: 'CP-01', time: '09:31:08', duration: '3.2s', before: 'login', after: 'login', action: null },
  { no: 2, status: 'done', title: '输入测试手机号', type: '操作', purpose: '建立验证码登录所需账号信息。', expected: '输入框显示脱敏手机号 138****8000。', result: '文本写入成功，焦点停留在手机号输入框。', check: 'CP-01', time: '09:31:16', duration: '2.1s', before: 'login', after: 'phone', action: { kind: 'POINT', name: 'inputText', source: 'layout', requested: '(180, 356)', dispatched: '(180, 356)', actual: null, x: 50, y: 43, bounds: [16, 37, 84, 49] } },
  { no: 3, status: 'done', title: '获取并填写验证码', type: '操作', purpose: '完成身份校验，为提交登录做准备。', expected: '验证码填入后登录按钮变为可用。', result: '验证码 246810 已填写，登录按钮已激活。', check: 'CP-02', time: '09:31:28', duration: '8.6s', before: 'phone', after: 'code', action: { kind: 'POINT', name: 'inputText', source: 'layout', requested: '(176, 448)', dispatched: '(176, 448)', actual: null, x: 48, y: 54, bounds: [16, 48, 84, 60] } },
  { no: 4, status: 'done', title: '点击登录并等待页面稳定', type: '操作', purpose: '提交登录信息并观察跳转结果。', expected: '进入首页且登录弹窗消失。', result: '页面在 1.4 秒后进入首页，未检测到异常弹窗。', check: 'CP-02', time: '09:31:42', duration: '6.4s', before: 'code', after: 'home', action: { kind: 'POINT', name: 'tap', source: 'layout', requested: '(180, 548)', dispatched: '(180, 548)', actual: '(181, 548)', x: 50, y: 67, bounds: [14, 62, 86, 72] } },
  { no: 5, status: 'done', title: '滑动检查首页内容', type: '操作', purpose: '确认首页已稳定响应交互，并检查登录后的内容区域。', expected: '页面随手势向上滚动，内容正常展示。', result: '页面滚动成功，未出现空白或异常遮挡。', check: 'CP-02', time: '09:31:55', duration: '4.3s', before: 'home', after: 'home', action: { kind: 'SWIPE', name: 'swipe', source: 'visual', requested: '(180, 650) → (180, 310)', dispatched: '(180, 650) → (180, 310)', actual: null, fromX: 50, fromY: 78, toX: 50, toY: 37 } },
  { no: 6, status: 'done', title: '验证首页用户身份', type: '检查', purpose: '确认不是仅发生页面跳转，而是已建立有效登录态。', expected: '个人中心显示测试账号昵称。', result: '个人中心入口显示昵称“测试学员08”。', check: 'CP-03', time: '09:32:40', duration: '12.8s', before: 'home', after: 'profile', action: { kind: 'POINT', name: 'tap', source: 'layout', requested: '(332, 780)', dispatched: '(332, 780)', actual: '(331, 780)', x: 88, y: 92, bounds: [76, 87, 100, 98] } },
];

const knowledgeInvestigations = {
  ios: [{
    queryId: 'knowledge-0001',
    decisionStep: 6,
    time: '09:32:52',
    sceneId: 'scene-006',
    purpose: '在形成失败结论前，确认游客状态是否属于已知的 iOS 平台差异。',
    query: 'iOS 个人中心登录后持续显示游客 是否为已知平台差异',
    expectationRefs: ['CP-03'],
    candidateCount: 2,
    truncated: false,
    filterDiagnostics: { scannedCount: 18, excludedBy: { app: 3, platform: 8 } },
    candidates: [
      { entryId: 'K-auth-017', title: 'iOS 旧版登录态刷新延迟', snapshotRef: 'knowledge/91f0a2.md', metadata: { app: 'com.codemao.app', platform: ['ios'], version: '6.18.x', page: '个人中心' }, assessment: { status: 'NOT_APPLICABLE', reason: '当前版本为 6.20.0，且等待超过 10 秒后仍显示游客，不符合适用范围。' } },
      { entryId: 'K-auth-024', title: '个人中心游客态判定规则', snapshotRef: 'knowledge/b872c1.md', metadata: { app: 'com.codemao.app', platform: ['ios'], page: '个人中心', operation: '登录后核验身份' }, assessment: { status: 'APPLICABLE', reason: '当前现场持续显示“游客”，与知识中“未建立有效登录态”的可观察条件一致。' } },
    ],
    review: { conclusion: 'APPLICABLE_FOUND' },
    knowledgeRefs: ['K-auth-024'],
    impact: '采用 K-auth-024 作为 CP-03 的业务规则依据，保持该验证点为失败，并据此形成用例失败结论。',
  }],
};

function platformKnowledge(platform) {
  return knowledgeInvestigations[platform] || [];
}

function reportHeader(platform = 'harmony') {
  const p = platforms[platform] || platforms.harmony;
  const run = cases[0].platforms[platform] || cases[0].platforms.harmony;
  const executionIds = {
    harmony: 'execution-harmony-20260902-093105',
    android: 'execution-android-20260902-093612',
    ios: 'execution-ios-20260902-094120',
  };
  return `<header class="report-head"><a class="back-button" href="#overview">${icon('arrowLeft','返回总览')}</a><div class="report-title"><span>${p.label} · 用例 001</span><h1>手机号验证码登录成功</h1><small>${executionIds[platform] || executionIds.harmony}</small></div><div class="report-result">${badge(run.verdict)}<span><b>${run.checks}</b>验证点</span><span><b>${run.duration}</b>总耗时</span></div></header>`;
}

function reportTabs(platform = 'harmony', active = 'summary') {
  const tabs = [['summary','结果概览'],['source','原始用例'],['understanding','用例理解'],['plan','执行计划'],['process','执行过程'],['logs','详细日志']];
  const logCount = 11 + platformKnowledge(platform).length * 2;
  return `<nav class="report-tabs">${tabs.map(([key,label])=>`<button class="${key===active?'active':''}" data-report-tab="${key}">${label}${key==='logs'?`<i>${logCount}</i>`:''}</button>`).join('')}</nav>`;
}

function reportSummary(platform = 'harmony') {
  const run = cases[0].platforms[platform] || cases[0].platforms.harmony;
  const failed = run.verdict === 'FAIL';
  const knowledge = platformKnowledge(platform)[0] || null;
  const checks = [
    ['CP-01','登录入口与前置状态正确','初始截图 + 控件树','PASS',[]],
    ['CP-02','提交验证码后成功进入首页','步骤 3-4 前后截图','PASS',[]],
    ['CP-03','首页显示已登录用户身份',failed ? '实际仍显示“游客”' : '步骤 6 个人中心截图',failed ? 'FAIL' : 'PASS',knowledge?.knowledgeRefs || []],
  ];
  const [covered, total] = run.checks.split('/').map(Number);
  const coverage = total ? Math.round(covered / total * 100) : 0;
  return `<section class="report-panel summary-panel" data-panel="summary"><div class="verdict-banner ${failed ? 'failed' : ''}"><div>${icon(failed ? 'alert' : 'check')}<span><b>${failed ? '执行失败' : '执行通过'}</b><small>${run.basis} · ${failed ? '2 / 3 个验证点满足' : '3 个验证点全部满足'}</small></span></div><p>${failed ? '登录提交后虽然进入首页，但个人中心仍显示游客状态，因此不能判定登录成功。' : '手机号验证码登录链路完整，首页跳转和用户身份均已确认。执行过程中未发生恢复或重试。'}</p></div><div class="metric-strip"><span><small>开始时间</small><b>${run.start.slice(-8)}</b></span><span><small>结束时间</small><b>${run.end.slice(-8)}</b></span><span><small>Agent 决策</small><b>${reportSteps.length}</b></span><span><small>设备操作</small><b>${run.actions}</b></span><span><small>现场观察</small><b>${run.actions + 1}</b></span><span><small>受控恢复</small><b>${run.recoveries}</b></span></div><div class="summary-columns"><section><h2>验证点结果</h2><div class="check-list">${checks.map(row=>`<article class="${row[3].toLowerCase()}"><span>${icon(row[3] === 'FAIL' ? 'alert' : 'check')}</span><div><b>${row[0]} · ${row[1]}</b><small>${row[2]}</small>${row[4].map(ref=>`<button type="button" class="knowledge-ref" data-jump-knowledge data-knowledge-step="5">知识依据 · ${ref}</button>`).join('')}</div><a href="#report-${platform}" data-jump-process>${icon('chevronRight')}</a></article>`).join('')}</div></section><section><h2>执行记录</h2><dl class="health-list"><div><dt>记录完整性</dt><dd class="direct"><b>完整</b><small>无叙事缺口</small></dd></div><div><dt>验证点覆盖</dt><dd><b>${run.checks}</b><span class="quality-bar"><i style="width:${coverage}%"></i></span></dd></div><div><dt>动作可追溯</dt><dd><b>${run.actions}/${run.actions}</b><span class="quality-bar"><i style="width:100%"></i></span></dd></div><div><dt>Runtime 请求错误</dt><dd class="direct"><b>0</b><small>invocationErrorCount</small></dd></div></dl></section></div></section>`;
}

function sourcePanel() {
  return `<section class="report-panel document-panel" data-panel="source" hidden><div class="document-meta"><span>原始内容</span><b>source.md</b><small>导入后未修改 · SHA-256 已校验</small></div><article class="case-document"><h2>手机号验证码登录成功</h2><h3>前置条件</h3><ul><li>App 已安装且当前为未登录状态。</li><li>测试手机号 <code>13800138000</code> 可正常接收验证码。</li><li>设备网络连接正常。</li></ul><h3>操作步骤</h3><ol><li>启动 App，进入手机号登录页面。</li><li>输入测试手机号，获取并填写验证码。</li><li>点击“登录”。</li></ol><h3>预期结果</h3><ul><li>登录页控件完整显示，登录按钮初始不可用。</li><li>验证码填写完成后，点击登录成功进入首页。</li><li>个人中心显示当前测试账号的用户昵称。</li></ul></article></section>`;
}

function understandingPanel() {
  const preconditions = ['App 已安装且当前为未登录状态。', '测试手机号可正常接收验证码。', '设备网络连接正常。'];
  const checks = [['CP-01','登录入口与前置状态正确','直接观察'],['CP-02','提交验证码后成功进入首页','直接观察'],['CP-03','首页显示已登录用户身份','直接观察']];
  return `<section class="report-panel" data-panel="understanding" hidden><div class="insight-lead"><span>理解摘要</span><p>这是一个正向验证码登录用例。关键不只是页面跳转，还要确认登录态已经建立，因此最终需通过个人中心的用户身份信息完成闭环验证。</p></div><div class="understanding-layout"><section><h2>前置条件</h2><ul class="narrative-list">${preconditions.map(item=>`<li>${item}</li>`).join('')}</ul><h2 class="subsection-title">不确定项</h2><p class="empty-data">无</p></section><section><div class="section-inline-head"><h2>验证点</h2><span>理解版本 2</span></div><div class="mapping-list">${checks.map(x=>`<article><span>${x[0]}</span><div><b>${x[1]}</b></div><small>${x[2]}</small></article>`).join('')}</div><details class="version-history"><summary>查看理解调整记录</summary><p><b>版本 1</b> 仅以进入首页作为验证点。</p><p><b>版本 2</b> 增加用户身份验证点，避免将未建立登录态的页面跳转误判为通过。</p></details></section></div></section>`;
}

function planPanel() {
  const initialPlan = ['确认手机号登录页初始状态', '输入手机号和验证码', '提交登录并确认进入首页', '根据首页状态形成结论'];
  const currentPlan = ['确认手机号登录页初始状态', '输入测试手机号', '获取并填写验证码', '提交登录并等待页面稳定', '滑动检查首页内容', '进入个人中心验证用户身份'];
  return `<section class="report-panel" data-panel="plan" hidden><div class="plan-head"><div><span>初始计划 ${initialPlan.length} 项 → 当前计划</span><h2>版本 2 · ${currentPlan.length} 项</h2></div></div><div class="plan-flow">${currentPlan.map((item,index)=>`<article><div class="plan-index">${String(index+1).padStart(2,'0')}</div><div><span>计划项</span><h3>${item}</h3></div>${index<currentPlan.length-1?'<i></i>':''}</article>`).join('')}</div><aside class="plan-adjustment"><b>计划调整</b><span>仅进入首页不足以证明登录态有效，追加首页交互检查和用户身份验证。</span><time>09:31:04 · 版本 2</time></aside><details class="initial-plan-history"><summary>查看初始计划</summary><ol>${initialPlan.map(item=>`<li>${item}</li>`).join('')}</ol></details></section>`;
}

function spatialOverlay(action) {
  if (!action) return '';
  if (action.kind === 'GESTURE' || action.kind === 'SWIPE') {
    const dx = action.toX - action.fromX;
    const dy = action.toY - action.fromY;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    return `<div class="spatial-overlay gesture" aria-hidden="true"><i class="swipe-line requested" style="--x1:${action.fromX}%;--y1:${action.fromY}%;--length:${length}%;--angle:${angle}deg"></i><i class="swipe-line dispatched" style="--x1:${action.fromX}%;--y1:${action.fromY}%;--length:${length}%;--angle:${angle}deg"></i></div>`;
  }
  return `<div class="spatial-overlay point" aria-hidden="true"><i class="target-bounds" style="left:${action.bounds[0]}%;top:${action.bounds[1]}%;width:${action.bounds[2]-action.bounds[0]}%;height:${action.bounds[3]-action.bounds[1]}%"></i><i class="marker requested" style="left:${action.x}%;top:${action.y}%"></i><i class="marker dispatched" style="left:${action.x}%;top:${action.y}%"></i>${action.actual ? `<i class="marker actual" style="left:${action.x+1.4}%;top:${action.y}%"></i>` : ''}</div>`;
}

function deviceShot(type, label, action = null) {
  const content = type === 'home' ? `<div class="mock-status">9:31 <span>5G ▰</span></div><div class="mock-home-head"><b>你好，测试学员08</b><small>继续今天的学习吧</small></div><div class="mock-banner">创作课 · 第 6 课</div><div class="mock-course-row"><i></i><i></i></div><div class="mock-nav"><b>首页</b><span>发现</span><span>创作</span><span>我的</span></div>` : ['profile','profile-fail'].includes(type) ? `<div class="mock-status">9:32 <span>5G ▰</span></div><div class="mock-profile ${type==='profile-fail'?'guest':''}"><i>${type==='profile-fail'?'游':'测'}</i><b>${type==='profile-fail'?'游客':'测试学员08'}</b><small>${type==='profile-fail'?'登录后同步个人数据':'ID 13800138000'}</small></div><div class="mock-menu"><span>我的作品 <b>${type==='profile-fail'?'0':'12'}</b></span><span>学习记录 <b>${type==='profile-fail'?'0':'38'}</b></span><span>账号与安全 <b>›</b></span></div><div class="mock-nav"><span>首页</span><span>发现</span><span>创作</span><b>我的</b></div>` : `<div class="mock-status">9:31 <span>5G ▰</span></div><div class="mock-logo">M</div><h4>手机号登录</h4><label>手机号<div>${type==='login'?'请输入手机号':'138 0013 8000'}</div></label><label>验证码<div>${type==='code'?'246810':'请输入验证码'}<b>获取验证码</b></div></label><div class="mock-login-button ${type==='code'?'ready':''}">登录</div><p>登录即表示同意《用户协议》和《隐私政策》</p>`;
  return `<div class="device-shot" role="button" tabindex="0" aria-label="查看${label}" data-view-shot data-shot-label="${label}" data-has-overlay="${action ? 'true' : 'false'}" data-overlay-kind="${action && action.kind !== 'POINT' ? 'gesture' : 'point'}" title="查看${label}"><span class="device-frame ${type}">${content}${spatialOverlay(action)}</span><span class="shot-caption">${label}</span><span class="shot-magnify">${icon('zoomIn')}</span></div>`;
}

function spatialEvidence(step) {
  if (!step.action) return '';
  return `<section class="spatial-data"><header><div><span>动作空间证据</span><b>${step.action.name}</b></div><em>${step.action.kind === 'POINT' ? '点操作' : '滑动手势'}</em></header><dl><div><dt>定位来源</dt><dd>${step.action.source === 'layout' ? '控件树定位' : '视觉定位'}</dd></div><div><dt>请求坐标</dt><dd>${step.action.requested}</dd></div><div><dt>命令投递坐标</dt><dd>${step.action.dispatched}</dd></div><div><dt>设备实际触点</dt><dd>${step.action.actual || '平台未提供真实触点'}</dd></div></dl></section>`;
}

function shotViewer() {
  return `<dialog class="shot-viewer" id="shot-viewer" aria-label="截图查看器"><header><div><span id="viewer-kicker">执行证据</span><b id="viewer-title">截图</b></div><div class="viewer-controls"><button type="button" data-viewer-action="out" title="缩小" aria-label="缩小">${icon('zoomOut')}</button><output id="viewer-scale">100%</output><button type="button" data-viewer-action="in" title="放大" aria-label="放大">${icon('zoomIn')}</button><button type="button" data-viewer-action="fit" title="适应窗口" aria-label="适应窗口">${icon('maximize')}</button><button type="button" data-viewer-action="close" title="关闭" aria-label="关闭">${icon('close')}</button></div></header><div class="viewer-stage" id="viewer-stage"><div class="viewer-canvas" id="viewer-canvas"></div></div><footer><button type="button" data-viewer-action="prev" title="上一张" aria-label="上一张">${icon('arrowLeft')}</button><div class="viewer-legend" id="viewer-legend"><span class="point-legend legend-requested"><i></i>请求位置</span><span class="point-legend legend-dispatched"><i></i>命令投递</span><span class="point-legend legend-actual"><i></i>设备触点</span><span class="gesture-legend legend-requested"><i></i>请求轨迹</span><span class="gesture-legend legend-dispatched"><i></i>投递轨迹</span></div><span id="viewer-count">1 / 1</span><button type="button" data-viewer-action="next" title="下一张" aria-label="下一张">${icon('chevronRight')}</button></footer></dialog>`;
}

function knowledgeStatusLabel(status) {
  return ({ APPLICABLE: '适用', NOT_APPLICABLE: '不适用', CONFLICTING: '存在冲突', INSUFFICIENT: '依据不足' })[status] || status;
}

function knowledgeReviewLabel(conclusion) {
  return ({ APPLICABLE_FOUND: '已找到适用知识', NO_APPLICABLE: '无适用知识', NO_MATCH: '无匹配候选', CONFLICTING: '候选存在冲突', INSUFFICIENT: '知识依据不足' })[conclusion] || conclusion;
}

function renderKnowledgeInvestigation(investigation) {
  if (!investigation) return '';
  const excluded = Object.entries(investigation.filterDiagnostics?.excludedBy || {}).map(([field,count])=>`${field} ${count} 条`).join(' · ');
  return `<section class="knowledge-investigation" data-knowledge-investigation><header><div><span>知识调查 · ${investigation.time}</span><h3>${knowledgeReviewLabel(investigation.review.conclusion)}</h3></div><b>${investigation.candidateCount} 个候选</b></header><div class="knowledge-query-grid"><div><small>查询目的</small><p>${investigation.purpose}</p></div><div><small>查询内容</small><code>${investigation.query}</code></div><div><small>关联验证点</small><p>${investigation.expectationRefs.join(' · ')}</p></div><div><small>查询标识</small><code>${investigation.queryId} · ${investigation.sceneId}</code></div></div><div class="knowledge-candidates"><div class="knowledge-section-head"><b>候选知识</b><small>扫描 ${investigation.filterDiagnostics?.scannedCount || 0} 条${excluded ? ` · 排除 ${excluded}` : ''}${investigation.truncated ? ' · 结果已截断' : ''}</small></div>${investigation.candidates.map(candidate=>{const scope=[candidate.metadata.app,(candidate.metadata.platform||[]).join('/'),candidate.metadata.version,candidate.metadata.page,candidate.metadata.operation].filter(Boolean).join(' · ');return `<article class="${candidate.assessment.status === 'APPLICABLE' ? 'applicable' : ''}"><header><div><small>${candidate.entryId}</small><b>${candidate.title}</b></div><em>${knowledgeStatusLabel(candidate.assessment.status)}</em></header><span>${scope}</span><p><b>适用性判断</b>${candidate.assessment.reason}</p><code>${candidate.snapshotRef}</code></article>`;}).join('')}</div><div class="knowledge-impact"><small>对执行的影响</small><p>${investigation.impact}</p><span>最终检查通过 <b>knowledgeRefs</b> 引用 ${investigation.knowledgeRefs.join(' · ')}</span></div></section>`;
}

function processKnowledgeStatus(platform) {
  const investigations = platformKnowledge(platform);
  if (!investigations.length) return `<div class="knowledge-process-status empty" data-knowledge-empty><span>${icon('search')}</span><div><b>本次执行未触发知识库查询</b><small>现场直接证据足以形成结论，无需外部业务规则。</small></div></div>`;
  const item = investigations[0];
  return `<button type="button" class="knowledge-process-status" data-knowledge-step="${item.decisionStep - 1}"><span>${icon('search')}</span><div><b>${investigations.length} 次知识调查 · ${knowledgeReviewLabel(item.review.conclusion)}</b><small>${item.expectationRefs.join(' · ')} 引用 ${item.knowledgeRefs.join(' · ')}，点击查看查询与复核过程</small></div>${icon('chevronRight')}</button>`;
}

function processPanel(platform = 'harmony') {
  return `<section class="report-panel process-panel" data-panel="process" hidden><div class="process-toolbar"><div><b>执行过程</b><span>选择步骤查看当时的意图、现场和结论</span></div><div class="legend"><span><i class="done"></i>完成</span><span><i class="issue"></i>异常</span><span><i class="evidence"></i>有证据</span></div></div>${processKnowledgeStatus(platform)}<div class="process-layout"><div class="step-list">${reportSteps.map((step,index)=>{const failed = platform === 'ios' && index === 5; const hasKnowledge = platformKnowledge(platform).some(item=>item.decisionStep===step.no); return `<button class="step-row ${index===0?'active':''} ${failed?'failed':''} ${hasKnowledge?'has-knowledge':''}" data-step="${index}"><span class="step-number">${step.no}</span><span class="step-state">${icon(failed?'alert':'check')}</span><span class="step-copy"><small>${step.type} · ${step.time} · ${step.duration}</small><b>${step.title}</b><em>${step.check}${hasKnowledge?' · 知识 1':''}</em></span><span class="step-arrow">${icon('chevronRight')}</span></button>`;}).join('')}</div><aside class="step-inspector" id="step-inspector"></aside></div></section>`;
}

function logsPanel(platform = 'harmony') {
  const knowledge = platformKnowledge(platform)[0] || null;
  const run = cases[0].platforms[platform] || cases[0].platforms.harmony;
  const lines = [
    { time:'09:31:05.118', type:'INFO', category:'SYSTEM', source:'execution', message:`Execution started on ${platform}`, generation:'1', app:'com.codemao.app' },
    { time:'09:31:08.306', type:'OBS', category:'OBSERVATION', source:'scene', message:'Captured scene-001 · usable=true · login page', generation:'1', app:'com.codemao.app', layout:'layouts/scene-001.json' },
    { time:'09:31:16.420', type:'ACT', category:'ACTION', source:'input', message:'input_text target=phone mode=replace · SUCCEEDED', operationId:'action-002', generation:'1', app:'com.codemao.app', layout:'layouts/scene-001.json' },
    { time:'09:31:28.022', type:'ACT', category:'ACTION', source:'input', message:'input_text target=verification_code · SUCCEEDED', operationId:'action-003', generation:'1', app:'com.codemao.app', layout:'layouts/scene-002.json' },
    { time:'09:31:34.090', type:'OBS', category:'OBSERVATION', source:'scene', message:'Captured scene-003 · login button enabled', generation:'1', app:'com.codemao.app', layout:'layouts/scene-003.json' },
    { time:'09:31:42.604', type:'ACT', category:'ACTION', source:'tap', message:'tap target=登录 · coordinateSource=layout', operationId:'action-004', generation:'1', app:'com.codemao.app', layout:'layouts/scene-003.json' },
    { time:'09:31:44.018', type:'INFO', category:'SYSTEM', source:'settle', message:'Foreground stable after 1414ms', operationId:'action-004', generation:'1', app:'com.codemao.app' },
    { time:'09:31:47.281', type:'OBS', category:'OBSERVATION', source:'scene', message:'Captured scene-004 · home page', operationId:'observation-004', generation:'1', app:'com.codemao.app', layout:'layouts/scene-004.json' },
    { time:'09:32:40.106', type:'ACT', category:'ACTION', source:'tap', message:'tap target=我的 · coordinateSource=layout', operationId:'action-006', generation:'1', app:'com.codemao.app', layout:'layouts/scene-005.json' },
    { time:'09:32:52.204', type:'OBS', category:'OBSERVATION', source:'check', message: platform === 'ios' ? 'CP-03 observed text=游客 · expected=测试学员08' : 'CP-03 matched text=测试学员08', operationId:'observation-006', generation:'1', app:'com.codemao.app', layout:'layouts/scene-006.json' },
    ...(knowledge ? [
      { time:'09:32:52.410', type:'KNW', category:'KNOWLEDGE', source:'knowledge', message:`knowledgeQueried · ${knowledge.query} · candidates=${knowledge.candidateCount}`, queryId:knowledge.queryId, sceneId:knowledge.sceneId, generation:'1', app:'com.codemao.app' },
      { time:'09:32:52.720', type:'KNW', category:'KNOWLEDGE', source:'knowledge', message:`knowledgeReviewed · conclusion=${knowledge.review.conclusion} · refs=${knowledge.knowledgeRefs.join(',')}`, queryId:knowledge.queryId, sceneId:knowledge.sceneId, generation:'1', app:'com.codemao.app' },
    ] : []),
    { time:'09:32:53.005', type:'INFO', category:'SYSTEM', source:'result', message:`Execution finalized · verdict=${run.verdict} · basis=${run.basis}`, generation:'1', app:'com.codemao.app' },
  ];
  const counts = category => lines.filter(item => item.category === category).length;
  return `<section class="report-panel logs-panel" data-panel="logs" hidden><div class="logs-toolbar"><div class="segmented" aria-label="日志分类"><button class="active" data-log-filter="ALL">全部 ${lines.length}</button><button data-log-filter="ACTION">操作 ${counts('ACTION')}</button><button data-log-filter="OBSERVATION">观察 ${counts('OBSERVATION')}</button><button data-log-filter="KNOWLEDGE">知识 ${counts('KNOWLEDGE')}</button><button data-log-filter="SYSTEM">系统 ${counts('SYSTEM')}</button></div><label class="search-box">${icon('search')}<input data-log-search placeholder="筛选日志内容"></label><span class="log-visible">显示 <b data-log-visible>${lines.length}</b> / ${lines.length}</span><button class="secondary-button" data-export-logs>导出日志</button></div><div class="log-view"><div class="log-lines">${lines.map((item,i)=>`<button class="log-line ${i===0?'active':''}" data-log-category="${item.category}" data-log-text="${`${item.time} ${item.type} ${item.source} ${item.message}`.toLowerCase()}" data-operation-id="${item.operationId||'-'}" data-query-id="${item.queryId||'-'}" data-scene-id="${item.sceneId||'-'}" data-generation="${item.generation||'-'}" data-app="${item.app||'-'}" data-layout="${item.layout||'-'}"><span>${String(i+1).padStart(2,'0')}</span><time>${item.time}</time><em class="log-${item.type.toLowerCase()}">${item.type}</em><b>${item.source}</b><code>${item.message}</code></button>`).join('')}<p class="log-empty" hidden>没有符合条件的日志。</p></div><aside data-log-context><span>日志上下文</span><b data-context-title>${lines[0].source}</b><dl><div><dt>operationId</dt><dd data-context-field="operationId">-</dd></div><div><dt>queryId</dt><dd data-context-field="queryId">-</dd></div><div><dt>sceneId</dt><dd data-context-field="sceneId">-</dd></div><div><dt>generation</dt><dd data-context-field="generation">1</dd></div><div><dt>App</dt><dd data-context-field="app">com.codemao.app</dd></div><div><dt>layout</dt><dd data-context-field="layout">-</dd></div></dl></aside></div></section>`;
}

function reportPage(platform = 'harmony') {
  return shell(`<div class="report-page" data-platform="${platform}">${reportHeader(platform)}${reportTabs(platform)}<div class="report-content">${reportSummary(platform)}${sourcePanel()}${understandingPanel()}${planPanel()}${processPanel(platform)}${logsPanel(platform)}</div>${shotViewer()}</div>`);
}

function caseContentPage() {
  return shell(`<div class="case-content-page"><header><a class="back-button" href="#overview">${icon('arrowLeft','返回总览')}</a><div><span>用例 001 · 用例内容</span><h1>手机号验证码登录成功</h1></div></header><div class="case-only-meta"><span><small>用例编号</small><b>001</b></span><span><small>caseKey</small><b>ck-a14f09c3e672</b></span><span><small>sourceSha</small><b>4c920f4d…fb31</b></span><span><small>导入来源</small><b>cases/source.md</b></span></div><article class="case-document full"><h2>用例说明</h2><p>验证用户使用有效手机号和验证码可以成功登录，并且登录后能够识别到正确的用户身份。</p><h2>前置条件</h2><ul><li>App 已安装且当前为未登录状态。</li><li>测试手机号 <code>13800138000</code> 可正常接收验证码。</li><li>设备网络连接正常。</li></ul><h2>操作步骤</h2><ol><li><b>启动 App</b><p>进入手机号登录页面。</p></li><li><b>输入登录信息</b><p>输入测试手机号，获取并填写验证码。</p></li><li><b>提交登录</b><p>点击“登录”，等待页面跳转完成。</p></li><li><b>确认用户身份</b><p>进入个人中心，查看当前账号昵称。</p></li></ol><h2>预期结果</h2><ul class="expected-list"><li>登录页控件完整显示，登录按钮初始不可用。</li><li>验证码填写完成后，点击登录成功进入首页。</li><li>个人中心显示当前测试账号昵称“测试学员08”。</li></ul></article></div>`);
}

function renderStep(index) {
  const step = reportSteps[index];
  const panel = document.querySelector('#step-inspector');
  if (!panel || !step) return;
  const failed = activeReportPlatform === 'ios' && index === 5;
  const knowledge = platformKnowledge(activeReportPlatform).find(item=>item.decisionStep===step.no) || null;
  const actual = failed ? '个人中心仍显示“游客”，未观察到测试账号昵称。' : step.result;
  panel.innerHTML = `<div class="inspector-head"><div><span>步骤 ${step.no} · ${step.type}</span><h2>${step.title}</h2></div>${badge(failed ? 'FAIL' : 'PASS')}</div><dl class="step-reasoning"><div><dt>为什么做</dt><dd>${step.purpose}</dd></div><div><dt>预期效果</dt><dd>${step.expected}</dd></div><div><dt>实际效果</dt><dd>${actual}</dd></div></dl>${renderKnowledgeInvestigation(knowledge)}${spatialEvidence(step)}<div class="shot-compare ${step.action ? 'has-spatial' : ''}">${deviceShot(step.before,'操作前')}${step.action ? deviceShot(step.before,'动作落点',step.action) : ''}${deviceShot(failed ? 'profile-fail' : step.after,'操作后')}</div><div class="evidence-row"><span><small>关联验证点</small><b>${step.check}</b></span><span><small>操作记录</small><b>op-${String(step.no).padStart(3,'0')}</b></span><span><small>证据状态</small><b>可用${knowledge ? ' · 含知识引用' : ''}</b></span></div><button class="log-jump" data-log-tab>${icon('logs','查看该步骤详细日志')}</button>`;
}

function initShotViewer() {
  const root = document.querySelector('.report-page');
  const dialog = document.querySelector('#shot-viewer');
  const stage = document.querySelector('#viewer-stage');
  const canvas = document.querySelector('#viewer-canvas');
  const scaleOutput = document.querySelector('#viewer-scale');
  let current = 0;
  let scale = 1;
  let dragging = false;
  let origin = null;
  const baseWidth = 190;
  const baseHeight = baseWidth * 16 / 9;

  function shots() { return [...document.querySelectorAll('[data-view-shot]')]; }
  function applyScale(next, center = true) {
    scale = Math.max(.45, Math.min(4, next));
    const width = baseWidth * scale;
    const height = baseHeight * scale;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.setProperty('--viewer-scale', String(scale));
    scaleOutput.value = `${Math.round(scale * 100)}%`;
    scaleOutput.textContent = `${Math.round(scale * 100)}%`;
    if (center) requestAnimationFrame(() => {
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
      stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
    });
  }
  function fit() {
    const availableWidth = Math.max(240, stage.clientWidth - 48);
    const availableHeight = Math.max(380, stage.clientHeight - 48);
    applyScale(Math.min(2.4, availableWidth / baseWidth, availableHeight / baseHeight));
  }
  function openShot(index) {
    const items = shots();
    if (!items.length) return;
    current = (index + items.length) % items.length;
    const source = items[current];
    const frame = source.querySelector('.device-frame').cloneNode(true);
    frame.classList.add('viewer-device-frame');
    canvas.replaceChildren(frame);
    document.querySelector('#viewer-title').textContent = source.dataset.shotLabel || '执行截图';
    document.querySelector('#viewer-count').textContent = `${current + 1} / ${items.length}`;
    document.querySelector('#viewer-kicker').textContent = source.dataset.hasOverlay === 'true' ? '动作空间证据' : '执行证据';
    const viewerLegend = document.querySelector('#viewer-legend');
    viewerLegend.hidden = source.dataset.hasOverlay !== 'true';
    viewerLegend.dataset.kind = source.dataset.overlayKind || 'point';
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(fit);
  }

  root.addEventListener('click', event => {
    const shot = event.target.closest('[data-view-shot]');
    if (shot) openShot(shots().indexOf(shot));
    const action = event.target.closest('[data-viewer-action]')?.dataset.viewerAction;
    if (!action) return;
    if (action === 'close') dialog.close();
    if (action === 'in') applyScale(scale + .25);
    if (action === 'out') applyScale(scale - .25);
    if (action === 'fit') fit();
    if (action === 'prev') openShot(current - 1);
    if (action === 'next') openShot(current + 1);
  });
  root.addEventListener('keydown', event => {
    const shot = event.target.closest('[data-view-shot]');
    if (shot && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openShot(shots().indexOf(shot));
    }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  stage.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    applyScale(scale + (event.deltaY < 0 ? .15 : -.15), false);
  }, { passive: false });
  stage.addEventListener('pointerdown', event => {
    dragging = true;
    origin = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging) return;
    stage.scrollLeft = origin.left - (event.clientX - origin.x);
    stage.scrollTop = origin.top - (event.clientY - origin.y);
  });
  const stopDragging = () => { dragging = false; origin = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', stopDragging);
  stage.addEventListener('pointercancel', stopDragging);
  stage.addEventListener('lostpointercapture', stopDragging);
}

function initFilters() {
  const buttons = [...document.querySelectorAll('.filter-btn')];
  const input = document.querySelector('.list-toolbar input[type="search"]');
  let selected = 'ALL';
  function apply() {
    const query = (input?.value || '').trim().toLowerCase();
    const items = [...document.querySelectorAll('.case-row, .lane-case, .focus-case')];
    let visible = 0;
    items.forEach(item => {
      const statusMatch = selected === 'ALL' || (item.dataset.status || '').split(' ').includes(selected);
      const searchMatch = !query || (item.dataset.search || '').includes(query);
      item.hidden = !(statusMatch && searchMatch);
      if (!item.hidden) visible += 1;
    });
    buttons.forEach(button => button.classList.toggle('active', button.dataset.filter === selected));
    const count = document.querySelector('.visible-count');
    if (count) count.textContent = `${visible} / ${items.length}`;
    const empty = document.querySelector('.empty-result');
    if (empty) empty.hidden = visible !== 0;
  }
  buttons.forEach(button => button.addEventListener('click', () => { selected = button.dataset.filter; apply(); }));
  input?.addEventListener('input', apply);
  apply();
}

function initLogs(root) {
  const buttons = [...root.querySelectorAll('[data-log-filter]')];
  const input = root.querySelector('[data-log-search]');
  const lines = [...root.querySelectorAll('.log-line')];
  const visibleOutput = root.querySelector('[data-log-visible]');
  const empty = root.querySelector('.log-empty');
  let selected = 'ALL';

  function apply() {
    const query = (input?.value || '').trim().toLowerCase();
    let visible = 0;
    lines.forEach(line => {
      const categoryMatch = selected === 'ALL' || line.dataset.logCategory === selected;
      const searchMatch = !query || line.dataset.logText.includes(query);
      line.hidden = !(categoryMatch && searchMatch);
      if (!line.hidden) visible += 1;
    });
    buttons.forEach(button => button.classList.toggle('active', button.dataset.logFilter === selected));
    if (visibleOutput) visibleOutput.textContent = visible;
    if (empty) empty.hidden = visible !== 0;
  }

  function showContext(line) {
    lines.forEach(item => item.classList.toggle('active', item === line));
    root.querySelector('[data-context-title]').textContent = line.querySelector('b').textContent;
    for (const field of ['operationId', 'queryId', 'sceneId', 'generation', 'app', 'layout']) {
      root.querySelector(`[data-context-field="${field}"]`).textContent = line.dataset[field] || '-';
    }
  }

  buttons.forEach(button => button.addEventListener('click', () => { selected = button.dataset.logFilter; apply(); }));
  input?.addEventListener('input', apply);
  lines.forEach(line => line.addEventListener('click', () => showContext(line)));
  root.querySelector('[data-export-logs]')?.addEventListener('click', () => {
    const content = lines.map(line => [...line.querySelectorAll('time, em, b, code')].map(item => item.textContent).join('\t')).join('\n');
    const href = URL.createObjectURL(new Blob([`${content}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `execution-${root.dataset.platform || 'report'}.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  });
  apply();
}

function initReport() {
  const root = document.querySelector('.report-page');
  const tabs = [...document.querySelectorAll('[data-report-tab]')];
  function selectStep(index) {
    document.querySelectorAll('[data-step]').forEach(item=>item.classList.toggle('active',Number(item.dataset.step)===index));
    renderStep(index);
  }
  function activate(key, stepIndex = 0) {
    tabs.forEach(tab=>tab.classList.toggle('active',tab.dataset.reportTab===key));
    document.querySelectorAll('[data-panel]').forEach(panel=>panel.hidden=panel.dataset.panel!==key);
    if(key==='process') selectStep(stepIndex);
  }
  tabs.forEach(tab=>tab.addEventListener('click',()=>activate(tab.dataset.reportTab)));
  initShotViewer();
  initLogs(root);
  root.addEventListener('click',event=>{
    const stepButton = event.target.closest('[data-step]');
    if(stepButton) selectStep(Number(stepButton.dataset.step));
    if(event.target.closest('[data-log-tab]')) activate('logs');
    const knowledgeJump = event.target.closest('[data-knowledge-step], [data-jump-knowledge]');
    if(knowledgeJump) activate('process', Number(knowledgeJump.dataset.knowledgeStep || 0));
    else if(event.target.closest('[data-jump-process]')) activate('process');
  });
}

function initPage(route) {
  if (route === 'overview') initFilters();
  if (route.startsWith('report-')) initReport();
}

function route() {
  const current = (location.hash || '#overview').slice(1);
  if (current === 'case-content') app.innerHTML = caseContentPage();
  else if (current.startsWith('report-') && platforms[current.slice(7)]) {
    activeReportPlatform = current.slice(7);
    app.innerHTML = reportPage(activeReportPlatform);
  } else app.innerHTML = overviewA();
  window.scrollTo(0, 0);
  initPage(current === 'case-content' || current.startsWith('report-') ? current : 'overview');
}

window.addEventListener('hashchange', route);
route();

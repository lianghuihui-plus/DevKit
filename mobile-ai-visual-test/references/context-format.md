# 上下文与结果

## CONTEXT.md / CONTEXT.html

人读报告，保持最新、简洁、可复盘；Markdown 便于 diff，HTML 展示截图和表格。

## index.html

`index.html` 是工作空间外层总览，展示全部用例的多平台聚合摘要并链接到 case 详情和各平台的 `CONTEXT.html`。

报告体系必须覆盖：

- 用例短编号 `caseNo`。
- 当前状态和最近一次结论。
- 源文件和源文件变更摘要。
- 已确认环境。
- 平台前置依赖状态。
- 步骤进度。
- 失败现场和证据路径。
- 执行统计摘要。
- 用户补充和失效补充。
- 用户下次执行前需要调整的内容。

其中 `index.html` 只承载工作空间总览、平台维度统计、case 卡片摘要和报告入口；完整步骤复盘、失败现场、截图证据和用户下次调整内容放在 `cases/<case>/CONTEXT.html` 或 `cases/<case>/platforms/<platform>/CONTEXT.html`。

多平台 case 的总览卡片状态是聚合状态，不是 case 的真实单一结果；聚合规则按 `FAIL > BLOCKED > UNKNOWN > NOT_RUN > PASS`，只有所有已展示平台都通过时才显示通过。正式执行中，断言证据不足会在内部归一为 `FAIL/ASSERTION_UNKNOWN`，`UNKNOWN` 只作为历史兼容或异常状态参与聚合。具体结论以平台标签和对应 `platforms/<platform>/CONTEXT.html` 为准。

当最新执行结果与当前 `sourceSha1` 或 `caseContractSha` 不匹配时，报告隐藏旧结果并显示“源用例或执行契约变更”；如果已经基于当前 source 和 contract 重新执行出新结果，不再显示变更警告。`caseContractSha` 至少覆盖 `sourceSha1`、`preconditions`、`globalRules` 和用户补充重放产生的步骤 hints。

HTML 跳转链路：

```text
index.html
  -> cases/<case>/CONTEXT.html
       -> platforms/<platform>/CONTEXT.html
```

- `index.html`：展示工作空间总览、用例维度统计、平台维度统计、每个 case 的前置条件判断标签和多端结果摘要；case 标题和“查看多端详情”进入 `cases/<case>/CONTEXT.html`，平台 chip 的“查看报告”直达对应单平台报告。
- `cases/<case>/CONTEXT.html`：展示单 case 的平台执行概览、共享前置条件、共享步骤、全局规则和用户补充；平台展示顺序统一为 Android、iOS、Harmony；平台概览固定按一个平台一行展示，适配三端；平台卡片只保留状态、中文执行结果、摘要、步骤、耗时、开始/结束时间和报告入口，不展示完整截图证据和完整 timeline；全局规则和用户补充上下独立展示，不并排。
- `cases/<case>/platforms/<platform>/CONTEXT.html`：展示单平台最新执行详情，包括执行结论、失败证据、步骤复盘、Flow、规则、环境和调试信息；截图证据优先按 observation 的 `stepId` 融入对应步骤卡；无 `stepId` 的观察必须显式标记 `scope=global`，作为平台诊断、环境快照或 Flow 辅助观察展示为未关联观察；截图在报告页内用 lightbox 预览，控件树和日志只提供原文件链接，不在 HTML 内嵌预览。

## result.json

每次执行写一个 `result.json`：

```json
{
  "schemaVersion": 1,
  "executionId": "20260616-180230",
  "caseKey": "ck-xxxxxxxxxxxx",
  "sourceSha1": "source-xxxxxxxxxxxx",
  "caseContractSha": "contract-xxxxxxxxxxxx",
  "status": "FAIL",
  "requestedStatus": "PASS",
  "failureCode": "ASSERTION_UNKNOWN",
  "startedAt": "2026-06-16T18:02:00+08:00",
  "endedAt": "2026-06-16T18:02:40+08:00",
  "failedStep": "step-006",
  "reason": "无法确认验证码输入框焦点"
}
```

时间字段语义：

- `startedAt`：当前 case execution 创建并开始执行的时间。
- `endedAt`：当前 case 完成断言并调用 finalize 的时间。
- `endedAt` 不应晚于当前 case 操作链路结束太久；批量执行时不能等其他 case 全部执行完成后再统一写入。
- 报告“更新时间”使用 `endedAt`，表示该 case 本次执行结论生成时间，不表示批量任务整体收尾时间。

## metrics.json

每次执行都写 `metrics.json`，即使环境或前置条件阶段失败。

稳定字段：

- status 和 failureCode
- requestedStatus，即 agent 调用 finalize 时请求的原始状态
- sourceSha1 和 caseContractSha
- durationMs
- environment
- precondition counts
- step counts
- action counts
- flow event counts
- flow scan counts
- rule event counts
- app foreground loss / relaunch attempt and success counts
- restart failure count and isolation status (`isolationClean` / `isolationCompromised` / `isolationRequired` / `isolationReason`)
- popup counts
- artifact counts

`durationMs` 固定按当前 case 的 `endedAt - startedAt` 计算。批量执行必须逐用例 finalize，避免把等待其他 case 执行、统一截图判定或批量报告刷新时间计入单个 case 耗时。

## state.json

`state.json` 保存最新状态、平台前置依赖和轻量累计统计。它不是续跑指针。正式多平台执行时，状态写入 `cases/<case>/platforms/<platform>/state.json`；根目录 `state.json` 只用于兼容旧产物。

## timeline.jsonl

`timeline.jsonl` 是执行事实源，记录模块接口产生的关键事实：

- `environmentProbe`
- `observation`
- `perception`
- `decision`
- `rule`
- `flowScan`
- `flow`
- `actionResult`
- `assertion`
- `result`

报告、结果和统计都从事实源和当前用例契约渲染，不作为续跑入口。

`execution.json` 记录预算、开始时间和 finalized 状态；finalized 后不得追加 timeline。
步骤事实写入前，当前 execution 必须已有每条 `case.json.preconditions` 的 `precondition` 事实。`PASS` 和 `PREPARED` 表示允许进入步骤；缺失会被 `PRECONDITION_REQUIRED` 拒绝且不会写入 timeline，非通过状态会按 `PRECONDITION_FAILED`、`PRECONDITION_UNKNOWN` 或 `PRECONDITION_UNSUPPORTED` 写入结果并 finalize，可短路剩余前置条件。
任何带 `stepId` 的步骤事实写入前，当前 execution 必须已有 execution 级全局可用 `flowScan` 事实；公开事实写入缺失或扫描 `status=FAILED` 时会被 `FLOW_SCAN_REQUIRED` 拒绝且不会写入 timeline；顶层 `scripts/action.sh` 发起的动作会写入失败 `actionResult`、结果和统计后收尾。
无 `stepId` 的 `observation` 必须显式带 `scope=global` 或 `global=true`；疑似步骤观察的 label 不能替代 `stepId`。
步骤事实必须按 `case.json.steps` 的顺序写入。带 `stepId` 的事实不能跳过前置步骤，不能在进入后续步骤后回头补写前置步骤；前一步没有通过证据时，后一步事实会被 `STEP_ORDER_VIOLATION` 拒绝且不会写入 timeline。
步骤通过证据以当前 execution 的事实为准：普通操作步骤需要真实业务动作 `tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back` 的 `actionResult ok=true` 且其后有同一步骤的 observation，或 `assertion PASS`；`assertion PASS` 必须通过 `evidence` 或 `evidenceObservation` 引用当前步骤已有且由 `scripts/observe.sh` 写入的 observation 截图、布局或 label，缺失时以 `ASSERTION_EVIDENCE_REQUIRED` 拒绝写入。断言型步骤必须有带 observation 证据引用的 `assertion PASS`。`launchApp`、`restartApp`、`wait`、`observation`、`perception`、`flowScan` 和 `flow` 是辅助证据，不单独让步骤通过。
正式观察和动作结果必须分别由顶层 `scripts/observe.sh`、`scripts/action.sh` 自动写入；`run-case.js --record-json` 只用于写 agent 事实，直接手写 `observation` 会被 `OBSERVATION_SOURCE_REQUIRED` 拒绝，直接手写 `actionResult` 会被 `ACTION_RESULT_SOURCE_REQUIRED` 拒绝。
请求 `--finalize --status PASS` 时，如果任一步骤缺少通过证据，框架会把本次结果写为 `FAIL/ASSERTION_UNKNOWN` 并 finalize，`requestedStatus` 保留原始请求，避免各报告产物对“证据不足”产生不同解释。
用例开始时的 `restartApp` 失败、不可验证或缺少 `coldStartVerified=true` 会进入当前 execution 事实源；冷启动敏感用例自动写为 `BLOCKED/CASE_RESTART_FAILED`，普通用例可以继续，但 `metrics.stability.isolationCompromised=true`，平台报告必须展示非干净环境警告。`metrics.stability.appRelaunchAttemptCount` 表示拉起尝试次数，`appRelaunchSuccessCount` 表示成功拉起次数，兼容字段 `appRelaunchCount` 按成功次数写入。

正式多平台执行的事件写入入口：

```bash
scripts/run-case.js <case-dir> --platform <platform> --start
scripts/observe.sh --case-dir <case-dir> --platform <platform> --execution-id <id> --step-id <step-id> --label "<label>"
scripts/run-case.js <case-dir> --platform <platform> --record-json '{"type":"assertion", "...":"..."}'
scripts/run-case.js <case-dir> --platform <platform> --finalize --status FAIL --reason "..."
```

正式平台执行的 `--finalize` 只能收尾已由 `--start` 创建的 execution；不能用 `--finalize` 直接隐式创建新 execution。无平台根运行态的历史兼容收尾必须显式使用 `--legacy-runtime`。

## 历史兼容

无平台根运行态只用于兼容旧产物，新执行必须显式传 `--platform`，正式执行不得使用 `--legacy-runtime`。需要人工迁移或收尾历史根运行态时才显式传 `--legacy-runtime`：

```bash
scripts/run-case.js <case-dir> --legacy-runtime --start
scripts/run-case.js <case-dir> --legacy-runtime --record-json '{"type":"decision", "...":"..."}'
scripts/run-case.js <case-dir> --legacy-runtime --finalize --status FAIL --reason "..."
```

兼容旧收尾方式仅用于人工排障旧产物：

```bash
scripts/run-case.js <case-dir> --legacy-runtime --status FAIL --reason "..."
```

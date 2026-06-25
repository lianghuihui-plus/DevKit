# 上下文与结果

## CONTEXT.md / CONTEXT.html

人读报告，保持最新、简洁、可复盘；Markdown 便于 diff，HTML 展示截图和表格。

## index.html

`ai-visual-test/index.html` 是外层总览，展示全部用例状态并链接到各自 `CONTEXT.html`。

必须包含：

- 用例短编号 `caseNo`。
- 当前状态和最近一次结论。
- 源文件和源文件变更摘要。
- 已确认环境。
- 步骤进度。
- 失败现场和证据路径。
- 执行统计摘要。
- 用户补充和失效补充。
- 用户下次执行前需要调整的内容。

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
- sourceSha1 和 caseContractSha
- durationMs
- environment
- precondition counts
- step counts
- action counts
- flow event counts
- flow scan counts
- rule event counts
- app foreground loss / relaunch counts
- popup counts
- artifact counts

`durationMs` 固定按当前 case 的 `endedAt - startedAt` 计算。批量执行必须逐用例 finalize，避免把等待其他 case 执行、统一截图判定或批量报告刷新时间计入单个 case 耗时。

## state.json

`state.json` 保存最新状态和轻量累计统计。它不是续跑指针。

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

事件写入入口：

```bash
scripts/run-case.js <case-dir> --start
scripts/run-case.js <case-dir> --record-json '{"type":"observation", "...":"..."}'
scripts/run-case.js <case-dir> --finalize --status FAIL --reason "..."
```

兼容旧收尾方式：

```bash
scripts/run-case.js <case-dir> --status FAIL --reason "..."
```

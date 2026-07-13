# 上下文与结果

> 负责：`timeline`、`execution`、`result`、`metrics`、`CONTEXT`、`index` 的产物语义。
> 不负责：执行阶段、证据规则、动作参数、failureCode 解释。
> 参见：`workflow.md`、`interfaces.md`、`failure-policy.md`。

## 报告链路

```text
index.html
  -> cases/<case>/CONTEXT.html
       -> cases/<case>/platforms/<platform>/CONTEXT.html
```

| 文件 | 职责 |
| --- | --- |
| `index.html` | 工作空间总览、平台统计、通过率、case 卡片、前置条件标签、多端摘要 |
| `cases/<case>/CONTEXT.html` | 单 case 多平台概览、共享前置条件、步骤、规则和用户补充 |
| `cases/<case>/platforms/<platform>/CONTEXT.html` | 单平台执行详情、失败现场、步骤复盘、Flow、环境和调试信息 |
| `CONTEXT.md` | 便于 diff 的文本报告 |

case 卡片状态是多平台聚合摘要；真实结论以平台报告为准。

## timeline.jsonl

当前 execution 的事实源。报告、结果和统计都从 timeline 和当前 `case.json` 渲染。

事件类型：`executionStart`、`environmentProbe`、`precondition`、`observation`、`perception`、`decision`、`rule`、`flow`、`actionResult`、`assertion`、`popup`、`appForeground`、`budgetExceeded`、`result`。`flow` 及 `scope=precondition-flow` 的 observation/actionResult 只属于前置条件。

事件 schema 见 `interfaces.md`。

## execution.json

记录 execution 生命周期：

```json
{
  "schemaVersion": 1,
  "executionId": "20260708-101500-001-abcd",
  "startedAt": "2026-07-08T10:15:00+08:00",
  "endedAt": "2026-07-08T10:18:00+08:00",
  "finalized": true,
  "status": "PASS",
  "requestedStatus": "PASS",
  "failureCode": null,
  "isolation": {"clean": true, "required": false}
}
```

finalized 后不得追加 timeline。

## result.json

```json
{
  "schemaVersion": 1,
  "executionId": "20260708-101500-001-abcd",
  "caseKey": "ck-xxxxxxxxxxxx",
  "platform": "android",
  "sourceSha1": "source-xxxxxxxxxxxx",
  "caseContractSha": "contract-xxxxxxxxxxxx",
  "preconditionPlanSha": "precondition-plan-xxxxxxxxxxxx",
  "status": "FAIL",
  "requestedStatus": "PASS",
  "failureCode": "ASSERTION_UNKNOWN",
  "startedAt": "2026-07-08T10:15:00+08:00",
  "endedAt": "2026-07-08T10:18:00+08:00",
  "failedStep": "step-006",
  "reason": "PASS 缺少步骤证据: step-006"
}
```

`status` 是归一结果，`requestedStatus` 是 agent 原始请求。`sourceSha1`、`caseContractSha` 和 `preconditionPlanSha` 用于判断旧结果是否仍适用；Flow 资产变化后旧结果不再展示。

## metrics.json

每次执行都写，即使环境或前置条件阶段失败。

稳定维度：status、requestedStatus、failureCode、sourceSha1、caseContractSha、preconditionPlanSha、durationMs、environment、precondition passed/prepared/blocked/failed/unknown counts、step counts、action counts、precondition Flow planned/started/completed/failed/blocked/alreadySatisfied/actions、rule counts、foreground loss、restart/isolation、popup counts、artifact counts。

`durationMs = endedAt - startedAt`，只覆盖当前 case。

## state.json

正式平台运行态：

```text
cases/<case>/platforms/<platform>/state.json
```

保存已确认环境、依赖状态、最新 execution、最新结果和轻量累计统计。根目录 `state.json` 只兼容旧产物。

## 源契约变化

当最新结果与当前 `sourceSha1`、`caseContractSha` 或重新计算的 `preconditionPlanSha` 不匹配：

- 隐藏旧结果。
- 显示“源用例或执行契约变更”。
- 基于当前 contract 重新执行后警告消失。

`caseContractSha` 至少覆盖源用例、前置条件、步骤、规则、用户补充和 isolation。

## index 聚合

聚合状态：

```text
FAIL > BLOCKED > UNKNOWN > NOT_RUN > PASS
```

只有所有已展示平台都通过时，case 聚合状态才是通过。

## 证据展示

- 步骤截图按 observation 的 `stepId` 归入步骤卡。
- 无 `stepId` 的 observation 必须标记全局诊断或辅助观察。
- `scope=precondition-flow` 的 observation 按 preconditionId、flowId、flowStepId 和 phase 展示在 Flow 区域，不归入“未关联观察”。
- 截图用 lightbox；控件树和日志只提供文件链接。

## 写入入口

```bash
scripts/run-case.js <case-dir> --platform <platform> --start
scripts/observe.sh --case-dir <case-dir> --platform <platform> --execution-id <id> --step-id <step-id> --label "<label>"
scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> --step-id <step-id> --type tap ...
scripts/run-case.js <case-dir> --platform <platform> --record-json '{"type":"assertion","...":"..."}'
scripts/run-case.js <case-dir> --platform <platform> --finalize --status FAIL --reason "..."
```

历史根运行态只允许显式 `--legacy-runtime` 兼容读取或人工收尾。

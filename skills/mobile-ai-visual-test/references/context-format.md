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
| `cases/<case>/CONTEXT.md` | 与根 HTML 同步刷新的多平台文本概览，便于 diff |
| `cases/<case>/platforms/<platform>/CONTEXT.md` | 单平台文本详情 |

case 卡片状态是多平台聚合摘要；真实结论以平台报告为准。

## timeline.jsonl

当前 execution 的事实源。结果和统计使用 timeline 与 `case.snapshot.json`；报告使用当前 `case.json` 判断执行契约是否仍适用。

事件类型：`executionStart`、`environmentProbe`、`executionRecovery`、`agentRuntime`、`precondition`、`observation`、`evidenceCheck`、`perception`、`decision`、`rule`、`flow`、`actionResult`、`assertion`、`popup`、`appForeground`、`budgetExceeded`、`result`。`agentRuntime` 只记录独立 Agent 会话绑定或失败，不参与业务 PASS；`evidenceCheck` 只能由 `run-case.js` 根据 perception 的结构化 `qualityClaim` 生成；`flow` 及 `scope=precondition-flow` 的 observation/actionResult 只属于前置条件。

事件 schema 见 `interfaces.md`。

## execution.json

记录 execution 生命周期：

```json
{
  "schemaVersion": 2,
  "executionId": "20260708-101500-001-abcd",
  "sourceSha1": "source-xxxxxxxxxxxx",
  "caseContractSha": "contract-xxxxxxxxxxxx",
  "preconditionPlanSha": "precondition-plan-xxxxxxxxxxxx",
  "startedAt": "2026-07-08T10:15:00+08:00",
  "endedAt": "2026-07-08T10:18:00+08:00",
  "lifecycle": "FINALIZED",
  "finalized": true,
  "status": "PASS",
  "requestedStatus": "PASS",
  "failureCode": null,
  "isolation": {"clean": true, "required": false}
}
```

生命周期为 `STARTING -> RUNNING -> FINALIZING -> FINALIZED`，冷启动入口异常可进入 `BLOCKED_START` 后由框架收尾。`FINALIZING` 使用 `result.draft.json` 恢复半提交；finalized 后不得追加 timeline。批次 execution 的 finalize 只产生业务 `result.json` 与 `metrics.json`，不会提前改写对外状态和报告。

同目录的 `case.snapshot.json` 是 execution 冻结业务契约。正式已启动 execution 的记录、Case Engine、finalize 和 Agent 请求都强制使用 snapshot；缺失或哈希不一致按执行契约损坏拒绝。仅显式历史兼容入口允许读取没有 snapshot 的旧产物。

## Agent 与批次产物

每个 execution 的 `execution.json` 固化所属 batchId，CaseAgentRequest 和 runtime.json 继续保存同一 batchId；`agent/` 保存 contract、request、runtime、response、validation 和未完成 turn draft。provider 由 Runtime Core 写入 request 并进入 `requestSha`，再与 `agentRuntime BOUND` 的 protocolSha、implementationSha 和 sessionId 共同绑定。validation 只由 Runtime Core 写入，并覆盖成功、结果无效、创建失败、中断和超时等所有 Runtime 终态。工作空间 `runs/<batchId>/` 保存 contract.json、batch.json 与 events.jsonl，并从绑定产物读取可信终态。

批次提交生成 `<execution>/completion.json`，这是报告和 index 读取的可信发布标记。`result.json` 始终保留业务执行结论；若 Runtime 校验失败，completion 的 `businessStatus` 仍保留该结论，但对外 `status` 为 `BLOCKED`，报告同时展示“对外结论、业务执行结果、Runtime 校验”。`state.json.committedExecutionIds` 保证可信发布累计统计只应用一次；报告属于可重建派生产物，重复提交会幂等刷新。

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

稳定维度：status、requestedStatus、failureCode、sourceSha1、caseContractSha、preconditionPlanSha、durationMs、environment、executionPhase、precondition passed/prepared/blocked/failed/unknown counts、step counts、action counts、precondition Flow planned/started/completed/failed/blocked/alreadySatisfied/actions、visual evidence checks/claimPresent/claimAbsent/unverifiable/sourceInvalid/sourceChanged、rule counts、foreground loss、restart/isolation、popup counts、artifact counts。环境或前置条件阻塞不得虚构 blocked step。

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
- 新截图卡同时展示 PNG 解码状态、尺寸和 SHA-256 短摘要；完整值保存在 observation 的 `artifactMetadata.screenshot`。
- `evidenceCheck` 按 `stepId` 展示在对应步骤事实中；它是原始文件与 Agent 声明的复核记录，不是业务 PASS 证据。

## 写入入口

```bash
scripts/run-case.js <case-dir> --platform <platform> --start
scripts/observe.sh --case-dir <case-dir> --platform <platform> --execution-id <id> --step-id <step-id> --label "<label>"
scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> --step-id <step-id> --type tap ...
scripts/run-case.js <case-dir> --platform <platform> --record-json '{"type":"assertion","...":"..."}'
scripts/run-case.js <case-dir> --platform <platform> --finalize --status FAIL --reason "..."
```

历史根运行态只允许显式 `--legacy-runtime` 兼容读取或人工收尾。

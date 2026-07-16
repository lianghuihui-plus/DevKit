# SMAP V3 产物协议

## 目录

1. [App Map 根目录](#1-app-map-根目录)
2. [Run 目录](#2-run-目录)
3. [scan 与 plan](#3-scan-与-plan)
4. [Context、Cursor 与指标](#4-contextcursor-与指标)
5. [Observation 与状态指纹](#5-observation-与状态指纹)
6. [Frontier、Attempt 与 Edge](#6-frontierattempt-与-edge)
7. [Navigation 与 BACK](#7-navigation-与-back)
8. [Verification](#8-verification)
9. [事件与恢复](#9-事件与恢复)
10. [Continuation](#10-continuation)
11. [终态校验](#11-终态校验)
12. [Snapshot 与 Dashboard](#12-snapshot-与-dashboard)
13. [历史兼容](#13-历史兼容)

## 1. App Map 根目录

`<app-map-root>` 固定属于一个 App 和一个环境：

```text
<app-map-root>/
├── app.json
├── run-index.json
├── runs/<scan-id>/
├── snapshots/
│   ├── current.json
│   └── generations/<generation-id>/
└── dashboard/index.html
```

`--app-map-root` 和 `--scan-dir` 必须为绝对路径。`scanId`、`goalId`、父 Run ID 等必须是单个安全路径段，拒绝斜线、`..` 和路径穿越。

## 2. Run 目录

V3 Run 目录：

```text
runs/<scan-id>/
├── scan.json
├── target.json
├── plan.json
├── timeline.jsonl
├── continuation.json              # 仅 Continuation
├── contexts/<context-id>/
│   ├── context.json
│   ├── graph.json
│   ├── frontier.json
│   ├── metrics.json
│   ├── live-cursor.json
│   ├── back-capabilities.json
│   └── verification-queue.json
├── attempts/<attempt-id>.json
├── evidence/
│   ├── observations/<obs-id>/
│   │   ├── observation.json
│   │   ├── screenshot.png
│   │   └── layout.json
│   ├── actions/<action-id>.json
│   ├── preparations/<preparation-id>.json
│   ├── restores/<restore-id>.json
│   ├── navigations/<navigation-execution-id>.json
│   ├── verifications/<verification-id>.json
│   └── logs/
├── goal/                           # 仅目标模式
├── known/contexts/                 # Continuation 恢复知识
├── merged/
│   ├── map.json
│   └── unresolved.json
└── report.md
```

V3 恰好只有一个 `contexts/<context-id>` 目录，且必须等于 `scan.json.contextId`。历史 V1/V2 Run 可保留多个 context 目录。

## 3. scan 与 plan

V3 `scan.json` 核心字段：

```json
{
  "schemaVersion": 3,
  "scanId": "scan-...",
  "parentScanId": null,
  "mapRevisionId": "scan-...",
  "scanMode": "exploration",
  "scanScope": "full",
  "graphProtocolVersion": 3,
  "attemptProtocolVersion": 3,
  "planProtocolVersion": 3,
  "eventProtocolVersion": 2,
  "projectionProtocolVersion": 2,
  "navigationProtocolVersion": 2,
  "verificationProtocolVersion": 2,
  "contextId": "guest",
  "profile": "standard",
  "navigationPolicy": "adaptive",
  "verificationRule": "CANONICAL_SCREEN_PATH",
  "budget": {},
  "budgetRevision": 1
}
```

V3 禁止写入 `plannedContextIds`、`activeContextId`、`budgetsByContext`。`verificationRule` 必须与模式匹配：

- exploration → `CANONICAL_SCREEN_PATH`
- goal-directed → `CONFIRMED_TARGET_PATH`

`plan.json` schemaVersion 3 保存最终确认计划。必须包含：

- `execution`：模式、范围、profile、唯一 context、验证规则和导航策略。
- `context`：身份及准备说明。
- `profileSelection.availableProfiles`：四个 profile、适用性与派生限制。
- `userConfiguration`：`profile`、`maxActiveMinutes`、`maxDepth`。
- `derivedExecutionLimits`：完整生效预算和策略限制。
- `timeExpectation`：活动时间含义与排除项。
- 安全边界、人工介入点、停止规则、产物路径和 Continuation 摘要。

计划内容哈希为 `planHash`。确认前配置变化必须增加 `budgetRevision`、写 `scanPlanConfigured` 并改变哈希；确认写 `scanPlanConfirmed`。确认后不得原地改计划。

## 4. Context、Cursor 与指标

`context.json` 保存唯一身份的准备、验证和运行状态。根 Observation 必须引用同一个 `ContextPreparation`，证明执行过受控冷启动、目标 App 回到前台，并使用最终稳定 Observation 完成身份验证。

`live-cursor.json`：

```json
{
  "schemaVersion": 1,
  "contextId": "guest",
  "reachableStateId": "reachable-...",
  "observationId": "obs-...",
  "status": "EXACT",
  "epoch": 2,
  "mutationSeq": 17,
  "establishedBy": "ATTEMPT_COMMIT",
  "lastValidatedAt": "...",
  "updatedAt": "...",
  "invalidatedReason": null
}
```

`epoch` 在冷启动或明确重建位置时递增，用于拒绝旧 Attempt；`mutationSeq` 必须与 metrics 的设备变更序号一致。Cursor 为 `EXACT` 时引用的 ReachableState 和 Observation 必须存在；`UNKNOWN` 时不得作为候选来源事实。

`metrics.json` 至少保留：

- `activeStartedAt`、`activeDurationMs`。
- `actions` 和五类动作：exploration/navigation/recovery/verification/interruption。
- `coldStarts`、`deviceMutationSeq`。
- `observations`、`observationSamples`、`observationStabilityWaitMs`、`dynamicVisualObservations`。
- 图、Frontier、NO_STATE_CHANGE 和 Cursor/导航相关派生指标。

五类动作之和必须等于 `deviceActions`。所有进入/离开 `SCANNING` 的迁移统一维护活动时间；PAUSED 时间不累计。

## 5. Observation 与状态指纹

正式 `observation.json` 必须包含触发类型和稳定链：

- `trigger`：`COLD_START`、`ACTION`、`NAVIGATION`、`RESTORE_*`、`VERIFICATION_*`、`POPUP_DISMISSAL` 或 `RECHECK` 等受控来源。
- `stability.accepted=true`。
- 终态为 `STABLE` 或 `LAYOUT_STABLE_VISUAL_DYNAMIC`。
- 每个样本的截图 SHA-256、布局哈希、前台信息、采集耗时、连续稳定计数和加载语义。
- 最终 `finalScreenshotSha256` 与 `finalLayoutHash`。

采样前后前台不一致、仍含加载语义或超时未稳定时，不创建正式 Observation；只写日志和 `observationRejected` 事件。Observation ID 允许有空洞。

VisualState fingerprint 保存 `layoutHash`、`screenshotSha256` 和 `visualDynamic`：

- 两者一致：`EXACT`。
- 布局一致、截图不同：最多 `PROBABLE`。
- 缺少历史截图哈希：不得升级为 `EXACT`。

## 6. Frontier、Attempt 与 Edge

FrontierItem 必须包含来源 ReachableState、候选、候选组、深度/优先级和状态。Claim 后保存唯一 `claimToken`、`claimedAttemptId`、NavigationPlan 摘要和 Claim 时 Cursor epoch。

Attempt Protocol V3 必须绑定：

- `attemptId`、`contextId`、`frontierId`、`claimToken`。
- `candidate` 与 `candidateHash`。
- `fromReachableStateId`。
- `navigationPlanId`、`sourceAcquisitionMode`、`cursorEpoch`。
- 来源 Observation、候选 ActionResult、结果 Observation。
- 审查结论、干扰处理、稳定重观察和终态。

完整 Edge 因果闭环：

```text
FrontierItem(CLAIMED)
  -> Attempt
     -> Navigation evidence / source Observation
     -> candidate ActionResult
     -> after Observation
  -> attemptCommitted event
  -> Edge + ReachableState + Frontier(EXPLORED) + Cursor
```

ActionResult 必须绑定 Attempt、Frontier 和 before Observation；Edge 必须引用同一 Attempt 的 before/action/after 证据。候选哈希必须等于 Frontier 候选。直接写 Edge 被禁止。

Edge V3 还保存：

```text
locatorResolution
replayPolicy
replayability                 # 历史兼容等级
verification.replayStatus     # UNVERIFIED | COLD_REPLAY_VERIFIED | REPLAY_UNSTABLE | INVALIDATED
verification.transitionFingerprint
verification.verificationIds[]
```

动作后的稳定状态与来源 `EXACT` 时闭环到 Attempt `NO_STATE_CHANGE` 和 Frontier `EXPLORED`，不写 VisualState、ReachableState 或 Edge。`wait` 禁止出现在新 Frontier、Attempt candidate 和 Edge action。

## 7. Navigation 与 BACK

NavigationPlan 是不可变意图，至少绑定 `navigationPlanId`、`planFingerprint`、来源/目标、Cursor epoch、模式和固定 steps。每次尝试建立唯一 NavigationExecution，并写入 `evidence/navigations/<navigation-execution-id>.json`：

- 来源/目标 ReachableState。
- 模式：`LIVE_CURSOR`、`BACKTRACK`、`GRAPH_PATH` 或 `COLD_REPLAY`。
- 计划步骤、估算动作、绑定 Cursor epoch。
- 每步动作、Observation、预期状态、比较结果和终态。
- `requestedMode`、`actualMode`、`fallbackFrom` 与 `fallbackReason`。
- 状态 `PLANNED | IN_PROGRESS | SUCCEEDED | FAILED | CANCELLED`，以及非冷导航失败后的唯一冷重放降级关系。

候选 ActionResult 的 before Observation 必须是 Navigation 成功后当前 Cursor 的 Observation，不能沿用过期来源证据。

`back-capabilities.json` 中每项必须绑定 from/to ReachableState、BACK ActionResult、前后 Observation 和 `verificationStatus=EXACT`。仅 `status=ACTIVE` 且转换仍有效的记录可被规划器使用。`arrivalSignature.expectedBackReachableStateId` 只是历史提示，不能替代实际采证。

`evidence/restores/<restore-id>.json` 保留 L4 冷启动恢复的 checkpoint：根、Edge 索引、预期状态、当前 Observation 和比较结果。恢复审查中的弹窗清理和短暂态重观察必须从同一 checkpoint 继续，不能重复冷启动。

## 8. Verification

`verification-queue.json` 中任务：

```text
verificationId
taskKey
contextId
reason: CANONICAL_SCREEN_PATH | CONFIRMED_TARGET_PATH
logicalScreenKey / decisionId
terminalReachableStateId
edgeIds[]
transitionFingerprints[]
status: PENDING | RUNNING | SUCCEEDED | FAILED | SUPERSEDED
```

`taskKey` 必须绑定转换指纹链。相同 LogicalScreen 出现新规范路径时，旧的 PENDING/RUNNING 任务标记 `SUPERSEDED`，新任务使用新 key。

Task 维护 `attemptCount`、`activeExecutionId`、`executionIds[]` 与 `executions[]`。Execution 状态为 `RESTORING | AWAITING_VISUAL_ASSESSMENT | SUCCEEDED | FAILED | ABANDONED`，每次尝试使用全 Run 唯一 `executionId`，不得复用或覆盖。

`evidence/verifications/<verification-id>/<execution-id>.json` 保存该次执行的固定 Edge/transition fingerprint 链、冷启动、逐步动作/Observation/比较和最终结果。文件创建后不可覆盖。成功任务必须能证明每条 Edge 从当前根逐步 `EXACT` 到达；目标任务还必须绑定人工 Decision 和最终强视觉判断。

队列投影遵循事件先行：先写 `verificationScheduled`，再写 queue。恢复器可从事件补放缺失任务。

验证失败不删除发现 Edge，只更新 `replayStatus=REPLAY_UNSTABLE` 并保留失败证据。验证成功按 transition fingerprint 写 `COLD_REPLAY_VERIFIED`；不同指纹不可继承。

## 9. 事件与恢复

`operations/<operation-id>.json` 是设备变更 Journal。冷启动、候选动作、导航、恢复、BACK 和弹窗清理在调用 Bridge 前先写 `STARTED`，完成证据闭环后写 `SUCCEEDED`；能证明未下发时才可写普通失败。进程消失但无法证明结果时写 `UNKNOWN_OUTCOME`，失效 Cursor 并暂停，不得自动重试非幂等动作。人工使用新的稳定 Observation 收敛后写 `RESOLVED_NO_EFFECT | RESOLVED_EFFECT`；未知结果本身不能生成 Edge。

`timeline.jsonl` 是关键事实序列，每个事件有 Run 内唯一递增 `eventId`。`event-head.json` 保存最后事件序号、类型、timeline byte offset 和摘要；`projection-state.json` 保存 reducer 版本、最后应用序号/offset 与关键投影摘要。关键提交顺序：

```text
校验意图
  -> 在 Run 锁内 append event
  -> 幂等更新投影文件
```

`attemptCommitted.commitProjection` 至少包含 LogicalScreen、VisualState、ReachableState、Edge、FrontierItem、Attempt 和 Cursor。`verificationScheduled` 包含完整任务事实。

可变入口加载 Run 时执行恢复：

- 仅从 `projection-state.timelineOffset` 之后增量补放事件。
- 关键投影摘要不一致时，从完整 timeline 定向重建该文件。
- 回收失去 lease 的 VerificationExecution；保留每次 Execution 历史。
- 回收失去执行器的 Device Operation 为 `UNKNOWN_OUTCOME`，失效 Cursor 并暂停。
- 保持已终结 Run 不可写。

`rebuild-run.js` 从事件的 `projectionOps` 重建到独立空目录，并比较 Graph、Frontier、Cursor、Queue、BackCapability、Operation、NavigationExecution 与 Attempt；Attempt 的中间态和终态都必须可恢复，差异表示协议损坏。

## 10. Continuation

`continuation.json` schemaVersion 3：

```text
parentScanId
contextId
scanMode
parentGoalSpecHash
importedFrontiers[]
skippedImportedFrontiers[]
```

父 Run 必须是完整校验的 `PARTIAL`，并与子 Run 具有相同 App、环境、版本、`contextId` 和 `scanMode`。子 Run 继承父 `mapRevisionId`；目标模式的 `goalSpecHash` 必须相同。

父 Graph 只复制到 `known/contexts` 作为导航和绑定知识。子 Run 必须重新冷启动、采集 Observation、建立根状态并将导入 Frontier 绑定到本 Run ReachableState 后，才能形成新事实。父 Run 不可修改。

## 11. 终态校验

`COMPLETED` 至少要求：

- 唯一 Context 已验证并存在合法根状态。
- 没有 `PENDING`、`RETRYABLE` 或无主 `CLAIMED` Frontier。
- Attempt、ActionResult、Observation、Edge 因果链完整。
- Cursor 和 metrics 引用一致。
- Verification Queue 无 `PENDING`、`RUNNING`、`FAILED` 必要任务。
- event head 与 projection watermark 完全追平，不存在 `STARTED` / `UNKNOWN_OUTCOME` Device Operation、运行中的 NavigationExecution 或未闭合 VerificationExecution。
- 探索模式的当前规范路径验证规则满足；目标模式存在 `FOUND_VERIFIED` 强路径。
- 五类动作总和、冷启动数、状态数、深度和活动时间不违反硬预算。

仍有待办或预算耗尽时只能 `PARTIAL`。终态先写 `scanFinalized`，随后 `scan.json` 为不可变投影；即使文件被意外回写，加载器仍以终态事件为准拒绝修改。

## 12. Snapshot 与 Dashboard

每次构建写入不可变 generation：

```text
snapshots/generations/<generation-id>/
├── manifest.json
├── map.json
├── unresolved.json
└── metrics.json
```

完成全部文件和摘要校验后，原子更新 `snapshots/current.json`。默认聚合同一 App 版本下所有通过校验的 `COMPLETED` 与 `PARTIAL` Run；显式 `--map-revision-id` 只用于单血缘诊断。

合并事实使用 LogicalScreen semantic key 和 transition fingerprint。较新相同转换可复用验证等级；目标、动作或转换指纹变化时不得继承。历史 `wait` Edge 在归一化层剔除，依赖它的不可达状态被裁剪并写 unresolved。

Dashboard 只能读取 `current.json` 指向且摘要匹配的 generation。ViewModel 将稳定英文协议值映射为中文标签，并展示发现 Edge、已验证 Edge、不稳定 Edge、冷启动和动作分类；固定 HTML 模板不得自行修改事实。

## 13. 历史兼容

V1/V2 Run 保持原目录和事实不可变。统一版本访问器负责：

- V1/V2 的 `plannedContextIds` 与 V3 的 `contextId`。
- V1/V2 的 `budgetsByContext` 与 V3 的 `budget`。
- 历史 Attempt/Edge 缺失 V3 字段时的保守读取。

新 writer 永远只生成 V3。V3 校验器只拒绝 V3 Run 的多 Context 结构，不能让全局入口拒绝历史多 Context Run。

历史 Edge 的验证映射必须基于证据：只有从冷启动开始、根与每个中间状态均精确、动作和目标转换一致的路径才映射为 `COLD_REPLAY_VERIFIED`；坐标不稳定或证据不完整的事实映射为 `REPLAY_UNSTABLE` / `UNVERIFIED` 并保留 provenance。

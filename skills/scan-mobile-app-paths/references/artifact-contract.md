# SMAP 产物协议

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
13. [协议版本](#13-协议版本)

## 1. App Map 根目录

`<app-map-root>` 固定属于一个 App 和一个环境：

```text
<app-map-root>/
├── app.json
├── run-index.json
├── maps/<context-id>/
├── runs/<scan-id>/
├── snapshots/
│   ├── current.json
│   └── generations/<generation-id>/
└── dashboard/index.html
```

`--app-map-root` 和 `--scan-dir` 必须为绝对路径。`scanId`、`goalId`、父 Run ID 等必须是单个安全路径段，拒绝斜线、`..` 和路径穿越。

`maps/guest` 与 `maps/authenticated` 保存该登录态当前 canonical map，包括 `graph.json`、`frontier.json`、`verification-queue.json`、`back-capabilities.json`、`visual-equivalence.json`、`state-equivalence.json`、`meta.json`、`map-events.jsonl` 和 `edits/`。Run 初始化时从这里 seed；Run 登记时同步回这里。

## 2. Run 目录

Run 目录：

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
│   ├── verification-queue.json
│   ├── visual-equivalence.json
│   └── state-equivalence.json
├── attempts/<attempt-id>.json
├── evidence/
│   ├── observations/<obs-id>/
│   │   ├── observation.json
│   │   ├── screenshot.png
│   │   └── layout.json
│   ├── actions/<action-id>.json
│   ├── visual-reviews/<visual-review-id>.json
│   ├── preparations/<preparation-id>.json
│   ├── restores/<restore-id>.json
│   ├── navigations/<navigation-execution-id>.json
│   ├── verifications/<verification-id>/<execution-id>.json
│   └── logs/
├── goal/                           # 仅目标模式
├── known/contexts/                 # Continuation 恢复知识
└── report.md
```

当前结构恰好只有一个 `contexts/<context-id>` 目录，且必须等于 `scan.json.contextId`。

## 3. scan 与 plan

`scan.json` 核心字段：

```json
{
  "scanId": "scan-...",
  "parentScanId": null,
  "mapRevisionId": "scan-...",
  "mapBaseRevisionId": null,
  "scanMode": "exploration",
  "scanScope": "full",
  "contextId": "guest",
  "profile": "standard",
  "navigationPolicy": "adaptive",
  "verificationRule": "CANONICAL_SCREEN_PATH",
  "budget": {},
  "budgetRevision": 1
}
```

当前结构禁止写入 `plannedContextIds`、`activeContextId`、`budgetsByContext`。`verificationRule` 必须与模式匹配：

- exploration → `CANONICAL_SCREEN_PATH`
- goal-directed → `CONFIRMED_TARGET_PATH`

`plan.json` 保存最终确认计划。必须包含：

- `execution`：模式、范围、profile、唯一 context、验证规则和导航策略。
- `context`：身份及准备说明。
- `profileSelection.availableProfiles`：四个 profile、适用性与派生限制。
- `userConfiguration`：`profile`、`maxActiveMinutes`、`maxDepth`。
- `derivedExecutionLimits`：完整生效预算和策略限制。
- `timeExpectation`：活动时间含义与排除项。
- 安全边界、人工介入点、停止规则、产物路径和 Continuation 摘要。

计划内容哈希为 `planHash`。确认前配置变化只重新运行 `preview-plan.js` 并得到新哈希，不写正式 Run；确认后 `init-scan.js --confirmed-plan-hash` 写入 `plan.json` 和 `scanPlanConfirmed`。确认后不得原地改计划。

## 4. Context、Cursor 与指标

`context.json` 保存唯一身份的准备、验证和运行状态。根 Observation 必须引用同一个 `ContextPreparation`，证明执行过受控冷启动、目标 App 回到前台，并使用最终稳定 Observation 完成身份验证。

Run 内 JSON 产物分为三类：

- Projection：状态型文件，必须通过 timeline projectionOps 写入，并能被 `rebuild-run.js` 重建比对。
- Evidence：不可变或追加型证据，写入后由 Projection 引用并由 `validate-run.js` 校验身份、hash 和因果关系。
- Canonical：`maps/<context>` 中的当前地图事实，可由已登记 session 推进，带 revision 与来源 Run provenance。
- Generated：报告和 Snapshot/Dashboard 输出，可从已校验 Run 与 canonical map 重新生成。

虽然 `evidence/preparations/*.json`、`evidence/restores/*.json` 与 `evidence/navigations/*.json` 位于 evidence 目录下，但它们记录执行状态机，属于 Projection；Observation、ActionResult、VisualReview 与 VerificationExecution 证据仍按 Evidence 处理。

`live-cursor.json`：

```json
{
  "schemaVersion": 1,
  "contextId": "guest",
  "reachableStateId": "reachable-...",
  "observationId": "obs-...",
  "status": "EXACT",
  "equivalence": null,
  "epoch": 2,
  "mutationSeq": 17,
  "establishedBy": "ATTEMPT_COMMIT",
  "lastValidatedAt": "...",
  "updatedAt": "...",
  "invalidatedReason": null
}
```

`epoch` 在冷启动或明确重建位置时递增，用于拒绝旧 Attempt；`mutationSeq` 必须与 metrics 的设备变更序号一致。Cursor 为 `EXACT` 时引用的 ReachableState 和 Observation 必须存在；`UNKNOWN` 时不得作为候选来源事实。若 Cursor 来自状态等价人工确认或来源匹配，`equivalence` 必须记录规则来源。

`state-equivalence.json` 保存人工确认后可复用的状态等价规则：

```json
{
  "schemaVersion": 1,
  "contextId": "guest",
  "rules": [
    {
      "ruleId": "seq-...",
      "reachableStateId": "rs-home",
      "visualStateId": "vs-home",
      "logicalScreenKey": "learning-center",
      "semanticAnchors": {
        "requiredTexts": ["学习中心"],
        "requiredIds": [],
        "requiredTitles": ["学习中心"],
        "requiredTabs": []
      },
      "allowedVariance": ["screenshotSha256", "layoutHash", "dynamicTexts", "listItems"],
      "createdFrom": {
        "restoreId": "restore-0001",
        "attemptId": "attempt-0001",
        "observationId": "obs-0003"
      },
      "humanAssessment": {
        "status": "EXPECTED_STATE_EQUIVALENT",
        "rationale": "动态图片变化，页面语义与布局一致"
      },
      "createdAt": "..."
    }
  ]
}
```

规则只能用于恢复、来源确认和探索路径验证中的状态等价，不能用于目标页面最终强匹配、动作无变化判断或风险动作放行。新确认只写入 `state-equivalence.json`。

`metrics.json` 至少保留：

- `activeStartedAt`、`activeDurationMs`。
- `actions` 和五类动作：exploration/navigation/recovery/verification/interruption。
- `coldStarts`、`deviceMutationSeq`。
- `observations`、`observationSamples`、`observationStabilityWaitMs`、`visualVarianceObservations`。
- 图、Frontier、NO_STATE_CHANGE 和 Cursor/导航相关派生指标。

五类动作之和必须等于 `metrics.actions`。所有进入/离开 `SCANNING` 的迁移统一维护活动时间；PAUSED 时间不累计。

## 5. Observation 与状态指纹

正式 `observation.json` 必须包含触发类型和稳定链：

- `trigger`：`COLD_START`、`ACTION`、`NAVIGATION`、`RESTORE_*`、`VERIFICATION_*`、`POPUP_DISMISSAL` 或 `RECHECK` 等受控来源。
- `stability.accepted=true`。
- 终态为 `STABLE` 或 `LAYOUT_STABLE_VISUAL_VARIANCE`。
- 每个样本的截图 SHA-256、布局哈希、前台信息、采集耗时、连续稳定计数和加载语义。
- 最终 `finalScreenshotSha256` 与 `finalLayoutHash`。

采样前后前台不一致、仍含加载语义或超时未稳定时，不创建正式 Observation；只写日志和 `observationRejected` 事件。Observation ID 允许有空洞。

VisualState fingerprint 保存 `layoutHash`、`screenshotSha256` 和 `semantic`：

- 两者一致：`EXACT`。
- 语义锚点充分但截图、列表或局部结构变化：可在恢复、来源确认和路径验证中判为 `SAME_PAGE`。
- 语义证据不足但存在部分重合：`PROBABLE` 或 `UNCERTAIN`，需要降级或人工复核。
- 缺少历史截图哈希：不得升级为 `EXACT`。

`evidence/visual-reviews/<visual-review-id>.json` 保存执行 agent 使用大模型视觉能力后的结构化结论。脚本不得在这里实现像素级黑屏/白屏兜底算法，只校验字段和引用关系：

```json
{
  "schemaVersion": 1,
  "visualReviewId": "vreview-0001",
  "contextId": "guest",
  "observationId": "obs-0001",
  "reviewType": "ROOT_STATE",
  "status": "ACCEPTED",
  "pageUsable": true,
  "pageKind": "page",
  "pageName": "首页",
  "reasonCode": null,
  "confidence": "HIGH",
  "rationale": "截图清晰，页面内容与根页面语义一致",
  "screenshotPath": "evidence/observations/obs-0001/screenshot.png",
  "layoutPath": "evidence/observations/obs-0001/layout.json",
  "owner": null,
  "createdAt": "..."
}
```

`reviewType` 当前至少使用 `ROOT_STATE` 与 `PAGE_OUTCOME`。`status=ACCEPTED` 要求 `pageUsable=true`；非接受状态必须写 `reasonCode`。VisualState 必须引用对应的 `visualReviewIds`，Edge 的 `evidence.visualReviewId` 必须绑定同一 Attempt 的 after Observation。

## 6. Frontier、Attempt 与 Edge

FrontierItem 必须包含来源 ReachableState、候选、候选组、深度/优先级和状态。Claim 后保存唯一 `claimToken`、`claimedAttemptId`、NavigationPlan 摘要和 Claim 时 Cursor epoch。

Attempt 必须绑定：

- `attemptId`、`contextId`、`frontierId`、`claimToken`。
- `candidate` 与 `candidateHash`。
- `fromReachableStateId`。
- `navigationPlanId`、`sourceAcquisitionMode`、`cursorEpoch`。
- 来源 Observation、候选 ActionResult、结果 Observation。
- 动作后 `PAGE_OUTCOME` VisualReview 及其状态。
- 审查结论、干扰处理、稳定重观察和终态。

返回 Attempt 的脚本必须同时输出顶层 `attemptId` 和嵌套 `attempt.attemptId`，便于执行 agent 直接透传；传入 `undefined`、`null` 等非具体 ID 必须以 `ATTEMPT_ID_INVALID` 拒绝。

完整 Edge 因果闭环：

```text
FrontierItem(CLAIMED)
  -> Attempt
     -> Navigation evidence / source Observation
     -> candidate ActionResult
     -> after Observation
     -> PAGE_OUTCOME VisualReview(ACCEPTED)
  -> attemptCommitted event
  -> Edge + ReachableState + Frontier(EXPLORED) + Cursor
```

ActionResult 必须绑定 Attempt、Frontier 和 before Observation，并保存实际执行动作、`actionIntent`、`deviceProfile` 与 `locatorEvidence`。Edge 必须引用同一 Attempt 的 before/action/after/visualReview 证据。候选哈希必须等于 Frontier 候选。直接写 Edge 被禁止。

Edge 还保存：

```text
intent                        # 可移植动作意图，不含坐标
locatorQuality                # SEMANTIC_PORTABLE | SEMANTIC_WITH_FALLBACK | DEVICE_BOUND | UNRESOLVED
locatorEvidence               # 本次设备上的匹配节点、fallback bounds、tapPoint 和 deviceProfileId
replayPolicy
replayability                 # STABLE | CONDITIONAL | UNSTABLE
verification.replayStatus     # UNVERIFIED | COLD_REPLAY_VERIFIED | REPLAY_UNSTABLE | INVALIDATED
verification.transitionFingerprint
verification.verificationIds[]
```

动作后的稳定状态与来源 `EXACT` 时闭环到 Attempt `NO_STATE_CHANGE` 和 Frontier `EXPLORED`，不写 VisualState、ReachableState 或 Edge。`wait` 禁止出现在新 Frontier、Attempt candidate 和 Edge intent。

## 7. Navigation 与 BACK

NavigationPlan 是不可变意图，至少绑定 `navigationPlanId`、`planFingerprint`、来源/目标、Cursor epoch、模式和固定 steps。每次尝试建立唯一 NavigationExecution，并写入 `evidence/navigations/<navigation-execution-id>.json`：

- 来源/目标 ReachableState。
- 模式：`LIVE_CURSOR`、`SOURCE_MATCH`、`BACKTRACK`、`GRAPH_PATH` 或 `COLD_REPLAY`。
- 计划步骤、估算动作、绑定 Cursor epoch。
- 每步动作、Observation、预期状态、比较结果和终态。
- `requestedMode`、`actualMode`、`fallbackFrom` 与 `fallbackReason`。
- 状态 `PLANNED | IN_PROGRESS | SUCCEEDED | FAILED | CANCELLED`，以及非冷导航失败后的唯一冷重放降级关系。

候选 ActionResult 的 before Observation 必须是 Navigation 成功后当前 Cursor 的 Observation，不能沿用过期来源证据。

`back-capabilities.json` 中每项必须绑定 from/to ReachableState、BACK ActionResult、前后 Observation 和 `verificationStatus=EXACT`。仅 `status=ACTIVE` 且转换仍有效的记录可被规划器使用。`arrivalSignature.expectedBackReachableStateId` 只是历史提示，不能替代实际采证。

`evidence/restores/<restore-id>.json` 保留 L4 冷启动恢复的 checkpoint：根、Edge 索引、预期状态、当前 Observation 和比较结果。恢复审查中的弹窗清理和短暂态重观察必须从同一 checkpoint 继续，不能重复冷启动。Restore 只能以 `SUCCEEDED`、`FAILED` 或 `REVIEW_REQUIRED` 离开执行入口；若调用方不允许人工复核，状态不匹配必须先写 `FAILED` 再向外抛错。

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

`evidence/verifications/<verification-id>/<execution-id>.json` 保存该次执行的固定 Edge/transition fingerprint 链、冷启动、逐步动作/Observation/比较和最终结果。文件创建后不可覆盖。探索路径成功任务必须能证明每条 Edge 从当前根逐步以 `EXACT`、`SAME_PAGE` 或已人工确认的 `PROBABLE` 到达；目标任务还必须绑定人工 Decision 和最终强视觉判断。

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

所有 Run 内 ID 由 `idAllocated` 事件分配并投影到 `scan.json.counters`。如果进程在 ID 分配后、业务事件前中断，该 ID 作为空洞保留；恢复和重建不得回滚 counter 或复用该 ID。

可变入口加载 Run 时执行恢复：

- 仅从 `projection-state.timelineOffset` 之后增量补放事件。
- 关键投影摘要不一致时，从完整 timeline 定向重建该文件。
- 回收失去 lease 的 VerificationExecution；保留每次 Execution 历史。
- 回收失去执行器的 Device Operation 为 `UNKNOWN_OUTCOME`，失效 Cursor 并暂停。
- 保持已终结 Run 不可写。

`rebuild-run.js` 从事件的 `projectionOps` 重建到独立空目录，并通过 `artifact-registry` 比较全部 Projection；Attempt、Operation、Goal、BackCapability、VisualEquivalence、Preparation、Restore 与 NavigationExecution 的中间态和终态都必须可恢复，差异表示协议损坏。

## 10. Continuation

`continuation.json`：

```text
parentScanId
contextId
scanMode
parentGoalSpecHash
importedFrontiers[]
skippedImportedFrontiers[]
```

父 Run 必须是完整校验的 `PARTIAL`，并与子 Run 具有相同 App、环境、版本、`contextId` 和 `scanMode`。目标模式的 `goalSpecHash` 必须相同。

Continuation 只表达执行血缘。新 Run 从当前 `maps/<context>` seed graph/frontier/queue，并记录 `mapBaseRevisionId`；父 Graph 可复制到 `known/contexts` 作为诊断输入，但不能替代 canonical map。子 Run 必须重新冷启动、采集 Observation 并绑定根状态后，才能执行新候选。父 Run 不可修改。

## 11. 终态校验

`COMPLETED` 至少要求：

- 唯一 Context 已验证并存在合法根状态。
- 没有 `PENDING`、`RETRYABLE` 或无主 `CLAIMED` Frontier。
- Attempt、ActionResult、Observation、Edge 因果链完整。
- Cursor 和 metrics 引用一致。
- Verification Queue 无 `PENDING`、`RUNNING`、`FAILED` 必要任务。
- event head 与 projection watermark 完全追平，不存在 `STARTED` / `UNKNOWN_OUTCOME` Device Operation、运行中的 NavigationExecution、未闭合 Restore 或未闭合 VerificationExecution。
- 探索模式的当前规范路径验证规则满足；目标模式存在 `FOUND_VERIFIED` 强路径。
- 五类动作总和、冷启动数、状态数、深度和活动时间不违反硬预算。

仍有待办或预算耗尽时只能 `PARTIAL`。终态先写 `scanFinalized`，随后 `scan.json` 为不可变投影；即使文件被意外回写，加载器仍以终态事件为准拒绝修改。

## 12. Snapshot 与 Dashboard

Canonical map 编辑产物：

```text
maps/<context-id>/edits/
├── <edit-id>.preview.json
└── <edit-id>.applied.json
```

`preview.json` 记录 `operation`、`target`、`beforeMapRevisionId`、`impact` 和 `confirmHash`，不修改地图事实。`applied.json` 记录实际应用时间、新旧 `mapRevisionId` 和同一份影响摘要。`apply-delete` 必须在 canonical map 锁内重新计算计划，并确认当前 `mapRevisionId` 未变且 `confirmHash` 匹配。

支持的编辑操作：

- `DELETE_EDGE`：删除指定 Edge，并级联删除因此不可达的 ReachableState。
- `DELETE_REACHABLE_STATE`：删除指定非 root ReachableState 及无其他入口的后代。
- `RESET_CONTEXT`：清空指定 context 的 canonical map。

编辑必须同步清理 `frontier.json`、`verification-queue.json`、`back-capabilities.json` 与等价规则。被影响的 VerificationTask 标为 `SUPERSEDED`；Frontier 和 BackCapability 从 canonical map 移除。删除 Edge 时，Frontier 还必须按同一 `fromReachableStateId + actionKey(candidate)` 清理已探索入口，避免删除后同一动作仍被 explored 记录压住而不容易重新发现。每次 apply 都写入新的 `meta.mapRevisionId`，并向 `map-events.jsonl` 追加 `canonicalMapEdited`。

每次构建写入不可变 generation：

```text
snapshots/generations/<generation-id>/
├── manifest.json
├── map.json
├── unresolved.json
└── metrics.json
```

完成全部文件和摘要校验后，原子更新 `snapshots/current.json`。默认读取 `maps/<context>` 的 canonical map，不跨 scan 聚合 graph；显式 `--map-revision-id` 只用于指定 canonical revision 诊断。

Run Index 只提供执行历史和耗时/动作指标。旧 graph 数据不再归一化，入口会以 `GRAPH_SCHEMA_UNSUPPORTED` 拒绝。

Dashboard 只能读取 `current.json` 指向且摘要匹配的 generation。ViewModel 将稳定英文协议值映射为中文标签，并展示发现 Edge、已验证 Edge、不稳定 Edge、冷启动和动作分类；固定 HTML 模板不得自行修改事实。

## 13. 协议版本

当前版本使用：

- `scan.graphProtocolVersion: 4`
- `scan.attemptProtocolVersion: 4`
- `contexts/<context>/graph.json.schemaVersion: 2`

Graph v2 禁止 `edge.action`；Edge 必须保存 `intent` 和 `locatorQuality`。旧图需要重新扫描生成当前 canonical map，不做原地迁移。

# SMAP 技术架构

## 目录

1. [目标与模式](#1-目标与模式)
2. [系统分层](#2-系统分层)
3. [单 Context Run](#3-单-context-run)
4. [稳定观测与图模型](#4-稳定观测与图模型)
5. [Live Cursor](#5-live-cursor)
6. [分级导航](#6-分级导航)
7. [调度与 Attempt](#7-调度与-attempt)
8. [发现与验证分层](#8-发现与验证分层)
9. [预算模型](#9-预算模型)
10. [事件、恢复与终态](#10-事件恢复与终态)
11. [Canonical Map 与协议版本](#11-canonical-map-与协议版本)
12. [模块职责](#12-模块职责)

## 1. 目标与模式

SMAP 以黑盒方式扫描 HarmonyOS App 的稳定可达状态和交互路径。核心要同时满足：

- 尽量减少冷启动和已知路径重复重放。
- 每个动作保留完整的 before/action/after 证据。
- 区分“本次观察到转换”与“已从冷启动验证路径”。
- 在同样图、Cursor、Frontier、预算和目标输入下产生确定性调度结果。
- 当前版本只消费当前图协议；旧 Run 或旧 canonical map 不参与续跑、Snapshot 或 Dashboard。

系统只有两种模式：

- `exploration`：locality-aware bounded BFS，覆盖浅层主干和安全分支。
- `goal-directed`：由文字和单张截图驱动的启发式搜索，候选需人工确认。

Continuation 是 `PARTIAL` 父 Run 与新 Run 的血缘关系，不是执行模式。

## 2. 系统分层

```text
Agent Orchestrator
  -> Work Scheduler / Scan Strategy
  -> Scan Engine
       -> Navigation Planner
       -> Attempt State Machine
       -> Verification Queue
  -> Deterministic Core
       -> Budget / Safety / Fingerprint / Graph / Event / Recovery / Validation
  -> Harmony Runtime Bridge
  -> Canonical Map
  -> Snapshot / Dashboard
```

- Agent 负责页面语义、有限候选、弹窗分类与结构化视觉判断；脚本只记录和校验 VisualReview，不实现页面视觉算法。
- Scheduler 决定下一项是发现、验证还是停止。
- Scan Engine 固化 Claim、导航、动作、审查和事务提交。
- Deterministic Core 负责所有可验证不变量。
- Runtime Bridge 只暴露探测、前台、重启、稳定采样所需原子动作。
- Canonical Map 保存每个 context 的当前路径地图；Snapshot/Dashboard 只消费 canonical map 与已登记执行历史。

## 3. 单 Context Run

新 Run 使用 当前结构：

```text
scan.json
  contextId: guest | authenticated
  budget: {...}
  verificationRule: CANONICAL_SCREEN_PATH | CONFIRMED_TARGET_PATH
```

一个 Run 固定一个登录态和一个活动设备 Cursor，不再维护 `plannedContextIds`、动态 `activeContextId` 或 `budgetsByContext`。两个登录态分别扫描、分别计时、分别终结，并分别扩展 `maps/guest` 与 `maps/authenticated`。

正式 Run 在计划确认后才创建。`preview-plan.js` 只读取 App 根、目标输入和配置，生成确定性 `planHash`；`init-scan.js --confirmed-plan-hash` 在哈希匹配时一次性落盘 Run、计划、目标产物和基础投影。

Run 开始前人工登录/退出不计活动时间。计划确认后执行受控冷启动建立根证据；该冷启动不清数据，也不代表洁净环境。

## 4. 稳定观测与图模型

Runtime Bridge 的单次采样包含截图、控件树、前台 App/Ability 和时间戳。稳定观测器按触发类型应用保护等待，并连续采样：

```text
页面变化
  -> 保护等待
  -> screenshot + layout + foreground
  -> 校验采样前后前台一致
  -> 连续样本稳定
  -> 发布最后样本为 Observation
```

允许的终态：

- `STABLE`：截图、规范布局和前台连续一致。
- `LAYOUT_STABLE_VISUAL_VARIANCE`：布局稳定、无加载语义，但截图持续波动。

页面比较由独立状态等价能力负责。`EXACT` 仍只表示 normalized layout 与截图哈希都一致；恢复、来源确认和路径验证可以在 dump 树语义锚点充分时得到 `SAME_PAGE`。语义指纹包括稳定文本、id、角色、标题、导航项、主操作和粗粒度结构哈希，用于覆盖截图波动、列表数据变化和局部配置变化。脚本无法自动证明但仍可人工确认的状态写入 `state-equivalence.json`，后续恢复同一 ReachableState 时可复用规则；目标查找的最终成功仍必须走目标验证的强匹配。

超时或前台不连贯的样本只能写诊断，不能成为图或目标证据。

图实体：

- `LogicalScreen`：跨 Run 稳定的产品语义页面。
- `VisualState`：稳定截图、布局与前台共同确定的视觉状态。
- `ReachableState`：`VisualState + contextId + arrivalSignature`。
- `Edge`：一次已观察转换，保存可移植 `intent`、安全属性、locator quality 和证据引用；实际坐标只保留在 ActionResult/locatorEvidence 中。
- `Path`：由 Edge ID 构成的规范可达路径，分为用于恢复/导航/导出的 runnable path 和仅表达冷启动验证信心的 verified path。

布局和截图都相同才为 `EXACT`；语义锚点充分但截图或局部结构变化时可为 `SAME_PAGE`。`wait` 不是图动作。动作后状态与来源 `EXACT` 时记录 `NO_STATE_CHANGE`，不生成 Edge；`SAME_PAGE` 只用于恢复、来源确认和路径验证，不用于证明动作无效果。

## 5. Live Cursor

`live-cursor.json` 表示引擎当前对设备位置的可执行承诺：

```text
contextId
reachableStateId
observationId
status: EXACT | UNKNOWN
epoch
mutationSeq
lastValidatedAt
establishedBy
```

Cursor 可执行需同时满足：

1. Run 与 Cursor context 一致。
2. Cursor 为 `EXACT`，且状态存在于当前图。
3. Cursor `mutationSeq` 等于 metrics 中最后设备变更序号。
4. Attempt 绑定的 `cursorEpoch` 仍是当前 epoch。
5. 超过 `cursorFreshnessMs` 时先做轻量 `RECHECK`；不是直接判失效。

成功的候选提交、导航、BACK、恢复和验证会建立新 Cursor。未知动作失败、前台漂移、比较失败或外部变更会使 Cursor 失效。冷启动建立新 epoch。

## 6. 分级导航

Navigation Planner 采用从低成本到高成本的确定性顺序：

| 等级 | 模式 | 使用条件 | 成本 |
| --- | --- | --- | --- |
| L0 | `LIVE_CURSOR` | 已在目标来源状态 | 0 或一次复核 |
| L0.5 | `SOURCE_MATCH` | 原本会冷重放，但当前屏幕经多证据匹配确认就是目标来源状态；重复文本候选必须有强页面身份和精确控件定位 | 一次轻量观测 |
| L1 | `BACKTRACK` | 已采证 BACK 能力精确到达目标 | 1 |
| L2 | `GRAPH_PATH` | 当前状态到目标存在安全可重放路径 | 路径动作成本 |
| L4 | `COLD_REPLAY` | Cursor 无效、无图路径或前级失败 | 冷启动 + 根路径 |

L3 `ROUTE_ENTRY` 是可选扩展，本实现未自动生成 RouteEntry；没有已验证入口时直接进入 L4。

Graph Path 只使用安全、非 `NONREPEATABLE`、未 `INVALIDATED` 且 locator quality 为 `SEMANTIC_PORTABLE` 或 `SEMANTIC_WITH_FALLBACK` 的边。执行时根据当前 Observation 的 layout 重新解析 `intent` 得到设备动作；`DEVICE_BOUND` 与 `UNRESOLVED` 边保留为发现证据，但不进入自动续跑路径。

执行非冷导航时每步检查前台并稳定观测目标状态。首次失败会使 Cursor 失效并最多降级一次到 L4；系统、风险或未知弹窗暂停，不以冷启动掩盖问题。

Planner 产出不可变 NavigationPlan（含 `planFingerprint`）；每次 Claim 创建唯一 NavigationExecution。Execution 分别保存 `requestedMode` 与 `actualMode`，因此一次 `GRAPH_PATH -> COLD_REPLAY` 降级不会覆盖原计划，也不会与后续同计划执行混用证据。

BACK 不从 `arrivalSignature` 推断。只有 `back-capability.js` 在新鲜来源 Cursor 上实际按 BACK，并稳定到达预期目标后，才写入可用能力。

## 7. 调度与 Attempt

Frontier Scheduler 使用 bounded BFS 的深度和优先级，同时加入位置成本：

```text
score = semanticPriority + depthCost + navigationCost + deterministicTieBreak
```

navigationCost 在 Claim 时根据最新 Cursor 计算，而不是在 Frontier 创建时固定。这样能连续消费同一来源和附近页面的候选，同时保持确定性边界。

统一 `nextWork()` 返回：

- `DISCOVER`：存在可领取 Frontier 且必要验证容量充足。
- `BACKFILL_FRONTIER_SUGGESTIONS`：Frontier 和本 Run suggestion 已空，但 canonical `candidateCoverage` 指出旧节点还没有候选覆盖；先从本 Run 或历史 Observation 引用生成 suggestion。
- `SUGGEST_FRONTIER`：Frontier 已空但还有可应用候选建议，先把安全、未重复、未阻塞且未超预算的建议应用为 Frontier。
- `VERIFY`：目标验证优先、Frontier 已空，或剩余容量接近必要验证估算。
- `STOP`：没有 Frontier 与必要验证。

调度器按 Verification 失败的依赖范围隔离阻塞。超过重试上限的失败任务不会默认阻塞整个 Run；系统先从 `failure` 字段或 Restore 证据推导 `blockingEdgeIds`，只暂缓依赖这些 Edge 的 Frontier 和 Verification。若失败点无法推导，则按旧的保守语义返回 `REQUIRED_VERIFICATION_FAILED`。当只剩被失败依赖阻塞的工作时，返回 `WORK_BLOCKED_BY_FAILED_DEPENDENCIES` 并建议 `PARTIAL`。

Frontier Suggestion 是 Run 内候选投影，不是地图事实。调度器只提示可应用 suggestion；旧节点通过 backfill 生成候选，backfill 可读取 `VisualState.evidenceObservationRefs` 指向的历史 Run 证据但不会复制为本 Run Observation。登记到 canonical 时只同步 `candidateCoverage` 摘要，用来判断续扫是否需要补候选。

Attempt 状态主链：

```text
CLAIMED
  -> PLANNED_NAVIGATION
  -> SOURCE_READY
  -> READY_FOR_ACTION
  -> ACTION_SUCCEEDED
  -> AWAITING_VISUAL_REVIEW
     -> PAGE_OUTCOME VisualReview(ACCEPTED)
  -> AWAITING_OUTCOME_REVIEW
     -> PAGE | BUSINESS_MODAL -> READY_TO_COMMIT -> COMMITTED
     -> NO_STATE_CHANGE -> terminal without Edge
     -> DISMISSIBLE_POPUP -> cleanup and re-observe
     -> TRANSIENT -> re-observe
     -> SYSTEM_OR_UNKNOWN -> PAUSED
```

Attempt 固定 `claimToken`、候选哈希、来源状态、NavigationPlan、Cursor epoch 和 before Observation。动作后 Observation 必须先绑定 `PAGE_OUTCOME` VisualReview，才允许进入结构化 outcome review；入图提交还会再次校验该 VisualReview 为 `ACCEPTED`。重复 prepare 复用同一 Attempt；动作失败释放 Claim 为 `RETRYABLE` 或 `FAILED` 并使 Cursor 失效。

## 8. 发现与验证分层

稳定的 A → action → B 证据可提交 Edge，其初始 `replayStatus=UNVERIFIED`。提交后的 Edge 只要动作语义、安全和副作用规则允许，就可进入 runnable path；Verification Queue 独立执行冷启动完整重放：

- 探索模式：每个新 LogicalScreen 选择一条当前规范路径，规则为 `CANONICAL_SCREEN_PATH`。
- 目标模式：人工确认目标后验证该路径，规则为 `CONFIRMED_TARGET_PATH`。

Verification task key 绑定 `contextId + LogicalScreen/Decision + transitionFingerprintChain`。Task 表达稳定验证意图；每次运行创建唯一 `VerificationExecution`，记录 attemptNo、lease、固定 Edge/指纹链和结果。同页面规范路径变化时旧待办标为 `SUPERSEDED`，不同转换指纹不能继承验证。

验证证据不可覆盖，按 `evidence/verifications/<verification-id>/<execution-id>.json` 保存。执行器丢失时当前 Execution 标记 `ABANDONED`，Task 在重试上限内回到 `PENDING`，否则进入 `FAILED`。

验证失败会记录失败影响范围。能定位到具体步骤时，Task/Evidence 写入 `failure.failedEdgeId`、`failure.blockingEdgeIds` 与 `failure.scope`；调度器用这些字段判断哪些旁支仍可继续。无法定位失败 Edge 的旧数据或异常证据视为未知失败，继续保持全局停扫以避免误执行。

验证逐 Edge 稳定观测：

- 成功：相关 Edge 为 `COLD_REPLAY_VERIFIED`。
- 失败：保留发现事实，Edge 为 `REPLAY_UNSTABLE`，写入 unresolved。
- 未运行：保持 `UNVERIFIED`。

目标模式在路径验证后还有最终目标匹配判断。路径验证成功但最终截图/语义未强命中时，Verification Task 可记录 `pathReplayStatus=COLD_REPLAY_VERIFIED` 与 `goalMatchStatus=GOAL_REPLAY_NOT_STRONG`；这只表示目标未确认成功，不表示 Edge 链不稳定，也不得把相关 Edge 降级为 `REPLAY_UNSTABLE`。

验证状态不决定路径是否出现在地图里；它只决定 `verifiedPathEdgeIds`、`pathStatus` 和人工审阅提示。

目标路径还需最终截图强匹配。必要任务处于 `PENDING`、`RUNNING` 或 `FAILED` 时，Run 不能 `COMPLETED`。

## 9. 预算模型

用户配置只有：

```text
profile
maxActiveMinutes
maxDepth
```

内部硬上限：

- `maxDeviceActions`：全部设备动作总数。
- `maxStates`：本 Run 新增 ReachableState 数量，计算为当前图总 ReachableState 减去 `budgetBaseline.baselineReachableStates`；canonical seed 的已有状态不占用本 Run 状态预算。
- `maxColdStarts`：准备、恢复和验证冷启动总数。
- `maxActiveMinutes`：自动活动累计时间。

动作分为 `explorationActions`、`navigationActions`、`recoveryActions`、`verificationActions`、`interruptionActions`，但分类仅用于指标，五类之和受同一个 `maxDeviceActions` 约束。

`maxActiveMinutes` 计入动作、稳定观测等待、导航、恢复、验证和自动审查；排除计划确认、人工身份切换、人工候选确认、PAUSED 和产物构建。

`maxScrollsPerState`、`maxCandidatesPerState`、`cursorFreshnessMs` 等属于 profile 派生的搜索策略参数，不是用户预算。`maxEdges` 和 `maxRouteDepth` 已删除；深度统一由 `maxDepth` 约束。

## 10. 事件、恢复与终态

关键事实采用 event-first：

```text
validate intent
  -> append timeline event under Run lock
  -> idempotently project Graph / Frontier / Attempt / Cursor / Queue
```

`event-head.json` 保存最后事件序号和 timeline byte offset，避免每次动作扫描完整 timeline；`projection-state.json` 保存最后应用水位和关键投影摘要。正常恢复只读取水位之后的新事件，只有摘要不一致时才从 timeline 定向重建损坏的 Graph、Frontier、Cursor、Queue 等投影。

产物按写入语义分三类，由 `scripts/lib/artifact-registry.js` 统一判定：

- Projection：Run 状态、Context、Graph、Frontier、Cursor、Queue、Attempt、Operation、Goal、BackCapability、StateEquivalence、VisualEquivalence、Continuation `known/contexts`，以及状态型的 preparation/restore/navigation execution JSON；必须由 timeline 的 projectionOps 重建和比对。
- Evidence：Observation 截图/布局、ActionResult、VerificationExecution 证据和日志；允许写入后被引用校验，不作为状态投影反复修改。
- Generated：report、Snapshot generation 和 Dashboard；从已校验事实重新生成，不参与 Run projection 恢复。

所有 Run 内 ID 通过 `idAllocated` 事件推进 counter。ID 允许因失败或中断产生空洞，但不得存在 timeline 外的 counter 递增，避免恢复或重建后复用 ID。

所有可能改变设备状态的冷启动、候选动作、导航、恢复、BACK 和弹窗清理都先写 Operation Journal。执行进程消失且 Operation 仍为 `STARTED` 时结果不可推断：标记 `UNKNOWN_OUTCOME`、失效 Cursor、关联 Attempt 标记 `UNKNOWN_EFFECT` 并暂停 Run。

Restore 是 Navigation 与 Verification 共用的执行子状态机。调用方允许人工复核时可停在 `REVIEW_REQUIRED` 等待处理；调用方不允许复核时，状态不匹配、预算拒绝或恢复链错误必须先写 `FAILED` 再向外返回失败。Run 终结为 `PARTIAL` 或 `COMPLETED` 前，`validate-run.js` 必须确认不存在 `IN_PROGRESS` Restore。

终态语义：

- `COMPLETED`：本次已发现工作与必要验证收敛。
- `PARTIAL`：仍有待办、预算耗尽或用户主动截断，可创建 Continuation。
- `BLOCKED` / `FAILED`：环境或不可恢复错误。

硬预算耗尽是正常收敛原因。`nextWork()` 必须返回 `STOP` 和建议 `PARTIAL`，`finalize-scan.js` 先关闭活动计时窗口再做终结校验，避免超时 Run 卡在 `SCANNING`。

终态事件写入后 Run 不可变。`PAUSED` 是非终态，可原地恢复且暂停时间不计活动预算。

## 11. Canonical Map 与协议版本

当前图协议为 `graphProtocolVersion: 4`，`graph.json.schemaVersion: 2`。新 writer 只写当前结构，当前 reader、校验、Snapshot 和 Dashboard 均拒绝旧 graph 数据。

Graph v2 的路径事实以 App 语义为核心：Edge identity、transition fingerprint、验证任务 key 均基于 `intent`，不包含设备坐标、分辨率或模拟器信息。设备信息写入 Observation、ActionResult 和 locatorEvidence 作为 provenance，用于解释“这次是在哪台设备上观察到的”，不能作为路径可达性的 canonical key。

`maps/<context>` 是该登录态唯一可持续扩展的 canonical map，包含 graph、frontier、verification queue、back capabilities 和等价规则。`init-scan.js` 从当前 canonical map 种下 session 投影；`register-run.js` 在 Run 终结后把 `COMPLETED/PARTIAL` 的 graph/frontier/queue 同步回 canonical map，并用 `mapBaseRevisionId` 防止落后 session 覆盖较新的地图。

Canonical map 支持受控编辑。`map-edit.js` 通过 `lib/canonical-map-editor.js` 先生成 preview，列出级联影响并绑定当前 `mapRevisionId`；apply 时在锁内重新计算并校验 `confirmHash` 和 revision，随后写入新 revision 与 `canonicalMapEdited` 事件。编辑只影响 `maps/<context>`，历史 Run 证据保持不可变。Dashboard 后续 UI 只能复用这套 preview/apply 能力，不能直接修改 JSON。

Snapshot 不再跨 scan 聚合 graph。`build-snapshot.js` 读取 canonical map 生成不可变 generation；`run-index.json` 只提供执行历史、耗时和动作指标。跨 session 的旧证据通过 `evidenceObservationRefs`、`provenance` 和 `sourceRunId` 指向源 Run，不复制到当前 session。

## 12. 模块职责

- `lib/run-protocol.js`：协议访问。
- `lib/observation-store.js`：Observation、layout、screenshot 路径、fingerprint 与语义节点的统一读取入口。
- `lib/budget.js` / `lib/action-metrics.js`：简化预算、活动时间和分类动作指标。
- `lib/live-cursor.js`：Cursor lease、epoch、复核、建立和失效。
- `lib/navigation-planner.js` / `navigate-source.js`：分级导航计划与执行。
- `lib/path-replay-engine.js`：导航/恢复路径步骤的安全判定、定位类型归一和统一设备动作执行入口。
- `back-capability.js` / `lib/back-capability-store.js`：BACK 实际采证。
- `lib/frontier-scheduler.js`：位置感知 Frontier 排序。
- `next-work.js` / `lib/work-scheduler.js`：发现、验证、停止统一调度。
- `lib/verification-store.js` / `lib/verification-result.js` / `verify-path.js`：规范路径任务、恢复链验证判定和冷启动验证。
- `lib/review-policy.js`：Restore/Outcome 人工复核请求、可选 disposition 和等价复核可用性。
- `lib/device-action-executor.js` / `action-runner.js` / `popup-dismiss-runner.js` / `back-capability.js` / `navigate-source.js` / `restore-node.js`：候选动作、弹窗清理、BACK 能力采证、导航执行和恢复回放的 ActionResult/Restore 证据、Operation Journal 与 bridge 下发。
- `execute-frontier.js` / `commit-attempt.js`：Attempt 因果链和事务提交。
- `lib/recovery.js` / `rebuild-run.js`：事件投影恢复和可重建性。
- `validate-run.js`：协议、证据、预算、Cursor、队列与终态校验。
- `lib/canonical-map-store.js`：canonical map 初始化、session seed、revision guard 和同步。
- `lib/canonical-map-editor.js` / `map-edit.js`：canonical map 受控删除、reset、引用清理、preview/apply 和审计事件。
- `build-snapshot.js` / `build-dashboard.js`：从 canonical map 生成不可变 Snapshot 与离线展示。

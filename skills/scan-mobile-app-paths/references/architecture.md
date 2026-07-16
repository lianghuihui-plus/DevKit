# SMAP V3 技术架构

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
11. [兼容与聚合](#11-兼容与聚合)
12. [模块职责](#12-模块职责)

## 1. 目标与模式

SMAP 以黑盒方式扫描 HarmonyOS App 的稳定可达状态和交互路径。核心要同时满足：

- 尽量减少冷启动和已知路径重复重放。
- 每个动作保留完整的 before/action/after 证据。
- 区分“本次观察到转换”与“已从冷启动验证路径”。
- 在同样图、Cursor、Frontier、预算和目标输入下产生确定性调度结果。
- 允许旧 Run 只读参与新 Snapshot，而不改写历史事实。

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
  -> Snapshot / Dashboard
```

- Agent 负责页面语义、有限候选、弹窗分类与结构化视觉判断。
- Scheduler 决定下一项是发现、验证还是停止。
- Scan Engine 固化 Claim、导航、动作、审查和事务提交。
- Deterministic Core 负责所有可验证不变量。
- Runtime Bridge 只暴露探测、前台、重启、稳定采样所需原子动作。
- Snapshot/Dashboard 只消费已校验事实。

## 3. 单 Context Run

新 Run 使用 Protocol V3：

```text
scan.json
  schemaVersion: 3
  graphProtocolVersion: 3
  attemptProtocolVersion: 3
  contextId: guest | authenticated
  budget: {...}
  verificationRule: CANONICAL_SCREEN_PATH | CONFIRMED_TARGET_PATH
```

一个 Run 固定一个登录态和一个活动设备 Cursor，不再维护 `plannedContextIds`、动态 `activeContextId` 或 `budgetsByContext`。两个登录态分别扫描、分别计时、分别终结，再由 Snapshot 聚合。

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
- `LAYOUT_STABLE_VISUAL_DYNAMIC`：布局稳定、无加载语义，但视觉持续动态。

超时或前台不连贯的样本只能写诊断，不能成为图或目标证据。

图实体：

- `LogicalScreen`：跨 Run 稳定的产品语义页面。
- `VisualState`：稳定截图、布局与前台共同确定的视觉状态。
- `ReachableState`：`VisualState + contextId + arrivalSignature`。
- `Edge`：一次已观察转换及其安全、重放和证据属性。
- `Path`：由 Edge ID 构成的规范可达路径。

布局和截图都相同才为 `EXACT`；布局相同但截图不同最多为 `PROBABLE`。`wait` 不是图动作。动作后状态与来源 `EXACT` 时记录 `NO_STATE_CHANGE`，不生成 Edge。

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
| L1 | `BACKTRACK` | 已采证 BACK 能力精确到达目标 | 1 |
| L2 | `GRAPH_PATH` | 当前状态到目标存在安全可重放路径 | 路径动作成本 |
| L4 | `COLD_REPLAY` | Cursor 无效、无图路径或前级失败 | 冷启动 + 根路径 |

L3 `ROUTE_ENTRY` 是可选扩展，本实现未自动生成 RouteEntry；没有已验证入口时直接进入 L4。

Graph Path 只使用安全、非 `NONREPEATABLE`、未 `INVALIDATED` 的边。坐标边必须有有效 fallback bounds；语义定位边优先，坐标边增加成本。

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
- `VERIFY`：目标验证优先、Frontier 已空，或剩余容量接近必要验证估算。
- `STOP`：没有 Frontier 与必要验证。

Attempt 状态主链：

```text
CLAIMED
  -> PLANNED_NAVIGATION
  -> SOURCE_READY
  -> READY_FOR_ACTION
  -> ACTION_SUCCEEDED
  -> AWAITING_OUTCOME_REVIEW
     -> PAGE | BUSINESS_MODAL -> READY_TO_COMMIT -> COMMITTED
     -> NO_STATE_CHANGE -> terminal without Edge
     -> DISMISSIBLE_POPUP -> cleanup and re-observe
     -> TRANSIENT -> re-observe
     -> SYSTEM_OR_UNKNOWN -> PAUSED
```

Attempt 固定 `claimToken`、候选哈希、来源状态、NavigationPlan、Cursor epoch 和 before Observation。重复 prepare 复用同一 Attempt；动作失败释放 Claim 为 `RETRYABLE` 或 `FAILED` 并使 Cursor 失效。

## 8. 发现与验证分层

稳定的 A → action → B 证据可提交 Edge，其初始 `replayStatus=UNVERIFIED`。Verification Queue 独立执行冷启动完整重放：

- 探索模式：每个新 LogicalScreen 选择一条当前规范路径，规则为 `CANONICAL_SCREEN_PATH`。
- 目标模式：人工确认目标后验证该路径，规则为 `CONFIRMED_TARGET_PATH`。

Verification task key 绑定 `contextId + LogicalScreen/Decision + transitionFingerprintChain`。Task 表达稳定验证意图；每次运行创建唯一 `VerificationExecution`，记录 attemptNo、lease、固定 Edge/指纹链和结果。同页面规范路径变化时旧待办标为 `SUPERSEDED`，不同转换指纹不能继承验证。

验证证据不可覆盖，按 `evidence/verifications/<verification-id>/<execution-id>.json` 保存。执行器丢失时当前 Execution 标记 `ABANDONED`，Task 在重试上限内回到 `PENDING`，否则进入 `FAILED`。

验证逐 Edge 稳定观测：

- 成功：相关 Edge 为 `COLD_REPLAY_VERIFIED`。
- 失败：保留发现事实，Edge 为 `REPLAY_UNSTABLE`，写入 unresolved。
- 未运行：保持 `UNVERIFIED`。

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
- `maxStates`：ReachableState 数量。
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

所有可能改变设备状态的冷启动、候选动作、导航、恢复、BACK 和弹窗清理都先写 Operation Journal。执行进程消失且 Operation 仍为 `STARTED` 时结果不可推断：标记 `UNKNOWN_OUTCOME`、失效 Cursor、关联 Attempt 标记 `UNKNOWN_EFFECT` 并暂停 Run。

终态语义：

- `COMPLETED`：本次已发现工作与必要验证收敛。
- `PARTIAL`：仍有待办、预算耗尽或用户主动截断，可创建 Continuation。
- `BLOCKED` / `FAILED`：环境或不可恢复错误。

终态事件写入后 Run 不可变。`PAUSED` 是非终态，可原地恢复且暂停时间不计活动预算。

## 11. 兼容与聚合

兼容访问集中在 `lib/run-protocol.js`：

```text
runContextIds(scan)
runContextId(scan)
activeContextId(scan)
runBudget(scan, contextId)
isV3(scan)
```

新 writer 只写 V3。Reader、校验、报告、重建、Run Index、Snapshot 和 Dashboard 继续读取 V1/V2；历史多 Context Run 不能被 V3 的单 Context 校验误拒绝。

历史 Edge 的验证等级按可证明证据保守映射：只有从冷启动开始、根和每步精确匹配、动作与最终转换证据完整时才视为已验证；坐标或证据不足时为不稳定/未验证。

Snapshot 按 App、环境和版本聚合通过校验的 `COMPLETED` 与 `PARTIAL` Run。相同转换指纹的较新事实可继承验证；transition fingerprint 改变时不可继承。`mapRevisionId` 只表达扫描血缘。

## 12. 模块职责

- `lib/run-protocol.js`：V1/V2/V3 版本访问。
- `lib/budget.js` / `lib/action-metrics.js`：简化预算、活动时间和分类动作指标。
- `lib/live-cursor.js`：Cursor lease、epoch、复核、建立和失效。
- `lib/navigation-planner.js` / `navigate-source.js`：分级导航计划与执行。
- `back-capability.js` / `lib/back-capability-store.js`：BACK 实际采证。
- `lib/frontier-scheduler.js`：位置感知 Frontier 排序。
- `next-work.js` / `lib/work-scheduler.js`：发现、验证、停止统一调度。
- `lib/verification-store.js` / `verify-path.js`：规范路径任务和冷启动验证。
- `execute-frontier.js` / `action-runner.js` / `commit-attempt.js`：Attempt 因果链和事务提交。
- `restore-node.js`：L4 冷启动恢复与验证底层执行器。
- `lib/recovery.js` / `rebuild-run.js`：事件投影恢复和可重建性。
- `validate-run.js`：协议、证据、预算、Cursor、队列与终态校验。
- `build-snapshot.js` / `build-dashboard.js`：不可变聚合与离线展示。

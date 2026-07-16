---
name: scan-mobile-app-paths
description: 扫描鸿蒙 HarmonyOS App 的可达页面、页面状态与交互路径，支持全局探索、根据文字和一张截图寻找目标页面，以及从当前 Snapshot 确定性生成离线静态 HTML 路径看板。按登录态构建节点、跳转边、可重放路径、覆盖指标和未探索项。用户要求扫描 App 路径、生成页面地图或静态看板、比较登录与未登录路径、寻找目标页面、验证页面可达性、继续或加深已有扫描时使用；不用于根据既有测试用例执行 PASS/FAIL 断言，也不用于执行支付、删除、发布等有副作用的业务目标。
---

# 鸿蒙 App 路径地图扫描

## 执行入口

执行扫描时完整读取 `references/workflow.md`。修改或排查引擎时再读取 `references/architecture.md` 与 `references/artifact-contract.md`。

通过 `devecocli` 枚举设备和读取日志。已安装 App 的启动、前台检查、稳定观测与动作只能调用本 Skill 的 Harmony Runtime Bridge；不得临时拼接 `hdc` 或 `uitest` 绕过证据和预算协议。

## 不可变执行原则

- 仅支持 HarmonyOS；一个 `APP_MAP_ROOT` 固定属于一个 App 和一个环境。
- 仅有 `exploration` 与 `goal-directed` 两种扫描模式。Continuation 是新 Run 续扫一个已终结 `PARTIAL` Run 的血缘，不是第三种模式。
- 一个 Protocol V3 Run 只绑定一个 `contextId`：`guest` 或 `authenticated`。比较两种身份时创建两个独立 Run，再由 Snapshot 聚合；不存在单 Run 多登录态合计预算。
- 登录或退出由人工在 Run 开始前完成。计划确认后执行一次受控冷启动来建立根状态；后续扫描优先在当前前台页面连续执行，不为每个候选固定冷启动。
- 通过 locality-aware bounded BFS 探索：同一来源或附近状态优先，深度和优先级仍是确定性约束。
- 来源导航依次尝试 `LIVE_CURSOR`、已采证 `BACKTRACK`、`GRAPH_PATH`，不可用或失败时才 `COLD_REPLAY`。`always-replay` 只作为兼容和对照策略。
- Cursor 必须绑定 context、ReachableState、Observation、epoch、设备 mutation sequence 和新鲜度。动作前 Cursor 不匹配时先重新观测；不确定动作失败、前台漂移或比较失败时立即使 Cursor 失效。
- 发现事实与验证事实分离。稳定的动作前后 Observation 可以提交已发现 Edge；冷启动完整重放由独立 Verification Queue 证明。
- `verificationPolicy` 不是用户配置。只读 `verificationRule` 由模式固定：探索为 `CANONICAL_SCREEN_PATH`，目标查找为 `CONFIRMED_TARGET_PATH`。
- 探索模式为每个新 LogicalScreen 的当前规范路径建立验证任务；目标模式仅在人工确认候选后建立目标路径任务。必要验证未完成时不得以 `COMPLETED` 终结。
- 用户预算只暴露 `profile + maxActiveMinutes + maxDepth`。内部派生 `maxDeviceActions`、`maxStates`、`maxColdStarts`；探索、导航、恢复、验证、干扰动作只分类计量，共享设备动作总上限。
- `maxActiveMinutes` 是单 Run 自动活动时间累计上限，包含动作、稳定等待、导航、恢复和验证；不包含计划确认、人工登录/退出、人工候选确认、PAUSED 时间及产物构建。
- 每次 Claim 前调用统一 `nextWork()`，动态为必要验证保留时间、动作和冷启动容量；保留量影响调度顺序，不形成新的用户预算。
- 所有正式 Observation 必须经过公共稳定观测器。布局和截图均相同才为 `EXACT`；布局相同但截图不同最多为 `PROBABLE`。
- `wait` 只属于观测控制，禁止成为 Frontier、Attempt 候选、Edge 或路径步骤。动作后与来源 `EXACT` 时记录 `NO_STATE_CHANGE`，不入图。
- 业务弹窗可作为 `modal` 入图；明确可关闭提示只留清理证据；Toast/加载态原地重观察；系统、风险或不确定弹窗暂停。
- 通用清理只允许关闭、取消、稍后或已证明安全的 BACK；禁止自动点击确定、同意、允许、继续、提交、删除或支付。
- 支付、账号注销、真实发布/外发、敏感凭证输入等动作始终硬阻止，不能通过预算或配置解除。
- 每个 Frontier Claim 由唯一 `claimToken` 绑定 Attempt；候选动作、前后 Observation、Edge 与事务事件必须保持完整因果链。
- 关键写入统一先追加 timeline，再幂等更新投影；`event-head.json` 与 `projection-state.json` 提供 O(1) 事件头和增量恢复水位，摘要不一致时才定向重建损坏投影。
- 设备变更前必须写唯一 Operation Journal。进程丢失且结果不明时标记 `UNKNOWN_OUTCOME`、失效 Cursor 并暂停，不得把未知副作用当作普通失败重试。
- Verification Task 是稳定意图，每次尝试创建唯一 VerificationExecution，证据写入 `evidence/verifications/<verification-id>/<execution-id>.json`；NavigationPlan 与 NavigationExecution 同样分离。
- 新 writer 只生成 Protocol V3。V1/V2 Run 保持只读，通过统一版本访问器参与校验、登记、Snapshot 与 Dashboard，不做原地迁移。
- Run 终态不可变。`PAUSED` Run 原地恢复；`PARTIAL` Run 继续扫描时创建 Continuation，并重新建立根证据。
- Snapshot 写入不可变 generation 后原子更新 `snapshots/current.json`；Dashboard 只能从已校验 Snapshot 和固定模板生成。

## 标准流程

1. 探测设备能力，创建或校验单 App 产物根。
2. 选择模式和唯一登录态；目标模式先把文字与单张截图解析为 `GoalSpec`。
3. 创建 V3 Run，展示全部 profile、当前覆盖、单 Run 活动时间、最大深度、只读验证规则、安全边界和产物位置。
4. 用户确认最终 `planHash`；若改 profile 或预算，重新展示并确认新哈希。
5. 人工完成登录/退出后，受控冷启动并稳定观测；清理明确干扰后验证身份、建立根节点和 Live Cursor。
6. 循环调用 `next-work.js`。返回 `DISCOVER` 时 Claim Frontier，通过分级导航取得来源状态并执行候选；返回 `VERIFY` 时执行对应冷启动路径验证；返回 `STOP` 时收敛。
7. 对动作结果进行结构化审查；仅稳定页面或业务弹窗可提交 Edge。风险、上下文漂移和未知状态必须暂停。
8. 目标候选为 `STRONG` 或 `UNCERTAIN` 时暂停；人工确认后执行完整冷启动验证，只有强匹配可完成目标 Run。
9. 校验并终结 Run，登记后构建 Snapshot，再从当前 Snapshot 原子生成离线 Dashboard。

## 资源

- `references/workflow.md`：命令顺序、人工暂停点、导航和验证循环。
- `references/architecture.md`：V3 分层、Cursor、调度、预算与兼容架构。
- `references/artifact-contract.md`：Run、证据、事件、验证和 Snapshot 数据契约。
- `scripts/`：确定性执行入口、Harmony Runtime Bridge 和自测。
- `assets/dashboard-template.html`：无 App 数据的固定离线看板模板。

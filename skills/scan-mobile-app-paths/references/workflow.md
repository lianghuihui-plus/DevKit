# SMAP 执行工作流

## 目录

1. [运行边界](#1-运行边界)
2. [探测与初始化](#2-探测与初始化)
3. [目标模式输入](#3-目标模式输入)
4. [计划展示与确认](#4-计划展示与确认)
5. [单登录态准备](#5-单登录态准备)
6. [建立根状态](#6-建立根状态)
7. [统一工作循环](#7-统一工作循环)
8. [来源导航](#8-来源导航)
9. [候选执行与审查](#9-候选执行与审查)
10. [路径验证](#10-路径验证)
11. [目标候选确认](#11-目标候选确认)
12. [终结、登记与发布](#12-终结登记与发布)
13. [暂停与 Continuation](#13-暂停与-continuation)
14. [Canonical Map 编辑](#14-canonical-map-编辑)
15. [开发自测](#15-开发自测)

## 1. 运行边界

脚本使用自身路径定位依赖，可从任意 cwd 执行。产物只写入用户指定的绝对路径；不得写入 Skill 安装目录。

```bash
SMAP_SKILL=/absolute/path/to/scan-mobile-app-paths
APP_MAP_ROOT=/absolute/path/to/app-map
```

一个 `APP_MAP_ROOT` 只对应一个 App 和一个环境。所有入口输出 JSON；退出码非零或 `ok=false` 时按 `error.code` / `reasonCode` 收敛，不得绕过脚本修改投影。

设备枚举和日志必须用 `devecocli`。App 的停止、启动、前台检查、截图、控件树和原子动作必须经 Harmony Runtime Bridge。

## 2. 探测与初始化

先枚举设备并探测所选设备能力：

```bash
devecocli device list
"$SMAP_SKILL/scripts/probe-env.sh" --device <device-id>
```

能力缺失时报告具体诊断；截图、布局、前台识别或动作能力不可用时不得开始正式扫描。

首次为 App 建根目录：

```bash
node "$SMAP_SKILL/scripts/init-app-root.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --bundle-name com.example.app \
  --entry-ability EntryAbility \
  --environment test
```

生成探索计划预览：

```bash
node "$SMAP_SKILL/scripts/preview-plan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --device <device-id> \
  --context guest \
  --profile standard
```

生成目标计划预览：

```bash
node "$SMAP_SKILL/scripts/preview-plan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --device <device-id> \
  --context authenticated \
  --scan-mode goal-directed \
  --profile goal \
  --description '进入账号与安全页面' \
  --screenshot /absolute/path/target.png \
  --success-criteria '{"requiredTexts":["账号与安全"]}'
```

当前 Run 只接受一个 `--context guest|authenticated`。`--contexts` 仅作为单值兼容别名；传入逗号分隔多值会被拒绝。比较两个登录态时创建两个 Run。

默认 `--navigation-policy adaptive`。只有兼容回归或基线对照才使用 `--navigation-policy always-replay`。

## 3. 目标模式输入

目标模式在预览计划时直接提供一段文字和一张截图。预览阶段只读取截图、计算哈希并纳入 `planHash`，不创建正式 Run 目录；确认后由 `init-scan.js --confirmed-plan-hash` 把同一目标输入写入 `goal/`。

首期只接受一张目标截图。`GoalSpec` 必须绑定截图 SHA-256、context 和成功条件；不能仅凭整图像素相似度判定成功。

## 4. 计划展示与确认

预览命令输出 `createsRunDirectory=false`、建议 `scanId`、`planHash`、结构化 `initArgs` 和可直接执行的 `initCli`。Agent 在一个确认点展示计划：

- App、设备、环境、App 版本、扫描模式和唯一 `contextId`。
- 四个 profile 的适用模式及派生限制，并标明当前选择。
- 用户可配置的 `profile`、`maxActiveMinutes`、`maxDepth` 和相对预设的覆盖。
- 只读 `verificationRule` 和 `navigationPolicy`。
- 活动时间的计入/排除范围、人工介入点、停止条件和硬安全限制。
- 将要创建的 Run、报告、Snapshot 指针位置；Continuation 还展示父 Run 和导入/跳过待办。

当前预设：

| Profile | 模式 | 活动时间 | 最大深度 | 设备动作 | 状态 | 冷启动 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| quick | exploration | 10 分钟 | 3 | 150 | 30 | 20 |
| standard | exploration | 20 分钟 | 5 | 500 | 80 | 40 |
| deep | exploration | 60 分钟 | 8 | 1500 | 200 | 100 |
| goal | goal-directed | 15 分钟 | 7 | 300 | 50 | 30 |

只有 `maxActiveMinutes` 和 `maxDepth` 是用户预算覆盖项。`maxDeviceActions`、`maxStates`、`maxColdStarts` 是随 profile 派生的内部硬上限，不接受普通用户逐项调节。

确认前可改配置并重新预览；不要为了改 profile、预算或目标输入创建临时 Run。

用户明确确认后，必须带回预览给出的 `scanId` 和 `planHash` 创建正式 Run：

```bash
node "$SMAP_SKILL/scripts/init-scan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --scan-id <preview.scanId> \
  --device <device-id> \
  --context guest \
  --profile standard \
  --confirmed-plan-hash <planHash>
```

目标模式创建正式 Run 时还要传入与预览完全相同的目标输入：

```bash
node "$SMAP_SKILL/scripts/init-scan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --scan-id <preview.scanId> \
  --device <device-id> \
  --context authenticated \
  --scan-mode goal-directed \
  --profile goal \
  --description '进入账号与安全页面' \
  --screenshot /absolute/path/target.png \
  --success-criteria '{"requiredTexts":["账号与安全"]}' \
  --confirmed-plan-hash <planHash>
```

如果任一输入变化导致哈希不匹配，`init-scan.js` 必须在创建 `runs/<scan-id>` 之前失败。`show-plan.js`、`context.js configure-plan` 与 `context.js confirm-plan` 仅保留为读取或兼容入口，新流程不得优先使用。

`maxActiveMinutes` 是该 Run 处于自动活动状态的累计上限，不是一次动作、一次 Attempt 或多登录态批次的墙钟时间。人工确认、登录/退出、PAUSED 等待及产物构建不计入。

`verificationPolicy` 不存在于用户计划中。探索 Run 固定为 `CANONICAL_SCREEN_PATH`；目标 Run 固定为 `CONFIRMED_TARGET_PATH`。

## 5. 单登录态准备

先由人工把 App 数据置于 Run 绑定的身份：

- `guest`：人工退出登录。
- `authenticated`：人工完成登录。

随后无论 App 是否已经在前台，都执行一次受控冷启动建立根证据。冷启动是 `force-stop + start`，不清除 App 数据：

```bash
node "$SMAP_SKILL/scripts/prepare-context.js" prepare \
  --scan-dir <scan-dir> --context guest
```

若是加载/过渡态，原地重观察：

```bash
node "$SMAP_SKILL/scripts/prepare-context.js" observe-again \
  --scan-dir <scan-dir> --context guest \
  --preparation-id <preparation-id> \
  --observation-id <obs-id>
```

若是明确安全的提示弹窗，留证后清理：

```bash
node "$SMAP_SKILL/scripts/prepare-context.js" dismiss-popup \
  --scan-dir <scan-dir> --context guest \
  --preparation-id <preparation-id> \
  --observation-id <obs-id> \
  --dismiss-action '{"type":"tap","target":"关闭","fallbackBounds":[900,80,1040,220]}'
```

只能使用最终稳定 Observation 验证身份：

```bash
node "$SMAP_SKILL/scripts/context.js" verify \
  --scan-dir <scan-dir> --context guest \
  --observation-id <obs-id> \
  --markers-present '["登录"]'

node "$SMAP_SKILL/scripts/context.js" start \
  --scan-dir <scan-dir> --context guest
```

身份与计划明确冲突时以 `CONTEXT_MISMATCH` 暂停；不要创建第二个人工“确认登录态”步骤。

## 6. 建立根状态

Agent 必须读取最终截图与控件树，用大模型视觉能力确认截图可用、确实是要作为根的页面，并先写入 `ROOT_STATE` VisualReview。脚本不会自行做黑屏/白屏或页面识别视觉算法；它只校验这里记录的结构化结论：

```bash
node "$SMAP_SKILL/scripts/visual-review.js" record \
  --scan-dir <scan-dir> --context guest \
  --observation-id <obs-id> \
  --review-type ROOT_STATE \
  --assessment '{"status":"ACCEPTED","pageUsable":true,"pageKind":"page","pageName":"首页","confidence":"HIGH","rationale":"截图清晰，页面内容与根页面语义一致"}'
```

然后用同一 Observation 和 `visualReviewId` 建立或绑定根 VisualState 和 ReachableState。若本 Run 从 `maps/<context>` 种下了 canonical map，下面两个命令会复用已有 root，挂载本 Run 的根 Observation/VisualReview，并建立 Live Cursor；不会重复创建根节点。

```bash
node "$SMAP_SKILL/scripts/graph.js" upsert-visual \
  --scan-dir <scan-dir> --context guest --root true \
  --observation-id <obs-id> \
  --visual-review-id <visual-review-id> \
  --logical-screen-key home --name 首页

node "$SMAP_SKILL/scripts/graph.js" upsert-reachable \
  --scan-dir <scan-dir> --context guest --root true \
  --visual-state-id <visual-state-id> \
  --arrival-signature '{"backBehaviorKey":"root-exit"}' \
  --depth '{"pathDepth":0,"routeDepth":0,"modalDepth":0}'
```

创建或绑定根 ReachableState 会把 Live Cursor 建立在该状态。扫描已有 canonical map 时沿用已有 LogicalScreen id，不要发明新的页面版本名。

## 7. 统一工作循环

每次选择工作前调用：

```bash
node "$SMAP_SKILL/scripts/next-work.js" \
  --scan-dir <scan-dir> --context guest
```

只按返回结果行动：

- `DISCOVER`：添加/领取 Frontier 并执行候选。
- `VERIFY`：执行返回的验证任务，不再领取新 Frontier。
- `STOP`：没有开放 Frontier/必要验证，或硬预算已经耗尽，可进入终结检查；返回 `suggestedTerminalStatus=PARTIAL` 时按 `PARTIAL` 收敛。

`nextWork()` 会根据待验证路径长度、稳定观测耗时和一次冷启动估算必要容量；剩余容量接近该估算时先验证。这是调度保留量，不是独立预算。

如果 `reasonCode` 为 `MAX_ACTIVE_MINUTES`、`MAX_DEVICE_ACTIONS`、`MAX_COLD_STARTS` 或 `MAX_STATES`，不要再尝试动作、导航或验证；直接执行 `finalize-scan.js --status PARTIAL`。

Agent 从稳定截图和控件树产生有限、安全、可解释的候选。`wait`、纯观测、系统权限确认和高风险动作不得加入 Frontier：

```bash
node "$SMAP_SKILL/scripts/frontier.js" add \
  --scan-dir <scan-dir> --context guest \
  --from-reachable-state-id <state-id> \
  --candidate-group-key 'home/profile' \
  --candidate '{"type":"tap","target":"我的","fallbackBounds":[0,2100,270,2400],"routeTransition":true}'

node "$SMAP_SKILL/scripts/frontier.js" claim \
  --scan-dir <scan-dir> --context guest
```

Claim 时调度器使用当前 Cursor 重新计算导航成本，避免按加入 Frontier 时的过期位置排序。

脚本返回的 ID 都已经通过 `idAllocated` 写入 timeline。执行 agent 可以继续按返回值透传；如果某次分配后业务步骤失败，ID 空洞是合法审计事实，不需要也不能手工回填。

## 8. 来源导航

Claim 时按当前 Cursor 自动生成不可变 NavigationPlan，并为本次尝试分配唯一 NavigationExecution。Plan ID/指纹相同表示同一导航意图；每次执行、失败和冷重放降级都只更新自己的 Execution，不覆盖 Plan：

```bash
node "$SMAP_SKILL/scripts/execute-frontier.js" prepare \
  --scan-dir <scan-dir> --context guest \
  --frontier-id <frontier-id> --claim-token <claim-token>
```

导航等级如下：

| 模式 | 条件 | 冷启动 |
| --- | --- | --- |
| `LIVE_CURSOR` | Cursor 已在来源状态；过期时先轻量重观察 | 否 |
| `SOURCE_MATCH` | 原计划将冷重放，但当前屏幕通过前台、语义锚点、结构角色和候选控件多证据匹配到来源状态 | 否 |
| `BACKTRACK` | 当前状态到来源状态的 BACK 已实际采证 | 否 |
| `GRAPH_PATH` | 存在安全、可重放的已知边路径 | 否 |
| `COLD_REPLAY` | Cursor 无效、无可达路径或前级失败 | 是 |

`LIVE_CURSOR`、SOURCE_MATCH、BACK 和 Graph Path 每一步都检查目标 App 前台并与预期状态比较。来源确认接受 `EXACT` 或 `SOURCE_CONFIRMED`；`SOURCE_CONFIRMED` 来自归一化结构、语义锚点、角色相似度和候选控件线索，不能用于目标最终匹配或风险动作放行。非冷导航失败只允许一次降级到冷重放；Execution 同时记录 `requestedMode`、`actualMode`、`fallbackFrom` 和 `fallbackReason`。不得在不确定状态继续执行候选。

`SOURCE_CONFIRMED` 只用于安全候选的来源确认：候选控件必须通过文本、resourceId 或 accessibilityLabel 等语义线索命中；fallback bounds 只能辅助定位，不能单独证明来源页面。`LOW_RISK_FORM`、`WRITE`、`PROHIBITED` 或带副作用的动作不得仅凭 `SOURCE_CONFIRMED` 执行。

若进程在设备操作已开始后丢失，Run 会以 `OPERATION_OUTCOME_UNKNOWN` 暂停。先通过 Context Preparation 冷启动取得新的稳定 Observation，再由人工根据证据收敛原操作；`NO_EFFECT` 可释放候选重试，`EFFECT_OBSERVED` 放弃该候选，二者都不会把未知结果提交为 Edge：

```bash
node "$SMAP_SKILL/scripts/operation.js" reconcile \
  --scan-dir <scan-dir> \
  --operation-id <operation-id> \
  --resolution NO_EFFECT \
  --observation-id <fresh-observation-id>
```

已处于某状态且希望证明 BACK 能力时，可在新鲜 `EXACT` Cursor 上执行：

```bash
node "$SMAP_SKILL/scripts/back-capability.js" verify \
  --scan-dir <scan-dir> --context guest \
  --from-reachable-state-id <current-state-id> \
  --to-reachable-state-id <expected-state-id>
```

只有实际 BACK 后稳定到达预期状态的记录可供调度器使用。

## 9. 候选执行与审查

来源就绪后执行候选：

```bash
node "$SMAP_SKILL/scripts/execute-frontier.js" act \
  --scan-dir <scan-dir> --context guest \
  --attempt-id <prepareResult.attemptId>
```

`act` 返回 `visualReviewRequest` 后，Agent 必须先读取返回的稳定截图和控件树，用大模型视觉能力判断截图是否可用、是否能支持后续页面/弹窗分类，并记录 `PAGE_OUTCOME` VisualReview：

```bash
node "$SMAP_SKILL/scripts/visual-review.js" record \
  --scan-dir <scan-dir> --context guest \
  --attempt-id <actResult.attemptId> \
  --observation-id <actResult.visualReviewRequest.observationId> \
  --review-type PAGE_OUTCOME \
  --assessment '{"status":"ACCEPTED","pageUsable":true,"pageKind":"page","pageName":"我的","confidence":"HIGH","rationale":"截图清晰，主内容和底部导航可见"}'
```

只有 `ACCEPTED` 会把 Attempt 推进到 `AWAITING_OUTCOME_REVIEW`。`REJECTED`、`NEEDS_REOBSERVE` 或 `NEEDS_HUMAN_REVIEW` 会释放/终止本次 Attempt，不能继续写页面或边。视觉审查通过后，再提交以下结构化结果之一：

- `PAGE`：稳定全屏页面。
- `BUSINESS_MODAL`：稳定业务弹窗。
- `NO_STATE_CHANGE`：与来源 `EXACT`，不入图。
- `DISMISSIBLE_POPUP`：明确安全提示，清理后复核。
- `TRANSIENT`：Toast、加载或过渡态，原地重观察。
- `SYSTEM_OR_UNKNOWN`：系统、风险或不确定状态，暂停。

```bash
node "$SMAP_SKILL/scripts/execute-frontier.js" review-outcome \
  --scan-dir <scan-dir> --context guest \
  --attempt-id <visualReviewResult.attemptId> \
  --observation-id <obs-id> \
  --disposition PAGE
```

`PAGE` / `BUSINESS_MODAL` 进入 `READY_TO_COMMIT` 后提交：

```bash
node "$SMAP_SKILL/scripts/commit-attempt.js" \
  --scan-dir <scan-dir> --attempt-id <reviewResult.attemptId> \
  --logical-screen-key profile --name 我的
```

提交会校验 Attempt 绑定的 `PAGE_OUTCOME` VisualReview 为 `ACCEPTED`，再写事务事件并更新图、Frontier、Attempt、Cursor 和 Verification Queue 投影。动作执行失败会释放 Claim 并使 Cursor 失效。

## 10. 路径验证

查看队列：

```bash
node "$SMAP_SKILL/scripts/verify-path.js" list \
  --scan-dir <scan-dir> --context guest
```

执行 `nextWork()` 返回的探索验证任务：

```bash
node "$SMAP_SKILL/scripts/verify-path.js" run \
  --scan-dir <scan-dir> --context guest \
  --verification-id <verification-id>
```

验证从受控冷启动开始，逐 Edge 稳定观测并用状态等价能力比较。`EXACT` 或 `SAME_PAGE` 可证明路径仍可达；人工确认过的 `PROBABLE` 也可作为该次验证的等价证据。成功把路径 Edge 标记为 `COLD_REPLAY_VERIFIED`；失败保留发现事实并标为 `REPLAY_UNSTABLE`。规范路径变化时旧待办会被 `SUPERSEDED`，不会把旧验证继承给新的 transition fingerprint chain。

截图波动、列表数据或局部配置导致的渲染差异优先由 dump 树语义指纹自动判定为 `SAME_PAGE`。只有脚本无法自动证明但人工确认同页时，恢复和探索路径验证才写入并复用 `state-equivalence.json` 规则。该规则不能用于目标页面最终强匹配、动作无变化判断或风险动作放行。

## 11. 目标候选确认

目标模式对当前状态提交绑定目标截图与 Observation 截图 SHA-256 的结构化视觉判断：

```bash
node "$SMAP_SKILL/scripts/evaluate-goal.js" evaluate \
  --scan-dir <scan-dir> \
  --observation-id <obs-id> \
  --reachable-state-id <state-id> \
  --visual-assessment '<assessment-json>'
```

`STRONG` 和 `UNCERTAIN` 都会暂停并等待人工。只有明确 `REJECTED` 才继续搜索；`CONFIRMED_TARGET` 会建立 `CONFIRMED_TARGET_PATH` 验证任务：

```bash
node "$SMAP_SKILL/scripts/evaluate-goal.js" decide \
  --scan-dir <scan-dir> --decision-id <decision-id> \
  --human-decision CONFIRMED_TARGET

node "$SMAP_SKILL/scripts/verify-goal-path.js" prepare \
  --scan-dir <scan-dir> --decision-id <decision-id>

node "$SMAP_SKILL/scripts/verify-goal-path.js" confirm \
  --scan-dir <scan-dir> --visual-assessment '<replay-assessment-json>'
```

目标完成要求冷启动完整重放后的强匹配；`PROBABLE`、人工初次确认或仅已发现 Edge 都不能替代。

## 12. 终结、登记与发布

先让 `nextWork()` 收敛，再终结：

```bash
node "$SMAP_SKILL/scripts/finalize-scan.js" \
  --scan-dir <scan-dir> --status COMPLETED
```

有开放 Frontier、失败/待办验证或预算耗尽时使用 `PARTIAL`；不可恢复错误使用 `BLOCKED` / `FAILED`。终态 Run 不可修改。

登记并发布：

```bash
node "$SMAP_SKILL/scripts/register-run.js" --scan-dir <scan-dir>
node "$SMAP_SKILL/scripts/build-snapshot.js" --app-map-root "$APP_MAP_ROOT"
node "$SMAP_SKILL/scripts/build-dashboard.js" --app-map-root "$APP_MAP_ROOT"
```

`register-run.js` 会把 `COMPLETED/PARTIAL` Run 同步到 `maps/<context>`；若 Run 的 `mapBaseRevisionId` 已落后于当前 canonical map，则只登记执行历史，不覆盖地图。`build-snapshot.js` 默认读取 canonical map，不再跨 scan 聚合 run 图；`run-index.json` 只提供执行历史指标。

## 13. 暂停与 Continuation

运行中需要人工处理时暂停：

```bash
node "$SMAP_SKILL/scripts/context.js" pause \
  --scan-dir <scan-dir> --reason-code <reason-code>
```

同一个非终态 `PAUSED` Run 原地 `start` 恢复，不创建 Continuation。已终结 `PARTIAL` 需要继续时先预览新 Run：

```bash
node "$SMAP_SKILL/scripts/preview-plan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --device <device-id> --context guest \
  --profile standard \
  --parent-scan-id <partial-scan-id>
```

确认计划后再用同一个 `scanId` 和 `planHash` 创建正式 Run：

```bash
node "$SMAP_SKILL/scripts/init-scan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --scan-id <preview.scanId> \
  --device <device-id> --context guest \
  --profile standard \
  --parent-scan-id <partial-scan-id> \
  --confirmed-plan-hash <planHash>
```

父子必须具有相同 `scanMode`、`contextId`、App 身份与版本；目标模式还要求相同 `goalSpecHash`。Continuation 是执行血缘，不是第三种模式；新 Run 仍从当前 canonical map 种下已知图和待办，必须重新冷启动并绑定根 Observation，随后在同一 canonical map 上增量扩展。父 Run 保持不可变。

## 14. Canonical Map 编辑

地图编辑只作用于 `maps/<context>`，不能修改历史 `runs/<scan-id>` 证据。删除必须先预览，再由用户确认后应用：

```bash
node "$SMAP_SKILL/scripts/map-edit.js" preview-delete \
  --app-map-root "$APP_MAP_ROOT" \
  --context guest \
  --reachable-state-id <reachable-state-id>

node "$SMAP_SKILL/scripts/map-edit.js" preview-delete \
  --app-map-root "$APP_MAP_ROOT" \
  --context guest \
  --edge-id <edge-id>
```

预览输出 `editId`、`confirmHash`、`beforeMapRevisionId` 和影响范围，包括将删除或清理的 ReachableState、VisualState、LogicalScreen、Edge、Frontier、VerificationTask、BackCapability 与等价规则。删除 Edge 时，影响范围还包括同一来源状态、同一动作指纹的已探索 Frontier，确保删除后该入口后续可以重新被候选发现。Agent 必须向用户展示影响范围；不得跳过确认直接 apply。

用户确认后应用：

```bash
node "$SMAP_SKILL/scripts/map-edit.js" apply-delete \
  --app-map-root "$APP_MAP_ROOT" \
  --edit-id <edit-id> \
  --confirm-hash <confirmHash>
```

`apply-delete` 会在 canonical map 锁内重新计算计划，并要求当前 `mapRevisionId` 等于预览时的 `beforeMapRevisionId`；若期间有 Run 同步或其他编辑更新了地图，必须重新 preview。

普通删除不允许删除 root ReachableState。需要清空某个登录态地图时使用 reset：

```bash
node "$SMAP_SKILL/scripts/map-edit.js" preview-reset-context \
  --app-map-root "$APP_MAP_ROOT" \
  --context guest
```

删除或 reset 后重新构建 Snapshot 和 Dashboard 即可生效。后续新 Run 从更新后的 canonical map seed，不会继承被删除的节点或边；但如果 App 之后真实到达同一页面，仍可能重新发现，永久忽略需要单独的 ignore 规则。

看板接入时只能生成同样的 edit request 或命令，由 Agent/本地服务调用 `map-edit.js preview/apply`；看板静态 HTML 不得直接写 canonical JSON。

## 15. 开发自测

Restore 相关快速回归：

```bash
node scripts/self-test.js --scope restore
```

事件、投影、执行 lease 与未知设备副作用的故障注入测试：

```bash
node scripts/self-test.js --scope protocol
```

完整协议回归：

```bash
node scripts/self-test.js --scope full
```

修改脚本后先运行 `node --check`，再运行两级回归。真实设备至少运行 `probe-env.sh`；没有明确 bundle/Ability 和授权时不要在真实 App 上执行扫描动作。

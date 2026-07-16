# SMAP V3 执行工作流

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
14. [开发自测](#14-开发自测)

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

创建探索 Run：

```bash
node "$SMAP_SKILL/scripts/init-scan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --device <device-id> \
  --context guest \
  --profile standard
```

创建目标 Run：

```bash
node "$SMAP_SKILL/scripts/init-scan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --device <device-id> \
  --context authenticated \
  --scan-mode goal-directed \
  --profile goal
```

V3 只接受一个 `--context guest|authenticated`。`--contexts` 仅作为单值兼容别名；传入逗号分隔多值会被拒绝。比较两个登录态时创建两个 Run。

默认 `--navigation-policy adaptive`。只有兼容回归或基线对照才使用 `--navigation-policy always-replay`。

## 3. 目标模式输入

目标模式在展示计划前解析一段文字和一张截图：

```bash
node "$SMAP_SKILL/scripts/parse-goal.js" \
  --scan-dir <scan-dir> \
  --description '进入账号与安全页面' \
  --screenshot /absolute/path/target.png \
  --context authenticated \
  --success-criteria '{"requiredTexts":["账号与安全"]}'
```

首期只接受一张目标截图。`GoalSpec` 必须绑定截图 SHA-256、context 和成功条件；不能仅凭整图像素相似度判定成功。

## 4. 计划展示与确认

生成计划：

```bash
node "$SMAP_SKILL/scripts/show-plan.js" --scan-dir <scan-dir>
```

Agent 在一个确认点展示：

- App、设备、环境、版本、扫描模式和唯一 `contextId`。
- 四个 profile 的适用模式及派生限制，并标明当前选择。
- 用户可配置的 `profile`、`maxActiveMinutes`、`maxDepth` 和相对预设的覆盖。
- 只读 `verificationRule` 和 `navigationPolicy`。
- 活动时间的计入/排除范围、人工介入点、停止条件和硬安全限制。
- Run、报告、Snapshot 指针位置；Continuation 还展示父 Run 和导入/跳过待办。

当前预设：

| Profile | 模式 | 活动时间 | 最大深度 | 设备动作 | 状态 | 冷启动 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| quick | exploration | 10 分钟 | 3 | 150 | 30 | 20 |
| standard | exploration | 20 分钟 | 5 | 500 | 80 | 40 |
| deep | exploration | 60 分钟 | 8 | 1500 | 200 | 100 |
| goal | goal-directed | 15 分钟 | 7 | 300 | 50 | 30 |

只有 `maxActiveMinutes` 和 `maxDepth` 是用户预算覆盖项。`maxDeviceActions`、`maxStates`、`maxColdStarts` 是随 profile 派生的内部硬上限，不接受普通用户逐项调节。

确认前可改配置：

```bash
node "$SMAP_SKILL/scripts/context.js" configure-plan \
  --scan-dir <scan-dir> \
  --profile deep \
  --budget '{"maxActiveMinutes":30,"maxDepth":7}'
```

配置变化后必须重新展示计划并使用新哈希。用户明确确认后：

```bash
node "$SMAP_SKILL/scripts/context.js" confirm-plan \
  --scan-dir <scan-dir> \
  --plan-hash <plan-hash>
```

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

Agent 读取最终截图与控件树，命名 LogicalScreen，并用同一 Observation 建立根 VisualState 和 ReachableState：

```bash
node "$SMAP_SKILL/scripts/graph.js" upsert-visual \
  --scan-dir <scan-dir> --context guest --root true \
  --observation-id <obs-id> \
  --logical-screen-key home --name 首页

node "$SMAP_SKILL/scripts/graph.js" upsert-reachable \
  --scan-dir <scan-dir> --context guest --root true \
  --visual-state-id <visual-state-id> \
  --arrival-signature '{"backBehaviorKey":"root-exit"}' \
  --depth '{"pathDepth":0,"routeDepth":0,"modalDepth":0}'
```

创建根 ReachableState 会把 Live Cursor 建立在该状态。扫描已有 Snapshot 时优先沿用 LogicalScreen 的 `semanticKey`。

## 7. 统一工作循环

每次选择工作前调用：

```bash
node "$SMAP_SKILL/scripts/next-work.js" \
  --scan-dir <scan-dir> --context guest
```

只按返回结果行动：

- `DISCOVER`：添加/领取 Frontier 并执行候选。
- `VERIFY`：执行返回的验证任务，不再领取新 Frontier。
- `STOP`：没有开放 Frontier 和必要验证，可进入终结检查。

`nextWork()` 会根据待验证路径长度、稳定观测耗时和一次冷启动估算必要容量；剩余容量接近该估算时先验证。这是调度保留量，不是独立预算。

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
| `BACKTRACK` | 当前状态到来源状态的 BACK 已实际采证 | 否 |
| `GRAPH_PATH` | 存在安全、可重放的已知边路径 | 否 |
| `COLD_REPLAY` | Cursor 无效、无可达路径或前级失败 | 是 |

`LIVE_CURSOR`、BACK 和 Graph Path 每一步都检查目标 App 前台并与预期状态比较。非冷导航失败只允许一次降级到冷重放；Execution 同时记录 `requestedMode`、`actualMode`、`fallbackFrom` 和 `fallbackReason`。不得在不确定状态继续执行候选。

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
  --attempt-id <attempt-id>
```

Agent 必须读取返回的稳定截图和控件树，并提交以下之一：

- `PAGE`：稳定全屏页面。
- `BUSINESS_MODAL`：稳定业务弹窗。
- `NO_STATE_CHANGE`：与来源 `EXACT`，不入图。
- `DISMISSIBLE_POPUP`：明确安全提示，清理后复核。
- `TRANSIENT`：Toast、加载或过渡态，原地重观察。
- `SYSTEM_OR_UNKNOWN`：系统、风险或不确定状态，暂停。

```bash
node "$SMAP_SKILL/scripts/execute-frontier.js" review-outcome \
  --scan-dir <scan-dir> --context guest \
  --attempt-id <attempt-id> \
  --observation-id <obs-id> \
  --disposition PAGE
```

`PAGE` / `BUSINESS_MODAL` 进入 `READY_TO_COMMIT` 后提交：

```bash
node "$SMAP_SKILL/scripts/commit-attempt.js" \
  --scan-dir <scan-dir> --attempt-id <attempt-id> \
  --logical-screen-key profile --name 我的
```

提交会先写事务事件，再更新图、Frontier、Attempt、Cursor 和 Verification Queue 投影。动作执行失败会释放 Claim 并使 Cursor 失效。

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

验证从受控冷启动开始，逐 Edge 稳定观测和 `EXACT` 比较。成功把路径 Edge 标记为 `COLD_REPLAY_VERIFIED`；失败保留发现事实并标为 `REPLAY_UNSTABLE`。规范路径变化时旧待办会被 `SUPERSEDED`，不会把旧验证继承给新的 transition fingerprint chain。

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

Snapshot 默认聚合同一 App 版本下所有通过校验的 `COMPLETED` 与 `PARTIAL` Run；`mapRevisionId` 只表达血缘，不代表整图覆盖权威。

## 13. 暂停与 Continuation

运行中需要人工处理时暂停：

```bash
node "$SMAP_SKILL/scripts/context.js" pause \
  --scan-dir <scan-dir> --reason-code <reason-code>
```

同一个非终态 `PAUSED` Run 原地 `start` 恢复，不创建 Continuation。已终结 `PARTIAL` 需要继续时创建新 Run：

```bash
node "$SMAP_SKILL/scripts/init-scan.js" \
  --app-map-root "$APP_MAP_ROOT" \
  --device <device-id> --context guest \
  --profile standard \
  --parent-scan-id <partial-scan-id>
```

父子必须具有相同 `scanMode`、`contextId`、App 身份与版本；目标模式还要求相同 `goalSpecHash`。Continuation 继承 `mapRevisionId` 和可恢复知识，但必须重新冷启动建立根 Observation，再绑定导入 Frontier。父 Run 保持不可变。

## 14. 开发自测

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

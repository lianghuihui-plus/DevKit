# 动作模型

> 负责：动作 JSON、坐标证据、平台差异、adapter/atoms 边界。
> 不负责：执行流程、步骤证据、报告展示。
> 参见：`interfaces.md`、`workflow.md`、`failure-policy.md`。

## 原则

- 动作必须结构化，agent 不直接拼设备命令。
- 正式单动作走 `scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> ...`；动作后必然需要观察时可走框架稳定入口 `scripts/action-observe.sh`。
- `actionResult` 只能由 `action.sh` 写入 timeline。
- 业务步骤动作必须携带由冻结步骤生成的 `case-step` 授权；`action.sh` 和 `run-case.js` 都会在 adapter 调用或事实写入前校验 `stepId + intentSha`。
- 前置条件 Flow 动作在 adapter 调用前，必须由 `run-case.js` 对照 execution 冻结计划校验；失败时不得触发设备动作。
- adapter 和 atoms 不读写 case、不写 timeline、不做业务判断。

业务步骤授权示例：

```json
{"source":"case-step","stepId":"step-006","intentSha":"step-intent-0123456789abcdef"}
```

授权只证明动作属于当前冻结步骤，不对删除、支付、发布等关键词做语义分类。前置条件 Flow 和 execution-bootstrap 不使用该授权，其中 Flow 的副作用安全限制保持不变。

## 动作集合

```json
{"type":"launchApp","reason":"启动目标应用"}
{"type":"restartApp","reason":"冷启动隔离"}
{"type":"tap","x":512,"y":1720,"target":"登录按钮","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在登录按钮 bounds"}
{"type":"toggle","x":920,"y":640,"target":"通知开关","coordinateSource":"layout","targetBounds":[860,590,980,700],"coordinateEvidence":"控件树存在通知开关 bounds"}
{"type":"longPress","x":512,"y":1720,"durationMs":800,"target":"会话项","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在会话项 bounds"}
{"type":"inputText","text":"13800000000","target":"当前已聚焦输入框"}
{"type":"inputText","x":360,"y":640,"text":"13800000000","target":"手机号输入框","coordinateSource":"layout","coordinateEvidence":"控件树存在手机号输入框 bounds"}
{"type":"swipe","fromX":800,"fromY":1800,"toX":800,"toY":600,"velocity":600}
{"type":"back"}
{"type":"home"}
{"type":"wait","ms":1000,"reason":"等待页面稳定"}
```

`swipe.velocity` 的统一单位是 `px/s`，必须是 `200-40000` 的整数，缺省值为 `600`。HarmonyOS adapter 原样传递速度；Android 和 iOS adapter 按滑动距离换算平台所需时长：`durationMs = max(1, round(distance / velocity * 1000))`。`durationMs` 是 `longPress` 参数，不作为公开 `swipe` 参数。

动作字段由 `scripts/lib/action-contract.js` 作为唯一契约源：`validateActionAsset` 校验 Agent/Flow 资产的结构，`normalizeActionProposal` 归一 Agent 提案，`validateActionExecution` 按平台和作用域校验最终可执行参数，`describeActionConstraints` 把同一约束写入 DecisionRequest。未知字段、非法枚举或平台不支持的组合都在设备调用前以 `ACTION_CONTRACT_INVALID` 拒绝，不记录为设备 `TOOL_ERROR`。

动作类型按作用域开放：

| scope | 允许的动作 |
| --- | --- |
| `case-step` | `tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back`、`home`、`wait` |
| `precondition-flow` | `launchApp`、`tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back`、`home`、`wait` |
| `execution-bootstrap` | `restartApp` |
| `formal-execution` | 框架内部完整动作集合，仅用于统一入口防御性校验 |

`launchApp` 和 `restartApp` 不属于业务步骤动作；即使传入 `stepId` 也会在设备调用前以 `ACTION_CONTRACT_INVALID` 拒绝。

## 坐标证据

`tap`、`toggle`、`longPress` 以及 HarmonyOS `inputText` 使用 `x/y` 时必须传：

- `--coordinate-source`
- `--coordinate-evidence`
- `--target-bounds`，当来源为 `visual`、`pixel`、`flow` 时必传。

| source | 场景 | 要求 |
| --- | --- | --- |
| `layout` | 目标有控件树或布局节点 | 坐标来自目标节点 bounds |
| `visual` | 截图可见但无独立节点 | 提供截图目标区域 |
| `pixel` | 基于像素识别 | 提供像素目标区域 |
| `flow` | 前置条件 Flow 资产提供坐标 | 提供 Flow 原始 bounds 和当前页面证据 |
| `manual` | 历史值 | 正式执行禁用 |

业务步骤只接受 `layout`、`visual`、`pixel`；前置条件 Flow 额外接受 `flow`；`manual` 在所有正式执行中禁用。Agent 常见表达会在校验前归一并只保存规范值：`screenshot/image -> visual`，`uiTree -> layout`。DecisionRequest 中的 `actionConstraints` 是当前平台和作用域的机器可读权威约束。

若业务步骤或 Flow 动作提案仍不合法，框架不提交该轮 perception/decision，也不调用设备；它写入受保护的 `actionRejected` 事实并返回相同类型的新 DecisionRequest，其中 `lastActionRejection` 给出字段、允许值和修正建议。连续两次不合法后以 `BLOCKED/ACTION_CONTRACT_INVALID` 确定性收尾，避免停留在同一动作执行状态。

禁止用相邻文本、输入框、容器 bounds、缩放预览或大概位置猜坐标。坐标动作未命中后必须重新 observe 并更新证据，不能重复同一坐标硬试。

## 平台差异

| 平台 | 差异 |
| --- | --- |
| Android | `inputText` 不接受 `x/y`；必须先 `tap` 聚焦，再输入；中文等非 ASCII 依赖已由 `prepare-env.sh` 准备好的 MAVT Input IME |
| HarmonyOS | `inputText` 原子命令需要 `x/y/text`；这是平台约束，不推广到 Android |
| iOS | `inputText` 不接受 `x/y`；优先写入已聚焦输入框，仅在页面只有一个可见输入框时兜底；多输入框页面必须先 `tap` 聚焦目标输入框 |

上方第一个 `inputText` 示例适用于 Android/iOS 已聚焦输入框，第二个带坐标示例适用于 HarmonyOS；不要跨平台复用参数形态。

## launchApp / restartApp

- `launchApp` 使用已确认环境，不能在无人值守阶段猜入口。
- Android 显式 entry 失败时可回退包级 launcher，并记录 `launchMethod=monkey-fallback`。
- `restartApp` 是 execution 级隔离动作，默认由 `run-case.js --start` 自动调用。
- 自动调用的 `restartApp` 写入 `scope=execution-bootstrap`，不得绑定步骤或前置条件；该 scope 不对 case-executor 开放。
- `restartApp` 禁止绑定 `stepId`，不能作为步骤证据。
- 只有 `ok=true` 且 `coldStartVerified=true` 才算干净冷启动。
- `restartApp` 使用统一 `startupDisplayPolicy` 和 `startupDisplay` 结果契约；Core 只校验策略是否被验证，不包含平台命令分支。
- HarmonyOS 手机默认要求竖屏启动：停止旧进程后归一方向，启动 App 后再次验证；全部过程仍只写一条 `scope=execution-bootstrap` 的 `restartApp actionResult`。
- Android 与 iOS 当前默认 `preserve`；后续只需由各自 adapter 实现同一结果契约，不改变 Case Engine。
- 冷启动失败处理见 `failure-policy.md`。

## adapter / atoms

顶层动作入口分发到：

```text
scripts/platform/adapters/<platform>/action.sh
scripts/platform/adapters/<platform>/atoms/
```

atoms 只做最小能力：`tap`、`long-press`、`swipe`、`input-text`、`screenshot`、`dump-tree`、`foreground`、`logs`、`launch-app`、`restart-app`、`wait`。

不要在底层封装 `tap + inputText`、`tap + wait + assert`、`scroll until visible + tap`、`longPress + tap menu item` 这类 agent 可审计流程。

`action-observe.sh` 位于稳定入口层而不是 adapter/atoms。它只把已经由 Agent 决定的一个 action 与随后一次 observation 确定性串联，仍分别写入两条正式事实；不允许包含第二个动作、断言、目标搜索或自动重试。

## 预算

- 动作成功后默认等待 1000ms，可用 `--settle-ms` 或 `MAVT_ACTION_SETTLE_MS` 覆盖。
- 同一操作最多尝试 2 次。
- 单个前置条件 Flow 最多 5 个 UI 动作，单 case 全部前置条件 Flow 最多 12 个 UI 动作。
- Flow actionResult 保存规范化的 `requestedAction`，用于执行后再次核对动作类型和 Flow 已定义参数。
- 目标 App 离开前台后每次最多恢复 1 次，累计 2 次停止当前 case。

# 动作模型

> 负责：动作 JSON、坐标证据、平台差异、adapter/atoms 边界。
> 不负责：执行流程、步骤证据、报告展示。
> 参见：`interfaces.md`、`workflow.md`、`failure-policy.md`。

## 原则

- 动作必须结构化，agent 不直接拼设备命令。
- 正式执行只走 `scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> ...`。
- `actionResult` 只能由 `action.sh` 写入 timeline。
- 前置条件 Flow 动作在 adapter 调用前，必须由 `run-case.js` 对照 execution 冻结计划校验；失败时不得触发设备动作。
- adapter 和 atoms 不读写 case、不写 timeline、不做业务判断。

## 动作集合

```json
{"type":"launchApp","reason":"启动目标应用"}
{"type":"restartApp","reason":"冷启动隔离"}
{"type":"tap","x":512,"y":1720,"target":"登录按钮","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在登录按钮 bounds"}
{"type":"toggle","x":920,"y":640,"target":"通知开关","coordinateSource":"layout","targetBounds":[860,590,980,700],"coordinateEvidence":"控件树存在通知开关 bounds"}
{"type":"longPress","x":512,"y":1720,"durationMs":800,"target":"会话项","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在会话项 bounds"}
{"type":"inputText","text":"13800000000","target":"当前已聚焦输入框"}
{"type":"swipe","fromX":800,"fromY":1800,"toX":800,"toY":600,"velocity":600}
{"type":"back"}
{"type":"home"}
{"type":"wait","ms":1000,"reason":"等待页面稳定"}
```

`swipe.velocity` 的统一单位是 `px/s`，必须是 `200-40000` 的整数，缺省值为 `600`。HarmonyOS adapter 原样传递速度；Android 和 iOS adapter 按滑动距离换算平台所需时长：`durationMs = max(1, round(distance / velocity * 1000))`。`durationMs` 是 `longPress` 参数，不作为公开 `swipe` 参数。

动作字段由 `scripts/lib/action-contract.js` 分两级校验：`validateActionAsset` 校验 Agent/Flow 的语义动作，`validateActionExecution` 在 adapter 调用前按平台校验最终可执行参数。两级使用相同字段、类型和数值范围；未知字段或平台不支持的组合在设备调用前以参数错误拒绝，不记录为设备 `TOOL_ERROR`。

## 坐标证据

`tap`、`toggle`、`longPress` 使用 `x/y` 时必须传：

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

禁止用相邻文本、输入框、容器 bounds、缩放预览或大概位置猜坐标。坐标动作未命中后必须重新 observe 并更新证据，不能重复同一坐标硬试。

## 平台差异

| 平台 | 差异 |
| --- | --- |
| Android | `inputText` 不接受 `x/y`；必须先 `tap` 聚焦，再输入；中文等非 ASCII 依赖已由 `prepare-env.sh` 准备好的 MAVT Input IME |
| HarmonyOS | `inputText` 原子命令需要 `x/y/text`；这是平台约束，不推广到 Android |
| iOS | `inputText` 不接受 `x/y`；优先写入已聚焦输入框，仅在页面只有一个可见输入框时兜底；多输入框页面必须先 `tap` 聚焦目标输入框 |

## launchApp / restartApp

- `launchApp` 使用已确认环境，不能在无人值守阶段猜入口。
- Android 显式 entry 失败时可回退包级 launcher，并记录 `launchMethod=monkey-fallback`。
- `restartApp` 是 execution 级隔离动作，默认由 `run-case.js --start` 自动调用。
- `restartApp` 禁止绑定 `stepId`，不能作为步骤证据。
- 只有 `ok=true` 且 `coldStartVerified=true` 才算干净冷启动。
- 冷启动失败处理见 `failure-policy.md`。

## adapter / atoms

顶层动作入口分发到：

```text
scripts/platform/adapters/<platform>/action.sh
scripts/platform/adapters/<platform>/atoms/
```

atoms 只做最小能力：`tap`、`long-press`、`swipe`、`input-text`、`screenshot`、`dump-tree`、`foreground`、`logs`、`launch-app`、`restart-app`、`wait`。

不要在底层封装 `tap + inputText`、`tap + wait + assert`、`scroll until visible + tap`、`longPress + tap menu item` 这类 agent 可审计流程。

## 预算

- 动作成功后默认等待 1000ms，可用 `--settle-ms` 或 `MAVT_ACTION_SETTLE_MS` 覆盖。
- 同一操作最多尝试 2 次。
- 单个前置条件 Flow 最多 5 个 UI 动作，单 case 全部前置条件 Flow 最多 12 个 UI 动作。
- Flow actionResult 保存规范化的 `requestedAction`，用于执行后再次核对动作类型和 Flow 已定义参数。
- 目标 App 离开前台后每次最多恢复 1 次，累计 2 次停止当前 case。

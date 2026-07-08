# 动作模型

> 负责：动作 JSON、坐标证据、平台差异、adapter/atoms 边界。
> 不负责：执行流程、步骤证据、报告展示。
> 参见：`interfaces.md`、`workflow.md`、`failure-policy.md`。

## 原则

- 动作必须结构化，agent 不直接拼设备命令。
- 正式执行只走 `scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> ...`。
- `actionResult` 只能由 `action.sh` 写入 timeline。
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
| `flow` | 沿用 Flow 坐标 | 提供原 Flow bounds 和证据 |
| `manual` | 仅 Flow 录制 | 正式 case 禁用 |

禁止用相邻文本、输入框、容器 bounds、缩放预览或大概位置猜坐标。坐标动作未命中后必须重新 observe 并更新证据，不能重复同一坐标硬试。

## 平台差异

| 平台 | 差异 |
| --- | --- |
| Android | `inputText` 不接受 `x/y`；必须先 `tap` 聚焦，再输入；中文等非 ASCII 依赖已由 `prepare-env.sh` 准备好的 MAVT Input IME |
| HarmonyOS | `inputText` 原子命令需要 `x/y/text`；这是平台约束，不推广到 Android |
| iOS | 通过 Appium/WDA 适配；能力未准备按 `PLATFORM_UNIMPLEMENTED` 或 `TOOL_ERROR` |

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
- 单个前置条件最多 5 个 UI 动作，全部前置条件最多 12 个 UI 动作。
- 目标 App 离开前台后每次最多恢复 1 次，累计 2 次停止当前 case。

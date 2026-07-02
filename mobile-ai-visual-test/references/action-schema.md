# 动作模型

动作必须结构化；agent 不直接拼 shell 命令。

## 通用动作

```json
{"type":"launchApp","reason":"启动目标应用"}
{"type":"tap","x":512,"y":1720,"target":"登录按钮","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在登录按钮 bounds","reason":"当前页面存在登录按钮"}
{"type":"toggle","x":920,"y":640,"target":"通知开关","coordinateSource":"layout","targetBounds":[860,590,980,700],"coordinateEvidence":"控件树存在通知开关 bounds","reason":"当前页面存在通知开关"}
{"type":"longPress","x":512,"y":1720,"durationMs":800,"target":"会话项","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在会话项 bounds","reason":"长按会话项打开更多操作"}
{"type":"inputText","text":"13800000000","target":"当前已聚焦的手机号输入框"}
{"type":"swipe","fromX":800,"fromY":1800,"toX":800,"toY":600,"velocity":600}
{"type":"back"}
{"type":"home"}
{"type":"wait","ms":1000,"reason":"等待页面稳定"}
```

## 坐标来源

`tap`、`toggle`、`longPress` 只要使用 `x/y`，必须同时记录坐标来源和证据：

- `coordinateSource=layout`：目标本身存在于控件树或平台布局中，`targetBounds` 必须来自目标节点 bounds。
- `coordinateSource=visual`：目标不存在于控件树，但截图中可见，例如 H5 自绘按钮、图片按钮、Canvas 区域。
- `coordinateSource=pixel`：已基于截图像素区域识别目标边界。
- `coordinateSource=flow`：沿用已录制 Flow 的目标坐标和边界，必须同时提供原 Flow 的 `targetBounds` 和可复核证据，并在动作后重新 observe 验证。
- `coordinateSource=manual`：仅允许 Flow Recording Mode 中根据人工明确指令记录；正式 case execution 禁止使用。

`visual`、`pixel` 和 `flow` 坐标必须提供 `targetBounds=[x1,y1,x2,y2]`，点击点应取该区域中心或明确可命中的内部点。禁止把相邻文本、输入框或容器 bounds 当成自绘按钮的 bounds。

无 dump 树时，坐标必须基于原始截图像素计算：先统一坐标系，再识别目标可点击区域 bounds，最后取区域内部安全点；禁止直接凭缩放预览、文字中心、图标中心或大概位置猜坐标。

`longPress` 是独立原子动作，最小输入为 `x/y`，可选 `durationMs`，默认 800ms。长按后的菜单、选择、拖拽或验证不在底层组合，必须由 agent 继续 observe 后编排。

Android 的 `inputText` 只向当前已聚焦输入框输入文本，不接受 `x/y`；agent 必须先用 `tap` 聚焦输入框，再调用 `inputText`，然后通过后续 observe 验证文本是否进入目标输入框。

Android 的 `inputText` 对 ASCII 文本使用 `adb shell input text`；对中文等非 ASCII 文本，adapter 使用执行前已准备好的 MAVT Input IME 通道提交 Unicode 文本。`input-state` 只作为诊断信息写入 action result，不作为硬准入条件；即使 `hasEditableConnection=false`，也应先尝试输入，再由后置 observe 判断是否成功。MAVT Input IME 的构建、安装和启用必须在 `scripts/prepare-env.sh --case-dir <case-dir> --platform android` 中完成；业务步骤执行阶段如果依赖未准备，动作返回 `TOOL_ERROR`，不能现场安装输入法，也不能调用会触发系统异常的 `adb shell input text <中文>`。

HarmonyOS 的 `inputText` 必须提供 `x/y`，设备端命令形态为 `uitest uiInput inputText <x> <y> <text>`；这是 HarmonyOS 平台命令的最小必需输入，不应推广为 Android 的组合动作模型。

当目标是 H5 自绘/图片/Canvas，且控件树没有独立节点时，必须先从截图中识别目标像素边界，再点击边界中心；不能只根据附近文字或输入框 bounds 估算坐标。

一次坐标点击后页面无变化或命中错误区域时，不能重复使用同一 `x/y` 重试。必须重新 observe，并更换坐标证据；如果仍无法定位，停止并按失败策略记录 `ACTION_TARGET_NOT_FOUND` 或 `UNKNOWN`。

## 平台适配

`scripts/action.sh --platform <platform>` 分发到：

```text
scripts/platform/adapters/harmony/action.sh
scripts/platform/adapters/android/action.sh
scripts/platform/adapters/ios/action.sh
```

平台 adapter 内部使用统一 atoms 结构：

```text
scripts/platform/adapters/<platform>/atoms/
```

atoms 只做最小设备能力，例如 `tap.sh`、`long-press.sh`、`swipe.sh`、`input-text.sh`、`input-state.sh`、`screenshot.sh`、`dump-tree.sh`、`foreground.sh`、`logs.sh`、`launch-app.sh`、`wait.sh`。`action.sh` 只分发动作到 atoms，`observe.sh` 只组合一次观察快照所需 atoms；不要把 `tap + inputText`、`tap + wait + assert`、`scroll until visible + tap`、`longPress + tap menu item` 这类 agent 可编排流程封装到平台底层。

## launchApp

`launchApp` 使用已确认环境；无人值守执行阶段不能临时猜测启动入口。Android 若显式 `entry` 因非 exported Activity 等原因启动失败，adapter 可以回退到包级 launcher 启动，并在 action result 中记录 `launchMethod=monkey-fallback` 和 `fallbackReason`。

## 预算

- 动作成功后默认等待 1000ms 再返回，避免下一次 observe 过早截图；可用 `--settle-ms <ms>` 或 `MAVT_ACTION_SETTLE_MS` 覆盖。
- 除 `launchApp` 和 `wait` 外，带 `--step-id` 的 case-bound 动作执行前必须已有当前步骤的 `flowScan` 事实；该事实应由 `scripts/flow/record-scan.js ... --step-id <step-id>` 写入，缺失时顶层 `scripts/action.sh` 会在调用平台 adapter 前失败，错误码为 `FLOW_SCAN_REQUIRED`。创建 execution 后的全局扫描只用于建立候选库，不能替代步骤级扫描。
- 同一操作最多尝试 2 次。
- 单个前置条件最多 5 个 UI 动作。
- 所有前置条件合计最多 12 个 UI 动作。
- 目标应用离开前台后，每次最多恢复 1 次；累计离开前台 2 次则失败。

## 前台偏离

每次 observe 后判断 `Observation.app.inTargetApp`：

- execution-bound observe 的截图、布局、日志文件名使用 `<seq>-<label>`，按文件名排序即采集顺序。
- 仍在目标 App：继续当前步骤。
- 系统弹窗覆盖：只处理已知且文案明确的弹窗。
- 进入设置、浏览器、其他 App：最多用 `launchApp` 恢复 1 次，并写入 `timeline.jsonl`。
- 恢复后页面状态不可判断或业务上下文丢失：`FAIL/APP_CONTEXT_LOST`。
- 累计离开目标 App 2 次：`FAIL/APP_LEFT_FOREGROUND`。

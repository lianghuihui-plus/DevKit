# 动作模型

动作必须结构化；agent 不直接拼 shell 命令。

## 通用动作

```json
{"type":"launchApp","reason":"启动目标应用"}
{"type":"tap","x":512,"y":1720,"target":"登录按钮","coordinateSource":"layout","targetBounds":[120,1680,900,1780],"coordinateEvidence":"控件树存在登录按钮 bounds","reason":"当前页面存在登录按钮"}
{"type":"toggle","x":920,"y":640,"target":"通知开关","coordinateSource":"layout","targetBounds":[860,590,980,700],"coordinateEvidence":"控件树存在通知开关 bounds","reason":"当前页面存在通知开关"}
{"type":"inputText","x":360,"y":920,"text":"13800000000","target":"手机号输入框","coordinateSource":"layout","targetBounds":[120,860,960,980],"coordinateEvidence":"控件树存在手机号输入框 bounds"}
{"type":"swipe","fromX":800,"fromY":1800,"toX":800,"toY":600,"velocity":600}
{"type":"back"}
{"type":"home"}
{"type":"wait","ms":1000,"reason":"等待页面稳定"}
```

## 坐标来源

`tap`、`toggle`、`inputText` 只要使用 `x/y`，必须同时记录坐标来源和证据：

- `coordinateSource=layout`：目标本身存在于控件树或平台布局中，`targetBounds` 必须来自目标节点 bounds。
- `coordinateSource=visual`：目标不存在于控件树，但截图中可见，例如 H5 自绘按钮、图片按钮、Canvas 区域。
- `coordinateSource=pixel`：已基于截图像素区域识别目标边界。
- `coordinateSource=flow`：沿用已录制 Flow 的目标坐标和边界。
- `coordinateSource=manual`：人工明确指定坐标。

`visual` 和 `pixel` 坐标必须提供 `targetBounds=[x1,y1,x2,y2]`，点击点应取该区域中心或明确可命中的内部点。禁止把相邻文本、输入框或容器 bounds 当成自绘按钮的 bounds。

当目标是 H5 自绘/图片/Canvas，且控件树没有独立节点时，必须先从截图中识别目标像素边界，再点击边界中心；不能只根据附近文字或输入框 bounds 估算坐标。

一次坐标点击后页面无变化或命中错误区域时，不能重复使用同一 `x/y` 重试。必须重新 observe，并更换坐标证据；如果仍无法定位，停止并按失败策略记录 `ACTION_TARGET_NOT_FOUND` 或 `UNKNOWN`。

## 平台适配

`scripts/action.sh --platform <platform>` 分发到：

```text
scripts/platform/adapters/harmony/action.sh
scripts/platform/adapters/android/action.sh
scripts/platform/adapters/ios/action.sh
```

## launchApp

`launchApp` 使用已确认环境；无人值守执行阶段不能临时猜测启动入口。

## 预算

- 动作成功后默认等待 1000ms 再返回，避免下一次 observe 过早截图；可用 `--settle-ms <ms>` 或 `MAVT_ACTION_SETTLE_MS` 覆盖。
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

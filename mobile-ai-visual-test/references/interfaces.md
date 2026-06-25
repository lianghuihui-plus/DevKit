# 模块接口

skill 只编排流程；确定性能力走模块接口，JSON 契约为准。

## 分层职责

```text
Skill 编排层
  -> 读取用例、确认环境、处理前置条件、执行循环、失败策略、报告规则

模块接口层
  -> CaseRepository、PlatformAdapter、Perception、Decision、Reporter、MetricsCollector

平台适配层
  -> harmony、android、ios
```

- 平台适配器只做设备事实采集和动作执行，不做用例判断。
- Perception 只做页面理解和候选目标识别。
- Decision 由 agent 根据用例、规则、观察事实和页面理解完成。
- Reporter/MetricsCollector 只从事实文件生成报告和统计。

## CaseRepository

负责用例空间和执行产物：

- 导入外部 Markdown 为 `source.md`。
- 从 `source.md` 生成 `case.json`。
- 追加 `notes.jsonl` 并重放用户补充。
- 创建 `executions/<executionId>/`。
- 读写 `timeline.jsonl`、`result.json`、`metrics.json`、`state.json`。

## PlatformAdapter

平台适配器必须提供同一组能力：

```text
probe(env?) -> EnvironmentProbe
observe(env, options) -> Observation
act(env, action) -> ActionResult
```

当前脚本入口：

```bash
scripts/probe-env.sh --platform <platform>
scripts/observe.sh --case-dir <case-dir> --execution-id <id> --platform <platform> ...
scripts/action.sh --case-dir <case-dir> --execution-id <id> --platform <platform> ...
```

正式执行用例时必须调用顶层 `scripts/observe.sh`、`scripts/action.sh`；平台实现放在：

```text
scripts/platform/adapters/<platform>/probe.sh
scripts/platform/adapters/<platform>/observe.sh
scripts/platform/adapters/<platform>/action.sh
```

## EnvironmentProbe

用于执行前环境确认。

```json
{
  "schemaVersion": 1,
  "type": "environmentProbe",
  "platform": "harmony",
  "targets": ["127.0.0.1:5555"],
  "capabilities": {
    "connector": "hdc",
    "screenshot": true,
    "layout": true,
    "foregroundApp": false,
    "logs": false,
    "launchApp": true,
    "actions": ["launchApp", "tap", "toggle", "inputText", "swipe", "back", "home", "wait"]
  }
}
```

必填：`schemaVersion`、`type`、`platform`、`targets`、`capabilities`。

## Observation

视觉和 CLI 事实的统一载体。

```json
{
  "schemaVersion": 1,
  "type": "observation",
  "platform": "harmony",
  "time": "2026-06-17T10:00:00.000Z",
  "label": "step-001-before",
  "artifacts": {"screenshot": "screenshots/step-001-before.png", "layout": "layouts/step-001-before.json", "logs": []},
  "device": {"id": "127.0.0.1:5555", "screen": null},
  "app": {
    "appId": "com.example.demo",
    "foregroundApp": "com.example.demo",
    "entry": "EntryAbility",
    "inTargetApp": true
  },
  "capabilities": {"screenshot": true, "layout": true, "foregroundApp": true, "logs": true}
}
```

必填：`schemaVersion`、`type`、`platform`、`time`、`label`、`artifacts`、`capabilities`。

`artifacts` 只记录相对当前 execution 目录的路径。

前台 App 和日志采集 best-effort；失败信息写入 `capabilities` 或 `raw`。

## Action

agent 只输出结构化动作：

```json
{
  "type": "tap",
  "target": "登录按钮",
  "x": 512,
  "y": 1720,
  "coordinateSource": "layout",
  "targetBounds": [120, 1680, 900, 1780],
  "coordinateEvidence": "控件树存在登录按钮 bounds",
  "reason": "截图和控件树均显示登录按钮"
}
```

动作集合：`launchApp`、`tap`、`toggle`、`inputText`、`swipe`、`back`、`home`、`wait`。

坐标动作必须说明坐标来源。`layout` 只能用于目标本身存在控件树节点的场景；H5 自绘、图片按钮、Canvas 等没有独立节点的目标必须使用 `visual` 或 `pixel`，并提供截图目标区域 `targetBounds` 和 `coordinateEvidence`。

## ActionResult

动作执行事实：

```json
{
  "schemaVersion": 1,
  "type": "actionResult",
  "platform": "harmony",
  "time": "2026-06-17T10:00:01.000Z",
  "action": "tap",
  "ok": true,
  "x": 512,
  "y": 1720,
  "coordinateSource": "layout",
  "targetBounds": [120, 1680, 900, 1780],
  "coordinateEvidence": "控件树存在登录按钮 bounds"
}
```

动作失败时返回或落盘错误事实。

## Perception

页面理解输出示例：

```json
{
  "pageState": "login_page",
  "visibleTexts": ["手机号", "验证码", "登录"],
  "candidates": [
    {
      "role": "login_button",
      "text": "登录",
      "bounds": [120, 1800, 960, 1900],
      "coordinateSource": "layout",
      "confidence": 0.92,
      "evidence": ["screenshot", "layout"]
    },
    {
      "role": "send_button",
      "text": null,
      "bounds": [839, 1201, 901, 1275],
      "coordinateSource": "pixel",
      "confidence": 0.86,
      "evidence": ["screenshot-orange-pixel-region"]
    }
  ],
  "risks": []
}
```

Perception 不执行动作、不判定最终通过。

## Decision

输入：

- `case.json` 当前步骤。
- `case.json.globalRules` 当前 case 的全局规则。
- `notes.jsonl` 用户补充。
- 当前 `Observation`。
- Perception 输出。
- 历史 `timeline.jsonl`。
- 前置条件、安全预算和失败策略。

输出：`act`、`assert_pass`、`assert_fail`、`wait`、`blocked`。

`globalRules` 只在当前 case execution 内生效。agent 根据观察事实判断规则是否命中；平台适配器和底层脚本不直接解释规则条件。

规则命中、跳过或失败时，agent 写入 `rule` 事实事件：

```json
{
  "type": "rule",
  "ruleId": "rule-001",
  "status": "MATCHED",
  "stepId": "step-002",
  "reason": "检测到权限弹窗"
}
```

`ruleId` 必须引用当前 `case.json.globalRules` 中存在的规则；`status` 使用 `MATCHED`、`SKIPPED`、`FAILED`、`BLOCKED` 或 `UNKNOWN`。

## Reporter 和 MetricsCollector

Reporter 渲染 `CONTEXT.md`/`CONTEXT.html`。MetricsCollector 生成 `metrics.json`。

报告和统计不得成为执行依据；下一次执行依据仍是 `source.md`、`case.json`、`notes.jsonl` 和已确认环境。

- `scripts/run-case.js <case-dir> --start` 创建 execution。
- `scripts/observe.sh --case-dir <case-dir> --execution-id <id> ...` 采集观察并自动记录。
- `scripts/action.sh --case-dir <case-dir> --execution-id <id> --step-id <step-id> ...` 执行动作并自动记录。
- `scripts/run-case.js <case-dir> --record-json <json>` 追加非平台事实事件。
- `scripts/run-case.js <case-dir> --finalize --status <status>` 聚合结果并刷新报告。

## BusinessFlowRepository

业务路径 Flow 是人工指挥 agent 录制出来的可复用业务操作参考，不替代 `case.json` 的用例步骤，也不替代 agent 的实时判断。

当前脚本入口：

```bash
scripts/flow/start-recording.js --name <flow-name> --intent <intent1,intent2> [--cwd <workspace-cwd>] [--platform <platform>] [--device <device>] [--app <appId>] [--entry <entry>]
scripts/flow/observe.sh --flow-dir <flow-dir> --recording-id <id> ...
scripts/flow/action.sh --flow-dir <flow-dir> --recording-id <id> --instruction <text> --type <action> ...
scripts/flow/finalize-recording.js <flow-dir> --recording-id <id> --status READY
```

`start-recording.js` 会把录制环境写入 Flow `state.json`；后续 `flow/observe.sh` 和 `flow/action.sh` 未显式传平台、设备、应用或入口时，必须继承该环境。

正式执行用例时，agent 必须在创建 execution 后调用 `scripts/flow/list-flows.js --cwd <workspace-cwd>` 扫描 `ai-visual-test/flows/` 的可用 Flow，并读取脚本输出作为候选业务路径库。脚本输出包含可执行参考步骤；不允许 agent 自己拼目录扫描。

当步骤文本、前置条件或当前页面目标包含业务导航语义时，例如“进入 AI 精灵页面”“打开创作页”“登录账号”“点击某业务入口后再验证”，agent 必须先尝试匹配候选 Flow；匹配依据包括 `name`、`intent`、`humanInstruction`、`successHint` 和当前页面状态。

每次扫描、使用、跳过或失败都必须在当前 execution 的 `timeline.jsonl` 写入 `flowScan` / `flow` 事实事件。涉及具体失败步骤时，`flowScan.stepId` 必须等于该失败步骤，否则不能作为该步骤的扫描证据；`PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 这类结论必须传 `--failed-step`。

`flowScan` 事件示例：

```json
{
  "type": "flowScan",
  "status": "COMPLETED",
  "candidateCount": 3,
  "matchedFlowIds": ["flow-xxxxxxxxxxxx"],
  "stepId": "step-002",
  "reason": "步骤需要进入 AI 精灵页面"
}
```

`flowScan.status` 使用 `COMPLETED`、`EMPTY` 或 `FAILED`。

```json
{
  "type": "flow",
  "flowId": "flow-xxxxxxxxxxxx",
  "flowStepId": "flow-step-001",
  "status": "STEP_COMPLETED",
  "stepId": "step-002",
  "reason": "已参考录制路径点击创作入口"
}
```

`flow` 状态使用 `STARTED`、`STEP_STARTED`、`STEP_COMPLETED`、`COMPLETED`、`FAILED`、`SKIPPED`、`BLOCKED`。

如果 agent 在未扫描 Flow 的情况下直接探索相似入口并失败，该执行不应直接判定业务阻塞；必须补做 Flow 扫描和匹配后再下结论。`PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 等结论缺少 `--failed-step` 或缺少同一失败步骤的 `flowScan` 事实时会被降级为 `UNKNOWN/FLOW_SCAN_MISSING`。

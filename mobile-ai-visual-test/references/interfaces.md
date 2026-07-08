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
- 创建当前平台的 `platforms/<platform>/executions/<executionId>/`。
- 读写当前平台的 `timeline.jsonl`、`result.json`、`metrics.json`、`state.json`。

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
scripts/observe.sh --case-dir <case-dir> --execution-id <id> --platform <platform> (--step-id <step-id>|--scope global) ...
scripts/action.sh --case-dir <case-dir> --execution-id <id> --platform <platform> ...
```

agent 可直接调用的稳定入口只包括三类，主执行入口保持精简，维护和 Flow 入口按需使用：

```text
scripts/probe-env.sh
scripts/resolve-execution-targets.js
scripts/parse-case.js
scripts/preflight-preconditions.js
scripts/update-env.js
scripts/prepare-env.sh
scripts/run-case.js
scripts/observe.sh
scripts/action.sh
scripts/apply-note.js
scripts/refresh-case.js
scripts/render-context.js
scripts/render-index.js
scripts/flow/start-recording.js
scripts/flow/observe.sh
scripts/flow/action.sh
scripts/flow/finalize-recording.js
scripts/flow/record-scan.js
```

`scripts/platform/`、`scripts/platform/adapters/`、`scripts/platform/adapters/<platform>/atoms/`、`scripts/case/`、`scripts/report/`、`scripts/execution/`、`scripts/lib/` 都是内部实现层；可以被稳定入口调用，但不作为 agent 操作入口。

顶层 `scripts/common.js` 仅是兼容导出层；共享实现放在 `scripts/lib/common.js`，shell 入口的公共逻辑放在 `scripts/lib/action-common.sh`。新增或重构脚本时，应优先复用 `scripts/lib/`，避免把内部实现重新暴露成 agent 入口。

正式执行用例时必须调用顶层 `scripts/observe.sh`、`scripts/action.sh`；平台实现放在：

```text
scripts/platform/adapters/<platform>/probe.sh
scripts/platform/adapters/<platform>/observe.sh
scripts/platform/adapters/<platform>/action.sh
```

正式执行必须显式传 `--platform <harmony|android|ios>`，顶层 case-bound observe/action/run-case 会拒绝缺少平台参数的调用。无平台根运行态只用于历史产物兼容，需显式 `--legacy-runtime`。步骤内观察必须给 `scripts/observe.sh` 传 `--step-id <step-id>`；非步骤级环境快照或诊断观察必须显式传 `--scope global` 或 `--global-observation`。

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
    "actions": ["launchApp", "restartApp", "tap", "toggle", "longPress", "inputText", "swipe", "back", "home", "wait"]
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

必填：`schemaVersion`、`type`、`platform`、`time`、`label`、`artifacts`、`capabilities`、`source`。正式 case execution 中 `source` 必须为 `observe.sh`，并且只能由顶层 `scripts/observe.sh` 的内部写入通道生成。

`artifacts` 只记录相对当前 execution 目录的路径；写入 observation 和 assertion 引用 observation 产物时，框架会校验对应文件存在。

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

动作集合：`launchApp`、`restartApp`、`tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back`、`home`、`wait`。

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

- `scripts/run-case.js <case-dir> --platform <platform> --start` 创建当前平台 execution，并自动通过顶层动作入口写入 execution 级 `restartApp` 冷启动事实；冷启动失败或不可验证时根据 `case.json.isolation.requireCleanRestart` 和自动推断结果决定阻塞或隔离降级。
- `scripts/preflight-preconditions.js <case-dir|caseNo|caseKey|title>... --cwd <workspace-cwd>` 在创建 execution 前批量归纳前置条件，输出 `READY`、`CONFIRM`、`NEEDS_SETUP`、`UNKNOWN`、`UNSUPPORTED` 分类，供用户决定哪些用例进入无人值守执行。
- `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>` 在 execution 创建前准备当前平台必需依赖，写入 `state.json.dependencies`，并刷新当前平台报告。
- `scripts/observe.sh --case-dir <case-dir> --platform <platform> --execution-id <id> (--step-id <step-id>|--scope global) ...` 采集观察并自动记录，内部写入 `source:"observe.sh"`；步骤内观察必须传 `--step-id`，报告据此把截图证据关联到用例步骤；非步骤观察必须显式标记全局。
- `scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> --step-id <step-id> ...` 执行动作并自动记录；`restartApp` 禁止绑定 `stepId`；非 `launchApp`、非 `wait` 的业务动作要求当前步骤已有 `COMPLETED` 或 `EMPTY` 的 `flowScan`，`FAILED` 扫描不能作为动作前置。
- `scripts/run-case.js <case-dir> --platform <platform> --record-json <json>` 追加非平台事实事件；正式观察只能由 `scripts/observe.sh` 自动写入，直接手写 `observation` 会被 `OBSERVATION_SOURCE_REQUIRED` 拒绝；正式动作结果只能由 `scripts/action.sh` 自动写入，直接手写 `actionResult` 会被 `ACTION_RESULT_SOURCE_REQUIRED` 拒绝；`assertion PASS` 必须引用当前步骤已有且由 `scripts/observe.sh` 写入的 observation 截图、布局或 label，例如 `{"type":"assertion","stepId":"step-001","status":"PASS","reason":"截图显示首页","evidence":["screenshots/001-step-001-after.png"]}`，缺失时以 `ASSERTION_EVIDENCE_REQUIRED` 拒绝。
- `scripts/run-case.js <case-dir> --platform <platform> --finalize --status <status>` 聚合结果并刷新当前平台报告。

## BusinessFlowRepository

业务路径 Flow 是人工指挥 agent 录制出来的可复用业务操作参考，不替代 `case.json` 的用例步骤，也不替代 agent 的实时判断。

当前脚本入口：

```bash
scripts/flow/start-recording.js --name <flow-name> --intent <intent1,intent2> --platform <platform> [--flow-scope universal|platform] [--cwd <workspace-cwd>] [--device <device>] [--app <appId>] [--entry <entry>]
scripts/flow/observe.sh --flow-dir <flow-dir> --recording-id <id> ...
scripts/flow/action.sh --flow-dir <flow-dir> --recording-id <id> --instruction <text> --type <action> ...
scripts/flow/finalize-recording.js <flow-dir> --recording-id <id> --status READY
scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id> [--step-id <step-id>] [--matched-flow-ids <id,id>]
```

`start-recording.js` 会把录制环境写入 Flow `state.json`；后续 `flow/observe.sh` 和 `flow/action.sh` 未显式传平台、设备、应用或入口时，必须继承该环境。

正式执行用例时，agent 必须在创建 execution 后调用 `scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>` 扫描 `<workspace-cwd>/flows/` 的可用 Flow，并读取脚本输出作为全局候选业务路径库；任何带 `stepId` 的步骤事实都要求这个 execution 级全局扫描已存在且可用。每个业务步骤匹配或动作前，必须再调用 `record-scan.js ... --step-id <step-id>` 写入步骤级 `flowScan`。脚本输出包含可执行参考步骤，并自动把带 `source=list-flows`、`flowsRoot`、`scannedFlowIds` 的 `flowScan` 事实写入当前 execution；不允许 agent 自己拼目录扫描或手写缺少扫描来源的 `flowScan`。带平台扫描默认只返回当前平台专用 Flow 和通用 Flow。`status=FAILED` 的扫描事实只能用于审计失败原因，不能满足后续步骤或动作守卫。

Flow 默认跨平台通用。录制时的 `recordingPlatform` 只表示采集环境；只有 `flow.json`/`state.json` 中存在 `platform` 字段，或 Flow 名称显式带有 `-android`、`-ios`、`-harmony` 这类平台标识时，才视为平台专用 Flow；同语义匹配时，当前平台专用 Flow 优先于通用 Flow。

当步骤文本、前置条件或当前页面目标包含业务导航语义时，例如“进入 AI 精灵页面”“打开创作页”“登录账号”“点击某业务入口后再验证”，agent 必须先尝试匹配候选 Flow；匹配依据包括 `name`、`intent`、`humanInstruction`、`successHint` 和当前页面状态。

每次扫描、使用、跳过或失败都必须在当前 execution 的 `timeline.jsonl` 写入 `flowScan` / `flow` 事实事件。涉及具体失败步骤时，`flowScan.stepId` 必须等于该失败步骤，否则不能作为该步骤的扫描证据；`PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 这类结论必须传 `--failed-step`。

`flowScan` 事件示例：

```json
{
  "type": "flowScan",
  "source": "list-flows",
  "status": "COMPLETED",
  "candidateCount": 3,
  "scannedFlowIds": ["flow-xxxxxxxxxxxx", "flow-bbbbbbbbbbbb", "flow-cccccccccccc"],
  "matchedFlowIds": ["flow-xxxxxxxxxxxx"],
  "flowsRoot": "<workspace-cwd>/flows",
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

如果 agent 在未扫描 Flow 的情况下直接探索相似入口并失败，该执行不应直接判定业务阻塞；必须补做 Flow 扫描和匹配后再下结论。`PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 等结论缺少 `--failed-step` 或缺少同一失败步骤的 `flowScan` 事实时会被归一为 `BLOCKED/FLOW_SCAN_MISSING`。

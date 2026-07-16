# 接口契约

> 本文件负责：稳定顶层入口、内部层级、事件类型和关键 JSON 契约。
> 本文件不负责：端到端阶段顺序、动作参数细节、failureCode 语义、报告展示规则。
> 相关文件：`workflow.md`、`action-schema.md`、`failure-policy.md`、`context-format.md`。

## 分层

```text
Skill 协议层
  SKILL.md
  references/*.md

稳定入口层
  scripts/probe-env.sh
  scripts/resolve-execution-targets.js
  scripts/parse-case.js
  scripts/preflight-preconditions.js
  scripts/update-env.js
  scripts/prepare-env.sh
  scripts/run-case.js
  scripts/observe.sh
  scripts/action.sh

内部实现层
  scripts/case/
  scripts/execution/
  scripts/report/
  scripts/lib/
  scripts/flow/

平台能力层
  scripts/platform/
  scripts/platform/adapters/<platform>/
  scripts/platform/adapters/<platform>/atoms/
```

agent 只调用稳定入口层。内部实现层、平台 adapter 和 atoms 不作为 agent 入口。

## 稳定入口

| 入口 | 职责 |
| --- | --- |
| `scripts/resolve-execution-targets.js` | 分流已有 case 与 Markdown 输入 |
| `scripts/parse-case.js` | 创建或刷新 case 资产 |
| `scripts/preflight-preconditions.js` | 严格匹配前置条件 Flow 并生成带哈希的执行计划 |
| `scripts/probe-env.sh` | 探测平台和设备能力 |
| `scripts/update-env.js` | 固化设备、App 和入口到平台 state |
| `scripts/prepare-env.sh` | 准备平台依赖 |
| `scripts/run-case.js` | 创建 execution、写 agent 事实、finalize、守卫和报告刷新 |
| `scripts/observe.sh` | 采集 observation 并写入 timeline |
| `scripts/action.sh` | 执行动作并写入 actionResult |
| `scripts/render-context.js` | 重渲染 case 报告 |
| `scripts/render-index.js` | 重渲染 workspace 总览 |

正式 case-bound 入口必须显式传 `--platform <harmony|android|ios>`。

### 参数所有权

稳定入口必须在调用平台 adapter、写 timeline 或触发 finalize 前拒绝未知参数，参数错误统一退出 `2`。平台分发器只选择 adapter，不解释业务参数；adapter 和 atom 继续做防御性校验，不得静默忽略未知参数。

| 参数类型 | 所属层 | 是否下传到 adapter |
| --- | --- | --- |
| `case-dir`、`execution-id`、`step-id`、`scope`、Flow 绑定参数 | 稳定入口 | 否 |
| `reason`、`target`、`coordinate-*`、`settle-ms` | 稳定入口的审计或编排信息 | 否 |
| `type`、坐标、`text`、`ms`、`velocity`、`duration-ms` | 统一动作参数 | 是，仅传动作所需字段 |
| `device`、`app/bundle`、`entry/ability` | 平台环境参数 | 是 |
| iOS Appium/WDA 参数 | `update-env.js` 固化的 state | 仅在 case-bound 入口解析完成后注入 iOS adapter |

新增参数时必须先在本节和对应领域契约中确定所有权，再修改稳定入口与 adapter；不能依靠底层忽略多余参数维持兼容。

## PlatformAdapter

平台 adapter 对外提供统一能力：

```ts
interface PlatformAdapter {
  probe(): EnvironmentProbe
  observe(input: ObserveInput): Observation
  action(input: Action): ActionResult
}
```

adapter 内部可以调用 atoms，但不得：

- 读取或修改 case 业务资产。
- 写入 `timeline.jsonl`。
- 做业务判断。
- 把 agent 可审计编排的多步流程封装成黑盒组合。

## EnvironmentProbe

`probe-env` 输出平台能力事实：

```json
{
  "schemaVersion": 1,
  "platform": "android",
  "devices": [{"id": "device-id", "name": "Pixel"}],
  "capabilities": {
    "screenshot": true,
    "uiTree": true,
    "foreground": true,
    "logs": true,
    "actions": ["launchApp", "restartApp", "tap", "inputText", "swipe", "back", "wait"],
    "dependencies": {"mavtInputIme": {"ok": true}}
  }
}
```

目标 App、入口和当前前台状态不由 `probe-env` 固化；目标信息由 `update-env.js` 写入，当前状态由 `observe.sh` 采集。

## Observation

正式 observation 必须由 `scripts/observe.sh` 写入，并带 `source: "observe.sh"`。

```json
{
  "schemaVersion": 1,
  "type": "observation",
  "source": "observe.sh",
  "ok": true,
  "platform": "android",
  "stepId": "step-001",
  "label": "001-step-001-before",
  "app": {
    "inTargetApp": true,
    "appId": "com.example.app",
    "activity": ".MainActivity"
  },
  "artifacts": {
    "screenshot": "screenshots/001-step-001-before.png",
    "layout": "layouts/001-step-001-before.json",
    "logs": "logs/001-step-001-before.log"
  }
}
```

步骤内观察必须传 `--step-id <step-id>`。全局诊断观察必须显式传 `--scope global` 或 `--global-observation`。前置条件 Flow 观察使用 `--scope precondition-flow`，绑定 `preconditionId`、`flowId` 和 `phase`，不得绑定 `stepId`。

前置条件 Flow observation 只有在 `ok=true` 且包含截图、布局或有效前台应用事实时才能作为证据；失败 observation 仍写 timeline，但带 `ok=false` 和专用失败码。

## ActionResult

正式 actionResult 必须由 `scripts/action.sh` 写入，并带 `source: "action.sh"`。

```json
{
  "schemaVersion": 1,
  "type": "actionResult",
  "source": "action.sh",
  "platform": "android",
  "stepId": "step-001",
  "action": "tap",
  "ok": true,
  "target": "登录按钮",
  "coordinateSource": "layout",
  "targetBounds": [120, 1680, 900, 1780],
  "coordinateEvidence": "控件树存在登录按钮 bounds"
}
```

动作集合和坐标要求见 `action-schema.md`。前置条件 Flow 动作使用 `scope=precondition-flow`，并绑定 `preconditionId`、`flowId`、`flowStepId`；它不属于 case step。

业务步骤中的 `actionResult ok=true` 只证明动作执行成功。即使随后已有同步骤 observation，也不能单独完成步骤或进入下一步；每个业务步骤最终都必须写入满足下述视觉证据门禁的 `assertion PASS`。

Flow 动作执行前由 `run-case.js` 对照 `execution.json` 中冻结的 action 做硬校验，actionResult 同时保存 `requestedAction` 供执行后复核。

## Agent 事实

agent 可通过 `run-case.js --record-json` 写入非平台事实：

| 类型 | 用途 |
| --- | --- |
| `precondition` | 当前 execution 内的前置条件结果 |
| `perception` | 影响后续动作的视觉理解 |
| `decision` | 影响后续动作或断言的决策 |
| `rule` | 全局规则或弹窗规则处理 |
| `flow` | 前置条件 Flow 的开始、步骤完成、完成或失败事实 |
| `assertion` | 步骤断言结果 |

不要为了说明想法写入不会影响执行的事实。

用于支持业务 `assertion PASS` 的 `perception` 必须绑定当前步骤最新 observation 的截图：

```json
{
  "type": "perception",
  "stepId": "step-001",
  "status": "USABLE",
  "evidence": ["screenshots/001-step-001-after.png"],
  "reason": "已实际查看当前截图，内容完整且足以判断本步骤"
}
```

`status` 可为 `USABLE`、`UNUSABLE` 或 `UNCERTAIN`。只有 `USABLE` 且包含 `reason` 的当前截图 perception 可以支持 PASS；其他 perception 仍可用于记录影响后续动作的视觉理解，但不能作为通过门禁。

`precondition` 最小模板：

```json
{
  "type": "precondition",
  "id": "pre-001",
  "status": "PASS",
  "reason": "用户已在执行前确认登录态满足"
}
```

`status` 只允许 `PASS`、`PREPARED`、`FAIL`、`UNKNOWN`、`BLOCKED`。`PASS` 和 `PREPARED` 允许进入步骤，其余状态会收尾当前 execution。

## Assertion

每个业务步骤都必须以 `assertion PASS` 作为通过证据。PASS 必须引用当前步骤最新 observation 的截图，并且此前已有引用同一截图的 `perception status=USABLE`：

```json
{
  "type": "assertion",
  "stepId": "step-001",
  "status": "PASS",
  "reason": "截图显示已进入首页",
  "evidence": ["screenshots/001-step-001-after.png"]
}
```

业务 assertion 的 `evidence` 只能引用 observation 产物路径；`label` 只用于定位和展示。前置条件 Flow 的 `evidenceObservation` 标识协议不受此规则影响。

证据要求和 PASS 归一规则见 `failure-policy.md`。

## Precondition Flow

Flow 事件只允许服务于前置条件：

```json
{
  "type": "flow",
  "usage": "precondition",
  "preconditionId": "precondition-001",
  "flowId": "flow-enter-creation",
  "flowStepId": "flow-step-001",
  "status": "STEP_COMPLETED",
  "reason": "动作成功且 after observation 已确认"
}
```

`status` 允许 `STARTED`、`STEP_COMPLETED`、`COMPLETED`、`FAILED`、`BLOCKED`。`STARTED` 前必须有 `entry-check` observation；`STEP_COMPLETED` 前必须有同 Flow step 的成功 actionResult 和 `after` observation；`COMPLETED` 前必须有 `end-check` observation。完整协议见 `flow-format.md`。

Flow 终态不可逆；终态后的下一条相关事实必须是同一前置条件的对应终态，之后不得重新 entry-check 或 STARTED。

## Result

`result` 事件、`result.json` 和 `metrics.json` 由 `run-case.js --finalize` 写入。报告产物语义见 `context-format.md`。

## 来源守卫

- 公开 `run-case.js --record-json` 不接受正式 `observation`。
- 公开 `run-case.js --record-json` 不接受正式 `actionResult`。
- 正式观察必须走 `observe.sh`。
- 正式动作必须走 `action.sh`。
- 直接手写观察或动作结果会被拒绝。

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
  scripts/flow/*.js|*.sh

内部实现层
  scripts/case/
  scripts/execution/
  scripts/report/
  scripts/lib/

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
| `scripts/preflight-preconditions.js` | 执行前批量归纳前置条件 |
| `scripts/probe-env.sh` | 探测平台和设备能力 |
| `scripts/update-env.js` | 固化设备、App 和入口到平台 state |
| `scripts/prepare-env.sh` | 准备平台依赖 |
| `scripts/run-case.js` | 创建 execution、写 agent 事实、finalize、守卫和报告刷新 |
| `scripts/observe.sh` | 采集 observation 并写入 timeline |
| `scripts/action.sh` | 执行动作并写入 actionResult |
| `scripts/render-context.js` | 重渲染 case 报告 |
| `scripts/render-index.js` | 重渲染 workspace 总览 |
| `scripts/flow/start-recording.js` | 创建 Flow 录制会话 |
| `scripts/flow/observe.sh` | 录制 Flow observation |
| `scripts/flow/action.sh` | 录制 Flow action |
| `scripts/flow/finalize-recording.js` | 生成 Flow 资产 |
| `scripts/flow/record-scan.js` | 扫描可用 Flow 并写入 execution |

正式 case-bound 入口必须显式传 `--platform <harmony|android|ios>`。

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

步骤内观察必须传 `--step-id <step-id>`。全局诊断观察必须显式传 `--scope global` 或 `--global-observation`。

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

动作集合和坐标要求见 `action-schema.md`。

## Agent 事实

agent 可通过 `run-case.js --record-json` 写入非平台事实：

| 类型 | 用途 |
| --- | --- |
| `precondition` | 当前 execution 内的前置条件结果 |
| `perception` | 影响后续动作的视觉理解 |
| `decision` | 影响后续动作或断言的决策 |
| `rule` | 全局规则或弹窗规则处理 |
| `flow` | Flow 使用、跳过、失败或完成事实 |
| `assertion` | 步骤断言结果 |

不要为了说明想法写入不会影响执行的事实。

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

`assertion PASS` 必须引用当前步骤已有 observation 证据：

```json
{
  "type": "assertion",
  "stepId": "step-001",
  "status": "PASS",
  "reason": "截图显示已进入首页",
  "evidence": ["screenshots/001-step-001-after.png"]
}
```

证据要求和 PASS 归一规则见 `failure-policy.md`。

## FlowScan

`flowScan` 必须由 `scripts/flow/record-scan.js` 写入：

```json
{
  "type": "flowScan",
  "source": "list-flows",
  "status": "COMPLETED",
  "flowsRoot": "flows",
  "candidateCount": 2,
  "scannedFlowIds": ["flow-xxx"],
  "matchedFlowIds": ["flow-xxx"],
  "stepId": "step-002"
}
```

Flow 录制、扫描和使用规则见 `flow-format.md`。

## Result

`result` 事件、`result.json` 和 `metrics.json` 由 `run-case.js --finalize` 写入。报告产物语义见 `context-format.md`。

## 来源守卫

- 公开 `run-case.js --record-json` 不接受正式 `observation`。
- 公开 `run-case.js --record-json` 不接受正式 `actionResult`。
- 正式观察必须走 `observe.sh`。
- 正式动作必须走 `action.sh`。
- 直接手写观察或动作结果会被拒绝。

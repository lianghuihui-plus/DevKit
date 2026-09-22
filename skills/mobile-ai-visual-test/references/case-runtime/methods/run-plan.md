# CaseRuntime.runPlan

连续执行受约束的短时动作、等待、采集、定位和技术检查计划。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
runPlan({ submissionId: string, sceneRef: string, purpose: string, maxDurationMs: number, onFailure: "STOP" | "CONTINUE", steps: Array<object | object | object | object | object | object>, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `submissionId` | 是 | `string` | 本次计划提交的幂等键 |
| `sceneRef` | 是 | `string` | 当前 Scene |
| `purpose` | 是 | `string` | 计划的业务目的 |
| `maxDurationMs` | 是 | `number` | 计划总时限，1 到 30000 毫秒 |
| `onFailure` | 是 | `"STOP" \| "CONTINUE"` | STOP 或受限 CONTINUE |
| `steps` | 是 | `Array<object \| object \| object \| object \| object \| object>` | 最多 12 个声明式步骤 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.steps: Array<{ id: string; type: "act"; actionRef: string; input?: { point?: Array<number>; pointRef?: string; from?: Array<number>; to?: Array<number>; text?: string; mode?: "replace" | "append"; durationMs?: number; ms?: number } } | { id: string; type: "wait"; ms: number } | { id: string; type: "capture"; mode: "SCREENSHOT_ONLY" | "FULL_SCENE"; promote?: boolean } | { id: string; type: "locate"; sourceRef: string; locator: { kind: "ELEMENT_REF"; elementRef: string } | { kind: "POINT"; point: Array<number> } | { kind: "REGION"; region: Array<number> } } | { id: string; type: "check"; sourceRef: string; predicate: { kind: "CAPTURE_AVAILABLE" } | { kind: "ELEMENT_VISIBLE"; elementRef: string } | { kind: "ELEMENT_ENABLED"; elementRef: string } | { kind: "APP_IN_FOREGROUND" } | { kind: "REFERENCE_EXISTS"; reference: string } } | { id: string; type: "checkpoint"; evidenceRefs?: Array<string> }>
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
```

## 条件要求

- 步骤 id 唯一；$<stepId>.<field> 只能引用已完成的先前步骤。capture 输出 sceneRef，locate 输出 point，可用于 act.input.pointRef。
- 包含 act 时 onFailure 必须为 STOP。需要间隔点击时使用 act/wait/act。

## 上下文校验

- Runtime 只执行确定性命令并返回证据；视觉变化和业务结论由 Agent 判断。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`planResultRef`、`planId`、`idempotent`。
- 主数据：`planResult`。
- 关联资源：`scene`、`screenshot`、`actionSpatialEvidence`、`planEvidence`、`technicalFact`。

## 副作用

- 按顺序投递计划中的设备动作
- 保存步骤事件和 Scene 证据

## 幂等性

相同 submissionId 和请求摘要返回原计划；未知动作结果永不重放。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`SCENE_CHANGED`](../errors/scene-action.md#error-scene-changed)
- [`PLAN_INVALID`](../errors/plan.md#error-plan-invalid)
- [`PLAN_STEP_FAILED`](../errors/plan.md#error-plan-step-failed)
- [`PLAN_SUBMISSION_CONFLICT`](../errors/plan.md#error-plan-submission-conflict)
- [`PLAN_RECORD_INCOMPLETE`](../errors/plan.md#error-plan-record-incomplete)
- [`LOCATOR_UNSUPPORTED`](../errors/plan.md#error-locator-unsupported)
- [`TARGET_NOT_FOUND`](../errors/plan.md#error-target-not-found)
- [`PLAN_CHECK_FAILED`](../errors/plan.md#error-plan-check-failed)
- [`PLAN_ACTION_OUTCOME_UNKNOWN`](../errors/plan.md#error-plan-action-outcome-unknown)
- [`PLAN_TIMEOUT`](../errors/plan.md#error-plan-timeout)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "runPlan",
  "input": {
    "submissionId": "run-plan-1",
    "sceneRef": "mavt:0123456789abcdef01234567:scene:scene-1",
    "purpose": "完成短时交互",
    "maxDurationMs": 2500,
    "onFailure": "STOP",
    "steps": [
      {
        "id": "shot",
        "type": "capture",
        "mode": "SCREENSHOT_ONLY",
        "promote": false
      }
    ]
  }
}
```

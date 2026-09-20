# CaseRuntime.runPlan

连续执行受约束的短时动作、等待、采集、定位和技术检查计划。

```typescript
runPlan({ capability: "runPlan", submissionId: string, basedOnSceneRef: string, purpose: string, maxDurationMs: number, onFailure: "STOP" | "CONTINUE", steps: object[], flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"runPlan"` | 固定为 runPlan |
| `submissionId` | 是 | `string` | 本次计划提交的幂等键 |
| `basedOnSceneRef` | 是 | `string` | 当前 Scene |
| `purpose` | 是 | `string` | 计划的业务目的 |
| `maxDurationMs` | 是 | `number` | 计划总时限 |
| `onFailure` | 是 | `"STOP" | "CONTINUE"` | STOP 或受限 CONTINUE |
| `steps` | 是 | `object[]` | 最多 12 个声明式步骤 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 上下文校验

- Runtime 只执行确定性命令并返回证据；视觉变化和业务结论由 Agent 判断。

## 成功状态

- `PLAN_COMPLETED`
- `PLAN_PARTIAL`
- `PLAN_INTERRUPTED`

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
  "capability": "runPlan",
  "submissionId": "run-plan-1",
  "basedOnSceneRef": "scene-1",
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
```

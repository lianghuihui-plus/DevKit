# Coordinator.confirmRun

选择当前环境、平台设备或确认完整目标绑定。

```typescript
confirmRun({ capability: "confirmRun", decision: "CONFIRM_BINDING", userInstruction?: string, platform?: "harmony" | "android" | "ios", deviceId?: string, binding?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"confirmRun"` | 固定为 confirmRun |
| `decision` | 是 | `"CONFIRM_BINDING"` | 互斥确认分支 |
| `userInstruction` | 否/条件 | `string` | 用户确认原文 |
| `platform` | 否/条件 | `"harmony" | "android" | "ios"` | 目标平台 |
| `deviceId` | 否/条件 | `string` | 响应要求时选择的设备 |
| `binding` | 否/条件 | `object` | 由探测事实形成的目标绑定 |

## 条件要求

- USE_CURRENT、SELECT_PLATFORM、CONFIRM_BINDING 三个分支字段不得混用。

## 上下文校验

- binding 必须来自当前探测事实。

## 成功状态

- `NEED_USER_CONFIRMATION`
- `CONFIRMED`

## 副作用

- 保存用户确认并准备 execution

## 幂等性

由 Coordinator 状态机拒绝阶段外重复确认。

## 错误

- [`COORDINATOR_INPUT_INVALID`](../errors.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors.md#error-coordinator-state-invalid)
- [`DECISION_NOT_ALLOWED`](../errors.md#error-decision-not-allowed)
- [`ENVIRONMENT_NOT_READY`](../errors.md#error-environment-not-ready)
- [`IOS_SIGNING_REQUIRED`](../errors.md#error-ios-signing-required)
- [`INPUT_CAPABILITY_NOT_READY`](../errors.md#error-input-capability-not-ready)
- [`COORDINATOR_TECHNICAL`](../errors.md#error-coordinator-technical)

## 最小示例

```json
{
  "capability": "confirmRun",
  "decision": "SELECT_PLATFORM",
  "platform": "harmony"
}
```

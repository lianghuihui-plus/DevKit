# Coordinator.confirmRun

确认当前环境、选择平台设备或确认绑定。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

## 调用分支

```typescript
confirmRun({ decision: "USE_CURRENT", userInstruction: string })
confirmRun({ decision: "SELECT_PLATFORM", platform: "harmony" | "android" | "ios", deviceId?: string })
confirmRun({ decision: "CONFIRM_BINDING", userInstruction: string, binding: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `decision` | 是 | `"USE_CURRENT" \| "SELECT_PLATFORM" \| "CONFIRM_BINDING"` | 当前 runDecision 允许的确认分支。 |
| `userInstruction` | 否/条件 | `string` | 用户对使用当前环境或目标绑定的明确确认原文。 |
| `platform` | 否/条件 | `"harmony" \| "android" \| "ios"` | 用户选择的平台。 |
| `deviceId` | 否/条件 | `string` | 当前探测事实中的设备标识；多设备时必须明确选择。 |
| `binding` | 否/条件 | `object` | 用户确认的目标设备与应用绑定。 |
| `binding.platform` | 否/条件 | `"harmony" \| "android" \| "ios"` | 已选择的平台。 |
| `binding.deviceId` | 否/条件 | `string` | 已确认的设备标识。 |
| `binding.appId` | 否/条件 | `string` | 已确认的目标应用标识。 |
| `binding.entry` | 否/条件 | `string` | HarmonyOS 应用入口。 |
| `binding.deviceType` | 否/条件 | `"simulator" \| "realDevice"` | iOS 模拟器或真机。 |
| `binding.deviceFormFactor` | 否/条件 | `string` | 设备形态。 |
| `binding.xcodeOrgId` | 否/条件 | `string` | 用户确认的 iOS 签名团队。 |
| `binding.xcodeSigningId` | 否/条件 | `string` | iOS 签名身份。 |
| `binding.updatedWDABundleId` | 否/条件 | `string` | WDA 签名 Bundle ID。 |

## 结构字段

```typescript
input.binding: { platform: "harmony" | "android" | "ios"; deviceId: string; appId: string; entry?: string; deviceType?: "simulator" | "realDevice"; deviceFormFactor?: string; xcodeOrgId?: string; xcodeSigningId?: string; updatedWDABundleId?: string }
```

## 条件要求

- 三个 decision 分支不得混用字段。

## 成功状态

- `SUCCEEDED`

### 成功 / outcome=NEED_USER_CONFIRMATION

- 简单结果：`outcome`、`phase`、`command`。
- 主数据：`runDecision`。
- 关联资源：`coordinatorDiagnostic`。

### 成功 / outcome=CONFIRMED

- 简单结果：`outcome`、`phase`、`command`。
- 主数据：无。
- 关联资源：无。

## 副作用

- 保存当前 run 的确定性进度

## 幂等性

advanceRun/cancelRun 终态复用原 runSummary；confirmRun 终态拒绝。

## 错误

- [`AGENT_INPUT_STALLED`](../errors/input-state.md#error-agent-input-stalled)
- [`COORDINATOR_INPUT_INVALID`](../errors/input-state.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors/input-state.md#error-coordinator-state-invalid)
- [`COORDINATOR_TERMINAL`](../errors/input-state.md#error-coordinator-terminal)
- [`DECISION_NOT_ALLOWED`](../errors/input-state.md#error-decision-not-allowed)
- [`ENVIRONMENT_NOT_READY`](../errors/environment.md#error-environment-not-ready)
- [`IOS_SIGNING_REQUIRED`](../errors/environment.md#error-ios-signing-required)
- [`INPUT_CAPABILITY_NOT_READY`](../errors/environment.md#error-input-capability-not-ready)
- [`PLATFORM_UNAVAILABLE`](../errors/environment.md#error-platform-unavailable)
- [`BATCH_BLOCKED`](../errors/batch.md#error-batch-blocked)
- [`COORDINATOR_TECHNICAL`](../errors/batch.md#error-coordinator-technical)
- [`RESOURCE_UNKNOWN`](../errors/resources.md#error-resource-unknown)
- [`RESOURCE_SCOPE_MISMATCH`](../errors/resources.md#error-resource-scope-mismatch)
- [`RESOURCE_INTEGRITY_INVALID`](../errors/resources.md#error-resource-integrity-invalid)

## 最小示例

```json
{"operation":"confirmRun","input":{"decision":"SELECT_PLATFORM","platform":"harmony"}}
```

```json
{"operation":"confirmRun","input":{"decision":"USE_CURRENT","userInstruction":"确认使用当前环境"}}
```

```json
{"operation":"confirmRun","input":{"decision":"CONFIRM_BINDING","userInstruction":"确认使用目标设备和应用","binding":{"platform":"harmony","deviceId":"device-1","appId":"com.example.app"}}}
```

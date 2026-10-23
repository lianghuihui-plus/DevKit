# Coordinator.confirmRun

确认当前环境、选择平台设备或确认绑定。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

## 调用分支

```typescript
confirmRun({ decision: "USE_CURRENT", userInstruction: string })
confirmRun({ decision: "SELECT_PLATFORM", platform: "harmony" | "android" | "ios", deviceId?: string, appId?: string, appName?: string })
confirmRun({ decision: "SELECT_APP", appId: string })
confirmRun({ decision: "SELECT_ENVIRONMENT_OPTION", optionId: string })
confirmRun({ decision: "RETRY_ENVIRONMENT" })
confirmRun({ decision: "CONFIRM_ENVIRONMENT", environmentRef: string, userInstruction: string })
confirmRun({ decision: "CONFIRM_BINDING", userInstruction: string, binding: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `decision` | 是 | `"USE_CURRENT" \| "SELECT_PLATFORM" \| "SELECT_APP" \| "SELECT_ENVIRONMENT_OPTION" \| "RETRY_ENVIRONMENT" \| "CONFIRM_ENVIRONMENT" \| "CONFIRM_BINDING"` | 当前 runDecision 允许的确认分支。 |
| `userInstruction` | 否/条件 | `string` | 用户对使用当前环境或目标绑定的明确确认原文。 |
| `platform` | 否/条件 | `"harmony" \| "android" \| "ios"` | 用户选择的平台。 |
| `deviceId` | 否/条件 | `string` | 当前探测事实中的设备标识；多设备时必须明确选择。 |
| `appId` | 否/条件 | `string` | 目标应用标识：优先使用用户已指定的标识，否则原样选择应用候选。 |
| `appName` | 否/条件 | `string` | 用户提供的应用名称，歧义时仍需选择候选。 |
| `optionId` | 否/条件 | `string` | 原样复制当前 runDecision 的配置候选 ID。 |
| `environmentRef` | 否/条件 | `string` | 原样复制当前 Run 返回的就绪环境引用。 |
| `binding` | 否/条件 | `object` | 兼容明确手动配置的高级输入，结构见下；正常流程使用 CONFIRM_ENVIRONMENT。 |

## 结构字段

```typescript
input.binding: { platform: "harmony" | "android" | "ios"; deviceId: string; appId: string; entry?: string; androidUiBackend?: "auto" | "helper" | "uiautomator"; deviceType?: "simulator" | "realDevice"; deviceFormFactor?: string; xcodeOrgId?: string; xcodeSigningId?: string; updatedWDABundleId?: string; platformVersion?: string }
```

## 条件要求

- decision 分支不得混用字段；配置和应用候选只能来自当前 runDecision；外部操作完成后提交 RETRY_ENVIRONMENT。

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

advanceRun/cancelRun 在终态且报告发布状态不变时复用当前 runSummary；发布状态变化时生成新快照并保留旧引用；confirmRun 终态拒绝。

## 错误

- [`AGENT_INPUT_STALLED`](../errors/input-state.md#error-agent-input-stalled)
- [`COORDINATOR_INPUT_INVALID`](../errors/input-state.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors/input-state.md#error-coordinator-state-invalid)
- [`COORDINATOR_TERMINAL`](../errors/input-state.md#error-coordinator-terminal)
- [`DECISION_NOT_ALLOWED`](../errors/input-state.md#error-decision-not-allowed)
- [`ENVIRONMENT_NOT_READY`](../errors/environment.md#error-environment-not-ready)
- [`ENVIRONMENT_REFERENCE_INVALID`](../errors/input-state.md#error-environment-reference-invalid)
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
{"operation":"confirmRun","input":{"decision":"SELECT_APP","appId":"com.example.app"}}
```

```json
{"operation":"confirmRun","input":{"decision":"SELECT_ENVIRONMENT_OPTION","optionId":"published-option-id"}}
```

```json
{"operation":"confirmRun","input":{"decision":"RETRY_ENVIRONMENT"}}
```

```json
{"operation":"confirmRun","input":{"decision":"CONFIRM_ENVIRONMENT","environmentRef":"published-environment-ref","userInstruction":"确认执行"}}
```

```json
{"operation":"confirmRun","input":{"decision":"CONFIRM_BINDING","userInstruction":"确认使用目标设备和应用","binding":{"platform":"harmony","deviceId":"device-1","appId":"com.example.app"}}}
```

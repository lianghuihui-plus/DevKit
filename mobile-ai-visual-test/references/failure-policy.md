# 失败策略

> 负责：状态、failureCode、结果归一、预算和停止规则。

## 状态

| 状态 | 含义 |
| --- | --- |
| `PASS` | 所有业务步骤都有当前 execution 内的通过证据 |
| `FAIL` | 明确不符合预期，或请求 PASS 但证据不足 |
| `BLOCKED` | 环境、工具、前置条件、业务上下文或安全限制导致无法继续 |
| `UNKNOWN` | 历史兼容状态；正式执行应尽量归一为 FAIL 或 BLOCKED |

## failureCode

| failureCode | 状态 | 含义 |
| --- | --- | --- |
| `ASSERTION_FAILED` | `FAIL` | 明确断言不通过 |
| `ASSERTION_UNKNOWN` | `FAIL` | 不能证明业务步骤通过 |
| `ASSERTION_EVIDENCE_REQUIRED` | `BLOCKED` | PASS 断言缺合法 observation 证据 |
| `STEP_ORDER_VIOLATION` | `BLOCKED` | 跳序、回补或步骤绑定非法 |
| `PRECONDITION_REQUIRED` | `BLOCKED` | 进入步骤前缺前置条件事实 |
| `PRECONDITION_FAILED` | `BLOCKED` | 前置条件明确不满足 |
| `PRECONDITION_UNKNOWN` | `BLOCKED` | 前置条件无法判断 |
| `PRECONDITION_UNSUPPORTED` | `BLOCKED` | 前置条件不支持自动处理 |
| `PRECONDITION_FLOW_AMBIGUOUS` | `BLOCKED` | 当前平台存在严格同名 Flow |
| `PRECONDITION_FLOW_INVALID` | `BLOCKED` | Flow 资产或事件序列非法 |
| `PRECONDITION_FLOW_CHANGED` | `BLOCKED` | preflight 后 Flow 或计划发生变化 |
| `PRECONDITION_FLOW_START_MISMATCH` | `BLOCKED` | 当前页面不满足 Flow 固定起点 |
| `PRECONDITION_FLOW_ACTION_FAILED` | `BLOCKED` | Flow 动作执行失败 |
| `PRECONDITION_FLOW_TARGET_NOT_REACHED` | `BLOCKED` | Flow 结束后未达到固定终点 |
| `PRECONDITION_FLOW_UNSAFE` | `BLOCKED` | Flow 包含不安全动作 |
| `PRECONDITION_FLOW_BUDGET_EXCEEDED` | `BLOCKED` | 前置条件 Flow 动作超预算 |
| `ENV_UNCONFIRMED` | `BLOCKED` | 环境未确认 |
| `ENV_UNAVAILABLE` | `BLOCKED` | 平台或设备不可用 |
| `ENV_AMBIGUOUS` | `BLOCKED` | 设备、App 或入口歧义 |
| `PLATFORM_UNIMPLEMENTED` | `BLOCKED` | 平台能力未实现 |
| `TOOL_ERROR` | `BLOCKED` | 工具或底层命令异常 |
| `ACTION_RESULT_SOURCE_REQUIRED` | `BLOCKED` | actionResult 来源非法 |
| `OBSERVATION_SOURCE_REQUIRED` | `BLOCKED` | observation 来源非法 |
| `CASE_RESTART_FAILED` | `BLOCKED` | 用例冷启动失败或不可验证 |
| `ACTION_TARGET_NOT_FOUND` | `FAIL`/`BLOCKED` | 业务步骤目标不可定位；上下文丢失时阻塞 |
| `PAGE_LOAD_BLOCKED` | `FAIL`/`BLOCKED` | 业务页面加载失败或长期无目标状态 |
| `APP_CONTEXT_LOST` | `BLOCKED` | 恢复前台后业务上下文不可判断 |
| `APP_LEFT_FOREGROUND` | `BLOCKED` | 多次离开目标 App |
| `UNKNOWN_POPUP` | `BLOCKED` | 未知弹窗无法安全处理 |
| `CASE_TIMEOUT` | `BLOCKED` | 单 case 超时 |
| `EXECUTION_BUDGET_EXCEEDED` | `BLOCKED` | 普通 observation、action、wait 等预算超限 |

## 证据和顺序

- 普通操作步骤：业务动作 `ok=true`，且动作后有同一步骤 observation。
- 断言型步骤：`assertion PASS` 必须引用同一步骤 observation。
- 页面已满足当前步骤时，也要先 observe，再写带证据的 PASS。
- `launchApp`、`restartApp`、`wait`、单独的 observation/perception/decision/rule，以及任何前置条件 Flow 事实都不能单独作为业务步骤通过证据。
- 第一个步骤事实属于 `case.json.steps[0]`；前一步有通过证据后才能进入下一步；进入后续步骤后不能回补。

请求 PASS 但业务步骤缺证据时，框架归一为：

```json
{"status":"FAIL","requestedStatus":"PASS","failureCode":"ASSERTION_UNKNOWN"}
```

## 冷启动、预算和停止

- 每个 execution 开始必须尝试 `restartApp`；冷启动敏感用例失败时为 `BLOCKED/CASE_RESTART_FAILED`。
- 单 case 默认 20 分钟；普通预算超限为 `EXECUTION_BUDGET_EXCEEDED`。
- 前置条件 Flow 每个条件默认最多 5 个动作，单 case 默认最多 12 个；超限为 `PRECONDITION_FLOW_BUDGET_EXCEEDED`。
- 明确断言失败、前置条件终态、环境不可用、工具错误、未知弹窗、破坏性风险或预算超限时立即停止当前 case。

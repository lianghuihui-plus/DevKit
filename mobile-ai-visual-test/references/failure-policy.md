# 失败策略

> 负责：状态、failureCode、结果归一、预算和停止规则。
> 不负责：执行阶段、事件 schema、动作参数、报告布局。
> 参见：`workflow.md`、`interfaces.md`、`context-format.md`。

## 状态

| 状态 | 含义 |
| --- | --- |
| `PASS` | 所有步骤都有当前 execution 内的通过证据 |
| `FAIL` | 明确观察到不符合预期，或证据不足被归一为失败 |
| `BLOCKED` | 环境、工具、前置条件、业务上下文或安全限制导致无法继续 |
| `UNKNOWN` | 历史兼容状态；正式执行应尽量归一到 `FAIL` 或 `BLOCKED` |

断言证据不足统一为 `FAIL/ASSERTION_UNKNOWN`。

## failureCode

| failureCode | 状态 | 含义 |
| --- | --- | --- |
| `ASSERTION_FAILED` | `FAIL` | 明确断言不通过 |
| `ASSERTION_UNKNOWN` | `FAIL` | 不能证明通过 |
| `ASSERTION_EVIDENCE_REQUIRED` | `BLOCKED` | PASS 断言缺合法 observation 证据 |
| `STEP_ORDER_VIOLATION` | `BLOCKED` | 跳序、回补或步骤绑定非法 |
| `PRECONDITION_REQUIRED` | `BLOCKED` | 进入步骤前缺前置条件事实 |
| `PRECONDITION_FAILED` | `BLOCKED` | 前置条件明确不满足 |
| `PRECONDITION_UNKNOWN` | `BLOCKED` | 前置条件无法判断 |
| `PRECONDITION_UNSUPPORTED` | `BLOCKED` | 前置条件不支持自动处理 |
| `FLOW_SCAN_REQUIRED` | `BLOCKED` | 缺全局或步骤级可用 Flow 扫描 |
| `FLOW_SCAN_MISSING` | `BLOCKED` | 判定导航类失败前缺扫描 |
| `FLOW_MATCH_UNRESOLVED` | `BLOCKED` | 命中 Flow 缺终态事实 |
| `FLOW_NOT_FOUND` | `BLOCKED` | 需要业务路径但无可用 Flow |
| `FLOW_STEP_UNMATCHED` | `BLOCKED` | Flow 步骤无法匹配页面 |
| `FLOW_ACTION_FAILED` | `BLOCKED` | Flow 参考动作失败 |
| `FLOW_UNSAFE` | `BLOCKED` | Flow 涉及不安全操作 |
| `ENV_UNCONFIRMED` | `BLOCKED` | 环境未确认 |
| `ENV_UNAVAILABLE` | `BLOCKED` | 平台或设备不可用 |
| `ENV_AMBIGUOUS` | `BLOCKED` | 设备、App 或入口歧义 |
| `PLATFORM_UNIMPLEMENTED` | `BLOCKED` | 平台能力未实现 |
| `TOOL_ERROR` | `BLOCKED` | 工具或底层命令异常 |
| `ACTION_RESULT_SOURCE_REQUIRED` | `BLOCKED` | actionResult 来源非法 |
| `OBSERVATION_SOURCE_REQUIRED` | `BLOCKED` | observation 来源非法 |
| `CASE_RESTART_FAILED` | `BLOCKED` | 用例冷启动失败或不可验证 |
| `ACTION_TARGET_NOT_FOUND` | `FAIL`/`BLOCKED` | 目标不可定位；上下文丢失时阻塞 |
| `PAGE_LOAD_BLOCKED` | `FAIL`/`BLOCKED` | 页面加载失败或长期无目标状态 |
| `APP_CONTEXT_LOST` | `BLOCKED` | 恢复前台后业务上下文不可判断 |
| `APP_LEFT_FOREGROUND` | `BLOCKED` | 多次离开目标 App |
| `UNKNOWN_POPUP` | `BLOCKED` | 未知弹窗无法安全处理 |
| `CASE_TIMEOUT` | `BLOCKED` | 单 case 超时 |
| `EXECUTION_BUDGET_EXCEEDED` | `BLOCKED` | observation、action、wait 等预算超限 |

## 步骤证据

通过证据只认当前 execution：

- 普通操作步骤：业务动作 `tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back` 的 `actionResult ok=true`，且动作后有同一步骤 observation。
- 断言型步骤：必须写 `assertion PASS`，并引用同一步骤 observation。
- 页面已满足当前步骤时，也必须先 observe，再写带证据的 `assertion PASS`。

不能单独作为步骤通过证据：`launchApp`、`restartApp`、`wait`、`observation`、`perception`、`decision`、`rule`、`flowScan`、`flow`。

## 顺序

- 第一个步骤事实必须属于 `case.json.steps[0]`。
- 进入下一步前，前一步必须已有通过证据。
- 进入后续步骤后，禁止回头补写前置步骤事实。
- `restartApp` 是 execution 级隔离动作，禁止绑定 `stepId`。

## PASS 归一

请求 PASS 但步骤缺证据时，框架写为：

```json
{"status":"FAIL","requestedStatus":"PASS","failureCode":"ASSERTION_UNKNOWN"}
```

`requestedStatus` 保留 agent 原始请求，`status` 是真实归一结果。

## 冷启动隔离

- 每个 execution 开始必须尝试 `restartApp`。
- `ok=true` 且 `coldStartVerified=true` 才算干净冷启动。
- 冷启动敏感用例失败时：`BLOCKED/CASE_RESTART_FAILED`。
- 普通用例可降级继续，但 metrics 和报告必须标记 `isolationCompromised=true`。

冷启动敏感来源：`case.json.isolation.requireCleanRestart=true`，或 `auto` 识别到首次进入、重启后、同一次启动内、默认初始化、新用户首次状态等语义。

## 预算和停止

- 单 case 默认 20 分钟，具体预算由 `run-case.js` 管理。
- 预算超限自动写 `budgetExceeded` 并 finalize 为 `BLOCKED`。
- `paceHint` 只提醒节奏，不改变结果。

立即停止当前 case 的情况：明确断言失败、前置条件终态、环境不可用、平台未实现、工具错误、未知弹窗、破坏性操作风险、预算超限、冷启动敏感用例无法确认真实冷启动。

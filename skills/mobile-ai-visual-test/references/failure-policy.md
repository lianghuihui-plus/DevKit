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
| `PRECONDITION_FLOW_OBSERVATION_FAILED` | `BLOCKED` | Flow 观察未获得截图、布局或有效前台事实 |
| `PRECONDITION_FLOW_ACTION_MISMATCH` | `BLOCKED` | 实际动作与 execution 中冻结的 Flow action 不一致 |
| `PRECONDITION_FLOW_ACTION_FAILED` | `BLOCKED` | Flow 动作执行失败 |
| `PRECONDITION_FLOW_TARGET_NOT_REACHED` | `BLOCKED` | Flow 结束后未达到固定终点 |
| `PRECONDITION_FLOW_UNSAFE` | `BLOCKED` | Flow 包含不安全动作 |
| `PRECONDITION_FLOW_BUDGET_EXCEEDED` | `BLOCKED` | 前置条件 Flow 动作超预算 |
| `ENV_UNCONFIRMED` | `BLOCKED` | 环境未确认 |
| `ENVIRONMENT_BINDING_MISMATCH` | `BLOCKED` | 正式调用显式环境与已确认 state 不一致 |
| `ENV_UNAVAILABLE` | `BLOCKED` | 平台或设备不可用 |
| `ENV_AMBIGUOUS` | `BLOCKED` | 设备、App 或入口歧义 |
| `PLATFORM_UNIMPLEMENTED` | `BLOCKED` | 平台能力未实现 |
| `TOOL_ERROR` | `BLOCKED` | 工具或底层命令异常；必须有失败 observation、actionResult 或框架技术事件支持 |
| `ACTION_RESULT_SOURCE_REQUIRED` | `BLOCKED` | actionResult 来源非法 |
| `OBSERVATION_SOURCE_REQUIRED` | `BLOCKED` | observation 来源非法 |
| `OBSERVATION_ARTIFACT_INVALID` | `BLOCKED` | 截图文件缺失有效 PNG 结构或无法解码 |
| `OBSERVATION_ARTIFACT_CHANGED` | `BLOCKED` | 截图当前 SHA-256 与 observation 采集时记录不一致 |
| `VISUAL_INPUT_UNVERIFIABLE` | `BLOCKED` | 原图有效，但 Agent 图片输入经过一次结构化复核重试后仍无法可靠判断 |
| `CASE_RESTART_FAILED` | `BLOCKED` | 用例冷启动失败或不可验证 |
| `ACTION_TARGET_NOT_FOUND` | `FAIL`/`BLOCKED` | 业务步骤目标不可定位；上下文丢失时阻塞 |
| `PAGE_LOAD_BLOCKED` | `FAIL`/`BLOCKED` | 业务页面加载失败或长期无目标状态 |
| `APP_CONTEXT_LOST` | `BLOCKED` | 恢复前台后业务上下文不可判断 |
| `APP_LEFT_FOREGROUND` | `BLOCKED` | 多次离开目标 App |
| `UNKNOWN_POPUP` | `BLOCKED` | 未知弹窗无法安全处理 |
| `CASE_TIMEOUT` | `BLOCKED` | 单 case 超时 |
| `EXECUTION_BUDGET_EXCEEDED` | `BLOCKED` | 普通 observation、action、wait 等预算超限 |
| `EVENT_SOURCE_REQUIRED` | `BLOCKED` | 公开入口尝试写框架所有事件 |
| `CASE_STEPS_REQUIRED` | `BLOCKED` | 用例未解析出任何可执行步骤 |
| `EXECUTION_RECOVERY_CONTRACT_CHANGED` | `BLOCKED` | 半提交 draft 与当前 execution 或 case contract 不一致，禁止自动恢复 |

## 证据和顺序

- 所有业务步骤：只有 `assertion PASS` 才是步骤通过证据；发生业务动作时，`ok=true` 和动作后的同步骤 observation 是必要过程事实，但不能单独完成步骤。
- 每个 `assertion PASS` 都必须引用同一步骤最新 observation 的截图，并且此前有引用同一截图、包含 `reason` 的 `perception status=USABLE`。
- 页面已满足当前步骤时，也要先 observe，再写带证据的 PASS。
- observation `label` 只用于定位和展示，不能作为业务 assertion 的证据；布局和日志只能补充截图证据。
- 最新 perception 为 `UNUSABLE`、`UNCERTAIN`，或最新 observation 之后又执行了动作时，禁止请求 PASS；必须重新观察和判断，或按现有失败策略收尾。
- 新 observation 自动记录截图 SHA-256、尺寸和 PNG 解码状态；perception 和 assertion 使用截图前必须确认当前文件仍对应采集时 SHA-256。
- 黑屏、黑块、花屏或预览解码异常首先属于 Agent 图片输入声明。Agent 必须写引用最新截图的结构化 `qualityClaim`，框架生成 `evidenceCheck` 后才能决定重试或收尾；仅凭自然语言 reason 或一次预览异常不得使用 `TOOL_ERROR`。
- 原始像素未命中声明或当前规则无法验证时，请求的 `UNUSABLE` 会归一为 `UNCERTAIN`。`CLAIM_PRESENT_IN_SOURCE` 只证明原图存在相应像素特征，不自动证明截图损坏。
- `VISUAL_INPUT_UNVERIFIABLE` 需要同一步骤两个不同 `attemptId` 的 `evidenceCheck`；第二次必须由 `retry_visual_input` decision 触发并用 `retryOf` 绑定首次检查。重复提交同一个 perception 不算重试。
- `launchApp`、`restartApp`、`wait`、单独的 observation/perception/decision/rule，以及任何前置条件 Flow 事实都不能单独作为业务步骤通过证据。
- 第一个步骤事实属于 `case.json.steps[0]`；前一步有通过证据后才能进入下一步；进入后续步骤后不能回补。

请求 PASS 但业务步骤缺证据时，框架归一为：

```json
{"status":"FAIL","requestedStatus":"PASS","failureCode":"ASSERTION_UNKNOWN"}
```

## 冷启动、预算和停止

- 每个 execution 开始必须尝试 `restartApp`；冷启动敏感用例失败时为 `BLOCKED/CASE_RESTART_FAILED`。
- 单 case 默认 30 分钟；超时为 `CASE_TIMEOUT`，其他普通预算超限为 `EXECUTION_BUDGET_EXCEEDED`。
- 前置条件 Flow 每个条件默认最多 5 个动作，单 case 默认最多 12 个；超限为 `PRECONDITION_FLOW_BUDGET_EXCEEDED`。
- Flow observation 失败仍写入 timeline 供审计，但不能作为 STARTED、STEP_COMPLETED、COMPLETED 或 already-satisfied 的证据。
- Flow observation/action 的确定性技术失败由框架写入 Flow 和前置条件阻塞终态并立即收尾。
- 明确断言失败、前置条件终态、环境不可用、工具错误、未知弹窗、破坏性风险或预算超限时立即停止当前 case。

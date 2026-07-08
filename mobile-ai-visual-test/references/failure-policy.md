# 失败策略

## 状态

- `PASS`：用例完整满足。
- `FAIL`：用例已执行但实际结果不满足预期，或缺少证明通过所需的断言证据。
- `BLOCKED`：环境、前置条件、平台工具或应用状态阻止可靠执行。
- `UNKNOWN`：仅保留给历史兼容或无法归类的异常状态；正式用例结果不应把断言证据不足落为 `UNKNOWN`。

## 失败码

`result.json` 和 `metrics.json` 使用稳定失败码：

- `ENV_UNCONFIRMED`
- `ENV_UNAVAILABLE`
- `ENV_AMBIGUOUS`
- `PLATFORM_UNIMPLEMENTED`
- `PRECONDITION_FAILED`
- `PRECONDITION_REQUIRED`
- `PRECONDITION_UNKNOWN`
- `PRECONDITION_UNSUPPORTED`
- `ASSERTION_FAILED`
- `ASSERTION_UNKNOWN`
- `ASSERTION_EVIDENCE_REQUIRED`
- `STEP_ORDER_VIOLATION`
- `ACTION_RESULT_SOURCE_REQUIRED`
- `ACTION_TARGET_NOT_FOUND`
- `PAGE_LOAD_BLOCKED`
- `FLOW_NOT_FOUND`
- `FLOW_SCAN_REQUIRED`
- `FLOW_STEP_UNMATCHED`
- `FLOW_ACTION_FAILED`
- `FLOW_UNSAFE`
- `FLOW_SCAN_MISSING`
- `FLOW_MATCH_UNRESOLVED`
- `APP_CONTEXT_LOST`
- `APP_LEFT_FOREGROUND`
- `UNKNOWN_POPUP`
- `CASE_TIMEOUT`
- `CASE_RESTART_FAILED`
- `EXECUTION_BUDGET_EXCEEDED`
- `TOOL_ERROR`

## 停止规则

- 无人值守执行阶段不向用户提问。
- 证据弱时不能强行判定 `PASS`。
- 每个步骤必须按 `case.json.steps` 顺序写入当前 execution 的步骤事实；跳过前置步骤、跨步记录或进入后续步骤后回头补写前置步骤时，入口以 `STEP_ORDER_VIOLATION` 拒绝且不写入 timeline。
- 前一步没有通过证据时不能进入下一步；普通操作步骤需要真实业务动作 `tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back` 的 `actionResult ok=true` 且其后有同一步骤的 observation，或 `assertion PASS`；`assertion PASS` 必须引用当前步骤已有 observation 的截图、布局或 label，缺失时入口以 `ASSERTION_EVIDENCE_REQUIRED` 拒绝且不写入 timeline；断言型步骤必须写带 observation 证据引用的 `assertion PASS`；`launchApp`、`restartApp`、`wait` 不能单独作为步骤通过证据。
- `actionResult` 必须由顶层 `scripts/action.sh` 自动写入，直接通过 `run-case.js --record-json` 手写动作结果时，入口以 `ACTION_RESULT_SOURCE_REQUIRED` 拒绝且不写入 timeline。
- `--finalize --status PASS` 缺少步骤通过证据时，本次结果归一为 `FAIL/ASSERTION_UNKNOWN` 并 finalize；`result.requestedStatus` 保留 agent 原始请求，agent 不能把缺证据当作 PASS。
- 需要破坏性准备时停止。
- 连续 3 次截图或控件树无明显变化时停止。
- 目标应用累计离开前台 2 次时停止。
- 重新拉起应用导致业务上下文丢失时停止。
- 用例开始时必须尝试 `restartApp` 并记录真实结果；冷启动失败或没有明确 `coldStartVerified=true` 时，`case.json.isolation.requireCleanRestart=true` 的用例必须按 `BLOCKED/CASE_RESTART_FAILED` 收尾；`auto` 模式下含“首次进入 / 重启 App 后 / 同一次 App 启动内 / 默认初始化 / 新用户首次状态”等语义的冷启动敏感用例同样阻塞，普通用例可标记 `isolationCompromised` 后继续执行。
- Flow 文件不存在、与当前页面明显不匹配、动作失败或涉及不安全业务操作时停止。
- 任何带 `stepId` 的步骤事实前必须已有 execution 级全局可用 `flowScan` 事实；公开事实写入缺失时入口以 `FLOW_SCAN_REQUIRED` 拒绝且不会写入 timeline，顶层动作入口缺失时会写入失败 `actionResult` 并 finalize。
- `restartApp` 是 execution 级隔离动作，禁止绑定 `stepId`；非 `launchApp`、非 `wait` 的业务动作前还必须已有当前步骤的可用 `flowScan` 事实；`flowScan` 必须由 `scripts/flow/record-scan.js ... --step-id <step-id>` 写入并包含 `source=list-flows`、`flowsRoot`、`scannedFlowIds`，且状态不能为 `FAILED`，否则顶层动作入口以 `FLOW_SCAN_REQUIRED` 拒绝且不会执行平台动作，并写入失败 `actionResult`、`result.json`、`metrics.json` 后 finalize。全局 `flowScan` 只用于建立候选库，不能替代步骤级扫描。
- 判定 `PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 前，必须传 `--failed-step`，且该失败步骤已有对应 `flowScan` 事实；否则结果归一为 `BLOCKED/FLOW_SCAN_MISSING`。
- 如果失败步骤的 `flowScan.matchedFlowIds` 非空，必须对每个命中的 Flow 写入同 `stepId` 的终态 `flow` 事实：`COMPLETED`、`FAILED`、`SKIPPED` 或 `BLOCKED`；否则结果归一为 `BLOCKED/FLOW_MATCH_UNRESOLVED`。
- 坐标目标判定 `ACTION_TARGET_NOT_FOUND` 前，必须至少有一次带 `coordinateSource`、`coordinateEvidence` 的动作事实；若目标是 H5 自绘、图片按钮、Canvas 或沿用 Flow 坐标，还必须有 `targetBounds`。正式 case execution 禁止使用 `coordinateSource=manual`。
- 坐标动作命中错误区域或页面无变化时，不能重复相同 `x/y` 作为新的尝试；必须重新观察并更换坐标证据，否则按 `ACTION_TARGET_NOT_FOUND` 或 `BLOCKED/TOOL_ERROR` 收尾。

## 执行预算

`scripts/observe.sh`、`scripts/action.sh` 和 `scripts/run-case.js --record-json` 都绑定 execution 并强制检查预算；超限会自动写入 `budgetExceeded` 事件并 finalize 为 `BLOCKED`。finalized 后继续观察、动作或 record 都会失败。

默认预算：

- 单用例总时长最多 20 分钟。
- observation 最多 80 次。
- action 最多 60 次。
- 单步骤相关事件最多 24 条。
- 单步骤 wait 最多 8 次。
- 已知弹窗最多处理 5 次。
- no-change observation 最多 5 次。

## 前置条件

前置条件分为：

- `auto_check`：平台级或环境级事实，可通过设备、应用、截图或控件树直接判断。
- `auto_prepare`：平台级或环境级事实，可在预算内通过安全 UI 动作准备。
- `manual_context`：业务级、账号级或数据级上下文，仅作为 agent 判断依据，不自动准备。
- `unsupported`：涉及破坏性、缺少凭证或不可验证条件，直接 `BLOCKED` 或 `FAIL`。

处理规则：

- 执行前用 `scripts/preflight-preconditions.js` 批量归纳前置条件并提示用户处理；预检不写入 execution。
- 创建 execution 后、进入步骤前，必须为每条 `case.json.preconditions` 写入 `precondition` 事实。
- 平台级前置条件检查和准备必须写入 `timeline.jsonl`；满足写 `PASS`，安全准备完成写 `PREPARED`。
- 业务级前置条件不做通用自动准备；agent 只能基于页面证据、用户补充和用例上下文保守判断。
- 登录态、账号数据、订单状态、业务资源数量、权限首次弹窗等前置条件默认属于 `manual_context` 或 `unsupported`；预检不得将这类业务上下文归为 `READY`。
- 不猜测密码、验证码或其他凭证。
- 不清数据、不卸载、不做支付、删除、发布、修改真实资料等破坏性动作。
- 缺少任何前置条件事实时，入口以 `PRECONDITION_REQUIRED` 拒绝并且不写入 timeline；前置条件为 `FAIL`、`UNKNOWN`、`BLOCKED` 时，分别以 `PRECONDITION_FAILED`、`PRECONDITION_UNKNOWN`、`PRECONDITION_UNSUPPORTED` 写入结果并 finalize，可短路剩余前置条件。
- 前置条件无法满足时，不进入步骤执行，仍生成本次 execution、`result.json`、`metrics.json` 和 `CONTEXT.md`。

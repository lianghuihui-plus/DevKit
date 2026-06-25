# 失败策略

## 状态

- `PASS`：用例完整满足。
- `FAIL`：用例已执行，但实际结果不满足预期。
- `BLOCKED`：环境、前置条件、平台工具或应用状态阻止可靠执行。
- `UNKNOWN`：证据不足，不能判定通过或失败。

## 失败码

`result.json` 和 `metrics.json` 使用稳定失败码：

- `ENV_UNCONFIRMED`
- `ENV_UNAVAILABLE`
- `ENV_AMBIGUOUS`
- `PLATFORM_UNIMPLEMENTED`
- `PRECONDITION_FAILED`
- `PRECONDITION_UNKNOWN`
- `PRECONDITION_UNSUPPORTED`
- `ASSERTION_FAILED`
- `ASSERTION_UNKNOWN`
- `ACTION_TARGET_NOT_FOUND`
- `PAGE_LOAD_BLOCKED`
- `FLOW_NOT_FOUND`
- `FLOW_STEP_UNMATCHED`
- `FLOW_ACTION_FAILED`
- `FLOW_UNSAFE`
- `FLOW_SCAN_MISSING`
- `FLOW_MATCH_UNRESOLVED`
- `APP_CONTEXT_LOST`
- `APP_LEFT_FOREGROUND`
- `UNKNOWN_POPUP`
- `CASE_TIMEOUT`
- `EXECUTION_BUDGET_EXCEEDED`
- `TOOL_ERROR`

## 停止规则

- 无人值守执行阶段不向用户提问。
- 证据弱时不能强行判定 `PASS`。
- 需要破坏性准备时停止。
- 连续 3 次截图或控件树无明显变化时停止。
- 目标应用累计离开前台 2 次时停止。
- 重新拉起应用导致业务上下文丢失时停止。
- Flow 文件不存在、与当前页面明显不匹配、动作失败或涉及不安全业务操作时停止。
- 判定 `PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 前，必须传 `--failed-step`，且该失败步骤已有对应 `flowScan` 事实；否则结果降级为 `UNKNOWN/FLOW_SCAN_MISSING`。
- 如果失败步骤的 `flowScan.matchedFlowIds` 非空，必须对每个命中的 Flow 写入同 `stepId` 的终态 `flow` 事实：`COMPLETED`、`FAILED`、`SKIPPED` 或 `BLOCKED`；否则结果降级为 `UNKNOWN/FLOW_MATCH_UNRESOLVED`。
- 坐标目标判定 `ACTION_TARGET_NOT_FOUND` 前，必须至少有一次带 `coordinateSource`、`coordinateEvidence` 的动作事实；若目标是 H5 自绘、图片按钮或 Canvas，还必须有 `targetBounds`。
- 坐标动作命中错误区域或页面无变化时，不能重复相同 `x/y` 作为新的尝试；必须重新观察并更换坐标证据，否则只能判定 `UNKNOWN`。

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

- 平台级前置条件检查和准备必须写入 `timeline.jsonl`。
- 业务级前置条件不做通用自动准备；agent 只能基于页面证据、用户补充和用例上下文保守判断。
- 登录态、账号数据、订单状态、业务资源数量、权限首次弹窗等前置条件默认属于 `manual_context` 或 `unsupported`。
- 不猜测密码、验证码或其他凭证。
- 不清数据、不卸载、不做支付、删除、发布、修改真实资料等破坏性动作。
- 前置条件无法满足时，不进入步骤执行，仍生成本次 execution、`result.json`、`metrics.json` 和 `CONTEXT.md`。

# 失败策略

批量执行的目标是产出可信的结果矩阵，而不是在单个困难用例上无限循环。

## 默认预算

单个用例：

- 1 次初始生成。
- 最多 2 次修复尝试。
- 最多 3 次总执行。
- 同一个失败码连续出现 2 次，停止该用例。
- blocked 重跑使用独立 rerun 预算；`keep_blocked` 不计入总执行次数。

批量模式：

- 先生成所有无歧义用例。
- 每个失败用例最多 1 次针对性修复，除非用户要求深入修复。
- blocked 重跑只执行 rerunSelection 中 `decision = rerun` 的子集；`keep_blocked` 只更新报告，不计入执行次数。
- 用例局部失败时，继续下一个用例。
- 基础设施失败时，停止整批。

## 失败码

报告中使用这些失败码：

```text
PASS
BUILD_APP_FAILED
BUILD_TEST_FAILED
BUILD_ENV_INVALID
BUILD_TASK_UNAVAILABLE
OHOSTEST_TARGET_MISSING
SIGNED_HAP_NOT_FOUND
BUNDLE_NAME_UNRESOLVED
TARGET_CONFIRMATION_BLOCKED
TARGET_CONFIRMATION_STALE
INSTALL_APP_FAILED
INSTALL_TEST_FAILED
DEVICE_UNAVAILABLE
PERMISSION_DENIED
TEST_TIMEOUT
ASSERTION_FAILED
SELECTOR_NOT_FOUND
MISSING_TEST_DATA
NAVIGATION_AMBIGUOUS
PRECONDITION_UNSATISFIED
PRECONDITION_UNKNOWN
AUTH_ACCOUNT_INVALID
NETWORK_OR_SERVER_ERROR
UNSUPPORTED_FLOW
RETRY_BUDGET_EXCEEDED
BLOCKED
```

## 单用例立即停止

这些情况不要自动修复：

- `MISSING_TEST_DATA`
- `NAVIGATION_AMBIGUOUS`，且预期行为不清楚。
- `PRECONDITION_UNSATISFIED`
- `PRECONDITION_UNKNOWN`，且影响执行或影响断言。
- `TARGET_CONFIRMATION_BLOCKED`
- `TARGET_CONFIRMATION_STALE`
- `AUTH_ACCOUNT_INVALID`
- `NETWORK_OR_SERVER_ERROR`
- `UNSUPPORTED_FLOW`
- `RETRY_BUDGET_EXCEEDED`

记录原因，必要时请用户补充自然语言运行上下文。前置条件类和目标确认类 blocked 优先走 rerun/resume，不进入代码修复。

构建探测类失败也不要通过修改 UI 测试代码修复：

- `BUILD_ENV_INVALID`
- `BUILD_TASK_UNAVAILABLE`
- `OHOSTEST_TARGET_MISSING`
- `SIGNED_HAP_NOT_FOUND`
- `BUNDLE_NAME_UNRESOLVED`
- `TARGET_CONFIRMATION_BLOCKED`
- `TARGET_CONFIRMATION_STALE`

这些失败应优先记录到 execution plan 和 report，必要时请用户确认 DevEco 环境、build-profile 修改、task fallback 或 bundleName 来源。

## 允许有限修复

在预算内允许修复：

- `SELECTOR_NOT_FOUND`：检查 UI 代码，必要时补稳定 `.id()`，更新 selector。
- `ASSERTION_FAILED`：对比断言、人工预期和 app 合法状态。
- `TEST_TIMEOUT`：把弱等待改成目标控件等待，或合法目标页面集合等待。
- 键盘或焦点问题：优先使用文档中的 UI 操作和稳定组件目标。
- `BUILD_TEST_FAILED`：修复生成测试代码或测试模块配置中的明确编译问题。

## 前置条件失败

`PRECONDITION_UNSATISFIED`：

- 前置条件已确认不满足，且 `impact` 为 `blocks_execution` 或 `affects_assertion`。
- 不执行测试，生成 `BLOCKED` 报告。

`PRECONDITION_UNKNOWN`：

- 前置条件无法自动判断。
- 如果 `impact` 为 `blocks_execution` 或 `affects_assertion`，不在执行阶段询问用户，直接记录 `BLOCKED` 并结束当前用例；批量模式继续后续用例。
- 如果 `impact` 为 `low_risk`，可以继续执行，但 plan/report 中必须记录 warning。

## 停止整批

以下情况停止批量执行，并记录 `BLOCKED`：

- 设备不可用。
- agent 环境因权限、沙箱或系统限制无法执行 hdc。
- app HAP 构建失败。
- app 安装失败。
- 测试 runner 基础设施无法启动。
- app 完全无法启动。

## 修复原则

修复必须针对失败原因，并回溯到人工用例。不要为了让测试通过而削弱断言。

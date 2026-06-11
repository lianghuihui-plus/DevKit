# 失败策略

## 何时读取

- 执行失败、构建失败、生成阻塞或 blocked 重跑时读取，用于确定失败码、是否可修、是否继续批量执行。
- 自动修复前读取，用于检查修复预算、同类失败停止阈值和 hdc 诊断要求。
- 只生成测试代码且尚未失败时，通常不需要读取本文件。

批量执行的目标是产出可信的结果矩阵，而不是在单个困难用例上无限循环。

## 默认预算

修复预算优先读取本次用户指令，其次读取工作目录 `config.json`，最后使用以下默认值。配置文件格式见 `references/project-notes/workspace-and-config.md`。

单个用例：

- 1 次初始生成。
- 默认每个用例最多 5 次自动修复尝试。
- 同一个失败码连续出现 3 次，停止该用例。
- blocked 重跑不占用修复预算。

批量模式：

- 先解析所有显式指定用例；可生成的生成测试，不可生成的写入 plan，`generation.status = blocked`。
- 若本次要求执行，`generation.status = blocked` 的用例直接记录 `BLOCKED/GENERATION_BLOCKED`，不进入构建和运行。
- 每个用例使用同一套修复预算；当前用例预算耗尽或同类失败连续达到阈值后，记录失败并继续下一个用例。
- blocked 重跑只执行本次运行上下文能覆盖的子集；可覆盖时先更新同一个 case plan 的 gate、目标确认和 evidence，再执行；无法覆盖的用例保持 `BLOCKED`。
- 用例局部失败时，先写入或覆盖该 case report，再继续下一个用例。
- 基础设施失败时，停止整批；停止前已完成的 case reports 必须保留。所有受该基础设施失败影响且尚未执行的 case，都必须写入 `BLOCKED` case report，`failure.code` 使用对应基础设施失败码。停止后从已有 case reports 生成或覆盖 summary 索引。

## 失败码

报告中使用这些失败码：

```text
PASS
GENERATION_BLOCKED
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
- `GENERATION_BLOCKED`
- `NAVIGATION_AMBIGUOUS`，且预期行为不清楚。
- `PRECONDITION_UNSATISFIED`
- `PRECONDITION_UNKNOWN`，且阻塞型前置条件影响开始执行。
- `TARGET_CONFIRMATION_BLOCKED`
- `TARGET_CONFIRMATION_STALE`
- `AUTH_ACCOUNT_INVALID`
- `NETWORK_OR_SERVER_ERROR`
- `UNSUPPORTED_FLOW`
- `RETRY_BUDGET_EXCEEDED`

记录原因，必要时请用户补充自然语言运行上下文。前置条件类和目标确认类 blocked 优先按运行上下文重跑，不进入代码修复。

构建探测类失败也不要通过修改 UI 测试代码修复：

- `BUILD_ENV_INVALID`
- `BUILD_TASK_UNAVAILABLE`
- `SIGNED_HAP_NOT_FOUND`
- `BUNDLE_NAME_UNRESOLVED`
- `TARGET_CONFIRMATION_BLOCKED`
- `TARGET_CONFIRMATION_STALE`

这些失败应优先记录到 execution plan 和 report，必要时请用户确认 DevEco 环境、build-profile 修改、task fallback 或 bundleName 来源。

`OHOSTEST_TARGET_MISSING` 单独处理：如果 product/module 已确认，且只缺少目标模块的 ohosTest target 或等价测试构建配置，允许在修复预算内修改测试构建配置并继续构建；如果会影响被测 app 产物、bundleName、签名、发布 target，或无法确认改动范围，则记录 `BLOCKED/OHOSTEST_TARGET_MISSING`。

## 允许有限修复

在预算内允许修复：

- `SELECTOR_NOT_FOUND`：检查 UI 代码，必要时补稳定 `.id()`，更新 selector。
- `ASSERTION_FAILED`：对比断言、人工预期和 app 合法状态。
- `TEST_TIMEOUT`：把弱等待改成目标控件等待，或合法目标页面集合等待。
- 键盘或焦点问题：优先使用文档中的 UI 操作和稳定组件目标。
- `BUILD_TEST_FAILED`：修复生成测试代码或测试模块配置中的明确编译问题。
- `OHOSTEST_TARGET_MISSING`：在 product/module 已确认且改动范围只限测试 target 配置时，补齐 ohosTest target 或等价测试构建配置。

对 `SELECTOR_NOT_FOUND`、`ASSERTION_FAILED`、`TEST_TIMEOUT`、`NAVIGATION_AMBIGUOUS`、`BUNDLE_NAME_UNRESOLVED`、runner 无结果或 app 启动失败等运行期问题，进入自动修复前应优先按 `references/project-notes/build-and-run.md` 做必要 hdc 实时诊断。诊断用于确认当前 UI、Ability、bundleName、进程或关键日志状态，避免盲目修改 selector、等待或断言。

诊断是失败定位辅助，不是修复尝试。诊断失败不占用修复预算，不阻塞报告生成；如果 hdc 或诊断命令不可用，记录诊断失败原因，并继续根据 runner 输出和已有证据分类。

自动修复循环：

```text
执行失败
-> 解析 runner 输出并初步判断失败类型
-> 对适用的运行期失败执行必要 hdc 实时诊断
-> 结合 runner 输出和诊断证据分类失败码
-> 不可修则记录最终失败
-> 可修则检查 repairBudget.remaining 和连续失败码次数
-> 可修且未超预算则修改并重跑目标用例
-> 每次重跑后更新 report 当前结果和 repairBudget
-> 通过则记录 PASS
-> 预算耗尽或同一失败码连续达到阈值则记录 FAIL/RETRY_BUDGET_EXCEEDED
```

## 前置条件失败

`PRECONDITION_UNSATISFIED`：

- 阻塞型前置条件已确认不满足，且 `impact` 为 `blocks_execution`。
- 不执行测试，生成 `BLOCKED` 报告。

`PRECONDITION_UNKNOWN`：

- 阻塞型前置条件无法自动判断。
- 如果 `impact` 为 `blocks_execution`，不在执行阶段询问用户，直接记录 `BLOCKED` 并结束当前用例；批量模式继续后续用例。
- 如果 `impact` 为 `affects_assertion` 或 `low_risk`，可以继续执行，但 plan/report 中必须记录 warning。

人工用例步骤中给出的账号、密码、手机号、验证码、商品 ID 等测试输入，不因 agent 无法预先确认有效性而产生 `PRECONDITION_UNKNOWN`；执行失败后按真实结果分类，例如 `ASSERTION_FAILED`、`AUTH_ACCOUNT_INVALID`、`NETWORK_OR_SERVER_ERROR` 或其他运行期失败码。

## 停止整批

以下情况停止批量执行，并记录 `BLOCKED`：

- 设备不可用。
- agent 环境因权限、沙箱或系统限制无法执行 hdc。
- app HAP 构建失败。
- app 安装失败。
- 测试 runner 基础设施无法启动。
- app 完全无法启动。

停止整批时，不只写 summary 索引；还要为每个受影响且未执行的 case 写入 `BLOCKED` case report。示例：app HAP 构建失败导致整批无法开始时，所有本批待执行 case 都写入 `BLOCKED/BUILD_APP_FAILED`；设备不可用时写入 `BLOCKED/DEVICE_UNAVAILABLE`。

## 修复原则

修复必须针对失败原因，并回溯到人工用例。不要为了让测试通过而削弱断言。

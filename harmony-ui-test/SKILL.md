---
name: harmony-ui-test
description: Use when generating, executing, reporting, or repairing HarmonyOS ArkTS UI tests from user-specified manual test cases, especially with ohosTest, Hypium, UiTest, HAP builds, hdc aa test, and execution reports.
---

# HarmonyOS UI Test

## 用途

当用户希望根据明确指定的人工测试用例，生成、执行、记录或修复 HarmonyOS ArkTS UI 测试时，使用这个 skill。

该 skill 是平台中立的。它假设 agent 具备读取文件、编辑项目文件、在获得权限后执行 shell 命令、写入报告的能力。不依赖特定 agent 平台的专用消息格式、插件或工具名。

## 核心模型

- 人工用例是行为源头：它定义“测什么”和“怎样算对”。
- 项目代码是辅助证据：用于定位模块、页面、路由、控件、selector 和已有风格，但不能擅自改变人工用例的预期。
- app HAP 是被测对象。
- ohosTest HAP 是测试者：包含测试逻辑、断言和 runner 入口。
- 执行报告是状态资产，不是临时日志。后续修复请求应能从报告恢复上下文。

## 输入规则

用户必须显式提供人工用例，形式可以是文件路径、多个文件路径，或直接粘贴的用例文本。

默认在 HarmonyOS 项目根目录执行。若当前目录不是项目根目录，先让用户提供项目路径，或切换到包含 `build-profile.json5`、`oh-package.json5`、`AppScope` 等项目标识的目录。

不要扫描整个项目去猜用例。出现以下情况时，停下来询问用户：

- 没有提供或找不到人工用例。
- 存在多个可能的候选用例。
- 缺少必要测试数据，例如账号、密码、入口、预期结果。
- 无法确定目标模块。
- 预期目标页面与代码中的合法跳转分支存在冲突或歧义。

## 参考文档

该 skill 自带参考文档。需要时按相对路径读取：

- `references/official/UI测试框架使用指导.md`：UI 测试流程、selector、等待、页面跳转判断。
- `references/official/单元测试框架使用指导.md`：Hypium、ohosTest 执行、`aa test`、指定 class、timeout。
- `references/official/@ohos.UiTest-ArkTS API-Test Kit.md`：`Driver`、`Component`、`On`、等待、点击、输入、键盘、断言等 API。
- `references/project-notes/build-and-run.md`：HAP 构建、安装、debug 校验、测试执行命令模板。
- `references/project-notes/execution-plan.md`：执行计划、前置条件闸门、plan/report 关系。
- `references/project-notes/test-code-patterns.md`：UI 测试代码模板、异常暴露、Driver 与 selector 稳定性规则。
- `references/project-notes/report-format.md`：报告文件和字段要求。
- `references/project-notes/failure-policy.md`：失败预算、失败码、继续/停止规则。

知识优先级：

1. 用户本次指定的文档。
2. skill 自带 `references/official/` 文档。
3. 项目内测试文档。
4. 项目已有测试和实现。
5. agent 通用知识。

执行报告中记录本次使用过的参考文档。

`references/official/` 中的文档可能较大。需要查 API 或框架细节时，优先用关键词搜索相关章节，再读取命中的片段；不要为了一个小问题一次性加载整份大文档。

## 测试放置规则

默认将 UI 测试写入对应被测模块：

```text
<module>/src/ohosTest/
```

只有在项目文档或现有结构明确要求集中测试工程时，才使用集中测试模块。

当 UI 缺少稳定定位点时，优先给被测页面或组件补充稳定 `.id()`。除非用户明确要求，不修改业务行为。

## 执行生命周期

只要从人工用例生成或更新测试代码，就必须生成 execution plan，并在测试代码中写入 `CASE_ID` 和 `PLAN_ID` 或 `planFile` 注释。若用户只要求生成测试，则 plan 保持 `draft`，不做完整探测和 gate，不生成执行报告，并说明未执行。

如果用户要求执行、验证、跑一下、看结果，或已经进入修复执行，则必须先读取已有 execution plan；如果不存在，再从用户指定的人工用例生成 plan。随后补全项目探测、前置条件闸门和目标产物确认。只有 gate 和当前阶段目标确认都允许时，才继续构建、安装、运行，并生成报告。若 gate 或目标确认阻塞，则不执行后续阶段，直接生成 `BLOCKED` 报告。

单个用例执行和批量执行都默认按无人值守处理。前置条件无法自动判断且会影响执行或断言时，不要中途询问用户；将当前用例标记为 `BLOCKED/PRECONDITION_UNKNOWN`，写入 plan/report，并结束当前用例的执行流程。若处于批量模式，继续后续用例。只有在生成测试前遇到用例缺失、入口不清、预期不明、模块归属不明等会导致测试代码无法可靠生成的歧义时，才停下来询问用户。

preconditionGate 默认阻塞执行，不默认阻塞测试代码生成。只有当前置条件导致人工预期、目标页面、测试入口或断言策略无法确定时，才阻塞测试生成；设备、hdc、构建环境、签名产物等执行环境问题通常只阻塞执行。

Execution Plan 是执行前产物，默认写入被测 HarmonyOS 项目根目录的 `test-reports/ui-test/`。它承载人工用例解析结果、前置条件、gate 决策、命令计划和产物路径。报告是执行后产物，必须引用本次使用的 plan。字段和规则见 `references/project-notes/execution-plan.md`。

构建或执行前必须进行项目探测，确认 `DEVECO_SDK_HOME`、`node`、`hvigorw.js`、可用 hvigor task、product、module、ohosTest target、bundleName 候选和 signed HAP 选择规则。构建完成后再选择实际 signed HAP 产物并更新 plan/report。探测规则见 `references/project-notes/build-and-run.md`。

构建、安装或运行前必须做目标产物确认，避免多 product、多 module 或多 bundleName 项目跑错对象。构建前先向用户展示将使用的 `product`、`moduleName`、`buildMode`、bundleName 候选、test module 候选、设备和关键构建命令；用户确认后再构建。安装或运行前再展示实际 app/test signed HAP 路径、最终 app `bundleName`、test module、设备、安装和运行命令；用户确认后才安装或执行。该确认闸门适用于单个用例和批量用例。若构建后实际 signed HAP、bundleName 或 test module 与确认摘要不一致，必须再次确认；用户未确认时记录 `BLOCKED/TARGET_CONFIRMATION_BLOCKED`，不要安装或运行。

单个用例：

```text
人工用例
-> 解析步骤、数据、前置条件和预期结果
-> 定位模块和入口
-> 生成 execution plan
-> 创建或更新模块 src/ohosTest
-> 生成或更新测试代码
-> 写入 CASE_ID 和 PLAN_ID 或 planFile 注释
-> 若需要执行，补全探测、检查前置条件并更新 preconditionGate
-> 构建前展示目标计划和构建命令摘要，等待用户确认
-> 构建 debug app HAP
-> 构建 module@ohosTest HAP
-> 安装/运行前展示实际 signed HAP、bundleName、test module 和命令摘要，等待用户确认
-> 安装 app HAP
-> 安装 test HAP
-> 执行目标测试
-> 写入报告
```

批量用例：

```text
先解析所有显式指定的用例
-> 生成 case/module/test 映射
-> 生成 summary plan 和每个 case plan
-> 对有歧义的用例停下来确认
-> 按模块生成测试
-> 写入每个 case 的 CASE_ID 和 PLAN_ID 或 planFile 注释
-> 若需要执行，补全共享探测、检查共享前置条件和 case 前置条件
-> 按 product/module/bundle 分组展示目标计划和构建命令摘要，等待用户确认
-> 尽量按模块构建
-> 安装/运行前按分组展示实际 signed HAP、bundleName、test module 和命令摘要，等待用户确认
-> 按分组安装并执行
-> 每个用例写 case report
-> 写 summary report
```

构建和执行命令模板见 `references/project-notes/build-and-run.md`。

执行 `hdc`、安装 HAP、运行 `aa test` 时，如果普通执行遇到 `Connect server failed`、权限、沙箱、server connect、USB 访问或系统拦截类错误，立即按 `references/project-notes/build-and-run.md` 的 hdc 权限处理流程，用平台提权/沙箱外机制重跑同一命令。提权后成功时，后续 install 和 aa test 沿用同一 hdc 路径和同一权限方式。不要把 agent 环境权限问题当成测试用例失败反复修代码。

## 断言策略

断言应匹配人工用例要求。

如果登录或导航成功后可能进入多个合法页面，优先断言人工用例中的稳定不变量，例如“离开账号密码登录页面”。如果需要更强的成功证明，应等待任一合法成功目标页面的稳定 id。除非测试能控制账号状态、redirect 或 mock 数据，否则不要断言唯一目标页面。

## 报告

用户要求执行后，只要进入探测、gate、目标确认、构建、安装或运行任一阶段，就必须在最终回复前写入报告，即使还没有真正执行测试。

如果前置条件闸门或目标产物确认阻塞导致没有执行测试，也必须生成 `BLOCKED` 报告，并引用对应 execution plan。

默认目录：

```text
test-reports/ui-test/
```

报告默认写入被测 HarmonyOS 项目根目录下的 `test-reports/ui-test/`，不是 skill 包目录。

单个用例写入：

```text
<timestamp>-<case-name>.md
<timestamp>-<case-name>.json
```

批量执行额外写入：

```text
<timestamp>-summary.md
<timestamp>-summary.json
```

报告字段见 `references/project-notes/report-format.md`。

## 基于运行上下文重跑 BLOCKED 用例

当用户要求重跑、继续或恢复 blocked 用例时，不要默认重跑全部 blocked 用例。先读取 summary/report 和对应 execution plan，筛选 `BLOCKED` 且失败码为 `PRECONDITION_UNKNOWN`、`PRECONDITION_UNSATISFIED`、`TARGET_CONFIRMATION_BLOCKED` 或 `TARGET_CONFIRMATION_STALE` 的用例。

用户只需要提供自然语言运行上下文，例如“账号已登录，测试数据已准备好，确认使用这个 bundle，重跑 blocked”。agent 负责把这句话映射到每个用例的阻塞型前置条件和目标确认状态，生成 rerun plan，并写入 `runContext` 和 `rerunSelection`。

只有当某个用例的所有阻塞型前置条件和目标确认阻塞都被本次运行上下文、自动检查结果或已有证据覆盖时，才重跑或继续该用例。只覆盖部分条件、无法判断覆盖关系，或没有新的运行上下文时，不执行该用例，继续保持 `BLOCKED` 并记录未覆盖条件。批量重跑时只执行可覆盖的子集。

重跑 blocked 不是修复测试代码，不写入 `repairHistory`；应写入 `rerunHistory`。如果重跑过程中发现测试代码或 selector 问题，再进入“基于报告修复”流程。

## 基于报告修复

当用户要求修复失败用例或之前执行过的用例时，不要盲目重新生成。

先按失败码分流：`PRECONDITION_UNKNOWN`、`PRECONDITION_UNSATISFIED`、`TARGET_CONFIRMATION_BLOCKED`、`TARGET_CONFIRMATION_STALE` 默认走“基于运行上下文重跑 BLOCKED 用例”，不是代码修复；只有用户明确要求改代码，或失败码属于 `SELECTOR_NOT_FOUND`、`ASSERTION_FAILED`、`TEST_TIMEOUT`、`BUILD_TEST_FAILED` 等可修复类型时，才进入本节修复流程。

按以下顺序恢复上下文：

1. 用户显式提供的报告路径。
2. 当前对话中提到过的报告路径。
3. `test-reports/ui-test/` 下最新 summary。
4. 如果只有一个失败用例，修复它。
5. 如果存在多个失败用例，询问用户选择哪一个。

只在当前被测 HarmonyOS 项目根目录的 `test-reports/ui-test/` 中查找报告。若最新 summary 中有多个失败用例，必须让用户选择；不要跨项目猜测要修复的报告。

修复流程：

```text
读取报告
-> 读取报告引用的 execution plan
-> 读取原始人工用例
-> 读取当前测试代码和相关 UI 代码
-> 继承原 plan 中的 preconditions 和 preconditionGate
-> 判断失败是否可修
-> 生成 repair execution plan
-> 做最小化针对性修改
-> 尽量只重跑目标用例
-> 向 case report 追加 repair history
-> 如果存在 summary，同步更新 summary
```

修复完成的条件是目标报告已经更新。

## 失败预算

不要无限循环修复。

默认预算：

- 单个用例：初始生成后最多 2 次修复尝试。
- 批量模式：每个失败用例最多 1 次针对性修复，除非用户要求深入修复。
- blocked 重跑使用独立 `rerunHistory`，不占用修复尝试次数；`keep_blocked` 不计入执行次数。
- 同类失败连续出现 2 次：停止该用例并记录失败。
- 批量模式下，设备、app 构建、app 安装、全局 runner 启动失败：记录阻塞并停止整批。

失败码和处理规则见 `references/project-notes/failure-policy.md`。

## 完成标准

只有满足以下条件，任务才算完成：

- 已生成测试代码，或已记录阻塞原因。
- 如果用户要求执行，必须有 pass、fail 或 blocked 报告。
- 修复尝试必须更新既有报告历史。
- 最终回复包含报告路径和简要结果。

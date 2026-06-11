---
name: harmony-ui-test
description: 当用户需要基于人工测试用例生成、执行、调试或修复鸿蒙/HarmonyOS ArkTS UI 单元测试时使用，适用于 ohosTest、Hypium、UiTest、HAP 构建安装、hdc/aa test 执行、前置条件判断、失败自动修复、测试报告和批量用例处理。
---

# HarmonyOS UI Test

## 快速入口

当用户希望根据明确指定的人工测试用例生成、执行、记录、重跑或修复 HarmonyOS ArkTS UI 测试时，使用这个 skill。

先读取 `references/project-notes/workflow-index.md`，按用户意图选择后续 reference；不要一次性加载全部文档。官方文档较大，只在需要 API 或框架细节时用关键词搜索相关片段。

## 核心底线

- 人工用例是行为源头：它定义“测什么”和“怎样算对”。
- 项目代码只作为辅助证据：用于定位模块、页面、路由、控件、selector 和已有风格，不能擅自改变人工用例预期。
- 生成测试前必须建立人工步骤到测试代码动作的逐条映射；不能跳步、合并丢信息、弱化断言或补充人工用例没有要求的业务动作。
- 无法忠实生成时，写入 execution plan 的 `generation.status = blocked`；不要生成打折用例。
- 测试代码默认贴近官方示例，直接使用 `Driver`、`ON`、`Component`、`expect` 等 API；不要为了包装错误信息而新增 helper 或宽泛 `try-catch`。
- 测试代码不写入 `CASE_ID`、`PLAN_ID`、`planFile` 或其他 workflow 追踪信息；人工用例、测试方法、plan、report 的映射只在 plan/report 中维护。
- 执行报告是状态资产；用户要求执行后，只要进入探测、gate、目标确认、构建、安装或运行任一阶段，就必须生成 report。

## 必读索引

- 工作流路由：`references/project-notes/workflow-index.md`
- 工作目录与配置：`references/project-notes/workspace-and-config.md`
- plan、caseId、前置条件和重跑：`references/project-notes/execution-plan.md`
- 测试代码模板、模块归属、等待、输入和异常暴露：`references/project-notes/test-code-patterns.md`
- 构建、安装、`aa test`、目标确认、hdc 和实时诊断：`references/project-notes/build-and-run.md`
- report 字段和格式：`references/project-notes/report-format.md`
- 失败码、修复预算和停止规则：`references/project-notes/failure-policy.md`
- 官方 UI 测试流程：`references/official/UI测试框架使用指导.md`
- 官方 Hypium/ohosTest 执行：`references/official/单元测试框架使用指导.md`
- 官方 UiTest ArkTS API：`references/official/@ohos.UiTest-ArkTS API-Test Kit.md`

知识优先级：

1. 用户本次指定的文档或要求。
2. 本 skill 的 `references/project-notes/`。
3. 本 skill 的 `references/official/`。
4. 被测项目内测试文档、已有测试和实现。
5. agent 通用知识。

## 输入与身份

新生成或更新测试代码时，用户必须显式提供人工用例，形式可以是文件路径、多个文件路径，或直接粘贴的用例文本。修复、重跑或续跑已有结果时，可以从 report 引用的 execution plan 恢复人工用例。不要扫描整个项目去猜用例。

默认在 HarmonyOS 项目根目录执行。若当前目录不是项目根目录，先切换到包含 `build-profile.json5`、`oh-package.json5`、`AppScope` 等项目标识的目录；无法确定时再让用户提供项目路径。

每个用例的 `caseId` 必须由该用例原文内容稳定计算：

```text
caseId = "tc-" + sha1(normalizedManualCaseText).slice(0, 12)
```

`normalizedManualCaseText` 只做机械规范化：去掉首尾空白，换行统一为 `\n`，连续空白折叠为单个空格。不翻译、不改写、不提取语义。批量输入必须先按人工用例边界切分，再分别计算每个用例的 `caseId`。

生成新测试时，只有整体输入不可用才询问用户，例如未提供人工用例、候选来源无法判断、或批量边界无法可靠切分。单个用例无法生成时，写入 plan blocked，并继续处理其他用例。

人工用例中明确给出的账号、密码、手机号、商品 ID 等测试输入，不要在执行前判断是否“可用”或“有效”；它们属于步骤和运行结果验证范围。

## 场景路由

只生成测试代码：

```text
读取 workflow-index
-> 读取 workspace-and-config、execution-plan、test-code-patterns
-> 解析人工用例和步骤映射
-> 生成或更新 plan
-> 可忠实覆盖则写入/更新测试代码，并在 plan 记录 testFile、testClass、testMethod
-> 无法忠实覆盖则 plan.generation.status = blocked
```

执行测试：

```text
读取 workflow-index
-> 读取 workspace-and-config、execution-plan、build-and-run、report-format、failure-policy
-> 读取或生成 plan
-> 补全项目探测、前置条件 gate 和目标产物确认
-> gate 和目标确认允许后构建、安装、执行
-> 失败后先结合 runner 输出和必要 hdc 实时诊断分类
-> 按失败策略判断修复、重跑或停止
-> 每个 case 到达 PASS/FAIL/BLOCKED 后立即写入或覆盖自己的 case report
-> 若基础设施失败导致整批停止，为所有受影响且未执行的 case 写入 BLOCKED case report
-> 批量结束或中止后，从已写入的 case reports 生成或覆盖轻量 summary 索引
```

修复失败用例：

```text
读取 workflow-index
-> 从用户指定 report、对话提到的 report、或当前工作目录 summary 索引恢复候选
-> 若 summary 索引中存在多个可修失败用例，列出候选并等待用户选择；只有一个候选时才自动继续
-> 读取 report.planFile 和对应 plan
-> 按 failure-policy 判断是否可修
-> 读取 test-code-patterns 和相关项目代码
-> 做最小化修改并重跑目标用例
-> 覆盖更新当前 report；批量场景同步或重建 summary 索引
```

重跑 BLOCKED 用例：

```text
读取 workflow-index
-> 读取 report 和 plan
-> 若 summary 索引中存在多个 blocked 用例，按本次运行上下文筛选；筛选后仍有多个且目标不明确时，列出候选并等待用户选择
-> 只选择本次运行上下文能覆盖的 blocked 用例
-> 对可覆盖用例更新同一个 case plan 的 preconditions、preconditionGate、targetConfirmation 和 evidence
-> 不改测试代码，不占用修复预算
-> 重跑后覆盖更新 report；批量场景同步或重建 summary 索引
```

## 执行约束

- 生成、执行或修复前先解析专属工作目录，默认是被测 HarmonyOS 项目根目录下的 `harmony-ui-test-workspace/`。
- 若工作目录不存在，创建目录和默认 `config.json`；若已存在，先读取配置。
- 构建或执行前必须探测 DevEco SDK、Node、hvigor、hdc、product、module、ohosTest target、bundleName 候选和 signed HAP 选择规则。
- 构建前必须展示目标产物确认摘要；用户确认后再构建。
- 构建后必须自动校验实际 signed HAP、bundleName、test module、设备和命令；一致时继续安装/执行，不一致或无法确认时再次确认。
- `hvigor tasks` 未列出测试构建 task 时，不要直接判定不可用；按 `build-and-run.md` 尝试 `taskTree`、模板命令或项目日志中的等价命令。
- 执行失败后可以用 hdc 做聚焦实时诊断，但诊断不能覆盖 runner 原始失败事实，诊断失败也不能阻塞报告生成。
- 不要无限循环修复；修复预算、同类失败停止阈值和批量停止规则以 `failure-policy.md` 和工作目录配置为准。

## 完成标准

任务完成必须满足：

- 已生成测试代码，或已在 plan 中记录无法生成的阻塞原因。
- 如果用户要求执行，每个已识别用例都有 `PASS`、`FAIL` 或 `BLOCKED` report；生成阶段 blocked 的用例写 `BLOCKED/GENERATION_BLOCKED`。
- 如果用户要求修复，目标 report 已更新为最新结果。
- 最终回复包含关键结果和 report/plan 路径；如果未能执行测试，说明原因。

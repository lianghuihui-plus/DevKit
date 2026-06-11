# 工作流索引

本文件用于决定当前任务应该读取哪些 reference。先按用户意图选择场景，再读取对应文件；不要为了一个局部问题一次性加载所有文档。

## 只生成测试代码

读取：

- `execution-plan.md`：生成 plan、caseId、人工用例到测试方法映射。
- `test-code-patterns.md`：测试代码写法、步骤覆盖、少封装、等待和输入规则。
- `workspace-and-config.md`：工作目录和配置文件。

不读取：

- `report-format.md`，除非用户同时要求执行。
- `build-and-run.md`，除非需要确认模块或 ohosTest 结构。

## 执行测试

读取：

- `workspace-and-config.md`：工作目录、环境默认值、修复预算配置。
- `execution-plan.md`：读取或生成 plan、前置条件 gate、目标映射。
- `build-and-run.md`：环境探测、构建、安装、`aa test`、目标确认和失败后 hdc 步骤复现。
- `report-format.md`：执行结果报告。
- `failure-policy.md`：失败码、是否修复、是否停止整批。

## 修复失败用例

读取：

- `report-format.md`：从 report 恢复 `planFile` 和当前结果。
- `execution-plan.md`：从 plan 恢复人工用例、测试文件、测试方法和前置条件。
- `failure-policy.md`：判断失败是否可修、预算是否可用。
- `test-code-patterns.md`：修复 selector、等待、断言、输入和异常暴露。
- `build-and-run.md`：运行期失败需要按人工步骤 hdc 复现定位时读取。

如果只能从 `summary.json` 恢复候选，且存在多个可修失败用例，必须先让用户选择目标 case；不要自动挑选。summary 是批量索引缓存，缺失或过期时从 case reports 重建。

## 重跑 BLOCKED 用例

读取：

- `execution-plan.md`：blocked 重跑条件、运行上下文覆盖规则。
- `report-format.md`：读取 case report 或 summary 索引。
- `failure-policy.md`：确认 blocked 失败码是否应该重跑而不是修代码。

如果 `summary.json` 中有多个 blocked 用例，先按本次运行上下文筛选；筛选后仍有多个且目标不明确时，必须让用户选择。summary 是批量索引缓存，不能替代 case report 和 case plan。

## 构建、安装或 aa test 问题

读取：

- `build-and-run.md`：DevEco/Node/hvigor/hdc 探测、目标确认、固定脚本和常见坑。
- `workspace-and-config.md`：环境路径默认值和配置优先级。
- `failure-policy.md`：构建类失败是否允许自动修复。

## 写或修 ArkTS UI 测试代码

读取：

- `test-code-patterns.md`：官方风格、少 helper、少 `try-catch`、`waitForComponent` 非空、目标状态等待、文本输入策略。
- `references/official/`：只在需要 API 细节时按关键词搜索相关片段。

## 报告和产物字段

读取：

- `report-format.md`：report JSON/Markdown 字段、diagnostics、覆盖策略。
- `execution-plan.md`：plan 与 report 的引用关系。
- `workspace-and-config.md`：工作目录、logs、reports、plans。

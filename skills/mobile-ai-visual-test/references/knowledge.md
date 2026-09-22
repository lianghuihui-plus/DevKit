# 本地知识库运行时规则

本地知识库用于补充当前 App 现场无法独立解释的已知业务现象、平台差异、版本行为和导航信息。知识只提供候选依据，Case Agent 必须结合当前 Scene 判断是否适用；查询命中本身不能改变 verdict。

知识的新增、修改、删除和面向维护者的全量校验不属于 MAVT 能力，由独立知识库管理 Skill 负责。MAVT 只读消费已存在的知识，并在创建执行请求时执行内部防御性校验。

## 用途与来源

Runtime 同时读取：

- Skill 级：`<skill-root>/knowledge/`
- Workspace 级：`<workspace>/knowledge/`

两个目录中的 Markdown 地位相同。Workspace 条目不自动高于 Skill 条目，不设置可信度、置信度或来源等级。执行请求创建后，当前 execution 使用冻结的知识候选和内容快照，不依赖实时文件继续保持不变。

## 查询上下文与候选规则

查询可包含 `platform`、`app`、`version`、`page`、`operation`、`symptom` 和 `keywords`。

- Runtime 始终使用 execution 绑定的 platform、`appId` 和可用版本作为硬兼容条件，不使用产品展示名。
- Runtime 已确认的 Scene page 是硬条件。
- Case Agent 提供的 page 和 operation 只是召回提示，仅参与排序和词面召回；名称不一致不会排除候选，也不能覆盖冻结环境或已确认页面。
- 明确违反硬条件的条目先被排除。
- 兼容条目中存在现象或关键词词面命中时，只返回词面命中的候选。
- 没有任何词面命中时，只返回至少匹配一个已声明元数据维度的发现候选。
- 每次最多返回 5 条；`candidateCount` 表示返回数量，`truncated` 表示是否仍有候选被上限截断。
- 分数只用于候选排序，不表示可信度或最终适用性。

零候选时，响应和 execution 事件通过 `filterDiagnostics` 记录扫描数量、按字段排除的数量和有限的拒绝示例。该诊断只解释未命中原因，不改变候选，也不要求 Case Agent 追加调用。

## 候选复核

查询返回候选后，Case Agent 必须根据当前 Scene 逐条判断：

- `APPLICABLE`：适用于当前现场，可以作为知识支持依据。
- `NOT_APPLICABLE`：内容可信，但不适用于当前版本、页面或现象。
- `CONFLICTING`：候选之间或候选与当前现场存在冲突。
- `INSUFFICIENT`：候选相关，但不足以支持当前结论。

候选复核使用 `APPLICABLE_FOUND`、`NO_APPLICABLE`、`CONFLICTING` 或 `INSUFFICIENT` 汇总调查。`NO_APPLICABLE` 必须评估全部候选；过期条目仍可返回，但不能评估为 `APPLICABLE`。零候选由 Runtime 自动记录 `NO_MATCH`。

候选评估通过 `knowledge` 的复核调用提交。查询和复核的完整签名见 [`CaseRuntime.knowledge`](case-runtime/methods/knowledge.md)。

## 快照与结果引用

每次查询冻结候选条目的 ID、来源 namespace、相对路径、适用范围元数据、追溯信息、内容 SHA、有效期、冲突声明和摘要片段。命中内容按 SHA 保存到当前 execution 的 `knowledge/<contentSha>.md`，相同内容只保存一次。

知识被评估为适用并影响最终检查时，check 使用 `knowledgeRefs` 引用条目 ID。Runtime 只接受当前 execution 已冻结且评估为 `APPLICABLE` 的引用。已发布报告只读取 execution 中的冻结候选和内容快照；实时知识文件后续修改或删除不会改变既有 execution 的依据。

## 何时调查

知识调查由结论所需信息触发，而不是由结论正负触发。出现以下情况时查询：

- 结论依赖 Scene 之外的产品规则、平台或版本差异、账号、配置或其他外部条件。
- 截图和控件树无法独立解释异常，并且知识可能补充缺失的业务语义。
- 无法确定下一步是因为缺少已知业务约束，而不是因为尚未观察或检查现有证据。

实际结果不符、操作失败或准备形成 `FAIL`、`INCONCLUSIVE`、`BLOCKED`，本身都不是强制查询条件。现场证据充分时直接形成结论；查询无候选或候选均不适用时仍按现场证据判断。

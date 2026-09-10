# 本地知识库

本地知识库用于补充当前 App 现场无法独立解释的已知业务现象、平台差异、版本行为和导航信息。知识只提供候选依据，Agent 必须结合当前 observation 判断是否适用；查询命中本身不能改变 verdict。

## 知识源

- Skill 级：`<skill-root>/knowledge/`
- Workspace 级：`<workspace>/knowledge/`

两个目录中的 Markdown 地位相同。条目进入目录即视为内容可信，不设置可信度、置信度或来源等级；Workspace 条目不自动高于 Skill 条目。

创建执行请求前必须运行等价于 `node scripts/knowledge.js validate --workspace <workspace>` 的校验。校验覆盖固定章节、重复 ID、文件大小、安全路径/符号链接、日期格式以及冲突引用存在性；失败只阻止新请求，不改写已有 execution 中冻结的知识事实。

## 条目格式

每个 `.md` 文件只包含一个条目，并严格按以下章节定义组织：

| 顺序 | 结构 | 内容要求 |
|---|---|---|
| 1 | 一级标题 | 以稳定且唯一的 `K-` 条目 ID 开头，并包含条目标题 |
| 2 | `适用范围` | 声明用于检索和适用性判断的结构化元数据 |
| 3 | `可观察现象` | 描述能够从当前业务现场核对的客观表现 |
| 4 | `结论与处理建议` | 描述知识支持的解释及执行建议 |
| 5 | `追溯信息` | 记录知识来源和可追溯依据 |

四个二级章节必须存在、顺序固定且内容非空。`适用范围` 支持以下元数据；未声明的维度不参与筛选，多值使用英文逗号分隔：

| 字段 | 写法 |
|---|---|
| `App` | 使用执行环境中的稳定 `appId`，即 Android/HarmonyOS 包名或 iOS Bundle ID；不填写产品展示名 |
| `Platform` | 使用 `harmony`、`android` 或 `ios` |
| `Version` | 仅在规则受版本限制时填写；支持精确版本、`3.2.x`/`3.2.*` 和 `4.0-4.5` |
| `Page` | 填写知识实际适用的业务页面名称 |
| `Operation` | 填写触发现象的业务操作 |
| `Valid until` | 使用 `YYYY-MM-DD`；过期条目仍可查到，但不能评估为 `APPLICABLE` |
| `Conflicts with` | 填写已知冲突条目的 `K-` ID |

`App` 和 `Platform` 使用标准化后的精确值匹配；其他适用范围字段用于进一步缩小候选。产品展示名、来源说明和适用包名可以出现在正文或追溯信息中，但参与 App 过滤的包名必须写入 `App`。条目不使用 YAML frontmatter、数据库、向量服务或可信评分。

`可观察现象` 只描述能从截图、控件树或当前业务现场核对的表现，并包含用户或用例常用的关键名称。原因解释、适用后的判断方式和不能解释的边界写入 `结论与处理建议`；来源、确认人或确认方式、日期和外部依据写入 `追溯信息`。未知的版本、页面或操作不要猜测，直接省略对应元数据。

最小示例：

```markdown
# K-editor-001 HarmonyOS 我的作品页不展示 Nemo 分类

## 适用范围
- App: com.codemao.hos.lunar
- Platform: harmony
- Page: 我的作品
- Operation: 查看作品分类 TAB

## 可观察现象
将作品分类 TAB 滑动到最右端后显示 Kids，但不显示 Nemo TAB；其他分类正常显示。

## 结论与处理建议
Nemo 缺失属于已知平台差异。独立验证其他分类，并在采用本规则时引用该知识条目。

## 追溯信息
产品确认，2026-08-20，适用包名 com.codemao.hos.lunar。
```

## 查询与审计

查询可包含 `platform`、`app`、`version`、`page`、`operation`、`symptom` 和 `keywords`。Runtime 始终使用 execution 绑定的 platform、`appId` 和可用版本作为硬兼容条件，不会使用产品展示名；Runtime 已确认的 Scene page 同样是硬条件。Case Agent 可通过 `knowledge.context.page` 和 `knowledge.context.operation` 提供召回提示，这两个字段只参与排序和词面召回，不因名称不一致排除候选，也不能覆盖冻结环境或已确认页面。本地脚本先排除与硬条件明确冲突的条目，再优先返回现象或关键词命中的条目；没有词面命中时，只返回至少一个已声明元数据维度匹配的发现候选。每次最多返回 5 条，响应以 `candidateCount` 表示返回数量，并以 `truncated` 表示是否仍有候选被上限截断。分数只用于候选排序。

零候选时，响应和 execution 事件使用 `filterDiagnostics` 记录扫描数量、按字段排除的数量和有限的拒绝示例。该诊断用于说明为什么没有命中，不改变知识候选，也不要求 Case Agent 追加调用。

每次查询冻结候选条目的 ID、来源 namespace、相对路径、完整适用范围元数据、追溯信息、内容 SHA、有效期、冲突声明和摘要片段。每个命中内容同时按 SHA 保存到当前 execution 的 `knowledge/<contentSha>.md`，候选通过 `snapshotRef` 引用它。相同内容只保存一份。查询事件同时绑定当时的 Scene、用例理解版本和相关验证点。Case Agent 结合当前现场判断候选是否适用，查询命中本身不改变 verdict。

- `APPLICABLE`：适用于当前现场，可作为知识支持依据。
- `NOT_APPLICABLE`：内容可信，但不适用于当前版本、页面或现象。
- `CONFLICTING`：候选之间或候选与当前现场存在冲突。
- `INSUFFICIENT`：候选相关，但不足以支持当前结论。

候选评估附在下一次已有 Runtime 请求的 `decision.knowledgeReview` 中，不增加新的操作类型或 Agent 往返。Runtime 随后记录 `knowledgeReviewed`；零候选由 Runtime 自动记录 `NO_MATCH`。有候选时用 `APPLICABLE_FOUND`、`NO_APPLICABLE`、`CONFLICTING` 或 `INSUFFICIENT` 总结本次调查；`NO_APPLICABLE` 需要评估全部候选，过期条目不能评估为 `APPLICABLE`。

知识被评估为适用并影响最终检查时，check 使用 `knowledgeRefs` 引用条目 ID；Runtime 校验所有引用均来自当前 execution 已冻结并评估为 `APPLICABLE` 的候选。正常、无疑问且不依赖 Scene 外信息的 PASS 可以不查询；实际结果与预期不符、截图和控件树无法独立解释、操作失败或无进展、下一步或结论性质无法确定、可能受外部条件影响，或准备形成负向结论时必须调查。Broker v3 会在 finish 对负向检查确定性收口。

已发布报告只使用 execution 中冻结的候选和内容快照，不重新读取当前知识文件；实时知识条目后续修改或删除不会改变既有 execution 的依据。

知识查询由现场需要触发，不是每个结果的固定步骤。Scene 证据充分只说明现场事实能够确认，不等于异常事实的解释已经充分；查询无候选或候选不适用时，完成调查后仍按现场证据形成结论。瞬态加载经重新观察恢复且不影响结论时不需要查询。

# 本地知识库

本地知识库用于补充当前 App 现场无法独立解释的已知业务现象、平台差异、版本行为和导航信息。知识只提供候选依据，Agent 必须结合当前 observation 判断是否适用；查询命中本身不能改变 verdict。

## 知识源

- Skill 级：`<skill-root>/knowledge/`
- Workspace 级：`<workspace>/knowledge/`

两个目录中的 Markdown 地位相同。条目进入目录即视为内容可信，不设置可信度、置信度或来源等级；Workspace 条目不自动高于 Skill 条目。

创建执行请求前必须运行等价于 `node scripts/knowledge.js validate --workspace <workspace>` 的校验。校验覆盖固定章节、重复 ID、文件大小、安全路径/符号链接、日期格式以及冲突引用存在性；失败只阻止新请求，不改写已有 execution 中冻结的知识事实。

## 条目格式

每个 `.md` 文件只包含一个条目，使用以下固定结构：

```markdown
# K-login-001 登录后首页可能延迟刷新

## 适用范围
- App: 编程猫
- Platform: harmony, android
- Version: 3.2.x
- Page: 首页
- Operation: 登录后返回首页
- Valid until: 2026-12-31
- Conflicts with: K-login-009

## 可观察现象
登录成功后短时间内首页仍显示游客态入口，重新观察后会刷新为用户头像。

## 结论与处理建议
该现象在适用版本中属于已知刷新延迟；等待页面稳定并重新观察，不能仅凭第一次截图判定登录失败。

## 追溯信息
移动端登录专项验证记录，2026-07-18。
```

要求：

- 一级标题必须以稳定且唯一的 `K-` 条目 ID 开头。
- 四个二级章节必须存在、顺序固定且内容非空。
- `适用范围` 中的元数据是可选的检索条件；多值使用英文逗号分隔。
- `Valid until` 使用 `YYYY-MM-DD`；超过日期的条目仍可被查到并标记过期，但不能作为 `APPLICABLE` 依据。
- `Conflicts with` 只声明已知冲突条目 ID，不代替 Agent 对当前场景的判断。
- 不使用 YAML frontmatter、数据库、向量服务或可信评分。

## 查询与审计

查询可包含 `platform`、`app`、`version`、`page`、`operation`、`symptom` 和 `keywords`。本地脚本按结构化字段和正文相关度排序，分数只用于候选排序。

每次查询冻结候选条目的 ID、来源 namespace、相对路径、完整适用范围元数据、追溯信息、内容 SHA、有效期、冲突声明和摘要片段。每个命中内容同时按 SHA 保存到当前 execution 的 `knowledge/<contentSha>.md`，候选通过 `snapshotRef` 引用它。相同内容只保存一份；查询提交、评估写入、finalize、completion 和报告读取都校验安全路径、文件存在性和 SHA。Agent 对候选逐条记录：

- `APPLICABLE`：适用于当前现场，可作为知识支持依据。
- `NOT_APPLICABLE`：内容可信，但不适用于当前版本、页面或现象。
- `CONFLICTING`：候选之间或候选与当前现场存在冲突。
- `INSUFFICIENT`：候选相关，但不足以支持当前结论。

零命中是有效查询结果。历史报告只使用 execution 中冻结的候选、内容快照和评估，不重新读取当前知识文件；实时知识条目后续修改或删除不会改变既有 execution 的依据。

知识查询由现场需要触发，不作为每个结果的固定步骤。FAIL、INCONCLUSIVE 和业务相关 BLOCKED 必须查询；前置条件异常、路径变化或现场无法独立解释时可以随时查询。当前直接证据已经充分支持 PASS 且没有异常时不要求查询；PASS 需要依赖已知正常现象、平台差异或版本行为时，必须查询并把适用候选评估为 `APPLICABLE` 后才能作为依据。

查询以 `agent/knowledge-query-<queryId>.draft.json` 作为本地提交日志：先冻结标准化 query、候选及完整内容，再写内容快照，最后写 timeline 事件并删除草稿。任一阶段中断后由协调器自动恢复，继续使用草稿中的首轮候选，即使实时知识文件已变化也不会重新检索；事件已经写入但草稿未删除时只校验绑定并清理草稿。

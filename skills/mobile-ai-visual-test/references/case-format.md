# 用例输入与产物

## 输入

用例来源可以是任意可由 Authoring Agent 读取的格式，也可以由一个或多个输入共同组成。文件数量、格式和物理布局不决定用例数量；Authoring Agent 完整阅读内容后，按业务语义形成一条或多条 draft。

每条 draft 包含稳定 `sourceLocator`、标题和相关原始内容。框架只验证这些字段并持久化，不解释表格行、文档章节或其他格式结构。空内容返回 `CASE_AUTHORING_INPUT_INVALID`，整批在写入前拒绝；已有单文本导入入口仍分别使用 `CASE_INPUT_EMPTY` 和 `CASE_INPUT_UNREADABLE`。

## case 目录

```text
cases/<title>__<caseKey>/
  case.json
  source.md
  platforms/<platform>/executions/<executionId>/
```

`source.md` 保存该逻辑用例对应的来源内容；`case.json` 只保存稳定的三位 `caseNo`、`caseKey`、标题、`sourceSha`、导入来源和 `contractSha`，不保存预生成验证点或计划。Agent-authored 用例以 `sourceLocator` 形成稳定标识，重复导入更新同一 case 并保留编号。用户以编号选择单个或批量执行范围，Coordinator 负责解析到稳定目录。

ExecutionRequest 只接受用例选择，不接受 Agent 生成的 inline Case Flow。创建 execution 时复制 `source.snapshot.md` 和 `case.snapshot.json`，并冻结环境、App、平台策略和协议摘要。源文件后续变化不会改变正在执行的 execution；重跑会创建独立的新 execution。

Case Flow 由 Case Agent 在 execution 内通过 `plan` 生成，所有 revision 追加到 `events.jsonl`，不写回 `case.json` 或 `source.md`。语义不变的节点和边保留 `N` / `L` 引用，取消的引用不复用。

当前唯一支持的 execution 格式为 schema 14。历史 execution 不迁移、不补写、不可继续执行或展示，统一标记为不支持并要求重跑；旧工作空间目录和原始用例仍可创建新的 schema 14 execution。

# 用例输入与产物

## 输入

任意可读取且至少包含一个非空白字符的文本文件都可作为用例输入，不要求 Markdown 标题、前置条件、编号步骤、断言表格或固定字段。框架不评价内容质量，也不从文本格式决定业务结果。

空文件、纯空白或去除 BOM 后为空返回 `CASE_INPUT_EMPTY`，不创建 case、execution、Agent session 或报告；不可读取路径返回 `CASE_INPUT_UNREADABLE`。

## case 目录

```text
cases/<title>__<caseKey>/
  case.json
  source.md
  platforms/<platform>/executions/<executionId>/
```

`source.md` 保存原文；`case.json` 只保存稳定的三位 `caseNo`、`caseKey`、标题回退值、`sourceSha`、导入来源和 `contractSha`，不保存预生成验证点或计划。用户以编号选择单个或批量执行范围，Coordinator 负责解析到稳定目录。

ExecutionRequest 只接受用例选择，不接受 Agent 生成的 inline Case Model。创建 execution 时复制 `source.snapshot.md` 和 `case.snapshot.json`，并冻结环境、App、平台策略和协议摘要。源文件后续变化不会改变正在执行的 execution；重跑会创建独立的新 execution。

Case Model 由 Case Agent 在 execution 内通过 `plan` 生成，所有 revision 追加到 `events.jsonl`，不写回 `case.json` 或 `source.md`。相同验证点保留原 `E` 引用，新验证点由 Runtime 分配新引用，取消的引用不复用。

当前 Reader 只接受当前 execution schema。其他格式不迁移、不补写、不继续执行，也不通过当前 Reader 转换；看板只从当前可发布 execution 中选择最新结果，取消记录不能覆盖较新的已发布结果。

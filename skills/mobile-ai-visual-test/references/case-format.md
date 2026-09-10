# 用例输入与产物

## 输入

任意可读取且包含至少一个非空白字符的文本文件都可作为用例输入，不要求 Markdown 标题、前置条件、编号步骤、断言表格或固定字段。框架不评价内容质量，也不从格式决定业务结果。

空文件、纯空白或去除 BOM 后为空的输入返回 `CASE_INPUT_EMPTY`，不创建 case、execution、Agent session 或报告。不可读取路径返回 `CASE_INPUT_UNREADABLE`。

## case 目录

```text
cases/<title>__<caseKey>/
  case.json
  source.md
  definitions/
    <definitionId>.json
    current.json
  platforms/<platform>/executions/<executionId>/
```

`source.md` 保存原文；`case.json` 只保存工作空间内唯一且稳定的三位起始编号 `caseNo`、机器标识 `caseKey`、标题回退值、sourceSha、导入来源和 contractSha，不包含固定 `preconditions`、`steps` 或 `globalRules`。新用例默认按 `001、002、003...` 分配；源文件名以数字开头且编号未占用时沿用该编号；重复导入同一路径保持原编号。

用户通过编号沟通单个或批量执行范围。协调器创建执行请求时提交目标 `caseNo`，框架负责解析为稳定的 `caseKey` 和目录；编号不存在或不匹配时在创建请求前明确报错。

Authoring 阶段由隔离的单用例 Compiler 读取原文并生成候选 CaseDefinition，确定性 Publisher 校验 case/source 绑定、expectation 原文 quote、连续 ID 和 `initialStateIntent` 后发布不可变版本。`definitions/current.json` 只保存当前 READY 引用；定义变化时创建新 definitionId，不覆盖旧版本。

ExecutionRequest 只接受 `caseNo + definitionRef`，不接受 inline CaseSpec、初始状态要求或 preparation policy。确定性代码从 CaseDefinition 投影运行契约；execution 创建时复制 `source.snapshot.md`、`case.snapshot.json`、`case-definition.snapshot.json` 和 `case-spec.snapshot.json`。后续修改源文件不会改变进行中的 execution；再次执行应创建新 execution，并使用独立产物。

旧 case 没有 `definitions/` 仍可正常显示历史报告；只有创建新执行时返回 `CASE_DEFINITION_REQUIRED`，通过一次隔离 Compiler 发布定义后即可继续，不批量改写旧 case 或历史 execution。

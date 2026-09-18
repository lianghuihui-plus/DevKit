---
name: mavt-knowledge-manager
description: 当用户需要在 MAVT 工作空间的 knowledge 知识库中新增、修改、删除、查看或校验知识条目，或要求从任意可读取材料沉淀 MAVT 本地知识时使用；不用于测试执行期间的知识查询或候选适用性判断。
---

# MAVT 知识库管理

## 能力边界

- 只操作 `workspace.json` 已标识为 READY 的 MAVT 工作空间。
- 输入材料不限制格式；使用适合的可用工具完整读取，由 Agent 判断知识边界和内容。
- 直接维护 `<workspace>/knowledge/`，但所有修改必须通过本 Skill 的 `prepare` 和 `apply`，不得绕过事务脚本直接写正式目录。
- 不执行测试，不查询用例知识，不修改 execution 快照或报告。

## 入口

每次任务先完整读取 [工作流](references/workflow.md)。

- 新增或修改时，再读取 [知识契约](references/knowledge-contract.md) 和 [编写指南](references/writing-guide.md)，并使用 [条目模板](assets/knowledge-entry-template.md) 起草。
- 查看、删除或校验时，只读取当前操作需要的引用；不要预读无关材料。

正式命令入口：

```bash
node <skill-root>/scripts/knowledge-manager.js <operation> --workspace <workspace> [...]
```

## 硬约束

- 未知事实必须省略，不得猜测 App、平台、版本、页面、操作、有效期或追溯信息。
- 一条知识只表达一个能独立判断适用性的现象或规则；同一规则优先更新，不重复新增。
- 用户已要求新增或修改时，计划校验通过后直接写入，无需再次确认。
- 只有用户明确要求删除已解析出的目标条目时才允许 `DELETE`。
- 任一阻塞校验失败都不得落盘；仅有质量告警时可以完成已授权操作并在结果中报告。
- 最终回复必须列出操作类型、条目 ID、正式路径、校验结果、告警和备份路径。

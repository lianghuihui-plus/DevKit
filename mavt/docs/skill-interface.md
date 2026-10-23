# MAVT Skill 入口约定

当前 `0.4.0` 提供四个入口：`mavt:author-cases`（MAVT 用例编写）、`mavt:run-tests`（MAVT 测试执行）、`mavt:manage-knowledge`（MAVT 知识管理）、`mavt:reporting`（MAVT 数据上报）。四个目录均独立维护 `SKILL.md` 和 `agents/openai.yaml`，通过同一份 MCP 分发包调用实际运行时。

`reporting` 使用独立 workspace 角色，负责配置、连接检查、手动补报、状态与重试；不推进 Run 或 Case。四个全局上报工具无需工作区，四个工作区工具要求 reporting context；Token 只存在私有本地文件，不出现在工具输入或安全视图。自动上报由测试终态钩子复用同一组件，故障不能阻塞测试或改变 verdict。当前验证见[验证汇总](../verification/summary.md)。

## 0.1.1 入口迁移与验证历史

插件 `0.1.1` 于 2026-10-22 统一三个用户入口。

| 入口 | 中文显示名 | 原 `0.1.0` 入口 |
| --- | --- | --- |
| `mavt:author-cases` | MAVT 用例编写 | `mavt:mavt-case-authoring` |
| `mavt:run-tests` | MAVT 测试执行 | `mavt:mobile-ai-visual-test` |
| `mavt:manage-knowledge` | MAVT 知识管理 | `mavt:mavt-knowledge-manager` |

Skill 目录名与 frontmatter `name` 保持一致，使用小写英文和连字符；插件提供 `mavt:` 命名空间。`description` 使用中文说明适用场景和必要的职责边界，不复述操作步骤。`agents/openai.yaml` 维护中文显示名和简短说明，保留默认自动发现。

三个 `SKILL.md` 统一按职责、工作区与版本绑定、操作流程、约束、结果汇报组织。用例编写负责语义拆分和正式导入；测试执行负责协调及报告，每个 Case 仍由独立 Agent 执行；知识管理只接受 READY 工作区并沿用 prepare/apply 事务。

本次仅整理插件入口、显示信息和引用。`src/`、`runtime/` 中的模块名称、Facade 协议、工作区 schema、Run 绑定和角色隔离设计保持原有定义。内部源模块的开发用 `SKILL.md` 不作为插件 Skill 发布。

升级时更新整个 marketplace 安装源，再运行 `codex plugin add mavt@mavt-local`。新开或重载会话后选择新入口；不保留重复旧入口别名。已绑定 Run 仍通过其固定副本恢复，旧版未绑定 Run 仍依赖原版本。

## 无设备验证

- 改名前将真实 Codex 发现检查切换到目标名称；旧安装包如预期因三个旧名称失败，随后新包通过相同检查。
- 三个 Skill 通过 `quick_validate.py`；独立只读评审的四个场景推演未发现职责约束遗漏或错误引用。
- 完整 `npm test` 通过：MAVT 88 组、知识管理 6 组、插件与项目边界 26 项、生成文档 51 份。
- 在临时 Codex home 安装 `0.1.1`，真实 app-server 返回三个新名称、正确中文显示信息且全部 enabled、errors 为空。升级到临时验证版本后，原固定 Run 仍可恢复并在设备确认前取消。
- 本机已安装的 MAVT 同步更新到 `0.1.1`，实际 app-server 重新发现三个新入口；桌面现有会话的选择器刷新仍以新开或重载会话为准。

结果和验证边界统一保留在 [验证汇总](../verification/summary.md)。原始 JSON 与日志已精简，需要时可从 Git 提交 `3621f35` 恢复。未运行手机、模拟器或设备连接测试。

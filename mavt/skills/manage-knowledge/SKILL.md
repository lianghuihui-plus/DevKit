---
name: manage-knowledge
description: 用户需要查看、校验、新增、修改或删除 MAVT 工作区知识，或从可读取材料沉淀知识时使用；不用于测试执行期间的知识查询或候选适用性判断。
---

# MAVT 知识管理

## 职责

只维护明确指定的 READY MAVT 工作区中的 `knowledge/`，不执行测试、不修改 execution 知识快照或报告。不得扫描猜测工作区；本 Skill 不初始化或修复工作区。

## 工作区与版本绑定

本文使用 MCP 原始工具名；通过宿主的工具发现入口按 `mavt` 查找并调用，实际名称可能带命名空间前缀，例如 `mcp__mavt__mavt_workspace_open`。

调用 `mavt_workspace_open({workspace,role:"knowledge"})`。保留响应原样返回的 `knowledgeRoot`、`bundleId` 和 `contextRef`，不要猜路径或拼造引用；contextRef 只绑定路由与完整性，不认证调用者身份。

只接受已有 READY 工作区；失败时报告原因，不改用 `mavt_workspace_init` 隐式初始化。固定旧实现返回 `MAVT_MCP_LEGACY_INTERFACE` 时报告接口不兼容，不接管旧绑定。完整读取本次 `<knowledgeRoot>/references/workflow.md`，调用 `mavt_knowledge_inspect({contextRef})`，仅 `status=VALID` 才继续。新增/修改还需读取 `references/knowledge-contract.md`、`references/writing-guide.md` 并使用 `assets/knowledge-entry-template.md`；这些相对路径和文档中的 `<skill-root>` 均以本次 `knowledgeRoot` 为根。其他操作只读相关引用。

## 操作流程

查看用 `mavt_knowledge_list/show({contextRef,...})`，校验用 `mavt_knowledge_validate({contextRef})`，新增、修改和删除用 `mavt_knowledge_prepare({contextRef,request})` / `mavt_knowledge_apply({contextRef,request,planHash})`。`request` 是对象，结构为 `{schemaVersion:1,reason,operations:[{type:"ADD",draftPath}|{type:"UPDATE",entryId,draftPath}|{type:"DELETE",entryId}]}`；同一事务复用原样请求与 prepare 返回的 `planHash`。一次维护任务的 prepare/apply 保持同一固定副本和传输；MCP 绑定的代码身份由运行时校验。跨会话丢失原绑定时，在当前选定版本重新检查并 `prepare`，不得自动应用旧计划。

MCP 返回 UNKNOWN 或结果不明时，按固定事务文档只读核查目标条目和事务记录；未确认结果前不重放 apply。

## 约束

- 完整读取用户材料，格式不限；未知 App、平台、版本、页面、操作、有效期或追溯事实必须省略，不得猜测。
- 先 list/show 了解可能重复或冲突的条目。一条知识只表达一个可独立判断适用性的现象或规则；同一规则优先更新，不重复新增。
- 草稿写在正式 `knowledge/` 外；新增使用未占用的稳定 `K-` ID，修改保留原 ID。所有正式修改通过 `prepare` / `apply` 事务，不直接编辑正式目录。
- 只有用户明确要求删除已解析出的目标条目才加入 `DELETE`；不得借新增/修改顺带清理。目标不明确时先解析并取得具体删除授权。
- 用户已授权新增或修改时，阻塞校验全部通过后直接 `apply`，无需再次确认。仅质量告警不阻止已授权操作，但需核对来源并报告；任一阻塞失败不得落盘。
- `apply` 使用本次 `prepare` 返回的原样 `planHash`；`KNOWLEDGE_PLAN_STALE` 时重新检查现状并 prepare，不复用旧哈希。保留事务的提交后校验、失败恢复和备份。

## 结果汇报

最终列出操作类型、条目 ID、正式文件路径、校验结果（含 `entryCount` / `expiredCount`）、告警、`transactionId` 与 `backupPath`；草稿路径不是正式交付路径。

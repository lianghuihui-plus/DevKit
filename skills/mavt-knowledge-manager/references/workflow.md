# MAVT 知识库管理工作流

## 1. 确认工作空间

必须取得目标 MAVT 工作空间路径，不得扫描或猜测其他目录。先运行：

```bash
node <skill-root>/scripts/knowledge-manager.js inspect --workspace <workspace>
```

只有响应为 `status=VALID` 才能继续。该 Skill 不初始化或修复工作空间。

## 2. 了解现有知识

列出条目：

```bash
node <skill-root>/scripts/knowledge-manager.js list --workspace <workspace>
```

按 ID 读取可能重复、重叠或冲突的条目：

```bash
node <skill-root>/scripts/knowledge-manager.js show --workspace <workspace> --entry-id <entry-id>
```

完整读取用户提供的所有来源。输入可以是文本、文档、表格、图片、缺陷记录或其他可读取材料，不能因为格式不同而跳过内容。

## 3. 起草变更

新增和修改时，把草稿写到正式 `knowledge/` 目录之外。新增使用尚未占用的稳定 `K-` ID；修改必须保留原 ID。根据用户意图构造事务请求：

```json
{
  "schemaVersion": 1,
  "reason": "记录已确认的业务规则",
  "operations": [
    { "type": "ADD", "draftPath": "/absolute/path/to/K-new-001.md" },
    { "type": "UPDATE", "entryId": "K-old-001", "draftPath": "/absolute/path/to/replacement.md" },
    { "type": "DELETE", "entryId": "K-unused-001" }
  ]
}
```

一个请求可以包含多项关联变更。用户明确要求删除后才能加入 `DELETE`；新增或修改请求不能顺带清理其他条目。

## 4. 准备并应用

先做无副作用预检：

```bash
node <skill-root>/scripts/knowledge-manager.js prepare --workspace <workspace> --request <request-json>
```

修复全部阻塞错误。质量告警需要结合来源审查，但不会自动阻止操作。用户已经授权新增或修改时，预检成功后直接执行 `apply`，并使用原样 `planHash`：

```bash
node <skill-root>/scripts/knowledge-manager.js apply --workspace <workspace> --request <request-json> --plan-hash <plan-hash>
```

`KNOWLEDGE_PLAN_STALE` 表示知识、请求或草稿在 prepare 后发生变化；重新检查现状并重新 prepare，不能复用旧哈希。

## 5. 校验和交付

只读全量校验可随时执行：

```bash
node <skill-root>/scripts/knowledge-manager.js validate --workspace <workspace>
```

`apply` 已自动执行提交后校验和失败恢复。最终报告：

- 新增、修改或删除的条目 ID
- 正式知识文件路径
- `entryCount`、`expiredCount` 和告警
- `transactionId` 与 `backupPath`

不得把草稿路径当作正式交付路径。

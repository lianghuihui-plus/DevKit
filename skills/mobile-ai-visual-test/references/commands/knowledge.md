# knowledge

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="knowledge-validate"></a>
## scripts/knowledge.js validate

Validate knowledge roots

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/knowledge.js validate --workspace <workspace> [--now <iso-time>]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Workspace path |
| `--now` | 否 | Validation clock override |

**成功：** `knowledge validation summary`

**最小示例：**

```bash
node '<skill-root>/scripts/knowledge.js' validate --workspace '<workspace>'
```

错误只按响应中的 [文档引用](errors/knowledge.md) 处理。

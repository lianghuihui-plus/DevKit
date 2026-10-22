# workspace

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="workspace"></a>
## scripts/workspace.js

Open the workspace

**角色：** `authoring`、`batch-coordinator`、`maintenance`

**访问：** `DIRECT`

```bash
node <skill-root>/scripts/workspace.js --cwd <workspace>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--cwd` | 是 | Workspace path |

**成功：** `workspace metadata and coordinatorCapabilities`

**最小示例：**

```bash
node '<skill-root>/scripts/workspace.js' --cwd '<workspace>'
```

错误只按响应中的 [文档引用](errors/workspace.md) 处理。

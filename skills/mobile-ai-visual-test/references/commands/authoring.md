# authoring

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="import-case"></a>
## scripts/import-case.js

Import one source file

**角色：** `authoring`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/import-case.js <input-file> --workspace <workspace>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `input-file` | 是 | Path to the source test-case file |
| `--workspace` | 是 | Workspace path |

**成功：** `imported case metadata`

**最小示例：**

```bash
node '<skill-root>/scripts/import-case.js' '<input-file>' --workspace '<workspace>'
```

错误只按响应中的 [文档引用](errors/authoring.md) 处理。

<a id="import-cases"></a>
## scripts/import-cases.js

Import Agent-authored case drafts

**角色：** `authoring`

**访问：** `DIRECT`

```bash
node <skill-root>/scripts/import-cases.js --workspace <workspace> --request-file <json-file>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Workspace path |
| `--request-file` | 是 | JSON file containing a non-empty cases array |

**成功：** `imported case metadata`

**最小示例：**

```bash
node '<skill-root>/scripts/import-cases.js' --workspace '<workspace>' --request-file '<json-file>'
```

错误只按响应中的 [文档引用](errors/authoring.md) 处理。

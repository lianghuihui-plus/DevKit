# reporting

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="render-context"></a>
## scripts/render-context.js

Render a case detail report

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/render-context.js <case-dir> [--platform <harmony|android|ios>]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `case-dir` | 是 | Case directory |
| `--platform` | 否 | Optional platform-specific report；可选：`harmony`、`android`、`ios` |

**成功：** `absolute context.html path`

**最小示例：**

```bash
node '<skill-root>/scripts/render-context.js' '<case-dir>'
```

错误只按响应中的 [文档引用](errors/reporting.md) 处理。

<a id="render-index"></a>
## scripts/render-index.js

Render the workspace index

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/render-index.js [workspace-cwd]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `workspace-cwd` | 否 | Workspace path; defaults to cwd |

**成功：** `absolute index.html path`

**最小示例：**

```bash
node '<skill-root>/scripts/render-index.js' '<workspace>'
```

错误只按响应中的 [文档引用](errors/reporting.md) 处理。

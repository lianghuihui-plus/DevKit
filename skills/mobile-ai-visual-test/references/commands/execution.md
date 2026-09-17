# execution

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="execution-request-create"></a>
## scripts/execution-request.js create

Freeze authorized targets and execution policies

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json <json> [--bootstrap-policy-json <json>] --user-instruction <text>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |
| `--mode` | 是 | Execution cardinality；可选：`single`、`batch` |
| `--targets-json` | 是 | Non-empty target list using workspace case numbers |
| `--bootstrap-policy-json` | 否 | Batch-level App bootstrap authorization; omit for KEEP_EXISTING |
| `--user-instruction` | 是 | The user instruction authorizing this execution |

**成功：** `frozen execution request`

**最小示例：**

```bash
node '<skill-root>/scripts/execution-request.js' create --workspace '<workspace>' --batch-id '<batch-id>' --mode single --targets-json '[{"caseNo":"004"}]' --user-instruction '<instruction>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="execution-request-status"></a>
## scripts/execution-request.js status

Read an execution request

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/execution-request.js status --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `current execution request`

**最小示例：**

```bash
node '<skill-root>/scripts/execution-request.js' status --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-init"></a>
## scripts/batch.js init

Initialize from an existing execution request

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js init --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `INITIALIZING`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' init --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-bootstrap"></a>
## scripts/batch.js bootstrap

Acquire the platform runtime and establish the warm session

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js bootstrap --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `batch state or terminal closure`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' bootstrap --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-reconcile"></a>
## scripts/batch.js reconcile

Advance all deterministic transitions until Agent work or terminal state

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js reconcile --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `BOOTSTRAP`、`NEED_CASE_AGENT`、`WAIT_EXECUTION_RESULT`、`BATCH_COMPLETE`、`BATCH_CANCELLED`、`BATCH_BLOCKED`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' reconcile --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-start"></a>
## scripts/batch.js start

Create the next opaque Case Agent Handoff

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js start --workspace <workspace> --batch-id <id> [--continuation-reason <reason>]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |
| `--continuation-reason` | 否 | Required only when replacing a lost Agent handle |

**成功：** `Agent dispatch metadata and optional opaque handoff`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' start --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-commit"></a>
## scripts/batch.js commit

Commit a completed current execution and refresh its report

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js commit --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `committed case and dashboard refresh status`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' commit --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-status"></a>
## scripts/batch.js status

Read batch state without advancing it

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js status --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `batch state and platform runtime status`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' status --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-cancel"></a>
## scripts/batch.js cancel

Record user cancellation

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js cancel --workspace <workspace> --batch-id <id> --reason <reason>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |
| `--reason` | 是 | Cancellation reason |

**成功：** `CANCELLING or terminal closure`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' cancel --workspace '<workspace>' --batch-id '<batch-id>' --reason '<reason>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

<a id="batch-teardown"></a>
## scripts/batch.js teardown

Release platform resources without cancelling business execution

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/batch.js teardown --workspace <workspace> --batch-id <id>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Absolute or relative MAVT workspace path |
| `--batch-id` | 是 | Execution request and batch identifier |

**成功：** `batch state and platform cleanup result`

**最小示例：**

```bash
node '<skill-root>/scripts/batch.js' teardown --workspace '<workspace>' --batch-id '<batch-id>'
```

错误只按响应中的 [文档引用](errors/execution.md) 处理。

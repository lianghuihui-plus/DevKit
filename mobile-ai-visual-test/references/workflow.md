# 执行流程

> 本文件负责：端到端阶段顺序、阶段输入输出和批量闭环。
> 事件 schema、动作参数和失败码分别见 `interfaces.md`、`action-schema.md`、`failure-policy.md`。

## 目标

每个 case 都必须完整重跑，并在当前 execution 内形成：

```text
resolve -> parse -> environment -> preflight plan -> prepare -> start
        -> preconditions (optional Flow) -> case steps -> finalize -> reports
```

Flow 只属于前置条件阶段，业务步骤阶段没有 Flow。

## 工作空间和输入

- 当前目录就是工作空间根目录；只检查当前目录，不向上查找或自动切换。
- 空目录可初始化 `workspace.json`、`cases/`、`flows/`、`index.html`。
- 非空且不是合法工作空间时停止。

先解析目标，再刷新 Markdown 用例：

```bash
scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>
scripts/parse-case.js <markdown-file> --cwd <workspace-cwd>
```

## 环境探测和确认

```bash
scripts/probe-env.sh --platform <harmony|android|ios>
scripts/update-env.js <case-dir> --platform <platform> --device <device> --app <appId> --entry <entry>
```

- 一个执行请求只做一次环境确认。
- 用户确认可复用于本批次，但必须对每个 case 分别调用 `update-env.js`。
- 用户确认和未命中 Flow 的业务前置条件，必须在无人值守执行开始前一次性收敛。

## 前置条件预检

```bash
scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd> --platform <platform>
```

预检不写 execution，而是为每个 case 生成带哈希的确定计划：

| resolution | 来源 | 执行方式 |
| --- | --- | --- |
| `flow` | 前置条件文本严格等于 Flow `name` | execution 中自动判断并执行 Flow |
| `framework` | 框架可直接判断 | execution 中写实际判断事实 |
| `confirm` | 需要人工确认 | 无人值守开始前确认，execution 中固化事实 |
| `external_setup` | 需要外部业务准备 | 执行前准备，未完成则剔除、跳过或阻塞 |
| `unsupported` | 当前不支持 | 剔除、跳过或阻塞 |

展示给用户时分成两组：自动命中的 Flow 仅供知晓；其余前置条件汇总后一次确认。Flow 严格匹配规则和资产格式见 `flow-format.md`。

## 单 case 执行

### 1. 准备和 start

```bash
scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>
scripts/run-case.js <case-dir> --platform <platform> --start --precondition-plan-sha <sha>
```

`--start` 会创建 execution、写 `executionStart`、固定完整前置条件计划并尝试 `restartApp`。若计划哈希与 preflight 不一致，必须重新 preflight；若输出 `blockedOnStart=true` 或 `nextAction=stop-current-case`，停止当前 case。

### 2. 前置条件

严格按 `case.json.preconditions` 顺序处理：

- `flow`：执行 `entry-check -> already satisfied / start check -> step loop -> end-check`，成功写 `PASS` 或 `PREPARED`。
- `framework`：采集所需事实后写 `PASS`、`FAIL`、`UNKNOWN` 或 `BLOCKED`。
- `confirm`：写入用户在无人值守开始前确认的结果。
- `external_setup`：已准备写 `PREPARED`，未准备写 `BLOCKED`。
- `unsupported`：写 `BLOCKED/PRECONDITION_UNSUPPORTED`。

只有全部前置条件为 `PASS` 或 `PREPARED` 才能进入业务步骤。Flow 的具体事件顺序见 `flow-format.md`。

### 3. 业务步骤

从 `case.json.steps[0]` 开始：

1. 用 `observe.sh ... --step-id <step-id>` 采集当前证据。
2. agent 基于最新 observation 做视觉理解和决策。
3. 需要动作时用 `action.sh ... --step-id <step-id>`。
4. 动作后再次 observe 验证结果。
5. 目标满足时立即写引用当前步骤 observation 的 `assertion PASS`；明确不满足时写失败断言或按失败策略收尾。

步骤阶段禁止 Flow 扫描、匹配和执行。前置条件 Flow 的 observation、action 和完成事件也不能充当业务步骤证据。

### 4. finalize

```bash
scripts/run-case.js <case-dir> --platform <platform> --finalize \
  --status <PASS|FAIL|BLOCKED|UNKNOWN> --reason "<reason>" --execution-id <id>
```

finalize 写 `result.json`、`metrics.json`，锁定 `execution.json`，刷新 case 报告和 workspace 总览。finalized 后不得追加 timeline。

## 批量和无人值守规则

- 批量执行必须逐 case 闭环，一个 case finalized 后才能开始下一个。
- 不复用上一 case 页面状态，不从中间步骤继续。
- 无人值守开始后不再询问业务状态，不安装或修复依赖，不修改 skill 代码。
- 能力缺口按 `TOOL_ERROR` 或 `PLATFORM_UNIMPLEMENTED` 收尾。
- 当前 observation 足以判断时立即写事实，不反复追加无新证据的解释事件。

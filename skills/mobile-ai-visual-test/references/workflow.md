# 执行流程

> 本文件负责：端到端阶段顺序、阶段输入输出和批量闭环。
> 事件 schema、动作参数和失败码分别见 `interfaces.md`、`action-schema.md`、`failure-policy.md`。

## 目标

每个 case 都必须完整重跑，并在当前 execution 内形成：

```text
resolve -> parse -> environment -> preflight plan -> prepare -> start
        -> Runtime Core -> isolated case Agent -> preconditions (optional Flow)
        -> case steps -> finalize -> validate result -> release Agent -> batch commit
```

Flow 只属于前置条件阶段，业务步骤阶段没有 Flow。

## 工作空间和输入

- 当前目录就是工作空间根目录；只检查当前目录，不向上查找或自动切换。
- 空目录可初始化 `workspace.json`、`cases/`、`flows/`、`index.html`。
- 非空且不是合法工作空间时停止。

先解析目标，再刷新 Markdown 用例：

```bash
scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>
scripts/parse-case.js <markdown-file> --cwd <workspace-cwd> [--refresh-from-input]
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
scripts/batch-runtime.js reconcile-current --workspace-cwd <workspace> --batch-id <id>
scripts/run-case.js <case-dir> --platform <platform> --start --precondition-plan-sha <sha> --batch-id <id>
```

批次先调用 `reconcile-current`，由脚本返回 `START_NEW`、`INIT_RUNTIME`、`BIND_RUNTIME`、`RESUME_RUNTIME`、`COMMIT_FINALIZED`、`RECOVER_FINALIZING`、`CLOSE_EXPIRED`、`CLOSE_ORPHANED`、`BLOCK_CONCURRENT`、`BLOCK_RUNTIME_RELEASE`、`BATCH_BLOCKED`、`BATCH_COMPLETE` 或 `CORRUPTED`，协调器不得自行推断恢复路径。

- `INIT_RUNTIME`：对返回的 executionId 调用 Runtime init，然后 bind。
- `BIND_RUNTIME`：Runtime 已创建但 batch 尚未绑定，先调用 batch `bind`，再继续 Runtime。
- `RESUME_RUNTIME`：继续该 Runtime 的 `next -> Host Adapter -> apply`。
- `COMMIT_FINALIZED`：调用 batch `commit-current`。
- `RECOVER_FINALIZING`：对返回的 executionId 重入 `run-case --finalize`，再继续 Runtime 或提交。
- `CLOSE_EXPIRED`：由 Runtime interrupt/timeout 状态机完成中断、释放和收尾。
- `CLOSE_ORPHANED`：调用 `run-case --recover-orphaned --execution-id <id> --batch-id <current>`。
- `BLOCK_CONCURRENT` 或 `CORRUPTED`：停止批次，不接管设备和 execution。
- `BATCH_BLOCKED` 或 `BATCH_COMPLETE`：批次已经是终态，重复恢复不得再次提交。
- `BLOCK_RUNTIME_RELEASE`：Host 连续三次未确认 session 释放，使用 batch `fail` 固化阻塞，禁止开始下一 case。

`--start` 会校验非空用例契约，创建 execution、固化 `batchId`、写 `case.snapshot.json`、在 execution.json 固化三类哈希、记录 `executionStart` 和环境摘要、固定前置条件计划并尝试 `restartApp`。后续执行只读 snapshot；源 case 变化只使报告过期。若计划哈希与 preflight 不一致，必须重新 preflight；若输出 `blockedOnStart=true`，停止当前 case。

### 1.1 创建独立 Agent 会话

批次协调器先创建 batch 产物。`--start` 可继续时，调用 `agent-runtime.js init` 生成 case-executor SkillContract、带 requestSha 的请求和 Runtime 状态。此后反复执行 `next -> Host Adapter -> apply`；`BOUND` 由 Core 在会话创建成功后写入。

BOUND 前只允许 `executionStart`、`environmentProbe` 和 `scope=execution-bootstrap` 的启动级 `restartApp actionResult`。这些事实由框架完成 execution 隔离，不属于子 Agent 业务事实；任何前置条件、Flow、业务 observation/actionResult、perception、decision 或 assertion 都必须晚于 BOUND。

Codex 主 Agent 只机械映射 Runtime operation，不直接写运行态。完整约束见 `agent-runtime.md` 和 `agent-runtimes/codex.md`。

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
2. agent 实际查看最新 observation 的截图；证据足以判断时写引用该截图、包含 `reason` 的 `perception status=USABLE`。若预览疑似存在黑屏、黑块、花屏或解码异常，写带异常类型和归一化区域的 `qualityClaim`；`run-case.js` 会绑定采集时 SHA-256、复核原始 PNG 并生成 `evidenceCheck`。复核完成前不得请求 PASS，也不得仅凭预览异常以 `TOOL_ERROR` 收尾。
3. 需要动作时用 `action.sh ... --step-id <step-id>`。
4. 动作后再次 observe 验证结果。
5. 每个步骤的目标满足时立即写引用当前步骤最新截图的 `assertion PASS`；明确不满足时写失败断言或按失败策略收尾。成功 actionResult 和动作后的 observation 不能单独完成步骤，observation `label` 只用于定位和展示，不能作为业务证据。

步骤阶段禁止 Flow 扫描、匹配和执行。前置条件 Flow 的 observation、action 和完成事件也不能充当业务步骤证据。

子 Agent 调用 `execute-next-work.js next`。Case Engine 在一次脚本调用中连续推进 observation、冻结动作、Flow 事实配对和 finalize 等确定性工作，只在需要看图时返回带 workToken 的 DecisionRequest。子 Agent 查看指定截图后调用 `decide`；脚本重新归约当前 execution、校验 workToken 并继续推进，过期决定不能写入。视觉重试由 `visualRetryContext` 固定尝试次数和 retryOf；同一 turn 的 perception 与 decision/assertion 使用恢复 draft 幂等补齐。

### 4. finalize

```bash
scripts/run-case.js <case-dir> --platform <platform> --finalize \
  --status <PASS|FAIL|BLOCKED|UNKNOWN> --reason "<reason>" --execution-id <id>
```

case-executor 通过 `execute-next-work.js` 间接 finalize。finalize 经 `FINALIZING` draft 原子写 `result.json`、`metrics.json` 并锁定 `execution.json`。随后 `build-case-agent-result.js` 构造摘要，Runtime Core 校验并写 `agent/validation.json`、释放 session，最后由 batch commit 生成 `completion.json` 并刷新状态与报告。finalize 可重入；finalized 后不得追加 timeline。无 batch 的历史兼容执行仍在 finalize 后直接刷新报告。

finalize 前会校验前置条件事实形成连续闭环、没有活动 Flow，并且每个 Flow 终态都有对应的前置条件终态；不满足时拒绝生成结果产物。execution start 阶段的冷启动硬失败是唯一允许在前置条件开始前直接收尾的内部路径。

## 批量和无人值守规则

- 批量执行必须逐 case 闭环，一个 case finalized 后才能开始下一个。
- `<workspace>/runs/<batchId>/batch.json` 通过 `commit-current` 自行读取 runtime、validation、execution、result 和 metrics；只有 session 已释放且 validation 有效时才能推进。
- start 阶段未创建子 Agent、但框架已经 finalized 的 execution 通过 `commit-start-result` 提交。
- 遗留 execution 只在批次开始或恢复时归约一次；同批次继续 Runtime，未过期的其他批次禁止抢占，过期 Runtime 走中断释放，过期且只有启动事实的孤立 execution 用 `run-case.js --recover-orphaned` 留下框架恢复事实后收尾。
- 每个 case 使用独立 Agent 会话；关闭后不得把其截图、工具输出或推理历史传给下一 case。
- 不复用上一 case 页面状态，不从中间步骤继续。
- 无人值守开始后不再询问业务状态，不安装或修复依赖，不修改 skill 代码。
- 底层命令失败按 `TOOL_ERROR`，未实现能力按 `PLATFORM_UNIMPLEMENTED` 收尾；原始截图有效但 Agent 图片输入经过一次复核重试仍无法可靠判断时使用 `VISUAL_INPUT_UNVERIFIABLE`。
- 当前 observation 足以判断时立即写事实，不反复追加无新证据的解释事件。

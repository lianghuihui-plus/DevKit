# 执行流程

> 本文件负责：Case Execution 的端到端阶段顺序、阶段输入输出和批量闭环。
> 本文件不负责：事件 schema、动作参数、failureCode 解释、报告字段细节。
> 相关文件：`interfaces.md`、`case-format.md`、`environment-probing.md`、`flow-format.md`、`failure-policy.md`、`context-format.md`。

## 目标

Case Execution Mode 将 Markdown 人工用例转成可审计的移动端视觉测试执行。每个 case 都必须完整重跑，并在当前 execution 内形成 `start -> precondition -> flowScan -> step facts -> finalize -> reports` 的闭环。

## 工作空间规则

- 当前目录就是工作空间根目录。
- 只检查当前目录，不递归、不向上查找、不自动切换目录。
- 空目录可初始化 `workspace.json`、`cases/`、`flows/`、`index.html`。
- 已有 `workspace.json` 或可识别的 `cases/`、`flows/` 时使用当前目录。
- 非空且不是合法工作空间时立即停止。

## 输入分流

先调用：

```bash
scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>
```

输出分为：

- `existingCases`：已有 case 引用，直接使用返回的 `caseDir`。
- `markdownFiles`：Markdown 文件或目录，继续用 `parse-case.js` 创建或刷新。

Markdown 路径一律按 `<workspace-cwd>` 解析。

## 用例资产准备

```bash
scripts/parse-case.js <markdown-file> --cwd <workspace-cwd>
```

产物：

- `cases/<caseNo>__<caseKey>/source.md`
- `cases/<caseNo>__<caseKey>/case.json`
- `cases/<caseNo>__<caseKey>/notes.jsonl`
- `cases/<caseNo>__<caseKey>/CONTEXT.md`
- `cases/<caseNo>__<caseKey>/CONTEXT.html`

格式和刷新规则见 `case-format.md`。

## 前置条件预检

无人值守执行前，先批量归纳所有目标 case 的前置条件：

```bash
scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd>
```

预检只辅助用户决策，不写入 execution。

分类语义：

| 分类 | 含义 | 执行前处理 |
| --- | --- | --- |
| `READY` | 技术上可直接判断满足 | 可进入执行 |
| `CONFIRM` | 需要用户确认当前业务状态 | 用户确认后才能进入执行 |
| `NEEDS_SETUP` | 明确需要先准备业务状态 | 准备后执行，或跳过 |
| `UNKNOWN` | 无法可靠判断 | 用户处理、剔除或跳过 |
| `UNSUPPORTED` | 当前框架无法自动判断或达成 | 用户处理、剔除或跳过 |

登录态、账号、权限、角色、灰度、订单、资源、服务端数据等业务上下文不得自动归为 `READY`。

## 环境确认

先探测，再确认，再固化：

```bash
scripts/probe-env.sh --platform <harmony|android|ios>
scripts/update-env.js <case-dir> --platform <platform> --device <device> --app <appId> --entry <entry>
scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>
```

规则：

- 一个执行请求只做一次环境确认。
- 正式执行必须显式传 `--platform <harmony|android|ios>`。
- `probe-env` 只探测平台和设备能力。
- 一次用户确认可以复用到本批次所有 case，但必须对每个待执行 case 分别调用 `update-env.js` 写入该 case 的 `platforms/<platform>/state.json`。
- `prepare-env.sh` 也必须按 case 调用；依赖未准备时该 case 不得 `--start`。
- 用户确认后进入无人值守执行，执行中不再补问用户，也不现场安装依赖。

详细边界见 `environment-probing.md`。

## 单 case 执行阶段

每个 case 独立执行，不能复用上一个 case 的页面状态。

### 1. start

```bash
scripts/run-case.js <case-dir> --platform <platform> --start
```

该入口会：

- 创建新的平台 execution。
- 写入 `executionStart`。
- 自动调用 `restartApp`。
- 记录冷启动隔离状态。
- 检查是否存在未 finalized 的 execution。

冷启动失败的阻塞或降级规则见 `failure-policy.md`。

如果 `--start` 输出 `blockedOnStart=true` 或 `nextAction=stop-current-case`，说明当前 execution 已因启动隔离要求自动 finalize；agent 必须停止该 case 的后续步骤，记录结论后进入下一个 case。

### 2. precondition facts

进入步骤前，为 `case.json.preconditions` 的每一项写入当前 execution 的 `precondition` 事实。

允许进入步骤的状态：

- `PASS`
- `PREPARED`

终态状态：

- `FAIL`
- `UNKNOWN`
- `BLOCKED`

终态前置条件会触发当前 execution 收尾；缺失前置条件事实会被入口拒绝。

preflight 结果到 execution 事实的最小映射：

| preflight | execution fact |
| --- | --- |
| `READY` 且已实际确认满足 | `PASS` |
| `CONFIRM` 且用户已确认 | `PASS` |
| `NEEDS_SETUP` 且已准备完成 | `PREPARED` |
| `NEEDS_SETUP` 但未准备 | `BLOCKED` |
| `UNKNOWN` | `UNKNOWN` |
| `UNSUPPORTED` | `BLOCKED` |

### 3. global flowScan

开始业务步骤前写入全局 Flow 候选库：

```bash
scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>
```

全局 `flowScan` 只建立候选库，不能替代步骤级扫描。

### 4. step loop

从 `case.json.steps[0]` 开始顺序执行每一步：

1. 调用 `record-scan.js ... --step-id <step-id>` 写入步骤级 `flowScan`。
2. 调用 `observe.sh ... --step-id <step-id>` 采集当前步骤证据。
3. agent 基于最新 observation 做视觉理解、Flow 匹配和决策。
4. 需要动作时调用 `action.sh ... --step-id <step-id>`。
5. 动作后再次 observe 验证结果。
6. 当前步骤目标明确满足时，立即写入带证据引用的 `assertion PASS`；明确不满足时写失败断言或按失败策略收尾。

步骤顺序和证据守卫见 `failure-policy.md`；事件 schema 见 `interfaces.md`。

### 5. finalize

每个 case 完成后立即收尾：

```bash
scripts/run-case.js <case-dir> --platform <platform> --finalize --status <PASS|FAIL|BLOCKED|UNKNOWN> --reason "<reason>" --execution-id <id>
```

finalize 会写入：

- `result.json`
- `metrics.json`
- `execution.json.finalized=true`
- `CONTEXT.md`
- `CONTEXT.html`
- workspace `index.html`

finalized 后不得追加 timeline。

## 批量执行规则

- 批量执行必须逐 case 闭环。
- 一个 case finalized 后，才能开始下一个 case。
- 禁止先跑多个 case，再统一写断言或统一 finalize。
- 禁止同时保留多个未 finalized execution。
- `endedAt` 和 `durationMs` 只覆盖当前 case 自身执行周期。

## 无人值守边界

无人值守执行开始后：

- 不再向用户确认业务状态。
- 不再安装或修复平台依赖。
- 不修改 skill 仓库代码。
- 不调用内部 adapter 或 atoms。
- 工具能力缺口按 `TOOL_ERROR` 或 `PLATFORM_UNIMPLEMENTED` 收尾。

## 执行节奏

- 当前 observation 已能判断时，立即写 PASS、FAIL 或 BLOCKED。
- 不产生新证据的解释性 `perception`、`decision`、`rule`、`flow` 不应反复写入。
- 顶层入口返回的 `paceHint` 只提示收敛节奏，不改变结果。

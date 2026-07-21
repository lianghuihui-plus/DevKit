---
name: mobile-ai-visual-test
description: 当需要基于 Markdown 人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持按平台适配截图、控件树、启动应用和受控操作，当前已实现 HarmonyOS、Android 与 iOS 适配。
---

# 移动端 AI 视觉测试

## 何时使用

用于基于 Markdown 人工测试用例执行移动端黑盒视觉测试。Flow 仅用于达成用例前置条件，不提供录制能力，也不参与业务步骤执行。

## 按角色读取

所有角色先完整读取本文件，再按当前角色读取下列文件，不能把协调器上下文复制给独立 case 子 Agent。

批次协调器必须读：

- `references/workflow.md`：端到端执行顺序。
- `references/interfaces.md`：稳定入口、事件契约和模块边界。
- `references/environment-probing.md`：环境探测、确认和依赖准备。
- `references/failure-policy.md`：状态、失败码、预算和结果归一。
- `references/flow-format.md`：前置条件 Flow 资产、匹配和执行协议。
- `references/agent-runtime.md`：Agent 平台抽象、单 case 会话隔离和结果校验。
- `references/case-executor-contract.md`：协调器下发给独立 case Agent 的执行边界。
- `references/context-format.md`：可信发布、结果、报告和 index 产物语义。
- Codex 平台再读 `references/agent-runtimes/codex.md`。

独立 case 子 Agent 只读：

- `references/case-executor-contract.md`：Case Engine、视觉决定和结果返回协议。
- `references/interfaces.md`：子 Agent 白名单入口和事实 schema。
- `references/failure-policy.md`：视觉证据、失败码和结果归一。
- `references/context-format.md`：execution 与结果产物语义。

按需再读：

- `references/installation.md`：三端安装和环境准备。
- `references/case-format.md`：Markdown、`case.json`、`notes.jsonl`、`source.md`。
- `references/action-schema.md`：动作参数、坐标证据和平台差异。

## 最小执行流程

1. 校验当前目录就是测试工作空间；只检查当前目录，不递归、不向上查找、不自动切换目录。
2. 用 `scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>` 解析目标。
3. 对 Markdown 输入用 `scripts/parse-case.js` 创建用例；已有 case 要采用本次外部 Markdown 时显式传 `--refresh-from-input`。解析后必须至少有一个步骤，否则停止。
4. 用 `scripts/probe-env.sh --platform <platform>` 探测环境；一次用户确认后，对每个 case 用 `scripts/update-env.js` 固化设备、App 和入口。
5. 用 `scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd> --platform <platform>` 生成确定的前置条件计划。严格同名命中的 Flow 自动执行；未命中的条件继续按 `framework`、`confirm`、`external_setup` 或 `unsupported` 处理，并在无人值守开始前集中请用户确认。
6. 对每个 case 调用 `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>`；依赖未准备不得开始 execution。
7. 创建 `batch-runtime.js init` 批次产物并固化 `runs/<batchId>/contract.json`；先用 `batch-runtime.js reconcile-current` 确定性归约遗留 execution，再对当前 case 用 `run-case.js ... --start --batch-id <id>` 创建 execution。若 `blockedOnStart=true`，不创建子 Agent。
8. 调用 `agent-runtime.js init` 固化 `agent/contract.json`、`request.json` 和 `runtime.json`。协调器只把 `agent-runtime.js next` 返回的 Host operation 映射到当前 Agent 平台，再用 `apply` 回写结果。
9. 子 Agent 校验 protocolSha 和 implementationSha 后，调用 `execute-next-work.js next`；脚本连续推进确定性工作并只在返回 `DECISION_REQUIRED` 时要求看图，子 Agent 用原 workToken 调用 `decide`。
10. Runtime Core 校验 `response.json` 与 execution/result/metrics，写 `validation.json` 并释放会话；协调器再用 `batch-runtime.js commit-current` 生成可信 `completion.json`、刷新报告并提交当前 case，然后才开始下一个 case。

agent 负责视觉理解、前置 Flow 起终点判断、决策和断言；脚本负责严格匹配、计划固定、确定性操作、预算、事实记录、守卫和报告。

## 不可违反的硬禁令

- 禁止在 skill 内录制、生成或交互式编辑 Flow 资产。
- 禁止在业务步骤中扫描、匹配或执行 Flow。
- 禁止 agent 自行创建 shell、Node、Python 或其他外层编排脚本串联多个步骤、多个 case、断言或 finalize。
- 只允许使用框架正式提供的 `action-observe.sh` 和 `commit-agent-turn.js` 合并当前动作后观察或当前单步 Agent 事实；不得据此扩展为多步骤批处理。
- 禁止用 `for`、`while`、`xargs`、一行多命令或模板化 JSON 批量生成步骤断言。
- 禁止因为 App 已停留在目标页面就复用页面状态、跳过第一个步骤或从中间步骤开始执行。
- 禁止同时保持多个 case execution 未 finalized。
- 禁止把 Agent 平台的并发能力用于并行执行多个移动端 case。
- 禁止子 Agent 继承父任务对话、旧 case 截图或完整 timeline；必须通过 SkillContract 从磁盘重新加载规范。
- 禁止在未 `--start` 创建 execution 时直接 finalize。
- 禁止执行完多个 case 后统一判图、统一写 assertion 或统一 finalize。
- 禁止绕过顶层入口直接调用 `adb`、`hdc`、Appium、截图、布局 dump、点击、输入、force-stop 或 start 命令。
- 禁止手写正式 `observation` 或 `actionResult`；正式观察只能由 `scripts/observe.sh` 写入，正式动作结果只能由 `scripts/action.sh` 写入。
- 禁止把 `launchApp`、`restartApp`、`wait`、`observation`、`perception`、`flow` 或页面状态本身当作业务步骤通过证据。
- 禁止在业务步骤中现场安装依赖、修改 adapter、修框架、编译辅助程序或换用未封装设备命令。
- 禁止静默执行清数据、卸载、支付、删除、发布、修改真实资料等破坏性操作。

## 关键执行规则

- 正式执行必须显式传 `--platform <harmony|android|ios>`；无平台根运行态只用于 `--legacy-runtime` 兼容旧产物。
- case-bound 的设备、App 和入口以已确认平台 `state.json` 为准；显式参数只能与已确认值相同，不一致时以 `ENVIRONMENT_BINDING_MISMATCH` 拒绝且不得调用 adapter。
- Flow 资产位于 `flows/preconditions/<business>/flow.json`，平台覆盖位于 `flows/preconditions/<business>/<platform>/flow.json`；不增加 `universal/` 目录层级。
- 前置条件文本与 Flow `name` 只做首尾空白清理后严格全等匹配；不做别名、模糊或语义匹配。
- preflight 返回的 `preconditionPlanSha` 必须原样传给 `--start`；资产或计划变化时重新 preflight。
- Flow 观察和动作必须使用 `--scope precondition-flow`，绑定 `preconditionId`、`flowId`，步骤内事实另绑定 `flowStepId`；不得绑定 case `stepId`。
- 每个 case 的 `--start` 都是新的 execution 边界，并自动记录 execution 级 `restartApp` 事实。
- `executionStart`、`environmentProbe` 和 `scope=execution-bootstrap` 的启动级 `restartApp` 是 BOUND 前唯一允许存在的启动事实；前置条件、Flow 和业务步骤事实必须晚于 Agent Runtime BOUND。
- 批次协调器负责 `--start` 和 Runtime Core，独立 case 子 Agent 只接管已处于 RUNNING 的指定 execution，不重复 start、probe 或 prepare。
- provider 是 Runtime Core 所有的规范机器标识，写入 `runtime.json` 与带 requestSha 的 `request.json`；子 Agent 不得填写或覆盖 provider。
- protocolSha 冻结角色规范，implementationSha 冻结运行实现；request、Runtime BOUND 和结果必须全链路一致。
- 子 Agent 每轮以 `execute-next-work.js` 的 DecisionRequest 为准；脚本每次重新归约并校验 workToken，不得仅凭会话记忆推进步骤。
- 步骤事实必须按 `case.json.steps` 顺序写入；进入后续步骤后不能回头补写前置步骤事实。
- 每个业务步骤都必须以 `assertion PASS` 作为通过证据；成功 actionResult 和动作后的 observation 只是必要过程事实，不能单独完成步骤或推进到下一步。
- `assertion PASS` 必须绑定 `stepId`，引用当前步骤最新 observation 的截图，并且前一条相关视觉理解必须是引用同一截图、包含 `reason` 的 `perception status=USABLE`；observation `label` 不能作为业务证据。
- 新 observation 的截图必须由顶层证据链记录 SHA-256、尺寸和 PNG 解码状态；perception 与 assertion 会复核同一路径仍对应采集时字节。
- Agent 预览中疑似出现黑屏、黑块或花屏时，先写带 `attemptId`、`presentationMode` 的 `UNCERTAIN` 或请求 `UNUSABLE` 结构化 `qualityClaim`；有限重试前写 `retry_visual_input` decision，第二次 perception 用新 `attemptId` 和 `retryOf` 绑定首次检查。框架按需生成不可手写的 `evidenceCheck`。
- 请求 PASS 但任一步骤缺通过证据时，框架归一为 `FAIL/ASSERTION_UNKNOWN`。
- `paceHint` 只是节奏提醒，不改变结果，也不能替代正式证据。

## 稳定顶层入口

按 SkillContract 角色使用：

- case-executor：`scripts/build-agent-contract.js`、`scripts/execute-next-work.js`、`scripts/build-case-agent-result.js`。
- batch-coordinator：`scripts/resolve-execution-targets.js`、`scripts/parse-case.js`、`scripts/probe-env.sh`、`scripts/update-env.js`、`scripts/preflight-preconditions.js`、`scripts/prepare-env.sh`、`scripts/run-case.js`、`scripts/build-agent-contract.js`、`scripts/agent-runtime.js`、`scripts/batch-runtime.js`。
- 维护和渲染：`scripts/apply-note.js`、`scripts/refresh-case.js`、`scripts/render-context.js`、`scripts/render-index.js`

`scripts/get-next-work.js` 只用于框架诊断。`scripts/observe.sh`、`scripts/action.sh`、`scripts/action-observe.sh` 和 `scripts/commit-agent-turn.js` 由 Case Engine 间接调用。`scripts/flow/`、`scripts/platform/`、`scripts/case/`、`scripts/report/`、`scripts/execution/`、`scripts/lib/` 都不是 agent 直接入口。
`scripts/build-case-agent-request.js`、`scripts/record-agent-runtime.js` 和 `scripts/validate-case-agent-result.js` 只由 Runtime Core 内部调用，不属于协调器或子 Agent 白名单。

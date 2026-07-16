---
name: mobile-ai-visual-test
description: 当需要基于 Markdown 人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持按平台适配截图、控件树、启动应用和受控操作，当前已实现 HarmonyOS、Android 与 iOS 适配。
---

# 移动端 AI 视觉测试

## 何时使用

用于基于 Markdown 人工测试用例执行移动端黑盒视觉测试。Flow 仅用于达成用例前置条件，不提供录制能力，也不参与业务步骤执行。

## 必读文件

- `references/workflow.md`：端到端执行顺序。
- `references/interfaces.md`：稳定入口、事件 schema 和模块边界。
- `references/environment-probing.md`：环境探测、确认和依赖准备。
- `references/failure-policy.md`：状态、失败码、预算和结果归一。
- `references/flow-format.md`：前置条件 Flow 资产、匹配和执行协议。

按需再读：

- `references/installation.md`：三端安装和环境准备。
- `references/case-format.md`：Markdown、`case.json`、`notes.jsonl`、`source.md`。
- `references/action-schema.md`：动作参数、坐标证据和平台差异。
- `references/context-format.md`：`timeline`、`result`、`metrics`、`CONTEXT`、`index`。

## 最小执行流程

1. 校验当前目录就是测试工作空间；只检查当前目录，不递归、不向上查找、不自动切换目录。
2. 用 `scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>` 解析目标。
3. 对 Markdown 输入用 `scripts/parse-case.js` 创建用例；已有 case 要采用本次外部 Markdown 时显式传 `--refresh-from-input`。解析后必须至少有一个步骤，否则停止。
4. 用 `scripts/probe-env.sh --platform <platform>` 探测环境；一次用户确认后，对每个 case 用 `scripts/update-env.js` 固化设备、App 和入口。
5. 用 `scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd> --platform <platform>` 生成确定的前置条件计划。严格同名命中的 Flow 自动执行；未命中的条件继续按 `framework`、`confirm`、`external_setup` 或 `unsupported` 处理，并在无人值守开始前集中请用户确认。
6. 对每个 case 调用 `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>`；依赖未准备不得开始 execution。
7. 用 `scripts/run-case.js <case-dir> --platform <platform> --start --precondition-plan-sha <sha>` 创建新 execution。若返回 `blockedOnStart=true` 或 `nextAction=stop-current-case`，停止当前 case。
8. 按 `case.json.preconditions` 顺序处理前置条件。Flow 条件必须先做入口观察；终点已满足则记录 `PASS/already_satisfied`，起点匹配才执行 Flow，否则以专用失败码阻塞；执行完成后做终点观察并记录 `PREPARED`。
9. 从 `case.json.steps[0]` 开始逐步 observe、判断、action 或 assertion。步骤阶段不扫描、不匹配、不执行 Flow。
10. 每个 case 立即用 `scripts/run-case.js ... --finalize` 收尾并刷新报告，完成后再开始下一个 case。

agent 负责视觉理解、前置 Flow 起终点判断、决策和断言；脚本负责严格匹配、计划固定、确定性操作、预算、事实记录、守卫和报告。

## 不可违反的硬禁令

- 禁止在 skill 内录制、生成或交互式编辑 Flow 资产。
- 禁止在业务步骤中扫描、匹配或执行 Flow。
- 禁止 agent 自行创建 shell、Node、Python 或其他外层编排脚本串联多个步骤、多个 case、断言或 finalize。
- 禁止用 `for`、`while`、`xargs`、一行多命令或模板化 JSON 批量生成步骤断言。
- 禁止因为 App 已停留在目标页面就复用页面状态、跳过第一个步骤或从中间步骤开始执行。
- 禁止同时保持多个 case execution 未 finalized。
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
- 步骤事实必须按 `case.json.steps` 顺序写入；进入后续步骤后不能回头补写前置步骤事实。
- 每个业务步骤都必须以 `assertion PASS` 作为通过证据；成功 actionResult 和动作后的 observation 只是必要过程事实，不能单独完成步骤或推进到下一步。
- `assertion PASS` 必须绑定 `stepId`，引用当前步骤最新 observation 的截图，并且前一条相关视觉理解必须是引用同一截图、包含 `reason` 的 `perception status=USABLE`；observation `label` 不能作为业务证据。
- 新 observation 的截图必须由顶层证据链记录 SHA-256、尺寸和 PNG 解码状态；perception 与 assertion 会复核同一路径仍对应采集时字节。
- Agent 预览中疑似出现黑屏、黑块或花屏时，先写带 `attemptId`、`presentationMode` 的 `UNCERTAIN` 或请求 `UNUSABLE` 结构化 `qualityClaim`；有限重试前写 `retry_visual_input` decision，第二次 perception 用新 `attemptId` 和 `retryOf` 绑定首次检查。框架按需生成不可手写的 `evidenceCheck`。
- 请求 PASS 但任一步骤缺通过证据时，框架归一为 `FAIL/ASSERTION_UNKNOWN`。
- `paceHint` 只是节奏提醒，不改变结果，也不能替代正式证据。

## 稳定顶层入口

agent 只使用：

- 主执行：`scripts/probe-env.sh`、`scripts/resolve-execution-targets.js`、`scripts/parse-case.js`、`scripts/preflight-preconditions.js`、`scripts/update-env.js`、`scripts/prepare-env.sh`、`scripts/run-case.js`、`scripts/observe.sh`、`scripts/action.sh`
- 维护和渲染：`scripts/apply-note.js`、`scripts/refresh-case.js`、`scripts/render-context.js`、`scripts/render-index.js`

`scripts/flow/` 是前置条件 Flow 的内部加载和解析层；`scripts/platform/`、`scripts/case/`、`scripts/report/`、`scripts/execution/`、`scripts/lib/` 都不是 agent 直接入口。

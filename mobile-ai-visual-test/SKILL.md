---
name: mobile-ai-visual-test
description: 当需要基于 Markdown 人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持按平台适配截图、控件树、启动应用和受控操作，当前已实现 HarmonyOS 与 Android 适配，并为 iOS 预留适配接口。
---

# 移动端 AI 视觉测试

## 何时使用

用于基于 Markdown 人工测试用例执行移动端黑盒视觉测试，或在人工指挥下录制可复用的业务路径 Flow。

## 模式分流

用户意图必须先分流，不能默认执行 case：

- 说“录制 Flow / 录制业务路径 / 新建 BusinessFlow / 教 agent 怎么登录 / 教 agent 怎么进入某页面”时，进入 Flow Recording Mode。
- 说“执行用例 / 跑 case / 测试这个 Markdown / 批量测试”时，进入 Case Execution Mode。
- 同时包含“录制”和“执行 case”时，先请用户确认当前只做哪一种。

两个模式不能混用。Flow Recording Mode 禁止调用 case 执行入口；Case Execution Mode 禁止调用 Flow 录制入口。

## 必读文件

Case Execution Mode 先读：

- `references/workflow.md`：端到端执行顺序。
- `references/interfaces.md`：稳定入口、事件 schema 和模块边界。
- `references/environment-probing.md`：环境探测、确认和依赖准备。
- `references/failure-policy.md`：状态、失败码、预算和结果归一。
- `references/flow-format.md`：Flow 扫描、匹配、使用和终态事实。

按需再读：

- `references/case-format.md`：Markdown、`case.json`、`notes.jsonl`、`source.md`。
- `references/action-schema.md`：动作参数、坐标证据和平台动作差异。
- `references/context-format.md`：`timeline`、`result`、`metrics`、`CONTEXT`、`index`。

Flow Recording Mode 先读 `references/flow-format.md`。

## Case Execution 最小流程

1. 校验当前目录就是测试工作空间；只检查当前目录，不递归、不向上查找、不自动切换目录。
2. 用 `scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>` 解析待执行目标。
3. 对 Markdown 输入用 `scripts/parse-case.js` 创建或刷新用例；已有 case 直接使用返回的 `caseDir`。
4. 用 `scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd>` 批量归纳前置条件；不满足或无法判断的 case 必须在无人值守执行前提示用户处理、剔除或跳过。
5. 用 `scripts/probe-env.sh --platform <platform>` 探测平台；一次用户确认后，对每个待执行 case 分别用 `scripts/update-env.js` 固化目标设备、App 和入口。
6. 对每个待执行 case 调用 `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>` 准备平台依赖；依赖未准备不得开始 execution。
7. 每个 case 都从 `scripts/run-case.js <case-dir> --platform <platform> --start` 开始；该入口会创建新 execution 并自动尝试 `restartApp`；若返回 `blockedOnStart=true` 或 `nextAction=stop-current-case`，当前 case 已收尾，直接进入下一个 case。
8. 写入当前 execution 的每条 `precondition` 事实；只有 `PASS` 或 `PREPARED` 才能进入步骤。
9. 调用 `scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>` 写入全局 `flowScan`。
10. 从 `case.json.steps[0]` 开始逐步执行；每步先写步骤级 `flowScan`，再 observe、判断、action 或 assertion，并留下当前步骤通过证据。
11. 每个 case 必须即时 `scripts/run-case.js <case-dir> --platform <platform> --finalize ...` 收尾并刷新报告，完成后再开始下一个 case。

agent 负责视觉理解、Flow 匹配、决策和断言；脚本负责确定性操作、预算、事实记录、守卫和报告。

## Flow Recording 最小流程

1. 确认 Flow `name`、`intent`、平台和适用范围；缺少 `name` 必须先询问。
2. 校验当前目录就是测试工作空间。
3. 调用 `scripts/flow/start-recording.js --name <name> --intent <intent> --platform <platform> --flow-scope <universal|platform> --cwd <workspace-cwd> ...`。
4. 每条人工指令都按 `flow observe before -> flow action -> flow observe after` 记录。
5. 只有用户明确说完成录制时，才调用 `scripts/flow/finalize-recording.js <flowDir> --recording-id <id> --status READY`。

录制期间禁止解析、启动、执行或 finalize 任何 case。

## 不可违反的硬禁令

- 禁止 agent 自行创建 shell、Node、Python 或其他外层编排脚本串联多个步骤、多个 case、断言或 finalize。
- 禁止用 `for`、`while`、`xargs`、一行多命令或模板化 JSON 批量生成步骤断言。
- 禁止因为 App 已停留在目标页面就复用页面状态、跳过第一个步骤或从中间步骤开始执行。
- 禁止同时保持多个 case execution 未 finalized。
- 禁止在未 `--start` 创建 execution 时直接 finalize。
- 禁止执行完多个 case 后统一判图、统一写 assertion 或统一 finalize。
- 禁止绕过顶层入口直接调用 `adb`、`hdc`、Appium、截图、布局 dump、点击、输入、force-stop 或 start 命令。
- 禁止手写正式 `observation` 或 `actionResult`；正式观察只能由 `scripts/observe.sh` 写入，正式动作结果只能由 `scripts/action.sh` 写入。
- 禁止把 `launchApp`、`restartApp`、`wait`、`observation`、`perception`、`flow` 或页面状态本身当作步骤通过证据。
- 禁止在业务步骤中现场安装依赖、修改 adapter、修框架、编译辅助程序或换用未封装设备命令。
- 禁止静默执行清数据、卸载、支付、删除、发布、修改真实资料等破坏性操作。

## 关键执行规则

- 正式执行必须显式传 `--platform <harmony|android|ios>`；无平台根运行态只用于 `--legacy-runtime` 兼容旧产物。
- 每个 case 的 `--start` 都是新的 execution 边界，并会自动记录 execution 级 `restartApp` 事实。
- `restartApp` 禁止绑定 `stepId`，也不能作为步骤证据；冷启动失败按 `failure-policy.md` 阻塞或降级。
- 步骤事实必须按 `case.json.steps` 顺序写入；进入后续步骤后不能回头补写前置步骤事实。
- `assertion PASS` 必须绑定 `stepId`，并通过 `evidence` 或 `evidenceObservation` 引用当前步骤已有且由 `observe.sh` 写入的 observation 证据。
- 请求 `--finalize --status PASS` 时若任一步骤缺少通过证据，框架会归一为 `FAIL/ASSERTION_UNKNOWN`。
- 当前 observation 已能明确判断时，立即写入带证据的 PASS/FAIL/BLOCKED 并继续；不要在 execution 中间反复解释或写无效事实。
- `paceHint` 只是节奏提醒，不改变结果，也不能替代正式证据。

## 稳定顶层入口

agent 只使用这些入口：

- 主执行：`scripts/probe-env.sh`、`scripts/resolve-execution-targets.js`、`scripts/parse-case.js`、`scripts/preflight-preconditions.js`、`scripts/update-env.js`、`scripts/prepare-env.sh`、`scripts/run-case.js`、`scripts/observe.sh`、`scripts/action.sh`
- 维护和渲染：`scripts/apply-note.js`、`scripts/refresh-case.js`、`scripts/render-context.js`、`scripts/render-index.js`
- Flow：`scripts/flow/start-recording.js`、`scripts/flow/observe.sh`、`scripts/flow/action.sh`、`scripts/flow/finalize-recording.js`、`scripts/flow/record-scan.js`

`scripts/platform/`、`scripts/platform/adapters/`、`scripts/platform/adapters/<platform>/atoms/`、`scripts/case/`、`scripts/report/`、`scripts/execution/`、`scripts/lib/` 都是内部实现层，不作为 agent 直接入口。

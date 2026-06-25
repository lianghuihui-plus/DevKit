---
name: mobile-ai-visual-test
description: 当需要基于 Markdown 人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持按平台适配截图、控件树、启动应用和受控操作，当前已实现 HarmonyOS 适配，并为 Android、iOS 预留适配接口。
---

# 移动端 AI 视觉测试

## 流程

### 模式分流

用户意图必须先分流，不能默认进入用例执行：

- 用户说“录制 Flow / 录制业务路径 / 新建 BusinessFlow / 教 agent 怎么登录 / 教 agent 怎么进入某页面”时，进入 Flow Recording Mode。
- 用户明确说“执行 skill 是为了录制 / 这次只录制 / 进入录制模式”时，必须进入 Flow Recording Mode，并严格执行录制协议。
- 用户说“执行用例 / 跑 case / 测试这个 Markdown / 批量测试”时，进入 Case Execution Mode。
- 用户意图同时包含“录制”和“执行 case”时，先向用户确认当前要做哪一种。

Flow Recording Mode 下禁止调用 `scripts/resolve-cases.js`、`scripts/parse-case.js`、`scripts/run-case.js <case-dir> --start`、顶层 `scripts/observe.sh --case-dir ...` 和顶层 `scripts/action.sh --case-dir ...`。只能使用 `scripts/flow/*` 录制入口和底层平台适配能力。

Case Execution Mode 下才执行下面的用例流程：

1. 先读取 `references/workflow.md` 和 `references/interfaces.md`。
2. 先用 `scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>` 分流输入：已有用例引用进入 `existingCases`，Markdown 文件或目录进入 `markdownFiles`；相对 Markdown 路径一律按 `<workspace-cwd>` 解析。
3. 对 `existingCases` 直接使用返回的 `caseDir`；对 `markdownFiles` 再用 `scripts/parse-case.js` 创建/刷新用例空间。
4. 执行前读取 `references/environment-probing.md`，探测并确认环境，用 `scripts/update-env.js` 固化到每个 `caseDir`。
5. 确认后进入无人值守执行；执行中不再向用户提问。
6. 每次执行完整重跑，先 `scripts/run-case.js <case-dir> --start` 创建新的 execution。
7. 创建 execution 后、开始业务步骤探索前，必须调用 `scripts/flow/list-flows.js --cwd <workspace-cwd>` 扫描 `ai-visual-test/flows/`，读取可用 Flow 的 `name`、`intent`、`steps`、`successHints`，并用 `scripts/run-case.js <case-dir> --record-json ...` 写入 `flowScan` 事实。
8. 执行每个步骤前，必须用步骤文本、前置条件、当前页面目标和候选 Flow 的 `name/intent/humanInstruction/successHint` 做匹配；如果步骤缺少进入目标页面的导航，但已有匹配 Flow，必须优先参考 Flow 进入业务页面。
9. 观察/动作只走顶层入口：`scripts/observe.sh --case-dir <case-dir> --execution-id <id> ...`、`scripts/action.sh --case-dir <case-dir> --execution-id <id> ...`。
10. agent 负责视觉理解、Flow 匹配、决策和断言；脚本负责确定性操作、预算、事实记录和报告。

Case Execution Mode 的 Flow 硬性规则：

- 禁止在未调用 `scripts/flow/list-flows.js --cwd <workspace-cwd>` 并写入当前 execution 的 `flowScan` 事实前开始业务步骤探索。
- 遇到“进入页面 / 打开入口 / 登录 / 到某业务页 / 选择业务 tab / 从首页进入功能”等导航语义时，必须先检查候选 Flow。
- 若 case 步骤从页面内操作开始，但当前页面不在目标业务页，也必须先检查候选 Flow，不能直接凭视觉相似入口探索。
- 如果匹配到 Flow，必须写入 `flow` 事实事件；如果决定不用匹配到的 Flow，也必须写入 `flow` 的 `SKIPPED` 事件并说明原因。
- 在判定 `PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 前，必须确认失败步骤已有对应 `flowScan`，且没有可用匹配，或每个匹配 Flow 都已有同 `stepId` 的终态事实：`COMPLETED`、`FAILED`、`SKIPPED` 或 `BLOCKED`。

Case Execution Mode 的批量执行硬性规则：

- 批量执行多个 case 时，必须逐用例闭环；一个 case 的 `start -> observe/action -> assertion -> finalize -> CONTEXT/index 刷新` 完成后，才能开始下一个 case。
- 禁止先执行完多个 case、缓存最终截图或待判定队列，再统一写 assertion 和批量 finalize。
- 禁止同时保持多个 case 的 execution 处于未 finalized 状态；若当前 case 已完成操作链路，必须立即判定并调用 `scripts/run-case.js <case-dir> --finalize ...`。
- `endedAt`、报告更新时间和 `durationMs` 必须只覆盖当前 case 自身执行周期，不能包含等待其他 case 执行、统一判图或批量收尾的时间。
- 批量总览可以在每个 case 自己 finalize 后统一查看，但不得用统一总览刷新替代单个 case 的即时 finalize。

Case Execution Mode 的坐标硬性规则：

- `tap`、`toggle`、`inputText` 只要使用 `x/y`，调用 `scripts/action.sh` 时必须传 `--coordinate-source` 和 `--coordinate-evidence`。
- `--coordinate-source layout` 只能用于目标本身存在控件树或平台布局节点的场景，坐标必须来自目标节点 bounds 内部。
- H5 自绘按钮、图片按钮、Canvas 区域或控件树没有独立节点的目标，必须使用 `--coordinate-source visual` 或 `--coordinate-source pixel`，并传 `--target-bounds x1,y1,x2,y2`。
- `visual`/`pixel` 的点击点应取截图目标像素区域中心或明确可命中的内部点；禁止用相邻文本、输入框、容器 bounds 代替真实目标区域。
- 坐标动作后页面无变化、命中输入框或命中错误区域时，禁止重复使用同一坐标重试；必须重新 observe 并更新坐标证据，仍无法定位时停止并记录 `UNKNOWN` 或 `ACTION_TARGET_NOT_FOUND`。

Case Execution Mode 的设备命令硬性规则：

- 禁止直接执行 `hdc shell aa force-stop`、`hdc shell aa start`、截图、布局 dump 或点击输入等设备命令来绕过顶层入口。
- 所有会改变 App 状态或产生证据的设备操作，必须通过 `scripts/observe.sh --case-dir ...`、`scripts/action.sh --case-dir ...` 或平台 adapter 间接执行，确保预算、时间线和报告同步。
- 如果确实需要记录平台探测、外部日志或人工事实，只能用 `scripts/run-case.js <case-dir> --record-json ...` 写入当前 execution，不得只在对话里描述。

### Flow Recording Mode 强制协议

只要进入 Flow Recording Mode，agent 必须按以下流程执行，不能跳步：

1. 读取 `references/flow-format.md`。
2. 确认 Flow `name` 和 `intent`。
   - 如果用户已经明确给出，直接复述确认后开始。
   - 如果缺少 `name`，必须先询问，不能自行开始。
   - 如果缺少 `intent`，可基于 name 给出候选，但必须等用户确认。
3. 调用 `scripts/flow/start-recording.js --name <name> --intent <intent> --cwd <workspace-cwd> ...` 创建录制会话；若已知录制设备和目标应用，必须同时传 `--platform`、`--device`、`--app`、`--entry`，后续 `flow/observe.sh` 和 `flow/action.sh` 会从录制状态继承这些环境参数。
4. 告知用户当前 `flowId`、`recordingId`，并等待或接收人工步骤指令。
5. 每收到一条人工步骤指令，必须执行：
   - `scripts/flow/observe.sh --flow-dir <flowDir> --recording-id <recordingId> --label <step>-before`
   - 根据人工指令调用 `scripts/flow/action.sh --flow-dir <flowDir> --recording-id <recordingId> --instruction <instruction> ...`
   - `scripts/flow/observe.sh --flow-dir <flowDir> --recording-id <recordingId> --label <step>-after`
6. 每一步结束后，简短回报已记录的动作和后置观察结果，然后等待下一条人工指令。
7. 只有用户明确说“完成录制 / 结束录制 / finalize / 生成 Flow”时，才调用 `scripts/flow/finalize-recording.js <flowDir> --recording-id <recordingId> --status READY`。
8. finalize 后返回 `flow.md`、`flow.json` 路径和步骤数量。

Flow Recording Mode 的禁止事项：

- 禁止自动查找、解析、启动或执行任何 case。
- 禁止为了录制而调用 `scripts/run-case.js`。
- 禁止使用最近一次 case、最近一次 execution 或历史失败现场作为录制入口。
- 禁止在没有用户步骤指令时自行探索业务路径。
- 禁止在用户未确认结束录制前 finalize。

## 规则

- 默认产物根目录为 `<执行 skill 时的当前目录>/ai-visual-test/`。
- Flow 录制前必须明确 `name`；如果用户没有给出名称，先询问名称，不能自行猜测并开始录制。
- Flow 录制前应明确 `intent`；如果用户没有给出 intent，可基于名称生成候选并向用户确认。
- Flow 录制前应明确录制环境；如果已有本轮确认环境，创建录制时写入该环境，否则先确认设备、目标 App 和启动入口。
- Flow 录制过程中每条人工操作指令必须按“先 observe、再 action、再 observe”的顺序记录。
- Flow 录制中的坐标动作同样必须记录 `--coordinate-source`、`--coordinate-evidence`；目标来自截图像素区域时还必须记录 `--target-bounds`，这些信息会进入 `flow.json` 供后续回放参考。
- Flow 录制过程中不得启动、刷新或 finalize 任何 case execution。
- `source.md` 是稳定输入源，`case.json` 是执行契约，`notes.jsonl` 是用户补充，`CONTEXT.md`/`CONTEXT.html` 是单用例报告，`index.html` 是总览。
- 不支持从失败步骤继续；每次执行都是完整重跑。
- 不静默执行清数据、卸载、支付、删除、发布、修改真实资料等破坏性操作。
- 未完成环境确认时，不开始执行用例。
- 无法准备或验证时，记录证据并 `FAIL`/`BLOCKED`。
- 不在通用逻辑里写死平台；平台能力只放 `scripts/platform/adapters/<platform>/`。

## 参考文件

- `references/workflow.md`：端到端流程和产物生命周期。
- `references/interfaces.md`：模块边界、统一 JSON 契约、视觉和 CLI 的结合方式。
- `references/case-format.md`：Markdown 解析、`case.json`、源文件变更和补充重放规则。
- `references/flow-format.md`：业务路径 Flow 的录制、资产格式和执行接入方式。
- `references/context-format.md`：`CONTEXT.md`、`result.json`、`metrics.json` 和摘要渲染。
- `references/action-schema.md`：通用动作 JSON、平台适配和安全预算。
- `references/environment-probing.md`：平台探测、执行前确认和适配器边界。
- `references/failure-policy.md`：状态、失败码、重试预算和停止规则。

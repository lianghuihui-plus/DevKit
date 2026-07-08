---
name: mobile-ai-visual-test
description: 当需要基于 Markdown 人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持按平台适配截图、控件树、启动应用和受控操作，当前已实现 HarmonyOS 与 Android 适配，并为 iOS 预留适配接口。
---

# 移动端 AI 视觉测试

## 流程

### 模式分流

用户意图必须先分流，不能默认进入用例执行：

- 用户说“录制 Flow / 录制业务路径 / 新建 BusinessFlow / 教 agent 怎么登录 / 教 agent 怎么进入某页面”时，进入 Flow Recording Mode。
- 用户明确说“执行 skill 是为了录制 / 这次只录制 / 进入录制模式”时，必须进入 Flow Recording Mode，并严格执行录制协议。
- 用户说“执行用例 / 跑 case / 测试这个 Markdown / 批量测试”时，进入 Case Execution Mode。
- 用户意图同时包含“录制”和“执行 case”时，先向用户确认当前要做哪一种。

Flow Recording Mode 下禁止调用 `scripts/resolve-cases.js`、`scripts/parse-case.js`、`scripts/run-case.js <case-dir> --start`、顶层 `scripts/observe.sh --case-dir ...` 和顶层 `scripts/action.sh --case-dir ...`。agent 只能调用 `scripts/flow/*` 录制入口；平台适配能力只能由 Flow 脚本内部间接调用，禁止直接调用 adapter 或 atoms。

Case Execution Mode 下才执行下面的用例流程：

1. 先读取 `references/workflow.md` 和 `references/interfaces.md`。
2. 先确认当前目录就是测试工作空间：只检查当前目录，不递归、不向上查找、不自动切换目录；若当前目录为空，初始化工作空间文件；若当前目录已有 `workspace.json` 或可识别的 `cases/`、`flows/` 工作空间结构，使用当前目录；其他非空目录立即停止并提示用户进入空目录或已有工作空间目录。
3. 先用 `scripts/resolve-execution-targets.js <输入...> --cwd <workspace-cwd>` 分流输入：已有用例引用进入 `existingCases`，Markdown 文件或目录进入 `markdownFiles`；相对 Markdown 路径一律按 `<workspace-cwd>` 解析。
4. 对 `existingCases` 直接使用返回的 `caseDir`；对 `markdownFiles` 再用 `scripts/parse-case.js` 创建/刷新用例空间。
5. 在环境确认和无人值守执行前，调用 `scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd>` 汇总所有待执行用例前置条件；登录态、账号、权限、角色、灰度等业务上下文不得归为 `READY`，若出现 `CONFIRM`、`NEEDS_SETUP`、`UNKNOWN`、`UNSUPPORTED`，必须一次性提示用户确认、准备、剔除或跳过对应用例，执行中不再补问。
6. 执行前读取 `references/environment-probing.md`，探测并确认平台环境；平台只使用 `harmony`、`android`、`ios` 三类，不细分 debug/release。
7. 用 `scripts/update-env.js <case-dir> --platform <platform> ...` 固化环境到 `caseDir/platforms/<platform>/state.json`。
8. 在创建 execution 前调用 `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>` 准备平台前置依赖，写入 `state.json.dependencies` 并刷新当前平台报告；例如 Android Unicode 输入依赖 MAVT Input IME，必须在这里安装/启用，禁止在业务步骤输入时临时安装。
9. 确认和依赖准备完成后进入无人值守执行；执行中不再向用户提问，也不再安装或修复平台依赖。
10. 每次执行完整重跑，先 `scripts/run-case.js <case-dir> --platform <platform> --start` 创建新的 execution；该入口会自动执行 `restartApp`，先停止目标 App 再按已确认入口冷启动，并把 `actionResult` 写入当前 execution。冷启动失败或平台明确无法验证真实冷启动时必须记录隔离状态；若 `case.json.isolation.requireCleanRestart=true`，或 `auto` 模式下用例包含“首次进入 / 重启 App 后 / 同一次 App 启动内 / 默认初始化 / 新用户首次状态”等冷启动敏感语义，会以 `BLOCKED/CASE_RESTART_FAILED` 自动收尾；普通用例可隔离降级继续执行，但报告必须标记非干净环境。
11. 创建 execution 后、开始业务步骤探索前，必须为 `case.json.preconditions` 写入当前 execution 的 `precondition` 事实；只有状态为 `PASS` 或 `PREPARED` 才允许进入步骤，`FAIL`、`UNKNOWN`、`BLOCKED` 是前置条件终态，会立即按 `PRECONDITION_FAILED`、`PRECONDITION_UNKNOWN`、`PRECONDITION_UNSUPPORTED` 写入结果并 finalize，可短路剩余前置条件，缺失事实会以 `PRECONDITION_REQUIRED` 拒绝进入步骤。
12. 创建 execution 后、开始业务步骤探索前，必须调用 `scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>` 扫描 `<workspace-cwd>/flows/` 并写入全局候选库 `flowScan` 事实；脚本内部会读取可用 Flow 的 `name`、`intent`、`steps`、`successHints`，默认列表只包含当前平台专用 Flow 和通用 Flow，其他平台专用 Flow 只有显式 `list-flows.js --all` 才会出现。
13. 执行每个业务步骤前，必须再调用 `scripts/flow/record-scan.js ... --step-id <step-id>` 写入步骤级 `flowScan`，并用步骤文本、前置条件、当前页面目标和候选 Flow 的 `name/intent/humanInstruction/successHint` 做匹配；同语义下，平台专用 Flow 优先，通用 Flow 兜底。
14. 观察/动作只走顶层入口：`scripts/observe.sh --case-dir <case-dir> --platform <platform> --execution-id <id> ...`、`scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> ...`；执行某个用例步骤内的观察必须传 `--step-id <step-id>`，确保截图证据能挂到对应步骤。
15. agent 负责视觉理解、Flow 匹配、决策和断言；脚本负责确定性操作、预算、事实记录和报告。

平台 adapter 必须按“原子能力优先”组织：`scripts/platform/adapters/<platform>/atoms/` 中的脚本只做最小设备能力，不读写 case、不写 timeline、不做业务判断；`action.sh` 只把通用动作分发到 atoms；`observe.sh` 只组合截图、控件树、前台信息和日志这类一次观察快照必须同步采集的 atoms。agent 能明确编排的动作，例如点击输入框、观察焦点、输入文本、再次观察验证，禁止在底层 adapter 里合并成不可审计的黑盒组合。

Case Execution Mode 的 Flow 硬性规则：

- 禁止在未调用 `scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>` 并写入当前 execution 的全局候选库 `flowScan` 事实前写入任何带 `stepId` 的步骤事实；每个业务步骤动作前还必须补写同 `stepId` 的步骤级 `flowScan`。
- `flowScan` 事实必须由 `record-scan.js` 产生，包含 `source=list-flows`、`flowsRoot`、`scannedFlowIds` 和 `candidateCount`；禁止手写缺少扫描来源的 `flowScan` 事件。
- `restartApp` 禁止绑定 `--step-id`；顶层 `scripts/action.sh --case-dir ...` 在执行带 `--step-id` 的非 `launchApp`、非 `wait` 业务动作前，会检查当前 execution 是否已有同一步骤的可用 `flowScan` 事实；`status=FAILED` 的扫描不能作为动作前置，全局 `flowScan` 只用于建立候选库，不能替代步骤级扫描。
- 遇到“进入页面 / 打开入口 / 登录 / 到某业务页 / 选择业务 tab / 从首页进入功能”等导航语义时，必须先检查候选 Flow。
- 若 case 步骤从页面内操作开始，但当前页面不在目标业务页，也必须先检查候选 Flow，不能直接凭视觉相似入口探索。
- 如果匹配到 Flow，必须写入 `flow` 事实事件；如果决定不用匹配到的 Flow，也必须写入 `flow` 的 `SKIPPED` 事件并说明原因。
- Flow 默认跨端通用；录制时若使用 `--flow-scope platform` 或 `--platform-specific`，或 Flow 的 `platform` 字段/名称后缀显式标识当前平台，例如 `-android`、`-ios`、`-harmony` 时，才作为当前平台专用 Flow 优先使用；`recordingPlatform` 只表示录制环境，不表示适用平台。
- 在判定 `PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 前，必须确认失败步骤已有对应 `flowScan`，且没有可用匹配，或每个匹配 Flow 都已有同 `stepId` 的终态事实：`COMPLETED`、`FAILED`、`SKIPPED` 或 `BLOCKED`。

Case Execution Mode 的批量执行硬性规则：

- 批量执行多个 case 时，必须逐用例闭环；一个 case 的 `start -> observe/action -> assertion -> finalize -> CONTEXT/index 刷新` 完成后，才能开始下一个 case。
- 禁止 agent 自行创建 shell、Node、Python 或其他外层编排脚本来串联多个步骤、多个 case 或批量写入 `assertion`/`finalize`；批量执行只能由 agent 在对话执行过程中逐步调用框架顶层入口并实时理解每次 observation 后继续。
- 禁止用 `for`、`while`、`xargs`、一行多命令或模板化 JSON 批量生成步骤断言；`assertion PASS` 必须是 agent 基于当前步骤最新 observation 的实时视觉判断。
- 每个 case 的 `--start` 都必须形成新的 execution 边界，并由框架自动写入一次 execution 级 `restartApp` 冷启动事实；agent 不能因为 App 已停留在目标页面就复用页面状态或跳过第一个步骤。
- 如果 `restartApp` 未能完成真实冷启动，或 action 事实没有明确 `coldStartVerified=true`，agent 不能把它当作成功；冷启动敏感用例会自动阻塞，普通用例只能在报告已标记 `isolationCompromised` 的前提下继续。
- 每个 case execution 必须从当前 `case.json` 的第一个步骤开始顺序处理；当前页面状态只能作为当前步骤的判断依据，禁止因为 App 停留在后续页面而跳过前置步骤或从中间步骤开始执行。
- 每个 case 进入步骤前必须先写齐当前 execution 的 `precondition` 事实；`PASS` 表示已确认满足，`PREPARED` 表示已在执行前准备完成，其他状态是终态并会自动收尾，可短路剩余前置条件，不能继续步骤。
- 任何带 `stepId` 的步骤事实都必须在 execution 级全局 `flowScan` 之后写入；公开事实写入缺失时以 `FLOW_SCAN_REQUIRED` 拒绝且不写入 timeline，顶层 `scripts/action.sh` 触发的动作缺失时会写入失败 `actionResult` 并 finalize。
- 任何带 `stepId` 的 `observation`、`perception`、`decision`、`rule`、`flowScan`、`flow`、`actionResult`、`assertion` 都必须满足步骤顺序守卫：只能记录当前步骤，或在前一步已有通过证据后进入下一步；一旦进入后续步骤，禁止回头补写前置步骤事实。
- 每个步骤完成时必须立即在当前 execution 写入步骤级通过证据；普通操作步骤需要真实业务动作 `tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back` 的 `actionResult ok=true` 且其后有同一步骤的 observation，或显式 `assertion PASS`；`assertion PASS` 必须通过 `evidence` 或 `evidenceObservation` 引用当前步骤已有 observation 的截图、布局或 label；`launchApp`、`restartApp`、`wait` 这类工具性动作不能替代步骤通过证据；断言型步骤必须写带 observation 证据引用的 `assertion PASS`，`observation`、`perception`、`flow` 或页面状态本身不能替代通过证据。
- 如果当前页面已经满足当前步骤目标，agent 可以不重复操作，但必须先调用 `scripts/observe.sh --case-dir ... --step-id <step-id>` 为该步骤采集 observation，并在 `assertion PASS` 中引用该 observation 的 label、截图或布局产物后，才能进入下一步。
- `restartApp` 只能作为 `--start` 自动写入的 execution 级隔离事实，或诊断用的全局动作；禁止绑定 `--step-id`，也不能作为任何步骤的通过证据。
- `--finalize --status PASS` 前必须确认所有步骤都有当前 execution 内的通过证据；缺证据时框架会把本次结果归一为 `FAIL/ASSERTION_UNKNOWN` 并 finalize，`requestedStatus` 保留 agent 原始请求，agent 不能把缺证据当作 PASS。
- Case execution 必须优先快速闭环：当前 observation 已能明确判断步骤结果时，立即写入带证据引用的 `assertion PASS` 或明确失败断言，然后进入下一步或 finalize；不产生新证据的反复复核、长解释和可选事实记录不得拖在 execution 中间。
- `perception`、`decision`、`rule`、`flow` 只在会影响下一步动作、Flow 选择、规则处理或失败归因时写入；不要为了“说明想法”额外写事实。顶层入口返回的 `paceHint` 只用于提醒 agent 收敛执行节奏，不改变用例结果，也不能替代正式证据。
- 禁止先执行完多个 case、缓存最终截图或待判定队列，再统一写 assertion 和批量 finalize。
- 禁止同时保持多个 case 的 execution 处于未 finalized 状态；若当前 case 已完成操作链路，必须立即判定并调用 `scripts/run-case.js <case-dir> --platform <platform> --finalize ...`。
- 禁止在未 `--start` 创建 execution 的情况下直接 `--finalize`；正式平台执行的 `finalize` 必须收尾已有 execution。
- `endedAt`、报告更新时间和 `durationMs` 必须只覆盖当前 case 自身执行周期，不能包含等待其他 case 执行、统一判图或批量收尾的时间。
- 批量总览可以在每个 case 自己 finalize 后统一查看，但不得用统一总览刷新替代单个 case 的即时 finalize。

Case Execution Mode 的坐标硬性规则：

- `tap`、`toggle`、`longPress` 只要使用 `x/y`，调用 `scripts/action.sh` 时必须传 `--coordinate-source` 和 `--coordinate-evidence`；Android `inputText` 不接受 `x/y`，必须先显式 `tap` 聚焦输入框，再调用 `inputText` 向当前焦点输入文本。
- `--coordinate-source layout` 只能用于目标本身存在控件树或平台布局节点的场景，坐标必须来自目标节点 bounds 内部。
- H5 自绘按钮、图片按钮、Canvas 区域或控件树没有独立节点的目标，必须使用 `--coordinate-source visual` 或 `--coordinate-source pixel`，并传 `--target-bounds x1,y1,x2,y2`。
- 无 dump 树时，坐标必须基于原始截图像素计算：先统一坐标系，再识别目标可点击区域 bounds，最后取区域内部安全点；禁止直接凭缩放预览、文字中心、图标中心或大概位置猜坐标。
- `visual`/`pixel` 的点击点应取截图目标像素区域中心或明确可命中的内部点；禁止用相邻文本、输入框、容器 bounds 代替真实目标区域。
- 正式 case 执行禁止使用 `--coordinate-source manual`；如果沿用已录制 Flow 的坐标，必须使用 `--coordinate-source flow`，同时提供 `--target-bounds` 和可复核的 `--coordinate-evidence`，并在动作后重新 observe 验证命中结果。
- HarmonyOS 当前平台命令 `uitest uiInput inputText` 的最小输入包含 `x/y/text`，因此 HarmonyOS 执行 `inputText` 仍必须提供 `x/y`；这是平台原子能力约束，不代表 Android 也可以把点击和输入合并。
- 坐标动作后页面无变化、命中输入框或命中错误区域时，禁止重复使用同一坐标重试；必须重新 observe 并更新坐标证据，仍无法定位时停止并记录 `ACTION_TARGET_NOT_FOUND` 或 `BLOCKED/TOOL_ERROR`。

Case Execution Mode 的设备命令硬性规则：

- 禁止直接执行 `hdc shell aa force-stop`、`hdc shell aa start`、`adb shell am force-stop`、截图、布局 dump 或点击输入等设备命令来绕过顶层入口；冷启动必须由 `run-case.js --start` 自动调用 `restartApp`，或在诊断场景通过顶层 `scripts/action.sh --type restartApp` 调用。
- 所有会改变 App 状态或产生证据的设备操作，必须通过 `scripts/observe.sh --case-dir ...`、`scripts/action.sh --case-dir ...` 或平台 adapter 间接执行，确保预算、时间线和报告同步。
- `scripts/run-case.js --record-json` 只用于写入 agent 事实；正式 execution 的 `observation` 必须由顶层 `scripts/observe.sh` 自动写入，正式 execution 的 `actionResult` 必须由顶层 `scripts/action.sh` 自动写入，直接手写观察或动作结果会被拒绝。
- 步骤执行前后、步骤内重试前后的截图观察必须调用 `scripts/observe.sh --case-dir ... --step-id <step-id> ...`；只有启动后环境快照、平台诊断、全局状态探测这类非步骤级观察可以不传 `--step-id`，但必须显式传 `--scope global` 或 `--global-observation`。
- 执行前环境探测用于用户确认，不写入 case execution；execution 创建后的平台诊断、外部日志摘要或人工事实，必须用 `scripts/run-case.js <case-dir> --platform <platform> --record-json ...` 写入当前 execution，不得只在对话里描述。

Case Execution Mode 的框架边界硬性规则：

- 执行用例期间，agent 只能写入当前测试工作空间的用例、运行态、证据和报告产物；禁止修改 skill 仓库自身的 `SKILL.md`、`references/`、`scripts/`、平台 adapter、辅助源码或工具实现。
- 遇到平台 adapter 能力缺口、底层设备命令异常、工具实现缺陷或执行框架不支持当前操作时，不得在当前 execution 中现场修框架、改 adapter、编译辅助程序或换用未封装的设备命令绕过。
- 上述情况必须作为本次用例执行的工具能力问题记录到当前 execution，并按 `TOOL_ERROR` 或 `PLATFORM_UNIMPLEMENTED` 收尾为 `BLOCKED`；报告中说明阻塞步骤、平台、动作和工具错误摘要。
- 只有用户明确授权“修框架 / 修 adapter / 修改 skill 实现”后，才能在独立的框架维护任务中修改 skill 仓库代码；该任务不得继续复用未收尾的 case execution。

### Flow Recording Mode 强制协议

只要进入 Flow Recording Mode，agent 必须按以下流程执行，不能跳步：

1. 读取 `references/flow-format.md`。
2. 确认 Flow `name` 和 `intent`。
   - 如果用户已经明确给出，直接复述确认后开始。
   - 如果缺少 `name`，必须先询问，不能自行开始。
   - 如果缺少 `intent`，可基于 name 给出候选，但必须等用户确认。
3. 确认当前目录就是测试工作空间：只检查当前目录，不递归、不向上查找、不自动切换目录；若当前目录为空，初始化工作空间文件；若当前目录已有 `workspace.json` 或可识别的 `cases/`、`flows/` 工作空间结构，使用当前目录；其他非空目录立即停止。
4. 调用 `scripts/flow/start-recording.js --name <name> --intent <intent> --platform <platform> --flow-scope <universal|platform> --cwd <workspace-cwd> ...` 创建录制会话；若已知录制设备和目标应用，必须同时传 `--device`、`--app`、`--entry`，后续 `flow/observe.sh` 和 `flow/action.sh` 会从录制状态继承这些环境参数；缺省 `--flow-scope universal` 表示跨端通用，平台专用 Flow 必须显式传 `--flow-scope platform` 或 `--platform-specific`。
5. 告知用户当前 `flowId`、`recordingId`，并等待或接收人工步骤指令。
6. 每收到一条人工步骤指令，必须执行：
   - `scripts/flow/observe.sh --flow-dir <flowDir> --recording-id <recordingId> --label <step>-before`
   - 根据人工指令调用 `scripts/flow/action.sh --flow-dir <flowDir> --recording-id <recordingId> --instruction <instruction> ...`
   - `scripts/flow/observe.sh --flow-dir <flowDir> --recording-id <recordingId> --label <step>-after`
7. 每一步结束后，简短回报已记录的动作和后置观察结果，然后等待下一条人工指令。
8. 只有用户明确说“完成录制 / 结束录制 / finalize / 生成 Flow”时，才调用 `scripts/flow/finalize-recording.js <flowDir> --recording-id <recordingId> --status READY`。
9. finalize 后返回 `flow.md`、`flow.json` 路径和步骤数量。

Flow Recording Mode 的禁止事项：

- 禁止自动查找、解析、启动或执行任何 case。
- 禁止为了录制而调用 `scripts/run-case.js`。
- 禁止使用最近一次 case、最近一次 execution 或历史失败现场作为录制入口。
- 禁止在没有用户步骤指令时自行探索业务路径。
- 禁止在用户未确认结束录制前 finalize。

## 规则

- 执行 skill 时的当前目录就是工作空间根目录；新建需求时用户应先创建并进入一个空目录，再执行 skill。
- agent 只使用稳定顶层入口：主执行入口为 `scripts/probe-env.sh`、`scripts/resolve-execution-targets.js`、`scripts/parse-case.js`、`scripts/preflight-preconditions.js`、`scripts/update-env.js`、`scripts/prepare-env.sh`、`scripts/run-case.js`、`scripts/observe.sh`、`scripts/action.sh`；按需维护/渲染入口为 `scripts/apply-note.js`、`scripts/refresh-case.js`、`scripts/render-context.js`、`scripts/render-index.js`；Flow 录制/扫描入口为 `scripts/flow/start-recording.js`、`scripts/flow/observe.sh`、`scripts/flow/action.sh`、`scripts/flow/finalize-recording.js`、`scripts/flow/record-scan.js`。`scripts/platform/`、`scripts/platform/adapters/`、`scripts/platform/adapters/<platform>/atoms/`、`scripts/case/`、`scripts/report/`、`scripts/execution/`、`scripts/lib/` 都是内部实现层，不作为 agent 直接入口。
- 如果当前目录为空，脚本可初始化 `workspace.json`、`cases/`、`flows/` 和 `index.html`；如果当前目录已有旧工作空间结构，脚本可补写 `workspace.json`；如果当前目录非空但不是合法工作空间，必须停止，不能混入产物。
- 工作空间定位只看当前目录；禁止递归搜索、向上查找、自动选择兄弟目录或自动创建子目录。
- `case.json`、`source.md`、`notes.jsonl` 是跨平台共享的用例资产；`state.json`、`executions/`、`CONTEXT.md`、`CONTEXT.html` 是平台运行态资产，写在 `caseDir/platforms/<platform>/`。
- 正式执行必须显式传 `--platform <harmony|android|ios>`；无平台根运行态只允许用 `--legacy-runtime` 读取或收尾历史产物，不能作为新执行入口。
- `index.html` 的卡片状态是多平台聚合摘要，不是 case 的真实单一执行状态；真实执行结果以每个平台的 `CONTEXT.html` 和平台标签为准，聚合规则按失败优先、全部通过才通过。
- Flow 录制前必须明确 `name`；如果用户没有给出名称，先询问名称，不能自行猜测并开始录制。
- Flow 录制前应明确 `intent`；如果用户没有给出 intent，可基于名称生成候选并向用户确认。
- Flow 录制前必须明确录制平台；如果已有本轮确认环境，创建录制时写入该环境，否则先确认设备、目标 App 和启动入口。录制脚本不会默认选择 Harmony/Android/iOS。
- Flow 录制前必须明确适用范围：跨端通用使用 `--flow-scope universal`，平台专用使用 `--flow-scope platform`；录制平台会写入 `recordingPlatform`，只有平台专用 Flow 才写入 `platform` 并参与平台优先匹配。
- Flow 身份按 `name + flowScope` 生成；平台专用 Flow 还包含 `platform`，同名不同平台专用 Flow 不会互相覆盖。
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

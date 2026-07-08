# 工作流

## 范围

基于 Markdown 人工用例执行移动端 AI 黑盒视觉测试；不生成原生自动化测试代码，不做坐标录制回放。

当前平台状态：

- `harmony`：已实现，使用 `hdc` 和设备端 `uitest`。
- `android`：已实现，使用 `adb`、`uiautomator`、`screencap`、`input` 和 `dumpsys`。
- `ios`：已实现基础适配，使用 Appium / WDA；依赖未准备或能力不可用时按平台能力问题阻塞。

## 用户输入

新导入接受 Markdown 用例路径；已有用例优先使用 `caseNo` 引用：

- 单文件：`cases/login.md`
- 多文件：`cases/login.md cases/register.md`
- 目录：`cases/`
- 已有用例：`C001`，由统一分流脚本返回 `existingCases[].caseDir`

执行入口必须先用统一分流脚本处理输入：

```bash
scripts/resolve-execution-targets.js <case-ref|case.md|dir> [...] --cwd <workspace-cwd>
```

输出中的 `existingCases[].caseDir` 可直接执行；`markdownFiles[]` 需要再导入或刷新。
相对 Markdown 文件或目录路径按 `<workspace-cwd>` 解析，不按 skill 仓库目录或 shell 当前目录解析。

目录扫描包含 `*.md`，排除 `README.md`、`_*.md`、隐藏目录、带 `workspace.json` 的目录和可识别的旧测试工作空间结构。

## 用例空间

执行 skill 时的当前目录就是测试工作空间根目录。新建需求时，用户应先创建并进入一个空目录；脚本会在空目录内初始化工作空间文件。若当前目录已有 `workspace.json` 或可识别的旧工作空间结构，脚本使用当前目录并可补写 `workspace.json`。若当前目录非空但不是合法工作空间，必须停止，不能混入产物。

```text
workspace.json
index.html
flows/
platforms/
├── harmony.json
├── android.json
└── ios.json
cases/
└── C001__<title-slug>__<caseKey>/
    ├── source.md
    ├── case.json
    ├── notes.jsonl
    └── platforms/
        ├── harmony/
        │   ├── CONTEXT.md
        │   ├── CONTEXT.html
        │   ├── state.json
        │   └── executions/
        └── android/
            ├── CONTEXT.md
            ├── CONTEXT.html
            ├── state.json
            └── executions/
                └── <executionId>/
                    ├── timeline.jsonl
                    ├── result.json
                    ├── metrics.json
                    ├── screenshots/
                    ├── layouts/
                    └── logs/
```

`source.md`、`case.json`、`notes.jsonl` 是跨平台共享资产；`state.json`、`CONTEXT.*` 和 `executions/` 是平台运行态资产，按 `platforms/<platform>/` 隔离。

## 执行阶段

1. 确认当前目录是工作空间：只检查当前目录，不递归、不向上查找、不自动切换目录。
2. 用 `scripts/resolve-execution-targets.js` 分流输入。
3. 对 `markdownFiles[]` 解析外部 Markdown 文件并导入为 `source.md`；对 `existingCases[]` 默认直接读取已有 `source.md` 和 `case.json`。
4. 解析或刷新 `case.json`。
5. 用 `scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd>` 对待执行用例的前置条件做批量预检和归类；登录态、账号、权限、角色、灰度等业务上下文不得归为 `READY`，`CONFIRM`、`NEEDS_SETUP`、`UNKNOWN`、`UNSUPPORTED` 必须在无人值守执行前由用户确认、准备、剔除或跳过。
6. 探测平台环境，并让用户确认平台、设备、应用标识、启动入口和核心能力；平台只使用 `harmony`、`android`、`ios`。
7. 用户确认后，用 `scripts/update-env.js <case-dir> --platform <platform> ...` 固化环境到 `caseDir/platforms/<platform>/state.json`。
8. 创建 execution 前，用 `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>` 准备平台前置依赖，写入 `state.json.dependencies` 并刷新当前平台报告；依赖准备失败时不进入无人值守执行。
9. 进入无人值守执行阶段；执行中不再安装、启用或修复平台前置依赖，也不再询问前置条件。
10. 对输入中的每个用例按顺序独立闭环执行；当前 case 未 finalize 前，不开始下一个 case。
11. 每个用例先 `scripts/run-case.js <case-dir> --platform <platform> --start` 创建 execution；该入口会自动通过 `restartApp` 停止目标 App 并冷启动，成功、失败或无法验证都会作为当前 execution 的 action 事实进入 `timeline.jsonl`。冷启动失败或没有明确 `coldStartVerified=true` 时，冷启动敏感用例自动 `BLOCKED/CASE_RESTART_FAILED`，普通用例标记 `isolationCompromised` 后继续执行。
12. 在当前 execution 中写入 `case.json.preconditions` 的 `precondition` 事实；状态只有 `PASS` 或 `PREPARED` 才允许进入步骤，`FAIL`、`UNKNOWN`、`BLOCKED` 是前置条件终态，会立即生成结果并 finalize，可短路剩余前置条件。
13. 在当前 execution 中写入业务步骤前，调用 `scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>` 读取 READY Flow 的 `name`、`intent`、`steps`、`successHints`，并写入全局候选库 `flowScan` 事实；默认只返回当前平台专用 Flow 和通用 Flow。
14. 从第 1 步完整执行所有步骤；`restartApp` 禁止绑定 `stepId`；除 `launchApp` 和 `wait` 外，带 `--step-id` 的业务动作前必须已有当前步骤的可用 `flowScan` 事实，`status=FAILED` 的扫描不能作为动作前置，否则顶层动作入口会失败。
15. 每个业务步骤执行前先调用 `record-scan.js ... --step-id <step-id>` 写入步骤级 `flowScan`，再判断是否需要业务导航 Flow；匹配到 Flow 时先参考 Flow 进入目标业务状态，并写入 `flow` 事实事件。
16. 按 `observe -> perceive -> match-flow -> decide -> act/assert -> observe -> verify -> record` 循环。
17. 观察和动作必须走 execution-bound 入口；入口会先检查前置条件、步骤顺序和预算，再执行平台 adapter 并自动写入 `timeline.jsonl`。
18. Perception、Decision、Flow、Assertion 等 agent 事实用 `scripts/run-case.js <case-dir> --platform <platform> --record-json <json>` 写入 `timeline.jsonl`；正式动作结果只能由 `scripts/action.sh` 自动写入，不能直接用 `record-json` 手写 `actionResult`。
19. 当前用例操作链路结束后，必须立即完成断言、用 `scripts/run-case.js <case-dir> --platform <platform> --finalize --status <status>` 收尾已 `--start` 的 execution，聚合生成 `result.json` 和 `metrics.json`，并刷新该平台用例报告；正式平台执行不能直接 `--finalize` 创建新 execution。
20. 当前用例完成 finalize 后，才能进入下一个用例；批量总览可在每个 case 各自 finalize 后再次刷新。

执行开始时先创建 execution：

```bash
scripts/run-case.js <case-dir> --platform <platform> --start
```

正式执行必须显式传 `--platform <harmony|android|ios>`。无平台根运行态仅用于历史产物兼容，脚本层需要显式 `--legacy-runtime`，不得作为新执行入口。

`--start` 是用例隔离边界，不只是创建目录：默认会调用顶层动作入口写入一次 `restartApp`，平台 adapter 必须先停止目标 App 再启动已确认入口，并用 PID、Ability、Appium app state 或平台等价状态验证冷启动是否真实发生。只有 action 事实明确 `ok=true` 且 `coldStartVerified=true` 才算干净冷启动；失败、不可验证或缺少验证字段都按隔离降级处理。`case.json.isolation.requireCleanRestart=true`，或 `auto` 模式下用例包含“首次进入 / 重启 App 后 / 同一次 App 启动内 / 默认初始化 / 新用户首次状态”等冷启动敏感语义时，当前 execution 自动收尾为 `BLOCKED/CASE_RESTART_FAILED`，`--start` 输出 `blockedOnStart=true` 和 `nextAction=stop-current-case`；普通用例保留未 finalized 状态继续执行，但 `metrics.stability.isolationCompromised=true`，报告展示“非干净环境执行”警告。

创建 execution 后 Flow 扫描：

```bash
scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform <platform> --execution-id <id>
```

agent 必须使用 `record-scan.js` 输出的候选 Flow 内容，而不是自己拼 `find`、直接调用内部列表脚本或手写扫描事实；若不存在 flows 目录或没有 READY Flow，`record-scan.js` 会在当前 execution 写入 `EMPTY` 的 `flowScan` 事实。带 `--platform` 时，脚本默认过滤其他平台专用 Flow；只有人工审计或调试时才查看全部 Flow。

执行中的观察和动作示例：

```bash
scripts/observe.sh --case-dir <case-dir> --execution-id <executionId> --platform <platform> --step-id step-001 --label before
scripts/action.sh --case-dir <case-dir> --execution-id <executionId> --step-id step-001 --platform <platform> --type launchApp --app <appId> --entry <entry>
```

execution-bound observe 会自动把 label 写成 `<seq>-<label>`，例如 `001-before`。步骤内观察必须传 `--step-id`，报告用 `stepId` 关联截图证据和用例步骤；label 只作为人类可读名称，不作为唯一关联依据。启动后环境快照、平台诊断、全局状态探测等非步骤级观察可以不传 `--step-id`，但必须显式传 `--scope global` 或 `--global-observation`。

## 设备命令边界

- 用例执行期间禁止直接调用 `hdc shell aa force-stop`、`hdc shell aa start`、`adb shell am force-stop`、截图、布局 dump、点击或输入等设备命令绕过框架入口。
- 会改变 App 状态的操作必须通过 `scripts/action.sh --case-dir <case-dir> --execution-id <executionId> ...` 执行；`actionResult` 必须由该入口自动写入，直接 `record-json` 手写动作结果会被 `ACTION_RESULT_SOURCE_REQUIRED` 拒绝。
- 会产生截图、布局或日志证据的观察必须通过 `scripts/observe.sh --case-dir <case-dir> --execution-id <executionId> ...` 执行；属于具体步骤的观察必须同时传 `--step-id <step-id>`。
- 执行前环境探测用于用户确认，不写入 case execution；execution 创建后的平台诊断、外部日志摘要或其他非交互事实，必须通过 `scripts/run-case.js <case-dir> --platform <platform> --record-json <json>` 写入当前 execution。
- 这样才能保证预算检查、`timeline.jsonl`、`startedAt/endedAt`、截图证据和报告时间一致。

## 批量执行边界

- 批量执行不是“先跑完所有 case，再统一判定”；它只是把多个单用例闭环按顺序执行。
- 禁止 agent 自行创建 shell、Node、Python 或其他外层编排脚本来串联多个步骤、多个 case 或批量写入 `assertion`/`finalize`；批量执行只能逐 case、逐步骤实时调用框架顶层入口。
- 禁止用 `for`、`while`、`xargs`、一行多命令或模板化 JSON 批量生成步骤断言；每条 `assertion PASS` 必须来自 agent 对当前步骤最新 observation 的实时视觉判断。
- 禁止为多个 case 同时创建未 finalized 的 execution。
- 禁止把多个 case 的最终截图先放入待判定队列，再批量写 assertion 或批量 finalize。
- 每个 case 的步骤游标从 `step-001` 开始，后续 case 不能因为 App 停留在上一 case 的页面而从中间步骤开始。
- `restartApp` 失败或不可验证不能伪装成成功；普通用例可以隔离降级继续，但必须保留动作事实和 `isolationCompromised` 指标；冷启动敏感用例必须阻塞，不能产出看似可信的业务结论。
- 当前页面状态可以作为当前步骤是否已满足的判断依据，但不能替代步骤事实；若当前步骤已满足，必须写入该步骤的 `assertion PASS` 后才能进入下一步。
- 任何步骤事实写入前，当前 execution 必须已有每条前置条件的 `precondition` 事实；缺失时拒绝码为 `PRECONDITION_REQUIRED`，非 `PASS`/`PREPARED` 状态会按 `PRECONDITION_FAILED`、`PRECONDITION_UNKNOWN` 或 `PRECONDITION_UNSUPPORTED` 自动收尾，并可短路剩余前置条件。
- 任何带 `stepId` 的步骤事实写入前，当前 execution 必须已有 execution 级全局可用 `flowScan` 事实；缺失或扫描失败时拒绝码为 `FLOW_SCAN_REQUIRED`。
- 步骤通过证据必须来自当前 execution：普通操作步骤需要真实业务动作 `tap`、`toggle`、`longPress`、`inputText`、`swipe`、`back` 的 `actionResult ok=true` 且其后有同一步骤的 observation，或 `assertion PASS`；`assertion PASS` 必须通过 `evidence` 或 `evidenceObservation` 引用当前步骤已有 observation 的截图、布局或 label；断言型步骤必须写带 observation 证据引用的 `assertion PASS`；`launchApp`、`restartApp`、`wait`、`observation`、`perception`、`flowScan` 和 `flow` 只提供辅助证据，不单独满足 PASS 条件。
- `scripts/run-case.js --record-json` 和顶层 observe/action preflight 会拒绝跳步、跨步和回头补写，错误码为 `STEP_ORDER_VIOLATION`。
- `scripts/run-case.js --finalize --status PASS` 会在缺少步骤通过证据时把本次结果归一为 `FAIL/ASSERTION_UNKNOWN` 并 finalize，`requestedStatus` 保留 agent 原始请求；agent 必须在 finalize 前补齐步骤证据，不能把缺证据当作 PASS。
- 执行中以快速闭环为优先：当前 observation 已足够判断时，立即写带证据引用的 `assertion PASS` 或明确失败断言，继续下一步或 finalize；不产生新证据的反复复核、长解释和可选事实记录不要占用 execution 时间。
- `perception`、`decision`、`rule`、`flow` 只在会影响后续动作、Flow 选择、规则处理或失败归因时写入；`run-case.js` 返回的 `paceHint` 是非阻断提醒，只帮助 agent 收敛节奏，不改变结果、不写入 timeline。
- 每个 case 的 `endedAt` 应接近该 case 最后一次断言或操作链路结束时间；`durationMs` 不应包含等待其他 case 执行、统一判图或批量收尾的时间。
- 如果需要统一查看批量结果，只能在所有 case 都已各自生成 `result.json`、`metrics.json` 和 `CONTEXT.md` 之后查看或重新渲染 `index.html`。
- 多平台工作空间中，`index.html` 的卡片状态是平台结果的聚合摘要，按失败优先、全部通过才通过；真实结果以平台报告为准。

## 前置条件边界

- 平台级前置条件可以标准化检查，例如设备连接、截图能力、控件树能力、目标 App 启动能力和已确认环境。
- 批量执行前置条件预检由 `scripts/preflight-preconditions.js` 完成，只做用例级归纳、风险分类和用户决策辅助，不写入 execution。
- execution 创建后，agent 必须把预检确认结果或现场判断写成 `precondition` 事实；`PASS` 表示已确认满足，`PREPARED` 表示已在执行前准备完成，`FAIL`、`UNKNOWN`、`BLOCKED` 会作为前置条件终态自动 finalize，可短路剩余前置条件。
- 业务级前置条件不做通用自动准备，例如登录态、账号数据、订单状态、权限首次弹窗或特定业务数据。
- 业务级前置条件由 agent 结合用户补充、页面证据和用例上下文保守判断；证据不足时记录为 `BLOCKED`、`PRECONDITION_UNKNOWN` 或 `PRECONDITION_UNSUPPORTED`。
- 不为了满足前置条件静默执行清数据、卸载、支付、删除、发布、修改真实资料等破坏性操作。

## 环境确认

- 一个请求只确认一次环境；批量用例共用确认结果。
- 确认后直到本次请求结束不再提问；无法处理的问题写入报告。
- 每个用例独立创建 execution、检查平台级前置条件并生成结果。

## 用户补充

用户在对话中补充信息时，使用 `scripts/apply-note.js` 追加 `notes.jsonl`，重新应用到 `case.json`，并刷新 `CONTEXT.md`。

用户表示已调整 `source.md` 时，由 agent 执行：

```bash
scripts/refresh-case.js <case-dir>
```

不要要求用户手动执行脚本。

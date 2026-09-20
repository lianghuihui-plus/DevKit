# Runtime Command Plan 方案

## 目标

为 Case Agent 增加一个受约束的 `runPlan` 能力，让 Agent 可以一次提交由动作、等待、采集、定位和确定性检查组成的短流程，由 Runtime 在设备侧连续执行并返回完整过程证据。该能力解决视频控制栏、Toast、弹窗按钮和动画状态等生命周期短于一次 Agent 决策周期的交互问题，重点覆盖 033“取消童锁”场景。这里的“连续”表示一次 Runtime 调用内不可被其他调用穿插，不表示设备动作可回滚或事务性原子提交。

## 核心原则

1. Agent 负责业务目标、流程选择、语义解释和 PASS/FAIL/INCONCLUSIVE 判断。
2. Runtime 负责命令校验、设备动作投递、截图或完整 Scene 采集、确定性定位、技术条件检查、证据持久化和失败恢复事实；不对前后截图是否“发生变化”作语义判断。
3. Runtime 不调用大模型，不替 Agent 解释自由文本，不直接形成业务结论。
4. `runPlan` 是声明式、有限步数、有限时间的命令计划，不是 Shell 执行器，也不是任意脚本语言。
5. 计划中的每一步都必须可审计、可判断是否重放、可说明失败位置；未知设备 effect 不得自动重放。

## 为什么需要新能力

当前 `act` 的语义是“投递一个动作并采集新的完整 Scene”。Android 033 的动作后 Scene 采集实际约 4.6 至 6.5 秒，而视频控制栏约 3 秒自动隐藏；即使先返回瞬时截图，Agent 仍需要新一轮判断，第二次点击仍可能错过窗口。因此解决点不是单纯加快截图，而是让短时连续交互在一次 Runtime 调用内完成。

## 公共接口

新增 Agent-facing capability `runPlan`，并增加对应的内部 Runtime operation。请求绑定当前 Scene、Case Flow 节点和业务目的：

```json
{
  "capability": "runPlan",
  "submissionId": "run-plan-033-attempt-01",
  "basedOnSceneRef": "scene-0012",
  "purpose": "唤起视频控制栏并解除童锁",
  "maxDurationMs": 2500,
  "onFailure": "STOP",
  "steps": [
    { "id": "reveal", "type": "act", "actionRef": "visual:tap", "input": { "point": [0.5, 0.5] } },
    { "id": "settle", "type": "wait", "ms": 300 },
    { "id": "controls", "type": "capture", "mode": "SCREENSHOT_ONLY", "promote": false },
    { "id": "lock", "type": "locate", "sourceRef": "$controls.sceneRef", "locator": { "kind": "POINT", "point": [0.098, 0.501] } },
    { "id": "unlock", "type": "act", "actionRef": "visual:tap", "input": { "pointRef": "$lock.point" } },
    { "id": "after", "type": "capture", "mode": "SCREENSHOT_ONLY", "promote": false },
    { "id": "technical-check", "type": "check", "sourceRef": "$after.sceneRef", "predicate": { "kind": "CAPTURE_AVAILABLE" } }
  ],
  "flowContext": { "nodeRef": "N5" }
}
```

Runtime 返回计划状态、每一步的状态、技术事实和 Scene/截图证据引用；Agent 读取结果后调用现有 `inspect`/`recordResult` 完成视觉事实和业务结论。`runPlan` 不自动调用 `recordResult`，也不把 `technical-check` 转换成业务 PASS。`submissionId` 用于 transport 超时后的幂等重试；同一 `submissionId` 只能对应一个规范化请求摘要。

## 命令模型

第一版只允许以下命令：

| 命令 | Runtime 责任 | 结果 |
| --- | --- | --- |
| `act` | 复用现有 ActionRef/visual gesture 投递一个设备动作；计划引用先解析为现有动作输入 | action result、命令状态、可选空间证据 |
| `wait` | 等待有限毫秒，受计划总预算约束 | 实际等待时间 |
| `capture` | 截取截图或执行完整 Scene 采集；`SCREENSHOT_ONLY` 不等待控件树 | Scene ref、capture timing、截图证据 |
| `locate` | 按声明的 locator provider 解析坐标或控件引用 | 坐标、匹配状态、置信度和定位证据 |
| `check` | 执行确定性技术谓词 | `SATISFIED`/`NOT_SATISFIED`/`UNAVAILABLE` 技术事实，不是用例结论 |
| `checkpoint` | 标记需交回 Agent 的证据集合 | checkpoint ref，不执行设备动作 |

计划禁止任意循环、Shell、文件写入、业务 API 和未注册的 locator/check provider。第一版的 locator provider 为 `ELEMENT_REF`、`POINT`、`REGION`；`TEMPLATE` 保留扩展接口，但没有可靠模板时必须返回 `LOCATOR_UNSUPPORTED`，不得猜坐标。后续若加入本地 CV/OCR，必须作为 provider 并返回匹配置信度、输入截图和算法版本。`POINT` 表示 Agent 声明的归一化坐标经 Runtime 校验后解析，不表示 Runtime 已经语义识别目标；`REGION` 只能解析出边界和中心点，也不能宣称目标内容匹配。

步骤 schema 的公共约束如下：计划最多 12 步，`maxDurationMs` 为有限正整数且不得超过当前 execution 剩余预算；步骤 `id` 唯一，引用格式为 `$stepId.field`，只允许引用已经完成步骤的输出；`act` 使用 `{ actionRef, input }`，`capture` 使用 `{ mode, promote }`，`wait` 使用 `{ ms }`，`locate` 使用 `{ sourceRef, locator }`，`check` 使用 `{ sourceRef, predicate }`。`capture.promote` 在规范化后必须是布尔值：`SCREENSHOT_ONLY` 默认 `false`，`FULL_SCENE` 默认 `true`，调用方显式传值时覆盖默认值；快照必须保存规范化后的值。计划只接受规范化后的字段，禁止把未声明的对象透传到适配器。

计划执行器维护一个独立的 `currentSceneRef`：初始值为 `basedOnSceneRef`，每个 `act` 都以该 Scene 做 stale-check；`SCREENSHOT_ONLY` capture 不改变它，`promote: true` 的 capture 才更新它。步骤结果必须记录 `basisSceneRef`，避免看板或恢复逻辑把历史瞬时截图误认为动作基准。

## Scene 与证据

`capture` 产生不可变的 Scene 事实。每个 Scene 都有 `sceneId`、`captureMode`（`FULL_SCENE` 或 `SCREENSHOT_ONLY`）、`screenshot`、`evidenceChannels`、`capturedAt`、`captureTiming` 和 `source`。`source` 至少包含 `{ operation, planId, stepId }`，普通观察的 `planId/stepId` 为空。`SCREENSHOT_ONLY` Scene 明确标记布局通道不可用，但视觉附件、时间、尺寸、sha256 和来源计划步骤必须完整记录。

证据 Scene 与当前 Scene 是两条不同语义：所有证据 Scene 仍追加一个 `sceneObserved` 事件并落盘到 `scenes/<sceneId>.json`，但只有 `promote: true` 才更新 `current-scene.json`。`current-scene.json` 是后续普通 `act` 的 Scene 基准，不是最近截图的别名。结果校验和 `inspect` 必须允许引用非当前的历史证据 Scene；Scene 事件增加 `captureMode`、`promoted`、`planId` 和 `stepId` 以保持这一区别可审计。

每个计划步骤写入追加式事件，至少包括 `planRequested`、`planStepStarted`、`planStepCompleted` 或 `planStepFailed`、`planCompleted`/`planInterrupted`。所有计划事件都包含 `planId`，步骤事件还包含 `stepId`、`stepIndex`、`stepType`；完成/失败事件包含 `startedAt`、`endedAt`、`durationMs`、`inputRefs`、`outputRefs`、`status` 和结构化 `error`。`planRequested` 只保存脱敏规范化请求的 `requestSha256`、`submissionId`、预算和 `planRecordRef`，不把原始输入文本重复写入事件。

计划的规范化快照写入 `operations/plans/<planId>.json`，包含以下稳定字段：`schemaVersion: 1`、`planId`、`executionId`、`submissionId`、`requestSha256`、`basedOnSceneRef`、`flowContext`、`purpose`、`maxDurationMs`、`onFailure`、`requestedAt`、`startedAt`、`endedAt`、`elapsedMs`、`remainingMs`、`status`、`steps[]`、`evidence`、`technicalFacts`、`failure` 和 `integrity`。快照的存储态允许 `PLAN_ACCEPTED`、`PLAN_RUNNING` 以及三个终态 `PLAN_COMPLETED`、`PLAN_PARTIAL`、`PLAN_INTERRUPTED`；Agent-facing 响应只返回三个终态，进程恢复时任何无终态事件的存储态都必须先标记为 `PLAN_INTERRUPTED` 再允许重试读取。`steps[]` 中每项至少包含 `stepId`、`stepIndex`、`type`、`status`、`startedAt`、`endedAt`、`durationMs`、`basisSceneRef`、`inputRefs`、`outputRefs`、`error` 和 `technicalFactRef`；`integrity` 至少包含规范化快照正文的 `recordSha256`。原始请求文本不写入快照，敏感输入仍按现有规则脱敏。该文件是报告投影的主数据源，事件用于时序审计和恢复；每个步骤完成或失败后都必须原子更新快照，计划终态也必须先写入终态快照再追加终态事件。缺少快照或快照摘要不一致时报告必须显示 `PLAN_RECORD_INCOMPLETE`/`PLAN_RECORD_INTEGRITY_MISMATCH`，不能从事件顺序猜造完整结果。

事件写入器必须拒绝 payload 覆盖 `schemaVersion`、`eventId`、`executionId`、`sequence`、`time` 和 `type` 等保留字段；计划输入中的同名字段必须在规范化阶段被拒绝。`runPlan` 的外层 Agent 决策可以继续进入现有叙事，但计划内部步骤只能进入独立的 plan projection，不能伪装成额外的 Agent 决策。

计划执行状态固定为 `PLAN_COMPLETED`、`PLAN_PARTIAL` 或 `PLAN_INTERRUPTED`；请求级失败使用现有 `REQUEST_INVALID`/`TECHNICAL` 响应且不创建可执行计划记录。确定性步骤失败且安全停止返回 `PLAN_PARTIAL`；动作结果未知、计划超时、进程中断或锁恢复返回 `PLAN_INTERRUPTED`。计划没有回滚语义。

所有已接受的计划响应（包括完成、部分完成和中断）固定返回 `planId`、`status`、`idempotent`（仅幂等重试时出现）、`remainingMs`、`steps[]`、`evidence` 和 `technicalFacts`。`steps[]` 中每项至少有 `stepId`、`stepIndex`、`type`、`status`、`durationMs`、`outputRefs`；失败项增加 `error.code` 和 `technicalFactRef`。`evidence` 按 `sceneRefs`、`screenshotRefs`、`locatorRefs`、`checkRefs` 分组。响应不返回平台 Shell、适配器命令或 CaseResult verdict。

`planStepFailed` 的技术错误通过 `technicalFactRef` 关联一个 `technicalIssue` 事件；`check` 的结果仍是 Runtime 技术事实，使用独立的 `checkRef` 和结构化结果，不直接成为 CaseResult 的 PASS/FAIL。需要业务结论时由 Agent 结合 Scene 证据调用 `inspect` 和 `recordResult`。

幂等规则：首次接受请求前先持久化 `planRequested` 和计划快照；同一 `submissionId` 且 `requestSha256` 相同的重试返回原计划结果并标记 `idempotent: true`，摘要不同则返回 `PLAN_SUBMISSION_CONFLICT`；动作已投递但结果未知时，重试只能读取该计划的中断结果，不得重新执行任何已投递步骤。计划快照采用临时文件写入后原子替换，终态事件携带 `planRecordRef` 和 `recordSha256`，报告据此校验事件与快照是否对应。

耗时以单次 Runtime 调用内的 monotonic clock 计算，事件同时保存 wall-clock 时间用于展示；适配器超时必须传递剩余计划预算，无法保证设备动作在 deadline 前结束时按未知结果处理。`Agent 与调度间隙` 不计入计划内部步骤耗时，计划内部等待、适配器和定位/检查时间全部属于 Runtime 计划耗时。

## 前后画面变化的判断边界

| 领域 | 影响 | 处理方式 |
| --- | --- | --- |
| 设备动作投递、stale Scene 校验、未知结果恢复 | 无行为影响 | 保留 ActionRef 校验、`SCENE_CHANGED` 和事务状态；只移除截图差异字段 |
| 截图与 Scene 完整性 | 无能力损失 | 保留截图、尺寸、SHA-256、前后 Scene 引用和证据完整性校验 |
| 滚动边界/覆盖跟踪 | 有实现影响 | 改用控件树 anchor 连续性和边界移动；证据不足时返回 `GAPPED` |
| Agent-facing 与报告 | 有契约影响 | 新执行不返回变化结论；历史记录只读兼容并标记为 legacy |
| `runPlan` 技术检查 | 有 schema 影响 | 删除 `SCREEN_CHANGED`，保留引用、截图、App 和控件技术检查 |

Runtime 不再根据前后截图 SHA-256 是否相同生成 `observedEffect`、`change`、`screenComparison` 或 `CHANGED`/`UNCHANGED` 结论。截图 SHA-256 仍用于证据完整性和产物篡改校验，但不代表页面语义发生或未发生变化；`SCENE_CHANGED` 仍保留，含义是动作依据的 Scene 已不是当前 Scene，与画面内容是否变化无关。

普通 `act` 和 `runPlan` 必须继续返回可审计的证据引用：动作前后 Scene 使用 `beforeSceneRef`/`afterSceneRef`（或等价的 `evidence.sceneRefs`）关联，计划步骤保留 `basisSceneRef` 和输出 Scene 引用；响应、事件和快照不得再写入变化结论。Agent 需要通过 `inspect(channel="visual")` 或读取计划中的截图证据，自行判断视觉变化、目标是否出现以及业务结果，再调用 `recordResult`。

新的动作证据投影固定为 `evidence: { sceneRefs: { before, after }, screenshotRefs: [] }`；事件仍可保留 `sceneId`/`sceneIdAfter` 作为索引字段，但不得新增 `observedEffect.status`。这样看板可以稳定地渲染操作前后证据，Agent 也能基于明确引用自行比较，而不依赖 Runtime 的预判。

`runPlan` 的确定性 `check` provider 移除 `SCREEN_CHANGED`；Runtime 可以检查截图存在、引用存在、App 身份和控件技术属性，但不得把两张截图的差异转换成业务或通用变化事实。旧 execution 中已经存在的 `observedEffect`/`screenComparison` 仅为历史兼容字段：报告可以标记为“历史 Runtime 比对”，但不得继续作为 Agent-facing 输出、CaseResult 证据结论或新执行的输入。

滚动上下文不再依赖 `observedEffect`。`scroll-context` 只根据控件树 anchor 的连续性、共享元素边界移动和动作方向生成内部的覆盖/连续性证据；布局缺失或无法证明连续移动时标记 `GAPPED`，不得据此推断页面变化或目标缺失。该内部证据只服务于滚动覆盖安全性，不对 Agent 宣称“画面已变化/未变化”。

## 看板与报告可观测性

新能力产生的基础事实继续复用现有执行目录：计划事件写入 `events.jsonl`，截图和 `SCREENSHOT_ONLY` Scene 写入现有证据目录，步骤和采集耗时写入现有 metrics/telemetry。这样不需要重做报告存储或另建一套看板数据源。

但现有看板不能完整表达计划语义。当前总览可以继续显示最终结论、用例总耗时、动作/观察数量和恢复次数；当前执行报告可以通过原始数据或普通 Scene 截图间接看到部分事实，但不会自动展示计划整体状态、步骤顺序与耗时、失败前缀、定位 provider/结果、技术检查状态，也不会标识 `SCREENSHOT_ONLY` 与完整 Scene 的差异。

因此 `runPlan` 上线前必须扩展报告投影和用例详情页，至少提供：

1. 计划摘要：计划 ID、总体状态、总耗时、完成步骤数、失败步骤和已完成前缀。
2. 步骤时间线：每个步骤的类型、状态、开始/结束/耗时、动作基准 Scene、输入引用、输出引用和技术错误。
3. 瞬时证据：`SCREENSHOT_ONLY` 标签、截图、尺寸/hash、来源步骤和是否提升为当前 Scene；操作前后截图只显示证据引用，不显示 Runtime 的 `DIFFERENT`/`IDENTICAL` 判断。
4. 定位与检查事实：provider、目标引用/坐标、匹配状态、置信度，以及 `SATISFIED`/`NOT_SATISFIED`/`UNAVAILABLE`；这些字段必须明确标为 Runtime 技术事实，不显示为业务 PASS/FAIL。
5. 耗时分解：计划总耗时、动作设备耗时、等待耗时、截图耗时、定位耗时、检查耗时和 Agent/调度间隙。

首版不要求改造总览页的全部统计，只需在用例详情页可审计地呈现以上信息；总览页可先增加计划执行次数、计划失败次数和瞬时采集次数等聚合指标，作为后续增强。

### metrics 与 telemetry 兼容约束

现有 `metrics.json` 使用 schema 3，`runPlan` 不修改既有字段含义，也不把每个步骤展开到顶层。计划指标以可选的 `planMetrics: { schemaVersion: 1, ... }` 嵌套对象追加，至少包含 `runCount`、`completedCount`、`partialCount`、`interruptedCount`、`screenshotOnlyCaptureCount`、`actionStepCount`、`waitMs`、`captureMs`、`locateMs`、`checkMs` 和 `runs[]` 摘要。`runs[]` 每项固定包含 `planId`、`status`、`elapsedMs`、`completedStepCount`、`failedStepId`、`screenshotOnlyCaptureCount`、`actionStepCount`、`waitMs`、`captureMs`、`locateMs`、`checkMs`、`startedAt`、`endedAt` 和 `recordSha256`；没有计划的旧 execution 不写该字段。看板的“计划失败数”只能明确标注为 `partialCount + interruptedCount` 的 Runtime 计划状态统计，不得混同为 CaseResult 业务失败数。

`telemetry/spans.jsonl` 继续记录细粒度耗时，计划步骤 span 至少包含 `name: "plan-step"`、`planId`、`stepId`、`stepType`、`startedAt`、`endedAt`、`durationMs` 和 `clock: "monotonic"`。现有 `runtimeActiveMs`、`adapterActiveMs` 等指标保持原口径，计划指标只做新增投影，避免把同一适配器耗时重复计入。

## 条件、失败与恢复

- `check` 只允许确定性技术谓词，例如截图存在、控件可见且 enabled、App 身份匹配、前后 Scene ref 存在。禁止 `SCREEN_CHANGED` 或“截图 hash 改变”类谓词；每个结果包含 `{ checkRef, predicate, sourceRefs, status, value }`，其中 `status` 只允许 `SATISFIED`、`NOT_SATISFIED`、`UNAVAILABLE`。
- `check` 失败时，计划按 `onFailure: "STOP"` 停止并返回已完成前缀；`CONTINUE` 仅允许对非设备动作步骤使用。
- 设备动作结果未知时，计划状态为 `PLAN_INTERRUPTED`，禁止自动重放；后续必须先 `observe` 或按恢复事实重新规划。
- 计划超时、步骤 schema 非法、引用过期或 provider 不支持时返回明确的技术错误和失败步骤，不伪造后续结果。
- Runtime 锁覆盖整个计划，避免同一 execution 的其他调用穿插；计划中每个设备动作仍保留操作 ID 和事务状态。锁只保证执行互斥，不提供设备回滚；计划超时或异常后必须依据计划快照和事务状态恢复，而不是从第一个步骤重新执行。

## 033 的执行方式

033 不应拆成“点击视频中心 -> Agent 读取截图 -> Agent 再点击童锁”两次 Agent 决策。Agent 在第一次决策时提交完整计划；Runtime 在约 300ms 的窗口内截屏、解析预声明区域并点击童锁，再在解锁后截屏。Agent 最后只处理两张证据和技术结果，判断锁图标状态及控制栏内容。

如果定位目标只依赖固定坐标，计划必须披露其平台、方向和来源；如果目标需要模板/CV，而当前平台没有可用 provider，Runtime 应停止并返回 `LOCATOR_UNSUPPORTED`，而不是让设备动作盲点。

## 兼容性与边界

- 现有 `observe`、`act`、`inspect`、`recordResult` 的设备动作、Scene 基准、证据持久化和结果记录语义不变；仅移除新执行中的 Runtime 截图变化结论，普通用例不自动改用计划。
- `act` 继续保证单动作加完整 Scene 的稳定路径；`runPlan` 是需要时间窗口时的显式选择。
- Coordinator 不读取计划内部步骤，不替 Case Agent 编排计划；它只等待 execution 的持久化结果。
- 计划响应必须保持紧凑，不返回 capability 卡片、方法说明或 Agent 指令。

## 验证标准

1. 单元测试证明 schema 只接受允许的命令、引用、预算和 locator/check provider。
2. Runtime 测试证明计划按顺序执行、短时截图可落盘、步骤事件完整、失败前缀可恢复、未知动作不重放。
3. Android、HarmonyOS、iOS 适配器测试证明 `SCREENSHOT_ONLY` 不隐式执行控件树采集，并保留真实截图 hash 与尺寸。
4. Agent-facing 测试证明 `runPlan` 出现在公开能力、文档和错误映射中，且不暴露 Runtime 内部实现细节。
5. 033 回归测试证明计划可以在控制栏 3 秒窗口内完成唤起、定位、点击和前后截图；结果仍由 Agent 通过视觉检查和结果记录收口。
6. 变化边界测试证明新执行不产生 `observedEffect`、`screenComparison` 或 `SCREEN_CHANGED`，但保留前后 Scene/截图引用；历史执行仍可读取且不会把旧 Runtime 比对投影为新的 Agent 事实。

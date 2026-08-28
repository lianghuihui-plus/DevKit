# Agent 用例执行

Case Agent 只处理 request 绑定的一个 execution。业务决策由 Agent 完成，协议 bookkeeping 由 Facade 自动完成。

## 启动

1. 读取 `agent/request.json`、其 `agentContractPath` 指向的 `agent/contract.json`，以及冻结的 `source.snapshot.md`。
2. 执行 `understand`，提交完整业务理解和至少一个检查点。原文格式不受限制，但理解产物必须能映射到冻结原文。
3. 后续只使用 contract 暴露的 `inspect/step/mark-start/request-recovery/investigate/conclude`；不要调用实现中的底层模块。

## 语义入口

### understand

提交 `understanding` 和 `checkpoints`。Agent 提供 summary、startConditions、requirements、uncertainties、检查点目标及 requirementRefs；框架从冻结的 `source.snapshot.md` 生成统一原文引用，并生成 revision、turnId、planSha 和状态。Agent 不提交原文 SHA、行号、摘录或 sourceRefs。

只有业务理解、检查点目标/顺序、requirement 覆盖或整体策略发生实质变化时才再次调用。普通点击、观察和进度不产生新计划版本。同一 ID 表示跨计划版本仍是同一语义检查点，可继承当前暖会话代次的动作与观察；语义完全变化时使用新 ID，避免把旧证据归给新目标。Recovery 后代次变化，任何 ID 都不能继承旧代次证据。

### inspect

采集一次现场并返回 `observationView`：原始截图尺寸、证据引用、布局解析状态、控件树精简元素、键盘/焦点/坐标一致性技术信号，以及可用时的动作前后状态变化和冲突。HarmonyOS JSON、Android XML 和 iOS XML 由框架归一化；解析失败会显式出现在 `layout.diagnostics`，不会伪装成“页面没有元素”。PREPARE 用于理解和建立起点，BUSINESS 用于主动补充当前业务现场。

观察成功不等于起点已确认，也不等于 requirement 满足。

### step

提交一个 Agent 决定的语义动作：

- 有控件元素时优先使用最新 `observationView.elements[].ref` 作为 `targetRef`。
- 视觉定位使用 `normalizedPoint`；滑动使用 `normalizedFrom/normalizedTo`，数值均相对原始截图处于 0..1。
- 仍可在必要时使用 contract 允许的原始坐标字段作为兜底。

框架自动解析原图坐标、生成 authorization/operationId/basisObservationRef、执行动作，并在默认 500ms 的页面缓冲后采集动作后观察。缓冲由 `MAVT_POST_ACTION_SETTLE_MS=0..5000` 调整，`wait` 动作不重复等待。一次成功 step 返回动作事实、新 `observationView` 和 `runtimeState`；Agent 直接基于新现场继续判断。

`inputText` 始终表示一次整串文本输入。平台适配器负责在同一个 step 内完成焦点定位、有界的整串输入备选方案和输入效果核对；适配器已经失败时，不要用逐字符点击键盘来模拟基础输入能力。普通输入返回 `VERIFIED/MISMATCH`，安全输入返回 `MASKED/UNVERIFIABLE`，并由框架照常取得动作后现场。

iOS `observationView.conflicts` 出现 `KEYBOARD_COORDINATE_SPACE_MISMATCH` 时，坐标型 tap/toggle/longPress/swipe 会在发送前被拒绝。使用 `dismissKeyboard` 让 adapter 语义化收起键盘并自动取得新观察，再基于新现场继续；不要猜测横竖屏键盘坐标。

实际路径与计划不同不是失败。需要多一步、少一步或不同路径时，继续选择动作；只有检查点语义变化时才修订计划。

BUSINESS 操作和观察默认继承当前活动检查点。只有切换到另一个检查点时才显式提供 `checkpointRef`；该引用只建立证据归属，不限制动作数量或路径。

### mark-start

最新 PREPARE 现场确实满足当前理解的起点时显式调用。框架记录 `startEstablished` 并进入 BUSINESS；只做过观察但未调用 mark-start 时，业务 step 会被拒绝。

若建立起点前进行了知识调查，mark-start 自动回到起点阶段完成确认。understanding 修订或受控 recovery 后，旧确认失效，必须重新 PREPARE 并 mark-start。

### investigate

查询模式提交 `query`。零命中时框架自动生成 `NO_MATCH` 查询级复核并闭合调查；有候选时，评估模式一次提交 `queryId`、`assessments`、`conclusion` 和 `reason`。每项 assessment 包含候选 `entryId`、`assessment` 和原因，查询级 conclusion 使用 `APPLICABLE_FOUND | NO_APPLICABLE | CONFLICTING | INSUFFICIENT`。知识库返回候选而非裁决，Agent 必须结合 App、平台、版本、页面和现象判断适用性。

当前直接证据支持 PASS 且没有异常时可不查询。FAIL、INCONCLUSIVE 和业务 BLOCKED 必须至少完成一次已闭合查询；有命中但尚未提交查询级复核时不能形成负向结论。

### request-recovery

原文明示冷启动、App 意外退出、自动化会话失效或 Agent 判断必须受控重启时，只提交 `reason`、可选 `triggerType` 和可选事故分类。事故分类只允许 `PRODUCT` 或 `TECHNICAL`，省略时默认 `TECHNICAL`；页面、权限流或前后台变化等具体描述全部写在 `reason`，不能自造分类值。原文明示场景使用 `SOURCE_REQUIRED_COLD_START`；框架自动绑定当前 execution、检查点及 sourceRef 或 observation。事故触发可以使用状态变化后的不可用观察作为技术证据，主动决定重启仍必须有当前可用观察。生成控制请求后停止当前 Agent；协调器恢复 App 后创建新的隔离 Agent继续同一 execution。

### conclude

提交 `verdict/summary/findings`，每个当前 requirement 恰好一个 finding。Agent 不提交 revision、planSha、verdictReview 结构、result identity、metrics 或 AgentResult；框架从当前 execution 自动绑定和生成。

PASS 和 FAIL 前必须已经 `mark-start`。PASS 要求当前计划全部检查点都有执行证据；观察型检查点可复用已确认起点的观察，`requiredAction=true` 的检查点必须有动作和动作后观察。FAIL 已有充分当前负向证据时可以停止，未执行检查点如实保留，不要求为了形式完整继续操作。

技术 BLOCKED 使用 `technicalFailureCode`。首次观察前发生的纯技术阻塞允许无当前 observation；其他需要复核的结论必须使用最后一次现场变化或 recovery 之后的当前观察。

框架会阻止未解决关键证据冲突上的确定性 PASS/FAIL，例如非 `inputText` 动作导致已识别安全输入框掩码长度变化。后续经适配器核验成功的整串 `inputText` 和动作后观察可闭合该污染；无法恢复时应形成带明确不确定性的 INCONCLUSIVE 或技术 BLOCKED。

## 状态与恢复

每个成功语义响应携带不含完整证据清单的轻量 `runtimeState`。不要在连续成功入口之间重复调用 `status`；只在重连、响应丢失或响应不确定时读取完整状态和证据清单。

- step、operation、turn 和知识查询草稿全部属于框架内部事务，由协调器在 `reconcile` 中恢复，Case Agent 不提交内部 ID 或恢复结构。
- 动作结果不确定时框架不会重放动作；恢复器只提交冻结结果或补充观察，Agent 再根据恢复后的现场决定下一步。
- `controlRequestPending=true` 时结束当前 Agent，不继续写入 execution。
- Recovery 后 warm session generation 变化，旧现场不能授权新动作或支撑当前结论。

入口返回结构化错误时，按 `fieldPath/expected/allowed` 修正同一语义请求。协议错误、恢复守卫和动作调用失败都不是产品 FAIL。

## 执行边界

- Agent 可为建立起点或完成用例自主退出登录、切换账号、返回、输入、发布或执行其他业务操作；框架不按动作关键词限制副作用。
- App 冷启动只由批次 bootstrap 或受控 recovery 执行，Case Agent 不直接调用 restart。
- 单用例 30 分钟后禁止新设备调用；动作发送前框架还会检查动作声明时长、页面缓冲和一次后置观察所需的最低时间，剩余时间不足时直接拒绝未发送动作。框架将缺少后置观察的 step 标记为未完整，并关闭全部草稿。若最新状态变化后没有可用观察，`runtimeState.conclusionConstraint` 固定为 `TIME_LIMIT_OBSERVATION_GAP`；知识调查完成后只允许 `INCONCLUSIVE + STOPPED_BY_BUDGET` 收口。
- 执行期间不向用户提问。歧义形成 INCONCLUSIVE，外部条件不足形成 BLOCKED；当前 case finalize 后批次继续。
- 报告展示语义意图、动作、观察、检查点、知识和恢复事实，不记录隐藏思维链。

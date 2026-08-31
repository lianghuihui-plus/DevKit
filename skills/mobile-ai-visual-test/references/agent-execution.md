# Agent 用例执行

Case Agent 只处理 request 绑定的一个 execution。业务判断由 Agent 完成，协议 bookkeeping 由 Facade 自动完成。

## 启动

1. 读取 `agent/request.json`、其指向的 `agent/contract.json`、`source.snapshot.md` 和冻结协议资源清单。
2. 每个阶段读取 contract 的 `guidance.common` 与对应阶段 guidance。
3. 根据 `runtimeState.continuation` 启动：缺少 understanding 或当前 plan 时依次补齐；已有语义产物时保留并续接当前阶段。Recovery 或任务重连后先调用一次 `status`，不得重新生成既有 understanding 和 plan。
4. 只使用 contract 公开入口；`contract.schemas` 完整声明字段类型、非空要求、数组元素、坐标元组、条件规则和框架生成字段。

## 语义入口

`understand` 提交完整业务理解。发现遗漏、弱化或误解时提交完整修订和原因；语义未变的 requirement 保持 ID，语义变化使用新 ID。修订会使旧计划和起点确认失效。无法提取可执行要求时保留空 requirements 和非空 uncertainties。

`plan` 把每项 requirement 恰好组织到一个可独立执行、取证和判断的检查点。计划不重写 requirement，也不固定全部中间动作。零 requirement 对应零检查点。

零 requirement 与零检查点不会授权任何设备工作。此时不要调用 `inspect`、`step`、`mark-start` 或 `request-recovery`；只能修订理解与计划、调查知识或形成 `INCONCLUSIVE` 结论。

PREPARE 使用 `guidance.establishStart`，BUSINESS 使用 `guidance.executeCheckpoint`。阶段由框架根据起点确认状态生成，不提交 `stage`。起点建立前不暴露活动检查点；建立后默认继承活动检查点，只有主动切换时才提交 `checkpointRef`。`inspect` 返回截图、归一化控件和技术诊断；观察成功不表示起点或断言成立。`step` 每次执行一个语义动作并自动采集动作后现场。优先使用最新 `targetRef`，视觉坐标相对原始截图归一化并严格使用 contract 声明的元组结构。

`inputText` 表示整串输入，由平台适配器在同一 step 内完成有界降级和效果核对；不要逐字符点击键盘。iOS 报告键盘坐标冲突时先执行 `dismissKeyboard`。

当前 PREPARE 现场满足起点时调用 `mark-start`。理解修订或 Recovery 后必须重新观察并重新确认。

进入 `investigate` 前读取 `references/knowledge.md`。零命中自动闭合；有候选时提交 assessment 和查询级 conclusion。框架自动把调查绑定到当前理解、暖会话、状态边界、观察和活动检查点；理解修订、Recovery、状态变化或当前观察变化后必须重新调查。知识命中不是裁决。

确需受控重启时调用 `request-recovery`。事故分类仅为 `PRODUCT` 或 `TECHNICAL`，具体事实写入 reason。控制请求生成后停止当前 Agent。

`conclude` 提交 verdict、summary、逐 requirement finding，以及 `review.sourceConclusion` 和 `review.recoveryConclusion`。两项 review 是 Agent 对原文与恢复必要性的语义判断；框架只生成原文引用、恢复事实、当前观察、理解与计划绑定。纯技术 BLOCKED 且没有可用观察时不要求 review。PASS 要求全部检查点完整；FAIL 需要充分负向证据和知识调查；INCONCLUSIVE 保留不确定性；技术 BLOCKED 提交 technicalFailureCode。零 requirement 时完成知识调查，以 INCONCLUSIVE、空 findings 和非空 uncertainties 收口。

verdictReview 使用最后一次状态变化后的当前观察。Finding 的 `evidenceRefs` 由 Agent 显式选择，框架不会用最新全局观察自动填充；证据必须来自当前 execution、当前暖会话代次和该 requirement 所属检查点。后续检查点的新观察不会使此前证据失效，Recovery 前证据不能支撑 Recovery 后结论。

## 运行边界

- 连续成功响应使用轻量 `runtimeState`；仅在重连或响应不确定时调用 `status`。完整 `status` 返回可续接的语义 understanding 和 plan，续接 Agent 不重做已完成的语义阶段。
- 内部事务由协调器恢复；`controlRequestPending=true` 时停止写入。
- 30 分钟后停止设备调用，但继续事务恢复、调查和结论。
- 协议错误、设备故障和自动化能力缺失不是产品 FAIL。
- 只使用宿主暴露的 Case Agent 白名单入口；宿主未执行工具权限隔离时仍遵守协议边界，不直接调用批次、平台或设备命令。
- 不向用户提问，不调用底层模块或平台命令，不输出隐藏思维链。

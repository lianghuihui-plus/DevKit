# 失败与结果策略

业务 verdict 由 Case Agent 根据用例原文和现场形成：

- `PASS`：观察与交互结果满足预期。
- `FAIL`：当前证据明确不满足预期。
- `INCONCLUSIVE`：原文或证据不足以可靠判断。
- `BLOCKED`：客观条件阻止继续执行。

设备离线、Adapter 不可用、截图损坏和 Runtime 文件异常属于技术事实，不直接成为产品 FAIL。Runtime 以统一 `TECHNICAL` 响应返回错误代码、说明、`technicalFactRef` 和最后 Scene，并自动把事实绑定到当前 decision、验证点、Scene 和 generation；Case Agent 根据可恢复性选择继续、`recover` 或基于已有事实收口。瞬态错误被后续成功操作或恢复后失效；只有属于当前 execution、当前 generation、关联该验证点且仍直接阻止验证的事实才由 check 的 `technicalRefs` 引用。

每次动作自动采集新 Scene。动作已经发出但结果未知时，Runtime 记录 `actionOutcomeUnknown` 并优先观察现场，不自动重放。非当前 Scene 的 Capability 返回 `SCENE_CHANGED` 和当前 Scene，不发送动作。

App 初始状态的授权或制品条件不满足时，ExecutionRequest 以 `INITIAL_STATE_PREFLIGHT_FAILED` 拒绝，不调用设备。预检通过但 Lifecycle 实际准备失败时，框架保存 `APP_INITIAL_STATE_UNAVAILABLE` 技术事实，自动生成覆盖全部 expectation 的 BLOCKED CaseResult 并完成 execution，不创建 Case Agent；已经分发但结果未知的清数据或重装不会重放。

截图是必需证据，控件树用于增强定位和状态理解，两者是并列能力。控件树为空、缺失或与截图冲突时不得推断页面空白，Case Agent 必须用 `view_image` 查看 Scene 视觉附件并调用 `inspectVisual` 登记；系统权限弹窗、Toast、遮罩、浮层、键盘、长按中状态、动画和纯视觉结果同样必须视觉复核。新协议 execution 中，每个最终 check 引用的 Scene 都必须有 `visualInspected` 记录，否则 Runtime 返回 `RESULT_INCOMPLETE`。

单用例预算为 30 分钟。到达预算后 Runtime 返回 `TIME_LIMIT` 并停止新的设备动作，`knowledge` 和 `finish` 仍可使用，Case Agent 基于现有 Scene 形成可解释结论。

无人值守批次中不等待用户补充账号、验证码、授权或业务解释。单用例能够收口时保存结果并继续下一用例；只有 bootstrap、共享设备、批次存储或平台资源出现批次级技术问题时停止整个批次。

Runtime reconcile 的锁竞争最多持久化重试三次；其他 execution 错误立即归类为 `FATAL_EXECUTION`，事件/批次存储损坏归类为 `FATAL_BATCH`。致命错误不再返回无限 `WAIT_CASE_AGENT`，而是进入统一阻塞收口。CLI reconcile 自动完成 settle、平台释放与报告发布；报告发布失败才返回 `PUBLISH_REPORTS + retryable=true`，且不跳过已完成、取消或阻塞的执行。

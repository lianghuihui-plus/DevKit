# Coordinator 错误路由

只定位当前响应的 `documentationRef`；完整原因和恢复动作位于对应分组页。

<a id="error-agent-input-stalled"></a>- [`AGENT_INPUT_STALLED`](errors/input-state.md#error-agent-input-stalled)：同类 Coordinator 输入错误连续发生，停止自动猜测。
<a id="error-coordinator-input-invalid"></a>- [`COORDINATOR_INPUT_INVALID`](errors/input-state.md#error-coordinator-input-invalid)：Coordinator 请求字段不合法。
<a id="error-coordinator-state-invalid"></a>- [`COORDINATOR_STATE_INVALID`](errors/input-state.md#error-coordinator-state-invalid)：Coordinator run 状态缺失、损坏或绑定不一致。
<a id="error-decision-not-allowed"></a>- [`DECISION_NOT_ALLOWED`](errors/input-state.md#error-decision-not-allowed)：确认决策不适用于当前阶段。
<a id="error-environment-not-ready"></a>- [`ENVIRONMENT_NOT_READY`](errors/environment.md#error-environment-not-ready)：平台、设备或 App 探测未就绪。
<a id="error-ios-signing-required"></a>- [`IOS_SIGNING_REQUIRED`](errors/environment.md#error-ios-signing-required)：iOS 真机绑定缺少明确签名字段。
<a id="error-input-capability-not-ready"></a>- [`INPUT_CAPABILITY_NOT_READY`](errors/environment.md#error-input-capability-not-ready)：设备输入能力尚未准备完成。
<a id="error-platform-unavailable"></a>- [`PLATFORM_UNAVAILABLE`](errors/environment.md#error-platform-unavailable)：目标平台或设备当前不可用。
<a id="error-batch-blocked"></a>- [`BATCH_BLOCKED`](errors/batch.md#error-batch-blocked)：批次存在不可自动恢复的终态阻塞。
<a id="error-coordinator-technical"></a>- [`COORDINATOR_TECHNICAL`](errors/batch.md#error-coordinator-technical)：未归类的批次级技术异常。

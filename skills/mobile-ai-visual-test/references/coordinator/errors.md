# Coordinator 错误目录

错误响应只返回本次失败原因、相关动态事实和本页锚点；调用签名见服务索引。

<a id="error-coordinator-input-invalid"></a>
## COORDINATOR_INPUT_INVALID

Coordinator 请求字段不合法。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-coordinator-state-invalid"></a>
## COORDINATOR_STATE_INVALID

Coordinator run 状态缺失、损坏或绑定不一致。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

<a id="error-decision-not-allowed"></a>
## DECISION_NOT_ALLOWED

确认决策不适用于当前阶段。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-environment-not-ready"></a>
## ENVIRONMENT_NOT_READY

平台、设备或 App 探测未就绪。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-ios-signing-required"></a>
## IOS_SIGNING_REQUIRED

iOS 真机绑定缺少明确签名字段。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-input-capability-not-ready"></a>
## INPUT_CAPABILITY_NOT_READY

设备输入能力尚未准备完成。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-batch-blocked"></a>
## BATCH_BLOCKED

批次存在不可自动恢复的终态阻塞。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

<a id="error-coordinator-technical"></a>
## COORDINATOR_TECHNICAL

未归类的批次级技术异常。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

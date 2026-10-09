# Case Runtime capability 错误

只在响应指向本页时读取对应错误章节。

<a id="error-capability-catalog-invalid"></a>
## CAPABILITY_CATALOG_INVALID

冻结能力目录缺失或完整性无效。

**可重试：** 否

**处理：** 保留 execution 和能力目录文件进行技术排障，不覆盖已有目录。

<a id="error-capability-unknown"></a>
## CAPABILITY_UNKNOWN

能力引用未发布或不在当前冻结目录。

**可重试：** 是

**处理：** 调用 queryCapabilities，并原样使用目录返回的 capabilityRef。

<a id="error-capability-scope-mismatch"></a>
## CAPABILITY_SCOPE_MISMATCH

能力引用属于其他 execution。

**可重试：** 否

**处理：** 使用当前 execution 的 queryCapabilities 返回的 capabilityRef。

<a id="error-capability-input-invalid"></a>
## CAPABILITY_INPUT_INVALID

能力输入不符合冻结 definition 的 Schema。

**可重试：** 是

**处理：** 读取 capabilityRef 对应 definition，按 issues 修正 input 一次。

<a id="error-capability-execution-failed"></a>
## CAPABILITY_EXECUTION_FAILED

能力模块明确返回调用失败。

**可重试：** 是

**处理：** 读取 invocation 和 technicalFact，修复明确的外部条件后再决定是否调用。

<a id="error-capability-outcome-unknown"></a>
## CAPABILITY_OUTCOME_UNKNOWN

能力调用可能已送达，但结果无法确认。

**可重试：** 否

**处理：** 不要自动重放；按用例需要查询外部状态或观察 App，再决定是否重新设置。

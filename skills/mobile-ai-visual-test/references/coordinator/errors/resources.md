# Coordinator resources 错误

只在响应指向本页时读取对应错误章节。

<a id="error-resource-unknown"></a>
## RESOURCE_UNKNOWN

资源引用未发布。

**可重试：** 否

**处理：** 使用同一 Facade 已返回的完整 ref。

<a id="error-resource-scope-mismatch"></a>
## RESOURCE_SCOPE_MISMATCH

资源不属于当前 run。

**可重试：** 否

**处理：** 使用返回该 ref 的绑定 command。

<a id="error-resource-integrity-invalid"></a>
## RESOURCE_INTEGRITY_INVALID

资源权威产物完整性校验失败。

**可重试：** 否

**处理：** 保留原始文件与引用，排查数据损坏。

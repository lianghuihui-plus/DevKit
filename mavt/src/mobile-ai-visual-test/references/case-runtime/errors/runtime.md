# Case Runtime runtime 错误

只在响应指向本页时读取对应错误章节。

<a id="error-resource-integrity-invalid"></a>
## RESOURCE_INTEGRITY_INVALID

已发布资源缺失或完整性校验失败。

**可重试：** 否

**处理：** 保留现场并报告资源完整性故障。

<a id="error-resource-format-unsupported"></a>
## RESOURCE_FORMAT_UNSUPPORTED

资源声明的内容格式不受支持或与文件格式冲突。

**可重试：** 否

**处理：** 保留 Scene 中其余可用资源，并根据 resourceDiagnostics 排查采集格式。

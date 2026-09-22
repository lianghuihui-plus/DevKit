# Coordinator batch 错误

只在响应指向本页时读取对应错误章节。

<a id="error-batch-blocked"></a>
## BATCH_BLOCKED

批次已阻塞。

**可重试：** 否

**处理：** 读取诊断并保留终态。

<a id="error-coordinator-technical"></a>
## COORDINATOR_TECHNICAL

Coordinator 技术异常。

**可重试：** 否

**处理：** 读取诊断并恢复外部条件。

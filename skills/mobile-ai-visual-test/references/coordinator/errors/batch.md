# Coordinator batch 错误

只在响应指向本页时读取对应错误章节。

<a id="error-batch-blocked"></a>
## BATCH_BLOCKED

批次存在不可自动恢复的终态阻塞。

**可重试：** 否

**处理：** 读取 facts 和 diagnostic 定位阻塞阶段；保留终态，只有外部条件确实修复后才创建新的 run。

<a id="error-coordinator-technical"></a>
## COORDINATOR_TECHNICAL

未归类的批次级技术异常。

**可重试：** 否

**处理：** 使用 diagnostic.stage、logRefs 和 resourceFacts 排障；恢复后从当前状态允许的 Facade 方法继续。

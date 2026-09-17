# Case Runtime knowledge-recovery 错误

只在响应指向本页时读取对应错误章节。

<a id="error-knowledge-query-unknown"></a>
## KNOWLEDGE_QUERY_UNKNOWN

知识 queryId 不存在或不属于当前 execution。

**可重试：** 是

**处理：** 先调用 knowledge(query) 创建查询，并使用该响应返回的 queryId 复核候选。

<a id="error-knowledge-review-invalid"></a>
## KNOWLEDGE_REVIEW_INVALID

知识候选复核不满足当前 query 约束。

**可重试：** 是

**处理：** 逐条覆盖当前 query 返回的候选并给出适用性原因，再提交同一 queryId。

<a id="error-app-initial-state-unavailable"></a>
## APP_INITIAL_STATE_UNAVAILABLE

授权的初始状态准备未完成。

**可重试：** 是

**处理：** 读取 technical facts 确认制品、设备或平台准备失败原因；完成技术处置后重试同一 recover.targetState。

<a id="error-case-runtime-technical"></a>
## CASE_RUNTIME_TECHNICAL

未归类的 execution 技术异常。

**可重试：** 否

**处理：** 读取 technical.stage、logRefs 和 resourceFacts 排障；恢复后先 observe 核验现场，再回到原业务节点。

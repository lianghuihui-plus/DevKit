# Case Runtime 错误目录

错误响应只返回本次失败原因、相关动态事实和本页锚点；调用签名见服务索引。

<a id="error-agent-input-invalid"></a>
## AGENT_INPUT_INVALID

请求结构、类型或条件字段不合法。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-agent-input-stalled"></a>
## AGENT_INPUT_STALLED

同类输入错误连续发生，停止自动猜测。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

<a id="error-protocol-mismatch"></a>
## PROTOCOL_MISMATCH

Prompt、文档、客户端或 execution 协议不一致。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

<a id="error-binding-invalid"></a>
## BINDING_INVALID

Execution 或 dispatch 绑定无效。

**可重试：** 否

**处理：** 读取 facts.technical.code：sequence 不匹配时原样复用当前 Loader/Brief 中的 command；只有 HANDOFF_REPLACED 才表示该 dispatch 已被真实 continuation 取代；HANDOFF_NOT_CLAIMED 表示 Loader 尚未成功 claim。

<a id="error-scene-required"></a>
## SCENE_REQUIRED

当前方法需要 Scene，但 execution 尚无 Scene。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-scene-changed"></a>
## SCENE_CHANGED

动作所依据的 Scene 已不是当前 Scene。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-action-not-available"></a>
## ACTION_NOT_AVAILABLE

ActionRef 对当前 Scene 不成立。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-action-input-invalid"></a>
## ACTION_INPUT_INVALID

动作输入缺失、越界或包含不支持字段。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-visual-inspection-required"></a>
## VISUAL_INSPECTION_REQUIRED

当前视觉动作或结论要求先登记图片事实。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-case-flow-required"></a>
## CASE_FLOW_REQUIRED

当前 execution 尚无 Case Flow。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-case-flow-revision-conflict"></a>
## CASE_FLOW_REVISION_CONFLICT

Case Flow baseRevision 不是当前 revision。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-case-flow-context-invalid"></a>
## CASE_FLOW_CONTEXT_INVALID

flowContext 的节点或分支不属于当前 Case Flow revision。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-expectation-unknown"></a>
## EXPECTATION_UNKNOWN

checkNodeRef 不属于当前 Case Flow 的 CHECK 节点。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-record-result-invalid"></a>
## RECORD_RESULT_INVALID

验证结果缺少有效证据或字段不符合当前验证点。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-evidence-reference-invalid"></a>
## EVIDENCE_REFERENCE_INVALID

Scene、知识、技术或滚动证据引用无效。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-knowledge-query-unknown"></a>
## KNOWLEDGE_QUERY_UNKNOWN

知识 queryId 不存在或不属于当前 execution。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-knowledge-review-invalid"></a>
## KNOWLEDGE_REVIEW_INVALID

知识候选复核不满足当前 query 约束。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-app-initial-state-unavailable"></a>
## APP_INITIAL_STATE_UNAVAILABLE

授权的初始状态准备未完成。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-action-outcome-unknown"></a>
## ACTION_OUTCOME_UNKNOWN

动作可能已经投递，禁止自动重放。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

<a id="error-case-result-incomplete"></a>
## CASE_RESULT_INCOMPLETE

Ledger 仍有 unresolved 或 conflicts。

**可重试：** 是

**处理：** 根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。

<a id="error-time-limit"></a>
## TIME_LIMIT

已停止新的设备动作。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

<a id="error-case-runtime-technical"></a>
## CASE_RUNTIME_TECHNICAL

未归类的 execution 技术异常。

**可重试：** 否

**处理：** 保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。

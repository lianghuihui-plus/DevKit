# Case Runtime 错误路由

只定位当前响应的 `documentationRef`；完整原因和恢复动作位于对应分组页。

<a id="error-agent-input-invalid"></a>- [`AGENT_INPUT_INVALID`](errors/transport.md#error-agent-input-invalid)：请求结构、类型或条件字段不合法。
<a id="error-agent-input-stalled"></a>- [`AGENT_INPUT_STALLED`](errors/transport.md#error-agent-input-stalled)：同类输入错误连续发生，停止自动猜测。
<a id="error-protocol-mismatch"></a>- [`PROTOCOL_MISMATCH`](errors/transport.md#error-protocol-mismatch)：Prompt、文档、客户端或 execution 协议不一致。
<a id="error-binding-invalid"></a>- [`BINDING_INVALID`](errors/transport.md#error-binding-invalid)：Execution 或 dispatch 绑定无效。
<a id="error-scene-required"></a>- [`SCENE_REQUIRED`](errors/scene-action.md#error-scene-required)：当前方法需要 Scene，但 execution 尚无 Scene。
<a id="error-scene-changed"></a>- [`SCENE_CHANGED`](errors/scene-action.md#error-scene-changed)：动作所依据的 Scene 已不是当前 Scene。
<a id="error-action-not-available"></a>- [`ACTION_NOT_AVAILABLE`](errors/scene-action.md#error-action-not-available)：ActionRef 对当前 Scene 不成立。
<a id="error-action-input-invalid"></a>- [`ACTION_INPUT_INVALID`](errors/scene-action.md#error-action-input-invalid)：动作输入缺失、越界或包含不支持字段。
<a id="error-visual-inspection-required"></a>- [`VISUAL_INSPECTION_REQUIRED`](errors/scene-action.md#error-visual-inspection-required)：当前视觉动作或结论要求先登记图片事实。
<a id="error-case-flow-required"></a>- [`CASE_FLOW_REQUIRED`](errors/flow-result.md#error-case-flow-required)：当前 execution 尚无 Case Flow。
<a id="error-case-flow-revision-conflict"></a>- [`CASE_FLOW_REVISION_CONFLICT`](errors/flow-result.md#error-case-flow-revision-conflict)：Case Flow baseRevision 不是当前 revision。
<a id="error-case-flow-context-invalid"></a>- [`CASE_FLOW_CONTEXT_INVALID`](errors/flow-result.md#error-case-flow-context-invalid)：flowContext 的节点或分支不属于当前 Case Flow revision。
<a id="error-case-flow-node-identity-changed"></a>- [`CASE_FLOW_NODE_IDENTITY_CHANGED`](errors/flow-result.md#error-case-flow-node-identity-changed)：Case Flow 节点 ref 被用于不同含义。
<a id="error-case-flow-edge-identity-changed"></a>- [`CASE_FLOW_EDGE_IDENTITY_CHANGED`](errors/flow-result.md#error-case-flow-edge-identity-changed)：Baseline Flow 边 ref 的端点或条件被改写。
<a id="error-expectation-unknown"></a>- [`EXPECTATION_UNKNOWN`](errors/flow-result.md#error-expectation-unknown)：checkNodeRef 不属于可处置的 CHECK 节点。
<a id="error-record-result-invalid"></a>- [`RECORD_RESULT_INVALID`](errors/flow-result.md#error-record-result-invalid)：验证结果缺少有效证据或字段不符合当前验证点。
<a id="error-evidence-reference-invalid"></a>- [`EVIDENCE_REFERENCE_INVALID`](errors/flow-result.md#error-evidence-reference-invalid)：Scene、知识、技术或滚动证据引用无效。
<a id="error-knowledge-query-unknown"></a>- [`KNOWLEDGE_QUERY_UNKNOWN`](errors/knowledge-recovery.md#error-knowledge-query-unknown)：知识 queryId 不存在或不属于当前 execution。
<a id="error-knowledge-review-invalid"></a>- [`KNOWLEDGE_REVIEW_INVALID`](errors/knowledge-recovery.md#error-knowledge-review-invalid)：知识候选复核不满足当前 query 约束。
<a id="error-app-initial-state-unavailable"></a>- [`APP_INITIAL_STATE_UNAVAILABLE`](errors/knowledge-recovery.md#error-app-initial-state-unavailable)：授权的初始状态准备未完成。
<a id="error-action-outcome-unknown"></a>- [`ACTION_OUTCOME_UNKNOWN`](errors/scene-action.md#error-action-outcome-unknown)：动作可能已经投递，禁止自动重放。
<a id="error-plan-invalid"></a>- [`PLAN_INVALID`](errors/plan.md#error-plan-invalid)：命令计划不满足步数、时限、引用或定位类型约束。
<a id="error-plan-step-failed"></a>- [`PLAN_STEP_FAILED`](errors/plan.md#error-plan-step-failed)：计划在指定步骤发生确定性技术失败。
<a id="error-plan-submission-conflict"></a>- [`PLAN_SUBMISSION_CONFLICT`](errors/plan.md#error-plan-submission-conflict)：同一 submissionId 对应了不同的规范化请求。
<a id="error-plan-record-incomplete"></a>- [`PLAN_RECORD_INCOMPLETE`](errors/plan.md#error-plan-record-incomplete)：计划快照缺失、未终结或摘要校验失败。
<a id="error-locator-unsupported"></a>- [`LOCATOR_UNSUPPORTED`](errors/plan.md#error-locator-unsupported)：当前 Runtime 不支持所声明的定位类型。
<a id="error-target-not-found"></a>- [`TARGET_NOT_FOUND`](errors/plan.md#error-target-not-found)：声明的 Scene、控件或定位目标不存在。
<a id="error-plan-check-failed"></a>- [`PLAN_CHECK_FAILED`](errors/plan.md#error-plan-check-failed)：技术检查无法执行或谓词不受支持。
<a id="error-plan-action-outcome-unknown"></a>- [`PLAN_ACTION_OUTCOME_UNKNOWN`](errors/plan.md#error-plan-action-outcome-unknown)：计划动作可能已投递，结果未知。
<a id="error-plan-timeout"></a>- [`PLAN_TIMEOUT`](errors/plan.md#error-plan-timeout)：计划未能在声明的有限时限内完成。
<a id="error-case-result-incomplete"></a>- [`CASE_RESULT_INCOMPLETE`](errors/flow-result.md#error-case-result-incomplete)：Ledger 仍有 unresolved 或 conflicts。
<a id="error-time-limit"></a>- [`TIME_LIMIT`](errors/flow-result.md#error-time-limit)：已停止新的设备动作。
<a id="error-case-runtime-technical"></a>- [`CASE_RUNTIME_TECHNICAL`](errors/knowledge-recovery.md#error-case-runtime-technical)：未归类的 execution 技术异常。

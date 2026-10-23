# Case Runtime flow-result 错误

只在响应指向本页时读取对应错误章节。

<a id="error-case-flow-required"></a>
## CASE_FLOW_REQUIRED

当前 execution 尚无 Case Flow。

**可重试：** 是

**处理：** 读取原始用例并调用 plan 创建完整 Case Flow，然后从 entryNodeRef 开始执行。

<a id="error-case-flow-revision-conflict"></a>
## CASE_FLOW_REVISION_CONFLICT

Case Flow baseRevision 不是当前 revision。

**可重试：** 是

**处理：** 读取响应中的当前 Case Flow revision，合并仍需要的调整理由后基于该 revision 重新提交。

<a id="error-case-flow-context-invalid"></a>
## CASE_FLOW_CONTEXT_INVALID

flowContext 的节点或分支不属于当前 Case Flow revision。

**可重试：** 是

**处理：** 使用当前 Case Flow 返回的 nodeRef 和 edgeRef；不要复用已 retired 的引用。

<a id="error-case-flow-node-identity-changed"></a>
## CASE_FLOW_NODE_IDENTITY_CHANGED

Case Flow 节点 ref 被用于不同含义。

**可重试：** 是

**处理：** 保留 Baseline 节点和既有 CHECK 的原始含义；现场适配或语义修正使用新的节点 ref 后重新提交。

<a id="error-case-flow-edge-identity-changed"></a>
## CASE_FLOW_EDGE_IDENTITY_CHANGED

Baseline Flow 边 ref 的端点或条件被改写。

**可重试：** 是

**处理：** 保留 Baseline 边的 from、to 和 condition；分支语义变化时使用新的边 ref 后重新提交。

<a id="error-expectation-unknown"></a>
## EXPECTATION_UNKNOWN

checkNodeRef 不属于可处置的 CHECK 节点。

**可重试：** 是

**处理：** 使用 Baseline CHECK 或最终 Working Flow 中仍活跃的补充 CHECK；已退休的补充检查点只能保留历史结果。

<a id="error-record-result-invalid"></a>
## RECORD_RESULT_INVALID

验证结果缺少有效证据或字段不符合当前验证点。

**可重试：** 是

**处理：** 按响应 issues 补齐 actual 和匹配当前验证类型的证据；证据不足时使用 INCONCLUSIVE。

<a id="error-evidence-reference-invalid"></a>
## EVIDENCE_REFERENCE_INVALID

Scene、知识、技术或滚动证据引用无效。

**可重试：** 是

**处理：** 只引用当前 execution 已登记并由 Runtime 返回的证据 ref；缺失时先采集或登记事实。

<a id="error-case-result-incomplete"></a>
## CASE_RESULT_INCOMPLETE

Ledger 仍有 unresolved 或 conflicts。

**可重试：** 是

**处理：** 逐项处置全部 Baseline CHECK 和最终活跃的补充 CHECK；可用 PASS、FAIL、BLOCKED、INCONCLUSIVE、条件检查的 NOT_APPLICABLE，或提供理由的 WAIVED。

<a id="error-case-final-review-required"></a>
## CASE_FINAL_REVIEW_REQUIRED

最终复核未确认或快照已更新。

**可重试：** 是

**处理：** 重新阅读 originalCase 和最新 checkpointLedger，补齐遗漏 CHECK 并成功记录结果；确认完整业务约束后，使用最新 finalReviewToken、Agent verdict 和 sourceCoverageConfirmed:true 提交 finish.finalReview。

<a id="error-result-correction-required"></a>
## RESULT_CORRECTION_REQUIRED

结果修改尚未成功，旧结果不能用于收口。

**可重试：** 是

**处理：** 按 pendingCheckNodeRefs 修正 recordResult 的参数或证据，成功重提交对应 CHECK；* 表示无法识别先前请求的 CHECK，请成功重提交正确结果。不得通过摘要宣称修改已生效。

<a id="error-case-final-verdict-mismatch"></a>
## CASE_FINAL_VERDICT_MISMATCH

Agent 明确结论与最新 ledger 聚合不一致。

**可重试：** 是

**处理：** 核对最新 CHECK 结果；如遗漏业务约束，先补齐 CHECK 和证据并成功记录；只有确认原文覆盖与聚合一致后再提交 finalReview。

<a id="error-time-limit"></a>
## TIME_LIMIT

已停止新的设备动作。

**可重试：** 否

**处理：** 不再执行设备动作；使用已有证据收口可判断项，并披露未完成项和时间限制。

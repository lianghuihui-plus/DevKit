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

<a id="error-expectation-unknown"></a>
## EXPECTATION_UNKNOWN

checkNodeRef 不属于当前 Case Flow 的 CHECK 节点。

**可重试：** 是

**处理：** 从当前 Case Flow 选择现存 CHECK 节点引用；如检查点确需变更，先用 plan 记录理由并修订。

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

**处理：** 读取未解决 CHECK 列表，补充观察或结果；无法形成确定判断时记录 INCONCLUSIVE 后再次 finish。

<a id="error-time-limit"></a>
## TIME_LIMIT

已停止新的设备动作。

**可重试：** 否

**处理：** 不再执行设备动作；使用已有证据收口可判断项，并披露未完成项和时间限制。

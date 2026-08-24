# 失败与结果策略

业务 verdict 与执行状态分开表达：

- `PASS`：原始 requirement 已满足；依据为当前直接证据或适用知识。
- `FAIL`：当前证据明确不满足原始 requirement，且疑似失败调查已完成。
- `INCONCLUSIVE`：证据或原文不足以可靠判断，不能伪造 PASS/FAIL。
- `BLOCKED`：客观技术或环境条件阻止继续，并保留已取得的业务事实。

executionStatus 表达 `COMPLETED`、`STOPPED_BY_BUDGET`、`TECHNICALLY_BLOCKED` 等执行完整性，不替代 verdict。达到 30 分钟只停止新设备调用；若已有充分且最新的证据，仍可形成 PASS 或 FAIL。若没有取得当前可用观察，只能形成带 `observationUnavailable` 和明确证据缺口的 `INCONCLUSIVE + STOPPED_BY_BUDGET`。

动作参数错误、授权过期、目标绑定变化和证据校验失败由脚本拒绝，返回可修正错误，不直接裁决产品 FAIL。App crash 作为产品事实保留；是否与当前 requirement 相关以及最终 verdict 由 Agent 根据恢复后的当前证据判断。

PASS 和 FAIL 都必须先用当前 understanding、当前 warmSessionGeneration 的观察显式建立起点。PASS 必须完成当前计划的全部检查点：观察型检查点可直接复用 `mark-start` 的当前观察，`requiredAction=true` 的检查点必须同时存在动作和动作后观察。FAIL 不要求机械执行后续检查点；当当前观察或相关 PRODUCT incident 已形成充分负向证据，并完成知识调查与 verdictReview 后可以提前结束。

FAIL、INCONCLUSIVE 或业务相关 BLOCKED 前必须存在 verdictReview，至少包含：原文 sourceRef 复核、当前可用 observation、恢复尝试或不恢复理由、knowledgeQuery 引用、剩余不确定性和结论理由。知识查询可以在任意活动阶段执行，零命中是有效调查结果。纯环境初始化失败可使用技术性 BLOCKED 例外。

## 无人值守收敛

- 用例原文歧义、目标不明确或证据不足时，不询问用户，形成可解释的 `INCONCLUSIVE`。
- 缺少账号、验证码、授权或外部依赖时，不询问用户，形成技术性或业务相关 `BLOCKED`。
- 上述 case 结果成功 finalize 和 commit 后，批量执行继续处理下一 case。
- bootstrap 失败、共享设备失联、binding 漂移、暖会话不可恢复或批次状态损坏时，自动停止批次并报告最后状态；不得把批次挂起等待用户答复。

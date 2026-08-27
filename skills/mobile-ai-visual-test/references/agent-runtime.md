# Agent Runtime

每个 case 使用独立 Agent session。协调器根据 `scripts/batch.js start` 返回的 `request` 创建 session；session 只读取 request 绑定的 execution、source snapshot、Skill contract 和知识 roots，不继承协调器推理或其他 case 对话。

execution 和 CaseAgentRequest 都必须绑定原始 `executionRequestSha`、冻结 target 快照、case-executor/coordinator protocol SHA 和 implementationSha，执行策略固定为 `interactionPolicy=UNATTENDED`、`userInteraction=forbidden`。Runtime 不提供等待用户状态；Agent 遇到歧义或缺少外部条件时按结果契约收尾，不能请求用户介入。

Runtime 使用 execution 内的逻辑 sessionId、batchId、implementationSha 和 warmSessionGeneration 绑定请求与结果。宿主 session 标识只用于平台调度，不能改写磁盘契约。session 中断时先由 `batch reconcile` 恢复冻结的内部事务，再从同一 request 和磁盘事实创建新的隔离 session；不得自动重放结果不确定的动作。

同一 case 发生受控 App recovery 时不更换逻辑 session。协调器推进 warmSessionGeneration，同步重绑定 execution、Runtime 和当前 Agent request，按原 generation 归档旧 request，并生成新的 requestSha；恢复前 observation 不能再建立起点、授权动作或支撑当前结论，Agent 随后通过同一白名单重新观察现场。

需要恢复 App 时，Case Agent 通过 `request-recovery` 只提交原因。Facade 自动冻结当前 execution、活动检查点和证据：Agent 主动重启使用当前可用 observation，事故恢复可以使用状态变化后的不可用 observation，首次观察前发生技术故障时使用失败 operation。原文明示必须冷启动时提交 `SOURCE_REQUIRED_COLD_START`，Facade 从活动检查点关联 requirement 自动绑定 sourceRef，因此可在首次观察前完成恢复且不生成事故。协调器收到 `RECOVER_APP` 后执行受控恢复，并在新隔离 session 中继续同一 execution。

Case Agent 调用 `conclude` 后由 Facade 生成并输出 AgentResult，同时落盘为 `agent/result.json`；CLI 在返回前记录成功 conclude attempt。协调器核对 request、协议、实现、代次、result/metrics 和知识快照，再调用 batch commit 释放逻辑 session，随后冻结报告依赖的 `artifact-manifest.json`、发布 completion 并推进下一个 case。若 conclude 已完成 finalize 但 AgentResult 尚未落盘，协调器只从冻结产物做确定性修复，不重新执行用例。

implementationSha 不一致时拒绝续写。代码切换、完整回退或平台实现变化后必须创建新 batch 和新 execution。

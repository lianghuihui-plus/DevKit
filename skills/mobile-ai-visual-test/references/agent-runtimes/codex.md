# Codex Host 映射

批次协调器在 Codex 中为每个 case 创建一个新的独立任务或子 Agent，提示中只提供 `request.json` 路径、Skill root 和“按 case-executor contract 执行”的要求。不要复制当前对话、上一 case 结果或截图。

等待 Agent 返回 `conclude` 生成的 AgentResult，或返回 `request-recovery` 生成的控制请求。控制请求出现时调用 `batch.js reconcile`，按 `RECOVER_APP` 中的 `recoveryRequest` 执行 `batch.js recover`，然后从更新后的同一 request 创建新的隔离 Agent。任务中断但 execution 未 finalized 时，先调用 `reconcile` 自动恢复冻结事务，再创建新的隔离 Agent继续；不要让新 Agent 继承旧 Agent 的对话摘要。execution 已 finalized 但 AgentResult 缺失时，由协调器从冻结产物修复，不重新运行用例。

同一时间只运行一个 case Agent。Agent 完成并由 `scripts/batch.js commit` 发布 completion 后，才创建下一 case Agent。

协调器完成环境确认后应结束当前推进动作，直到用户在 Codex 中再次明确给出执行范围。执行请求一旦创建，后续 case 任务均为无人值守：不要调用用户输入工具，不要在消息中索取补充信息；按结果和批次停止策略自行收敛。

# Codex Host 映射

批次协调器在 Codex 中为每个 case 创建一个新的独立任务或子 Agent，提示中只提供 `request.json` 路径、Skill root 和“按 case-executor contract 执行”的要求。不要复制当前对话、上一 case 结果或截图。

Case Agent 宿主必须只暴露 `allowedEntrypoints` 中的九个入口和 `requiredResources` 中的只读资源，不暴露 Batch、平台 adapter、`hdc`、`adb`、Appium 或通用 Shell。若当前 Codex 宿主不能配置工具白名单，应明确记录为“协议隔离”，不得声称已经实现强权限隔离；不要使用同一文件权限域内可读取的 token 模拟安全边界。

等待 Agent 返回 `conclude` 生成的 AgentResult，或返回 `request-recovery` 生成的控制请求。控制请求出现时调用 `batch.js reconcile`，按 `RECOVER_APP` 中的 `recoveryRequest` 执行 `batch.js recover`，然后从更新后的同一 request 创建新的隔离 Agent。恢复后的 Agent 首次调用 `status`，读取 `continuation` 和 `semanticContext` 后保留既有 understanding、plan 与 requirement ID，从 PREPARE 重新观察；不得重新执行初始化理解和计划。任务中断但 execution 未 finalized 时，先调用 `reconcile` 自动恢复冻结事务，再创建新的隔离 Agent并按同一方式续接；不要让新 Agent 继承旧 Agent 的对话摘要。execution 已 finalized 但 AgentResult 缺失时，由协调器先封存残留入口 attempt，再从冻结产物修复，不重新运行用例。

同一时间只运行一个 case Agent。Agent 完成并由 `scripts/batch.js commit` 发布 completion 后，才创建下一 case Agent。

协调器完成环境确认后应结束当前推进动作，直到用户在 Codex 中再次明确给出执行范围。执行请求一旦创建，后续 case 任务均为无人值守：不要调用用户输入工具，不要在消息中索取补充信息；按结果和批次停止策略自行收敛。

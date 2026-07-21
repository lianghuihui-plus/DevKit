# Codex Host Adapter

Codex 的会话工具属于宿主能力，普通 Node 脚本不能直接调用。因此 Codex 主 Agent 是薄 Host Adapter；所有业务状态仍由 `scripts/agent-runtime.js` 管理。

## 机械映射

协调器循环调用 Runtime Core 的 `next`，只执行返回的一个 operation：

| Runtime operation | Codex 宿主动作 | apply 结果 |
| --- | --- | --- |
| `OPEN_SESSION` | 使用 operation 提供的 `providerTaskName`，先复用同名 Agent，否则创建不继承父任务历史的独立子 Agent | `sessionId` 使用宿主返回的 Agent 标识 |
| `AWAIT_RESULT` | 只在 operation 的 `remainingMs` 内等待指定子 Agent | `result` 必须是完整 CaseAgentResult JSON；到期返回 `timedOut=true` |
| `INTERRUPT_SESSION` | 中断指定子 Agent | 返回 `ok` 和失败原因 |
| `RELEASE_SESSION` | 确认该子 Agent 已结束，不再发送消息 | 返回 `ok=true` |

Codex 子 Agent 会继承父任务的工作区和权限配置，所以权限隔离不能靠子 Agent 创建参数实现；本 Skill 通过最小 SkillContract 白名单和运行时硬守卫限制其行为。

## 子任务消息

```text
你是 mobile-ai-visual-test 的单用例执行 Agent。
只处理 request.json 指定的 execution。
完整读取 skillContract.requiredResources，并先验证 protocolSha 和 implementationSha。
只能使用 skillContract.allowedEntrypoints。
逐轮执行 execute-next-work next/decide；完成后用 build-case-agent-result 返回单个 JSON。

requestPath: <absolute path>
```

不要把父会话、旧 case 截图、完整 timeline 或其他 case 结果复制到消息中。子 Agent 自己从 requestPath 和当前 execution 的事实源读取。

## 往返规则

- 每次只处理 Runtime Core 返回的一个 operationId，`apply` 成功前不得请求下一操作。
- `next` 返回同一个 operationId 时复用已有宿主动作结果，不重复创建或等待。
- `AWAIT_RESULT` 必须使用 Runtime 给出的 `remainingMs` 作为硬等待上限；到期后由 Core 生成中断和释放操作。
- 子 Agent 的自然语言说明不是结果；只把结构化 CaseAgentResult 交给 Core。CaseAgentResult 的 provider 由结果构造器从 request 读取，Host Adapter 和子 Agent 都不得改写。
- Host Adapter 不直接写 `agentRuntime`、runtime.json、response.json、validation.json 或 batch 文件。
- 任何失败先 `apply ok=false`；Core 负责失败码、execution 收尾和持久化。
- `RELEASE_SESSION` 失败时按 Core 返回的新 operationId 重试，最多三次；Core 进入 `RELEASE_FAILED` 后停止宿主操作并让批次固化 `AGENT_RUNTIME_RELEASE_FAILED`，不得继续下一 case。

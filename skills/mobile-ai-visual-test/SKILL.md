---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；由 Agent 自主理解目标、建立起点、调整计划、执行与断言，并支持本地知识调查、批次暖会话及 HarmonyOS、Android、iOS 平台适配。
---

# 移动端 AI 视觉测试

## 核心原则

1. 任意非空文本都可执行；框架不校验用例格式、步骤数量或表达质量。
2. Agent 只负责业务理解、检查点、动作选择、异常判断、知识适用性和结论。
3. 框架自动处理 revision、authorization、operationId、证据绑定、动作后观察、复核结构和结果产物；这些协议细节不交给 Agent 维护。
4. 计划是可修订检查点集合，不是固定点击脚本；现场需要多一步、少一步或换路径时继续自主处理，不因计划偏差自动失败。
5. 疑似异常不直接失败；先复核现场，并按结论规则查询本地知识。
6. 只保留设备/App 绑定、真实证据、单用例 30 分钟时限、事务恢复和产物完整性等精确约束，不限制业务动作副作用。
7. 同批次只在 bootstrap 冷启动一次 App；用例间复用暖状态，但每个用例使用独立 execution、Agent session，并重新建立自己的起点。
8. 环境确认与执行授权分离；批量执行开始后全程无人值守，不向用户提问或等待回复。

## 角色资料

批次协调器读取：

- `references/workflow.md`
- `references/interfaces.md`
- `references/environment-probing.md`
- `references/failure-policy.md`
- `references/case-format.md`
- `references/agent-runtime.md`
- Codex 平台再读取 `references/agent-runtimes/codex.md`

Case Agent 只读取当前 contract 的 `requiredResources`：

- `SKILL.md`
- `references/agent-execution.md`
- `references/knowledge.md`

每个 execution 冻结 `agent/contract.json`，它是 Case Agent 的命令、字段、枚举和示例权威来源。不要读取实现代码或其他文档猜测协议。

## 人工与批次流程

1. `scripts/workspace.js --cwd <workspace>` 校验或初始化空目录/既有工作空间。
2. `scripts/import-case.js <input-file> --workspace <workspace>` 导入任意非空文本；空文本在创建 case 前返回 `CASE_INPUT_EMPTY`。
3. 探测并准备环境，向用户展示设备、App 和入口；用户确认后调用 `scripts/environment.js confirm`，然后停止。
4. 等待用户另行明确说明单独执行哪个用例，或批量执行哪些用例及顺序；再用 `scripts/execution-request.js create` 冻结无人值守请求。
5. `scripts/batch.js init` 后只执行一次 `bootstrap`，随后串行 `reconcile -> start -> 独立 Case Agent -> commit`。
6. App 意外退出或原文明示冷启动时，Case Agent 通过统一控制请求交给协调器执行受控 `recover`；普通用例切换不重启 App。
7. 批次结束后调用一次 `scripts/render-index.js` 重建详情和首页。

## Case Agent 流程

正式入口只有：

```text
status
understand
inspect
step
mark-start
request-recovery
investigate
conclude
```

正常主链：

```text
understand
-> inspect PREPARE
-> step PREPARE（按需，建立起点所需的任意业务操作）
-> mark-start
-> step BUSINESS（按需，每次自动采集动作后现场）
-> investigate（按需）
-> conclude
```

- `understand` 提交业务理解和检查点；框架自动生成 understanding/plan revision、turnId、planSha 和检查点状态。
- `inspect` 取得当前截图、控件树精简元素和诊断资料；它不自动确认起点。
- `step` 只提交意图、检查点和语义动作；优先使用 `targetRef`，视觉坐标使用原图 0..1 归一化值。框架自动执行一个动作并采集动作后观察。
- `mark-start` 显式确认最新 PREPARE 现场满足本用例起点，然后进入业务执行。
- `request-recovery` 只在原文明示冷启动、App 意外退出或 Agent 主动判断必须重启时提交原因和触发类型；框架自动补齐 execution、检查点、sourceRef 或现场证据，随后交回协调器恢复。
- `investigate` 查询知识或评估候选适用性；候选本身不能改变结论。
- `conclude` 提交 verdict、summary 和逐 requirement finding；框架自动生成 checkpointFinding、verdictReview、result、metrics 和 AgentResult。

每个成功响应都带最新 `runtimeState`。正常执行直接使用它；只有重连或响应不确定时调用 `status`。内部 step、operation、turn 和知识查询草稿全部由协调器恢复，Case Agent 不组装恢复请求；`controlRequestPending=true` 时结束当前任务，等待协调器恢复后创建新的隔离 Agent。

## 结论规则

- 当前直接证据充分支持 PASS 且无待解释异常时，不强制查询知识。
- FAIL、INCONCLUSIVE 和业务相关 BLOCKED 必须先完成至少一次知识调查。
- 纯技术 BLOCKED 可不查询知识；首次观察前即发生技术阻塞时允许没有 verdictReview，但必须提供技术故障码和逐 requirement 阻塞原因。
- 每个 requirement 必须且只能有一个 finding。PASS 全部为 `SATISFIED`；FAIL 至少一项 `NOT_SATISFIED`；INCONCLUSIVE 至少一项 `UNRESOLVED` 并保留 uncertainties；BLOCKED 至少一项 `BLOCKED`。
- `ok=true` 只表示动作调用完成，不表示断言成立。断言由 Agent 根据动作后真实现场形成。
- PASS 和 FAIL 必须已经显式确认当前起点；观察型检查点可以复用该起点观察，要求实际动作的检查点必须存在动作及动作后观察。FAIL 取得充分负向证据后不强制继续无关检查点。
- 达到 30 分钟后停止新设备调用，但继续恢复冻结事务、知识调查和结论收口；时限本身不自动改写业务 verdict。

## 禁止事项

- 禁止 Case Agent 调用底层 `commit-turn/phase/observe/action/query-knowledge/finalize/result`、平台 adapter、`hdc`、`adb` 或 Appium。
- 禁止并行执行多个移动端 case，或跨 case 复用 Agent session、业务证据和对话上下文。
- 禁止伪造 observation、actionResult、知识候选、result 或 completion。
- 禁止自动重放结果不确定的动作；恢复后旧 observation 只用于审计，必须重新观察并重新确认起点。
- 禁止把用例表达模糊、协议错误或计划变化直接解释为产品 FAIL。
- 禁止在无人值守执行中向用户提问、请求确认或进入等待状态。

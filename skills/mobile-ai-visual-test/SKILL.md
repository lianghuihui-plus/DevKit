---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；由 Agent 自主理解目标、建立起点、调整计划、执行与断言，并支持本地知识调查、批次暖会话及 HarmonyOS、Android、iOS 平台适配。
---

# 移动端 AI 视觉测试

## 核心原则

1. 任意非空文本都可进入执行；框架不校验用例格式、步骤数量或表达质量。
2. Agent 负责业务理解、计划、动作、断言、知识适用性和结论；框架只处理确定性协议、设备调用、证据、事务和产物。
3. 执行计划是可修订的业务检查点集合，不是固定点击脚本；现场路径可以增减动作或改变策略。
4. 用例理解应忠实保留原文语义；发现遗漏或误解时允许修订，修订后必须重新生成计划并重新确认起点。
5. 现场异常不直接判定失败；先复核证据，并按结论规则查询本地知识。
6. 只保留设备与 App 绑定、真实证据、30 分钟单用例时限、事务恢复和产物完整性约束，不限制必要业务动作。
7. 同批次只在 bootstrap 冷启动一次 App；用例间复用暖状态，每个用例使用独立 execution 和 Agent session。
8. 环境确认与执行授权分离；批量执行开始后全程无人值守。
9. 只接受当前协议和当前实现，不转换、改写或兼容旧产物。

## 角色路由

批次协调器读取 `references/workflow.md`、`references/interfaces.md`、`references/environment-probing.md`、`references/failure-policy.md`、`references/case-format.md`、`references/agent-runtime.md`；Codex 运行时再读取 `references/agent-runtimes/codex.md`。

Case Agent 的冻结协议资源包含 `references/agent-execution.md` 和 `references/knowledge.md`，并读取 execution 内的 `agent/request.json`、`agent/contract.json` 和 `source.snapshot.md`。`agent/contract.json` 是命令、Schema、枚举和阶段 guidance 的唯一权威；知识协议只需在进入调查时使用。

## 人工与批次流程

1. 校验或初始化空目录或既有工作空间。
2. 导入任意非空文本并分配稳定用例编号；空文本在创建 case 前返回 `CASE_INPUT_EMPTY`。
3. 探测环境并等待用户确认设备、App 和入口；确认后停止，不自动执行用例。
4. 用户另行按看板编号授权单用例或批量用例及顺序。
5. 协调器执行 `init -> bootstrap -> reconcile -> start -> Case Agent -> commit`，每个 commit 后增量刷新看板。
6. App 意外退出或原文明示冷启动时，Case Agent 提交统一恢复请求，由协调器受控恢复。
7. 批次结束后释放框架托管的平台资源并全量重建看板。

## Case Agent 主链

正式入口只有 `status`、`understand`、`plan`、`inspect`、`step`、`mark-start`、`request-recovery`、`investigate` 和 `conclude`。

正常顺序为：

```text
understand -> plan -> inspect/step PREPARE -> mark-start
-> inspect/step BUSINESS -> investigate（按需）-> conclude
```

- `understand` 忠实提取起点、requirement、必做交互、预期结果和不确定性。无法提取可执行 requirement 时保留空集合并记录 uncertainty。
- `plan` 将每项 requirement 恰好归属到一个检查点；检查点数量由独立执行、取证和判断的业务边界决定。没有 requirement 时提交空计划。
- `inspect` 取得截图、控件树和技术诊断；`step` 执行一个 Agent 选择的动作并自动采集动作后现场。
- `mark-start` 显式确认当前 PREPARE 现场满足本用例起点。
- `investigate` 查询并评估本地知识，入口自动记录调查阶段。
- `conclude` 提交业务结论和原文、恢复语义复核；框架补充引用与客观事实，并生成检查点事实、result、metrics 和 AgentResult。

零 requirement 且计划为空时，`inspect`、`step`、`mark-start` 和 `request-recovery` 均不可用；Agent 只能修订理解与计划、调查知识或以 `INCONCLUSIVE` 收口。

每个成功响应携带轻量 `runtimeState`。只有重连、Recovery 续接或响应不确定时调用 `status`；完整状态提供现有 understanding 和 plan，续接时不得重建。设备阶段和默认活动检查点由框架推导，Agent 不提交 `stage`，仅在 BUSINESS 主动切换检查点时提交 `checkpointRef`。内部 step、operation、turn 和知识查询事务由协调器恢复；`controlRequestPending=true` 时 Case Agent 停止。

## 结论边界

- 当前直接证据充分支持 PASS 且无待解释异常时，不强制查询知识。
- FAIL、INCONCLUSIVE 和业务 BLOCKED 必须完成至少一次知识调查；纯技术 BLOCKED 可不查询。
- 有 requirement 时，每项必须且只能有一个 finding；零 requirement 只能形成 `INCONCLUSIVE + INSUFFICIENT_EVIDENCE`，findings 为空且 uncertainty 非空。
- `ok=true` 只表示动作调用完成。业务断言由 Agent 根据真实现场形成。
- verdictReview 使用最后一次状态变化后的当前观察；Agent 必须为 requirement finding 显式选择当前暖会话代次内对应检查点的有效证据，框架不自动补用最新观察。
- Recovery 前证据不能支持 Recovery 后的当前结论。
- 知识调查绑定当前理解版本、暖会话代次、状态变化边界和当前观察；任一上下文变化后旧调查只保留审计价值。
- PASS 和 FAIL 必须显式确认当前起点；FAIL 取得充分负向证据后不强制继续无关检查点。
- 达到时限后停止新设备调用，但继续恢复事务、知识调查和结论收口。

## 禁止事项

- Case Agent 不调用底层 operation、平台 adapter、`hdc`、`adb` 或 Appium。
- Agent 宿主必须按 Case Agent 的 `allowedEntrypoints` 和只读资源清单限制工具；宿主不支持工具白名单时，本 Skill 只提供协议隔离，不构成强权限隔离。
- 不并行执行移动端 case，不跨 case 复用 Agent session、证据或对话上下文。
- 不伪造 observation、actionResult、知识事实、result 或 completion。
- 不自动重放结果不确定的动作。
- 不把用例表达模糊、协议错误或计划变化解释为产品 FAIL。
- 不在无人值守执行中向用户提问或等待回复。

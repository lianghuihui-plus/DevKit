# Case Agent 自主执行提示词优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 Case Agent 在现场起点与预期不一致时过早收口的问题，使其能够基于当前事实自主调整执行路径，同时保持 Runtime 业务无关且不增加业务门禁。

**Architecture:** 将 Case Agent 的执行规则分成三层：`prompts/case-agent.md` 只定义角色、边界、信息来源和高层执行循环；`references/case-execution-principles.md` 统一定义业务判断、现场适配、证据充分性和结果语义；Runtime 契约与生成文档只描述接口、结构约束、技术事实和技术错误。提示词通过原则赋予 Agent 判断空间，不规定具体导航动作、固定重试次数或业务恢复脚本。

**Tech Stack:** Markdown prompts and references, Node.js CommonJS Agent-facing contracts, generated Runtime Markdown, existing assertion-based contract tests.

**Spec:** 依据 2026-09-22 对 iOS 020 execution 与 Case Agent 提示词体系的审计结论，以及已确认的约束：修改必须通用、增强 Agent 自主性、不增加 Runtime 业务门禁、Runtime 只承担业务无关的基础职责、回归由用户执行。

## Global Constraints

- 不针对“返回上一页”“重新进入作品列表”等单一用例路径编写规则。
- 不增加“必须重试”“必须恢复”“必须查询知识”或“禁止 `NOT_RUN`”等 Runtime 业务门禁。
- Runtime 只校验请求结构、生命周期、引用完整性、技术结果和持久化一致性，不判断业务前置条件是否满足，也不审批 Agent 的业务恢复方案。
- 不新增 Case Agent 能力，不改变 `observe / read / inspect / plan / recordResult / act / runPlan / knowledge / recover / finish` 操作集合。
- 不改变最终 verdict 与 CHECK status 枚举，不改变现有 ledger 聚合规则。
- 不规定恢复动作类型或统一次数；Agent 根据副作用风险、结果是否已知、剩余时间和新获得的信息自主决定。
- 动作结果未知时禁止自动重放、技术失败不能直接报告为产品 FAIL 等安全边界保持不变。
- `prompts/case-agent.md` 与强制读取的 `references/case-execution-principles.md` 合计不得超过当前 10,373 字节基线；重写后不能通过跨文件重复规则消耗同等或更多注意力。
- 每项规范只能有一个权威定义：业务判断只在 `case-execution-principles.md` 完整定义，Prompt 只引用并组织执行，Runtime 与维护文档只陈述本层事实。
- Prompt、原则文档和生成的 Case Runtime 文档会改变 `caseProtocolSha`；`scripts/case-runtime/` 下的实现改动会改变 `runtimeSha`，其中公开契约改动会同时改变两者；`SKILL.md` 会改变 `coordinatorProtocolSha`。发布前必须确认没有仍需继续执行的活动 Coordinator、Batch、Execution 或 Handoff，变更只用于新 execution。
- 本计划不执行 iOS、Android、HarmonyOS 业务回归；回归场景和期望结果交给用户执行。

---

## 1. 问题与根因

### 1.1 直接现象

iOS 020 execution：

`/Users/cm/WorkSpace/UITestWorkspace/MAVT0908-1/cases/020-kittenN作品列表页进行复制作品__ck-77f8714cc3e0/platforms/ios/executions/20260921-223322-116-uunb`

实际调用序列是：

```text
plan -> observe -> inspect(visual) -> finish(notRun)
```

Agent 已识别当前处于错误页面，但没有执行 `act`、`recover` 或修订 Working Flow，直接提交 `NOT_RUN`。前一条用例 019 留下的编辑器状态通过 warm session 进入 020，是现场起点偏移的来源；真正导致过早结束的不是 warm session 本身，而是提示词把“已观察到用例级前置条件不满足”写成了一个过于直接的终止入口。

### 1.2 提示词层根因

1. `prompts/case-agent.md` 当前第 17 条直接把“前置条件不满足”映射为 `finish(mode="notRun")`，没有先要求 Agent 判断当前 execution 权限与能力范围内是否仍存在安全、合理、可验证的继续路径。
2. “独立负责”和“可修订 Case Flow”虽然已经声明，但缺少可执行的自主判断循环，Agent 更容易跟随后续的具体收口规则。
3. 大量 API 使用规则与业务原则混在同一个 17 步列表中，接口操作顺序压过了“根据新事实重新决策”的职责。
4. `knowledge` 被描述为形成业务负向结论前的通用步骤，而 Runtime 方法文档又明确负向结果不强制知识调查，存在规则冲突。
5. 正常动作异常被约束为“一次有限重试”，容易把自主恢复降格为固定模板；同时没有定义何时应换路径、何时应停止无信息增益的重复动作。
6. `references/case-execution-principles.md` 主要讲 Case Flow 建模，缺少结果语义、证据充分性、现场适配和终止判断等真正的执行原则。
7. Brief 的 `initialState.currentAppState: "UNVERIFIED"` 实际表达“没有已完成的准备记录”，不是当前 UI 或业务状态，字段名会诱导 Agent 把准备事实当作现场状态。

## 2. 目标职责划分

| 层级 | 唯一职责 | 应包含 | 不应包含 |
|---|---|---|---|
| `prompts/case-agent.md` | 定义 Case Agent 如何工作 | 角色、权限边界、事实来源、高层执行循环、安全不变量、文档路由 | 完整 API 手册、逐错误教程、固定恢复动作、固定重试次数、重复的结果定义 |
| `references/case-execution-principles.md` | 定义 Agent 如何作业务判断 | 原始语义、Baseline/Working Flow、当前事实适配、证据充分性、知识使用、CHECK 与 verdict 语义、终止原则 | Runtime 字段签名、平台命令、业务用例专属导航 |
| `scripts/case-runtime/agent-facing-contract.js` 及生成文档 | 定义 Runtime 能力和技术约束 | 输入 Schema、引用、生命周期、技术状态、真实结构校验、生成文档 | “应该继续业务还是结束”的判断、恢复方案审批、知识强制要求 |
| `SKILL.md` 与维护文档 | 定义角色协作和框架事实 | Coordinator/Case Agent 分工、Handoff、基础设施与持久化边界 | Case Agent 业务判断规则的第二份完整副本 |

## 3. 目标执行模型

Case Agent 面对每个新 Scene 或技术结果时，统一使用以下循环；这是一套判断框架，不是固定操作序列：

```text
读取事实 -> 识别当前目标与差异 -> 判断是否存在安全、授权、用例范围内的继续路径
         -> 有：调整 Working Flow，执行下一步并重新观察
         -> 无：判断证据能支持哪一种 CHECK 状态或最终结果，再收口
```

核心原则如下：

1. 当前事实与预期条件不一致，是下一次判断的输入，不自动等于终止结论。
2. Agent 先区分“原始用例明确要求且当前无法建立的执行条件”和“只是当前导航位置、临时 UI、历史状态或执行路径与预想不同”。
3. 只要存在安全、已授权、仍属于当前用例目标且可通过后续观察验证的继续路径，Agent 就可以修订 Working Flow 并继续。
4. 恢复不限定为 `recover` operation；普通 `act`、重新观察、重新定位、选择其他安全路径、使用 Runtime 技术恢复或登记框架外技术事实都可能是合法手段。
5. Agent 不重复没有新信息、没有新假设或存在不可接受副作用的同一动作；何时停止由风险、证据、时间和能力共同决定，不由统一重试次数决定。
6. `knowledge` 只在结论依赖 Scene 之外的产品规则、版本差异、账号/配置语义或未知业务约束时使用；负向结论本身不是强制查询条件。
7. 只有当当前 execution 的权限、事实和可用能力内不存在合理继续路径，且已有证据能够说明未进入实际验证的原因时，才使用 `NOT_RUN`。

## 4. 结果语义

### 4.1 CHECK status

Case Agent 通过 `recordResult` 判断 CHECK status；这些状态属于单个检查点，不等同于最终 verdict。

| CHECK status | 使用条件 | 不得用于 |
|---|---|---|
| `PASS` | 当前 CHECK 的业务预期已被可靠 Scene 证据满足 | 仅因流程顺利执行但未验证预期 |
| `FAIL` | 当前 CHECK 的适用业务预期被可靠业务证据明确否定 | 技术动作失败、环境故障、证据不足 |
| `INCONCLUSIVE` | 已进入当前 CHECK 的验证，但证据冲突、模糊或覆盖不足，无法可靠判断 | 已有明确产品不符合证据或明确技术阻塞 |
| `BLOCKED` | 技术、环境或能力问题直接阻止当前 CHECK 继续执行或取得必要证据，并有有效技术事实支撑 | 当前页面不是预想页面但仍存在安全继续路径 |
| `NOT_APPLICABLE` | 原始语义中的条件分支未进入，仅用于 `CONDITIONAL CHECK` | REQUIRED CHECK、执行失败或不想继续验证 |
| `WAIVED` | Agent 基于已有事实明确豁免当前 CHECK，并提交独立理由；报告继续披露该豁免 | 替代恢复、掩盖产品 FAIL、绕过证据不足 |

### 4.2 正常 verdict 聚合

正常收口使用 `finish(mode="complete")`。Agent 不直接提交最终 verdict；Runtime 从最终 ledger 按现有规则聚合：

1. 聚合时忽略 `NOT_APPLICABLE` 和 `WAIVED`。
2. 剩余 CHECK 中存在 `FAIL` 时 verdict 为 `FAIL`。
3. 否则存在 `BLOCKED` 时 verdict 为 `BLOCKED`。
4. 否则存在 `INCONCLUSIVE` 时 verdict 为 `INCONCLUSIVE`。
5. 否则剩余 CHECK 全部为 `PASS` 时 verdict 为 `PASS`。
6. 全部 CHECK 都是 `NOT_APPLICABLE` 或 `WAIVED` 时，保持现有聚合规则，verdict 仍为 `PASS`，报告单独披露相应状态。

### 4.3 用例级 NOT_RUN

`NOT_RUN` 不是 CHECK status，只能通过 `finish(mode="notRun")` 形成用例级 verdict，并且最终结果不包含 CHECK。

只有当用例级必要执行条件在当前 execution 的权限、事实和可用能力内无法建立、没有安全合理的继续路径，并且尚未进入相应业务 CHECK 的验证时，才使用 `NOT_RUN`。采集或检查一个 Scene 本身不等于已经进入业务验证；是否进入验证由 Case Flow、实际目标和已执行行为共同判断，不能由 `sceneObserved` 或 `actionRequested` 事件类型机械推断。

`NOT_RUN` 不得用于可以通过安全路径调整的起点差异，也不得替代已进入验证后的 `FAIL`、`BLOCKED` 或 `INCONCLUSIVE`。

## 5. 文件改动总览

**核心行为文件：**

- Modify: `prompts/case-agent.md`
- Modify: `references/case-execution-principles.md`

**契约与职责一致性：**

- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/runtime-operation-contract.js`
- Modify: `SKILL.md`
- Modify: `references/failure-policy.md`
- Modify: `references/knowledge.md`
- Modify: `references/workflow.md`
- Modify: `docs/architecture.md`

**Brief 事实语义：**

- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/tests/agent-facing-case-runtime.test.js`
- Modify: `scripts/tests/case-runtime.test.js`

**提示词契约维护：**

- Modify: `scripts/tests/architecture-boundaries.test.js`
- Modify: `scripts/tests/agent-capability-contract.test.js`

**通过契约生成器更新，不手工编辑：**

- Regenerate: `references/case-runtime.md`
- Regenerate: `references/case-runtime/methods/plan.md`
- Regenerate: `references/case-runtime/methods/record-result.md`
- Regenerate: `references/case-runtime/methods/finish.md`
- Regenerate: `references/case-runtime/errors/scene-action.md`

---

### Task 1: 重写执行判断原则

**Files:**

- Modify: `references/case-execution-principles.md`

**Interfaces:**

- Consumes: 原始用例、Case Flow、当前 Scene、动作技术结果、知识与证据引用。
- Produces: Case Agent 唯一的业务执行判断原则，不改变任何 Runtime API。

- [ ] 将文档从“Case Flow 建模注意事项”改造成“语义建模、现场适配、证据判断、结果收口”四个明确章节。
- [ ] 保留现有条件作用域、DECISION 与 CONDITIONAL CHECK 的正确规则，但把示例降为解释语义的例子，不让示例暗示唯一执行路径。
- [ ] 增加通用原则：“当前事实与预期不一致是判断输入，不是自动终止条件”。
- [ ] 明确 Baseline Flow 冻结原始用例语义，Working Flow 表达当前 execution 的实际路径；首次计划不是对现场导航路线的不可变承诺。
- [ ] 明确 Agent 可以根据新 Scene、动作效果、环境事实或新理解修订 Working Flow，并记录修订原因。
- [ ] 增加“合理继续路径”判断维度：是否安全、是否已授权、是否仍服务原用例目标、是否可观察验证、是否有可接受副作用、是否能获得新信息。
- [ ] 按第 4 节分别定义 CHECK status、Runtime 正常 verdict 聚合和用例级 `NOT_RUN`，不得把三者重新合并为一组 Agent 可直接选择的最终状态。
- [ ] 明确知识查询是业务规则依赖时的工具，不是所有负向结论的前置仪式。
- [ ] 明确不应重复没有信息增益的动作，同时不规定统一的恢复动作或次数。

### Task 2: 将 Case Agent Prompt 收敛为自主执行循环

**Files:**

- Modify: `prompts/case-agent.md`

**Interfaces:**

- Consumes: Handoff Brief、执行原则、Runtime 短索引及按需方法/错误文档。
- Produces: 更短且优先级清晰的 Case Agent 冻结 prompt。

- [ ] 保留“独立负责一个 execution”、不可伪造框架证据、作用域与破坏性操作边界。
- [ ] 保留启动时完整读取 `case-execution-principles.md`，以及 Runtime 文档按需读取规则。
- [ ] 将当前 17 条顺序规则重构为“理解语义 -> 建立 Baseline -> 观察并执行 -> 根据新事实调整 -> 记录结果 -> 收口”的循环。
- [ ] 在循环中明确：现场不一致时先判断继续路径；存在路径时修订 Working Flow 并继续，不把差异直接映射为 `NOT_RUN`。
- [ ] 删除“准备形成业务负向结论时必须查询 knowledge”的表述，改为只有依赖现场外业务规则时才查询。
- [ ] 删除“优先进行一次有限重试”的固定次数，改为由 Agent 基于结果已知性、副作用、现场适用性、新信息和时间选择有边界的恢复。
- [ ] 保留 `ACTION_OUTCOME_UNKNOWN` 禁止自动重放，以及安全可重放动作必须先确认当前 Scene 仍适用的原则。
- [ ] 保留截图实际查看、视觉登记、动作后读取 Scene 与 `previousAction`、搜索覆盖边界等证据要求。
- [ ] 将逐错误恢复说明缩减为安全不变量；具体错误码的参数和恢复步骤只从 `documentationRef` 读取。
- [ ] 将 `finish(mode="notRun")` 描述改为第 4 节定义，不把“观察到前置条件不满足”单独作为充分条件。

### Task 3: 清理跨文档冲突和重复业务规则

**Files:**

- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/case-runtime/runtime-operation-contract.js`
- Modify: `SKILL.md`
- Modify: `references/failure-policy.md`
- Modify: `references/knowledge.md`
- Modify: `references/workflow.md`
- Modify: `docs/architecture.md`
- Regenerate: `references/case-runtime.md`
- Regenerate: `references/case-runtime/methods/plan.md`
- Regenerate: `references/case-runtime/methods/record-result.md`
- Regenerate: `references/case-runtime/methods/finish.md`
- Regenerate: `references/case-runtime/errors/scene-action.md`

**Interfaces:**

- Consumes: `PUBLIC_CONTRACT` 作为 Runtime 生成文档的唯一来源。
- Produces: Runtime 文档只描述真实接口/技术约束，角色文档不再维护第二套 Case Agent 判断政策。

- [ ] 从 `plan.contextualValidationRules` 移出“如何理解原始用例、如何设计正常 END”这类业务建模原则，只保留 Runtime 实际校验的 revision、ref 身份、CHECK 类型和 ledger 责任。
- [ ] 在 `recordResult` 与 `finish` 文档保留真实结构事实：证据引用有效性、`NOT_APPLICABLE` 仅用于条件检查、`WAIVED` 需要独立理由、全部必需 CHECK 必须处置。
- [ ] 保留“负向结果不强制知识调查”这一 Runtime 事实，并确保核心原则与之相同，不再出现互相冲突的规则。
- [ ] 将内部 `knowledge.whenToUse` 从“负向结论前”改成“结论依赖 Scene 外部业务规则或当前异常无法仅靠现场事实解释时”。
- [ ] 将 `ACTION_EFFECT_MISMATCH` 的恢复说明改成 Agent 自主选择安全且有信息增益的恢复，不写固定次数；继续禁止直接判产品 FAIL。
- [ ] 在 `references/failure-policy.md` 删除固定“一次有限重试”，只保留结果已知/未知与副作用安全边界；同时删除“业务前置条件直接形成 BLOCKED”的重叠定义，使 `BLOCKED`、`INCONCLUSIVE` 和 `NOT_RUN` 与第 4 节一致。
- [ ] 在 `references/knowledge.md` 将“实际结果不符、操作失败或准备形成负向结论时必须调查”改成基于外部业务规则依赖的条件式使用说明；现场证据足以支撑结论时不得为了流程完整性强制查询。
- [ ] 在 `references/workflow.md` 删除用首次 `actionRequested` 或 `sceneObserved` 推断是否进入业务验证的事件启发式；明确普通观察不排除 `NOT_RUN`，是否进入验证由 Case Flow 和实际业务行为判断。
- [ ] 在 `references/workflow.md` 将 `NOT_RUN` 说明收紧为“必要执行条件无法在当前 execution 的权限和能力内建立、没有安全继续路径且未进入对应 CHECK 验证”。
- [ ] 在 `docs/architecture.md` 将笼统的“前置条件不满足使用 NOT_RUN”替换为第 4 节的三层结果模型，并明确正常 verdict 由 Runtime 从 ledger 聚合。
- [ ] 精简 `SKILL.md` 中 Case Agent 业务细则，只保留 Coordinator/Case Agent 职责边界和 Runtime 不作业务判断的框架事实。
- [ ] 运行 `node scripts/build-agent-facing-docs.js` 生成文档，禁止直接维护生成文件中的重复规则。

### Task 4: 独立修正 Brief 初始状态字段的事实含义

**Files:**

- Modify: `scripts/case-runtime/agent-facing-contract.js`
- Modify: `scripts/tests/agent-facing-case-runtime.test.js`
- Modify: `scripts/tests/case-runtime.test.js`

**Interfaces:**

- Consumes: `runtimeStatus(executionDir).preparation` 的持久化准备记录。
- Produces: `caseBrief.initialState.preparationFact`，不再声称 Runtime 已知当前 App 业务/UI 状态；本任务使用独立提交，不阻塞 Task 1 至 Task 3 的核心提示词修复。

- [ ] 删除 `initialState.currentAppState`。
- [ ] 新增以下业务无关的事实投影，`availablePreparation` 的现有内容保持不变：

```typescript
initialState: {
  automaticPreparation: "NONE" | "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL";
  preparationFact: null | {
    status: "SATISFIED" | "FAILED";
    targetState: "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL" | null;
  };
  availablePreparation: Array<{
    targetState: "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL";
    meaning: string;
    authorized: boolean;
    platformEffect: string;
  }>;
}
```

- [ ] `preparationFact: null` 只表示没有已持久化的准备完成/失败事实，不表示当前页面正确、错误、空白或未知。
- [ ] 不从 Scene、页面文本、历史动作或业务用例推断 `preparationFact`。
- [ ] `preparationFact` 只表达准备历史，不作为当前业务页面判断依据；失败原因继续由当前错误响应或 continuation 的 `resumeState.preparation` 提供，本任务不把内部 `technicalFactRef` 直接暴露为未发布资源引用。
- [ ] 更新 Case Brief 投影断言，覆盖无准备记录、准备成功和准备失败三种事实。
- [ ] 不增加兼容字段；JS 投影变化会改变 `runtimeSha`，而同批 Prompt/原则变更会改变 `caseProtocolSha`，新 Brief 形状只由新 execution 使用。

### Task 5: 调整提示词契约测试而不固化业务策略

**Files:**

- Modify: `scripts/tests/architecture-boundaries.test.js`
- Modify: `scripts/tests/agent-capability-contract.test.js`

**Interfaces:**

- Consumes: 核心 prompt、原则文档、角色资源 manifest。
- Produces: 防止职责边界回退的静态约束，不参与 Runtime 执行决策。

- [ ] 保留资源清单、能力集合、禁止内部字段、禁止嵌入请求 Schema 等现有架构断言。
- [ ] 删除依赖具体恢复句式、错误码叙述顺序和结果措辞的细碎正则，避免测试迫使 Prompt 长期保留固定表达。
- [ ] 只增加可机械证明的稳定结构断言：`case-agent.md` 必须加载 `case-execution-principles.md`，未知动作结果禁止重放这一安全不变量继续存在，Case Agent 公开能力集合不变。
- [ ] 不用正则尝试证明“Agent 具有自主判断能力”、语义规则没有重复或某类业务句式永远不会出现；业务结果只在 principles 完整定义一次由第 6 节只读审查确认，自主行为由用户回归验证。
- [ ] 测试只检查提示词契约是否自洽，不调用设备、不评估业务页面、不成为新的 Runtime 门禁。

### Task 6: 静态一致性检查与用户回归交接

**Files:**

- Verify only.

**Interfaces:**

- Consumes: 前五个任务的文档、契约和生成物。
- Produces: 可交给用户执行三端回归的稳定版本。

- [ ] 运行 `node scripts/build-agent-facing-docs.js --check`，确认生成文档与契约源一致。
- [ ] 运行只读搜索，确认核心语义只在 `case-execution-principles.md` 保留一份完整定义，其他文档只引用或陈述本层事实；同时确认 `references/knowledge.md`、Prompt 和 Runtime 契约中均不存在“负向结论本身强制触发知识查询”的残留规则。
- [ ] 运行 `wc -c prompts/case-agent.md references/case-execution-principles.md`，确认输出的 `total` 不超过 10,373 字节。
- [ ] 运行以下非设备测试，要求全部通过：

```bash
node scripts/self-test.js boundaries agentCapabilityContract agentFacingCaseRuntime caseRuntime agentFacingDocs entrypoints agentHandoff coordinatorAgentFacing
```

- [ ] 发布前检查所有使用该 Skill 的目标工作区，确认没有仍需继续执行的活动 Coordinator、Batch、Execution 或 Handoff；若存在则先让旧执行按冻结协议完成，不使用新代码或新文档恢复旧 execution。
- [ ] 运行 `git diff --check`，确认无格式错误。
- [ ] 不执行设备回归，不启动 iOS/Android/HarmonyOS 批次。
- [ ] 向用户提供下列回归场景、预期行为和实际改动文件清单。

## 6. 用户回归矩阵

| 场景 | 期望行为 |
|---|---|
| 起点在错误业务页面，但存在安全可达路径 | Agent 观察并调整 Working Flow，继续执行；不能只因起点不符直接 `NOT_RUN` |
| 起点与预期不一致，存在多个可能路径 | Agent 结合 Scene、风险和可验证性自主选择，不要求固定使用返回键或 `recover` |
| 单次动作技术核验失败且结果已知 | Agent 根据当前 Scene 和副作用自主重试、换动作或换路径；不能直接产品 FAIL |
| 动作可能已生效但结果未知 | Agent 先观察并重新判断，禁止自动重放 |
| 产品预期被现场证据明确否定 | 可以直接记录 FAIL；只有依赖外部业务规则时才查询知识 |
| 已进入验证但截图/结构/搜索覆盖不足 | 记录 INCONCLUSIVE，不伪造“不存在”结论 |
| 技术环境阻止继续且有技术事实 | 记录 BLOCKED，不伪装为 FAIL 或 NOT_RUN |
| 已 observe 当前页面，但必要执行条件无法在当前授权和能力内建立、没有安全继续路径且未进入对应 CHECK 验证 | 使用 NOT_RUN，并引用原因与已登记事实；不能因为已有 `sceneObserved` 就机械改成 BLOCKED |
| 条件分支未进入 | 对相应 CONDITIONAL CHECK 记录 NOT_APPLICABLE，不产生 FAIL |
| warm session 继承前一用例现场 | Agent 把继承现场当作当前事实重新决策，不假设其必然正确，也不自动清理状态 |

## 7. 验收标准

1. `case-agent.md` 不再把现场起点不符直接映射为 `NOT_RUN`。
2. `case-execution-principles.md` 明确定义自主适配、停止条件和证据充分性，并分别定义 CHECK status、Runtime 聚合 verdict 与用例级 `NOT_RUN`。
3. `prompts/case-agent.md` 与 `references/case-execution-principles.md` 合计不超过 10,373 字节，且没有跨文件重复的完整业务规则。
4. 提示词不包含业务用例专属恢复动作，不包含统一恢复次数。
5. Prompt、`references/knowledge.md`、Runtime 契约和生成文档都不再把负向业务结论本身绑定到知识查询。
6. `references/workflow.md` 不再用 `sceneObserved` 或 `actionRequested` 推断是否进入业务验证；`references/failure-policy.md`、`docs/architecture.md` 与核心原则使用同一结果边界。
7. Runtime 没有新增业务判断或强制返工门禁，公开能力集合与 verdict/status 枚举及聚合优先级保持不变。
8. Runtime 生成文档只保留结构、技术事实和实际校验，不维护第二套业务原则。
9. Brief 不再使用 `currentAppState` 表达准备记录，且不推断当前 UI/业务状态；该独立改动不阻塞核心提示词修复。
10. 现有安全边界继续成立：未知动作结果不重放、技术失败不直接产品 FAIL、破坏性或越权动作仍需确认。
11. 指定的非设备测试和生成文档检查全部通过；三端业务回归未由实现者执行，由用户按第 6 节矩阵独立验证。
12. 发布时正确识别 `caseProtocolSha`、`runtimeSha` 与 `coordinatorProtocolSha` 的变化，且没有使用新协议继续旧的活动 Coordinator、Batch、Execution 或 Handoff；新提示词和 Brief 形状只用于新 execution。

## 8. 非目标

- 不改变 warm session 默认的 `KEEP_EXISTING` 策略。
- 不让 Runtime 自动把 App 导航到某个业务页面。
- 不新增通用“返回首页”“重启后导航”“清空页面栈”等恢复 API。
- 不改变 `NOT_RUN` 的持久化格式、报告展示或 batch 聚合。
- 不增加模型调用轮次、强制反思轮次或固定自我检查次数。
- 不为 iOS 020 编写专属规则或识别 KittenN 编辑器/作品列表的页面逻辑。
- 不在本次工作中执行或发布三端回归结果。

## 9. 建议提交边界

1. `docs(mavt): define autonomous case execution principles`
2. `refactor(mavt): simplify case agent decision prompt`
3. `docs(mavt): align runtime references with agent-owned judgment`
4. `fix(mavt): expose preparation facts without app-state inference`
5. `test(mavt): protect case agent prompt boundaries`

# Agent-Runtime 通信协议优化讨论

## 1. 文档定位

本文持续记录 mobile-ai-visual-test 中 Agent 与 Runtime 通信协议的性能问题、讨论结论和待决方案。

本文当前是讨论记录，不是最终设计规格或实施计划。只有已经达成一致的内容进入“已确认结论”；尚未验证或仍有分歧的内容进入“待讨论问题”。

已确认结论对应的 Protocol 详细接口、数据模型、状态机和部署约束见 [`docs/superpowers/specs/2026-09-16-agent-runtime-protocol-design.md`](superpowers/specs/2026-09-16-agent-runtime-protocol-design.md)。

## 2. 问题背景

最新 Android 用例 002 和 003 均执行通过，但端到端耗时分别约为 16 分 36 秒和 20 分 25 秒。其中 Runtime 实际活动时间分别约为 28 秒和 51 秒，其余时间主要发生在 Agent 调度、模型决策及工具调用之间。

因此，当前主要性能问题不在设备 Adapter，而在 Agent-facing 通信协议及 Agent 执行流程。

## 3. 已确认的根因

### 3.1 Agent 与 Runtime 的通信颗粒度过细

一个业务执行被拆分成多个 Agent、工具和 Runtime 回合。每个回合都要求 Agent重新恢复上下文、读取响应并形成下一次请求，导致单个业务动作的通信成本被显著放大。

### 3.2 Runtime 返回给 Agent 的数据过重

Runtime 当前重复返回完整 Scene、动作候选、Case Model 及操作模板，其中大量内容与 Agent 当前决策无关。重复和无关信息持续进入模型上下文，增加读取、筛选和推理成本。

### 3.3 用例结束时要求 Case Agent 全量复审

`finish` 阶段要求 Case Agent 重新审视完整 Case Model，逐项组织验证结果、证据引用、视觉登记和不确定项。执行过程中已经形成的判断未被充分复用，导致结束阶段出现重复推理和明显长尾。

## 4. 已确认的职责边界

### 4.1 Agent

Agent 是唯一业务语义决策者，负责：

- 理解原始用例和页面业务含义。
- 查看截图并形成视觉判断。
- 决定下一步业务动作。
- 选择当前 Scene 已发布的具体动作。
- 判断验证点状态和最终业务结论。

### 4.2 Runtime

Runtime 是无智能的确定性设备代理和事实记录者，负责：

- 封装设备、自动化驱动、截图、控件树及平台差异。
- 校验 Scene 与动作引用。
- 执行 Agent 明确指定的设备动作。
- 等待页面稳定并采集新现场。
- 完整记录动作、Scene、证据、异常和生命周期事实。
- 根据确定性规则投影 Agent 当前需要的信息。

Runtime 不理解自由文本业务意图，不自主选择业务目标，不判断页面是否满足业务预期，也不替代 Agent 形成 PASS、FAIL 或 INCONCLUSIVE 结论。

## 5. 已确认的交互原则

### 5.1 保留业务决策因果链

以下流程符合移动端业务执行规律，不能跨决策边界合并：

```text
查看 Scene N 截图
→ Agent 形成判断
→ Agent 选择并提交具体动作
→ Runtime 执行动作并采集 Scene N+1
→ Agent 查看 Scene N+1 后形成下一次判断
```

Agent 必须基于最新现场决定下一步操作。Runtime 不能在 Agent 尚未查看操作后现场时自动推导或执行后续业务动作。

### 5.2 只合并同一次决策产生的确定性工作

在 Agent 已经查看 Scene 并完成本轮决策后，可以考虑将以下内容作为一个复合请求提交：

- 登记 Agent 对当前 Scene 已形成的视觉事实。
- 首次提交或修订 Case Model。
- 更新本轮已经形成的验证点判断和证据引用。
- 校验 `basedOnSceneRef` 和具体 `actionRef`。
- 执行本轮已经决定的具体动作，或执行一次明确的 observe。
- 等待页面稳定，采集并持久化新 Scene。
- 返回本次执行结果和新 Scene 的最小必要投影。

这类合并不会让 Runtime 获得业务智能，只是减少同一 Agent 决策被协议拆成多个通信回合。

Case Model、视觉事实和验证点判断都由 Agent 生成，Runtime 只负责校验、绑定 revision 并持久化。验证点状态必须作为 Agent 请求的一部分，不能由 Runtime 根据操作响应自行推断。

复合请求应先完成全部静态校验，再执行设备动作。设备动作无法与文件记录形成真正的数据库原子事务，因此仍需事务日志保证恢复：动作投递前失败不得执行设备操作；动作投递后结果未知不得自动重放。

### 5.3 异常结果必须回到 Agent 决策

- 页面已变化时，Runtime 返回 `SCENE_CHANGED`，不得执行基于旧 Scene 的动作。
- 动作引用失效时，Runtime 返回动作失效事实，不猜测替代目标。
- 动作已投递但结果与预期不符时，Runtime 返回实际现场，不自动重试可能产生副作用的动作。
- Agent 查看新现场后决定调查、纠正、调整计划或收口。

### 5.4 Runtime 使用说明与运行时数据分离

Runtime 作为独立模块，应有独立、稳定、可版本绑定的使用文档。能力签名、参数说明、控件到动作的通用映射、example、错误恢复方式和证据约束属于文档；现场事实、有效引用和本次失败原因属于运行时响应。两者不能混在每次调用的返回中。

Case Agent Prompt 只保留职责边界、核心执行原则及 Runtime 文档引用。Case Agent 启动时只读取有硬体积预算的短索引；紧凑签名不足时按需读取对应方法页，遇到错误时只读取 `documentationRef` 指向的错误章节。Runtime 的机器校验仍然保留，不能仅依赖 Agent 正确阅读文档。

### 5.5 消除单次 Runtime 调用内部的宿主工具双边界

当前 Case Agent Prompt 要求每次先创建一次性请求文件，再单独执行 Runtime command。一个逻辑 Runtime 调用因此被拆成至少两次宿主工具调用，并产生两次模型续推理边界。

`agent-facing-client.js` 只从 stdin 读取 JSON。Prompt 和 Brief 让 Agent 在一次 Shell 工具调用中将 JSON 传给预绑定 command，不创建中间请求文件。

更彻底的目标是将 Agent-facing Runtime 暴露为单个结构化 MCP 工具。MCP 参数 Schema 取代 Shell 编码和临时文件，一次 Agent tool call 完成一次决策提交。该方向能进一步消除文件、Shell 和手工 JSON 引用边界，但涉及工具注册、execution 绑定、dispatch 校验和生命周期管理，应作为独立阶段实施。

### 5.6 Agent-facing 服务统一文档原则

所有直接向 Agent 提供能力的服务必须有独立、稳定、可版本绑定的使用文档。角色 Prompt 只说明职责边界并引用对应服务文档，不复制服务的完整用法。

成功响应只返回：

- 本次操作的状态和结果事实。
- 本次 execution 或 Scene 的动态数据与引用。
- Agent 下一次业务决策必须知道的状态变化。

错误响应允许返回：

- 稳定错误码。
- 本次失败的具体原因和字段问题。
- 与错误有关的当前资源、Scene 或状态事实。
- 错误是否可重试等客观属性。
- 指向服务文档错误章节的稳定引用。

响应不再返回：

- `useWhen`、`required`、`optional`、`source`、`returns` 等能力说明。
- 请求 Schema、通用 example 或 usage 文本。
- `retryWith`、`nextCall.example`、`technicalContext.resume` 等内联解决步骤。
- 与当前结果无关的完整能力目录或恢复教程。

错误的诊断方法、恢复步骤、重试条件和示例统一放入服务文档，并以错误码作为稳定索引。Runtime 和 Coordinator 仍执行机器校验；文档不能替代输入校验或状态机约束。

execution 绑定、dispatch sequence、Scene ref、设备候选等运行时动态数据不属于“如何使用”的静态说明，可以继续作为事实或不透明调用句柄返回，但不附带重复教程。

### 5.7 Agent-facing 能力采用 SDK 式方法契约

Agent 在第一次调用某项能力前，必须能够从对应服务文档中查到稳定的方法签名，而不是依赖某次响应临时提供的 example 猜测请求格式。

每个 Agent-facing 方法至少应记录：

- 方法名和一句话用途。
- 请求方法签名或结构化 Schema。
- 必填参数、可选参数和条件必填参数。
- 每个参数的业务含义、类型、枚举、范围和数据来源。
- 动态引用应从哪个运行时事实中取得。
- 前置条件、状态约束、幂等性和可能副作用。
- 成功返回类型和可能状态。
- 稳定错误码及对应错误文档章节。
- 一个最小通用示例；不复制具体 execution 的动态值。

建议使用类似 SDK 的签名表达：

```text
act(
  basedOnSceneRef: SceneRef,          // 必填；当前决策依据的 Scene
  actionRef: ActionRef,               // 必填；由控件引用和动作类型构造
  purpose: string,                    // 必填；Agent 的本轮决策摘要
  input?: ActionInput,                // 可选；仅输入、等待、坐标等动作需要
  updates?: DecisionUpdates           // 可选；本轮 Case Model、视觉事实和验证点判断
) -> ActionResult
```

机器可读 Schema、MCP tool schema、服务端校验和 Markdown 方法文档应来自同一份接口定义，避免手工维护多份契约。对应文档加入 protocol resources；签名变化必须改变 protocol SHA，并由测试检查文档覆盖全部公开方法和错误码。

运行时响应仍可提供当前有效的 `SceneRef`、`elementRef`、设备候选或枚举子集，但这些是动态参数值，不再携带参数说明和通用 example。`ActionRef` 的稳定构造规则属于方法文档；Agent 根据当前控件事实构造，Runtime 继续校验它是否对当前 Scene 有效。

## 6. 统一目标架构

优化后的协议按六层组织。每层只解决一种问题，避免再次把说明书、业务决策、设备执行和审计数据混在同一个响应中。

### 6.1 能力发布层

- Coordinator 和 Case Runtime 分别提供 SDK 式启动短索引：`references/coordinator.md` 和 `references/case-runtime.md`；方法详情、ActionRef 规则和错误恢复拆为按需子文档。
- 每个公开方法具有稳定签名、参数约束、返回类型、副作用、幂等性和错误码。
- 一份机器可读接口定义是唯一契约源，并生成或校验服务端 Schema、MCP tool schema 和 Markdown 方法文档。
- 接口定义和服务文档进入 protocol resources；契约变化必须改变 protocol SHA。

这一层解决“Agent 在调用前是否知道如何调用”的问题，是移除响应内 capability card、Schema 和 example 的前置条件。

### 6.2 调用传输层

- 近期正常路径通过 stdin 向现有 `agent-facing-client.js` 提交 JSON，把 `Write(requestPath) + Bash(command)` 收敛为一次宿主工具调用。
- Case Runtime 不保留请求文件入口；人工诊断也通过相同 stdin 契约执行。
- 后续将同一份机器接口定义发布为结构化 MCP 工具，消除 Shell、临时文件和手工 JSON 编码边界。

stdin 和 MCP 只改变请求如何到达 Runtime，不改变 Agent 与 Runtime 的业务职责。

### 6.3 决策提交层

一次请求对应 Agent 基于某个 Scene 已完成的一次决策。请求可以同时携带：

- Case Model 首次提交或修订。
- 当前 Scene 的视觉事实。
- 已形成的验证点结果更新。
- 一个明确的 act 或 observe。

这些字段是同一次决策的复合提交，而不是 Runtime 执行业务意图。新的 Scene 返回后必须重新交给 Agent 判断，不能越过“看图、决策、操作、再看图”的边界。

### 6.4 响应投影层

- 成功响应只提供本次状态变化、动态事实、有效引用和下一次业务决策必需的数据。
- Scene 默认返回截图、精简可交互控件事实（含 `elementRef` 与必要交互属性）、异常信号、冲突和上一动作摘要，不返回完整动作目录或逐动作 example。
- 完整布局、控件树、技术诊断和历史事实通过显式 inspect 或引用按需获取。
- 错误响应提供错误码、具体原因、字段问题、相关当前事实、`retryable` 和 `documentationRef`；恢复方法和示例只存在于文档。

### 6.5 结果状态层

- Runtime 按 expectation 持久化 Agent 在执行过程中已经形成的判断及其证据引用。
- Case Model revision 或验证点语义变化时，Runtime 根据稳定 revision/hash 规则使相关判断失效或转为未决。
- `finish` 只要求 Agent 处理 `unresolved` 和 `conflicts` 并确认摘要，不再重新生成全部验证点结论。
- Runtime 仍对最终完整结果和证据图执行全量确定性校验。

### 6.6 内部执行与审计层

完整 Scene、事件流、设备命令、截图、控件树、知识快照、证据图、事务日志和幂等恢复继续由 Runtime 内部保存。Agent-facing 数据变小不等于内部记录变少，也不能降低结果完整性。

### 6.7 端到端调用形态

```text
服务文档 / 方法签名
        ↓ 调用前查询
Agent 查看 Scene N，形成一次业务决策
        ↓ 一次结构化提交
updates(caseModel / visual / verdict) + act|observe
        ↓
Runtime 静态校验 → 记录事务 → 执行设备动作 → 采集并完整持久化 Scene N+1
        ↓ 最小必要投影
Agent 查看 Scene N+1，开始下一次决策
```

## 7. 当前模块边界

### 7.1 正式 Agent-facing 服务

当前角色契约只定义两个正式 Agent-facing 服务：

1. Coordinator Facade：入口为 `scripts/coordinator-agent.js`，服务主 Agent，负责 `prepareRun`、`confirmRun`、`advanceRun` 和 `cancelRun`。
2. Case Runtime Facade：入口为 `scripts/case-runtime/agent-facing-client.js`，服务 Case Agent，负责单条 execution 的观察、调查、计划、操作、知识、恢复和收口。

当前公开方法清单：

| 服务 | 方法 | 当前主要参数 |
|---|---|---|
| Coordinator | `prepareRun` | `workspace`、`caseNos` |
| Coordinator | `confirmRun` | 按 decision 分支使用 `userInstruction`、`platform`、`deviceId` 或 `binding` |
| Coordinator | `advanceRun` | 无业务参数 |
| Coordinator | `cancelRun` | `reason` |
| Case Runtime | `observe` | 可选 `purpose`、`expectationRefs` |
| Case Runtime | `inspect` | `channel`；按 channel 条件使用 `observation`、`expectationRefs`、`filter` |
| Case Runtime | `plan` | `understanding`、`preconditions`、`verificationPoints`、`items`、`uncertainties`；修订时需要 `reason` |
| Case Runtime | `act` | `actionRef`、`purpose`；可选 `input`、`expectationRefs` |
| Case Runtime | `knowledge` | 查询模式使用 `query`；复核模式使用 `queryId`、`conclusion`、`assessments` |
| Case Runtime | `recover` | `reason`；按模式使用 `targetState` 或 `externalAction` |
| Case Runtime | `finish` | `summary`；可选 `uncertainties`、`updates.visual`、`updates.expectationResults` |

### 7.2 一次性引导入口

1. Workspace Bootstrap：`scripts/workspace.js`，发现或初始化 Workspace，并交付 Coordinator 的绑定信息。
2. Case Handoff Loader：`scripts/case-agent-bootstrap.js`，校验 Handoff 并交付 Case Agent 的 execution 绑定、角色 Prompt 和 Runtime 入口。

引导入口属于对应服务的启动过程，可以在同一套分层文档中说明，不需要复制完整能力目录到引导响应。

### 7.3 内部模块

Batch、Environment、ExecutionRequest、Handoff、Runtime Core、Scene、Knowledge、Adapter、Device Port、Evidence Store、Result Integrity、Report 等模块由上述 Facade 调用，不是正常执行中的 Agent-facing 服务。它们不向 Agent 发布独立调用说明；需要 Agent 处理的错误事实和文档引用通过所属 Facade 返回。

### 7.4 目标文档映射

- 主 Agent：`SKILL.md` 引用 `references/coordinator.md` 短索引；方法详情和 Coordinator 错误恢复位于 `references/coordinator/` 下的按需文档。
- Case Agent：`prompts/case-agent.md` 引用 `references/case-runtime.md` 短索引；Runtime 方法、ActionRef 和错误恢复位于 `references/case-runtime/` 下的按需文档。
- Authoring 或维护入口：继续与正常执行隔离，由独立 Authoring 接口文档维护，不混入 Coordinator 或 Case Runtime 响应。

服务文档应加入对应角色的 protocol resources 和摘要计算。文档中的契约或恢复规则变化时，protocol SHA 应同步变化，防止 Agent Prompt、服务实现和说明书发生漂移。

### 7.5 当前与目标原则的差距

Coordinator 当前存在：

- Workspace Bootstrap 在每次响应中返回完整 capability cards。
- Coordinator 响应返回 template、usage 和下一步 command 说明。
- 输入错误或技术错误返回 `retryWith`、resume 示例等内联解决步骤。

Case Runtime 当前存在：

- Case Brief 返回完整 capability cards 和 input 使用说明。
- 每个 Scene 返回 `actions[].example`、`inspect`、`plan` 和 `finish` example。
- 错误或恢复响应返回 `retryWith`、`nextCall.example` 和 `technicalContext.resume`。

目标是移除上述静态说明和内联解决步骤，只保留运行时动态事实、不透明绑定信息、错误原因及文档锚点。

当前 Agent 的调用知识主要来自响应中的 capability card、template 和 example；完整请求 Schema 只存在于 `agent-facing-contract.js`。因此 Agent 虽然通常能通过复制 example 完成调用，但缺少一份调用前可稳定查询的 SDK 式方法参考，条件必填、枚举范围、参数语义和错误处理分散在 Prompt、响应和实现代码中。

## 8. 已确认的优化方向

- P0 使用现有 stdin 通道，将“写 requestPath + 执行 command”合并为一次宿主工具调用。
- 后续评估将 Agent-facing Runtime 暴露为单个结构化 MCP 工具。
- Runtime 内部继续完整记录，Agent-facing 响应改为按需投影。
- Runtime 提供独立使用文档；稳定调用规则、通用动作映射和 example 不随每次响应重复返回。
- Case Agent Prompt 引用 Runtime 短索引，并要求 Agent 启动时只读索引、遇到问题时按链接查阅单个方法或错误章节。
- 减少“一次性请求文件 + 执行命令”造成的重复工具边界。
- 将同一次 Agent 决策产生的 Case Model 修订、视觉事实、验证点判断和具体动作合并提交。
- Scene 只返回精简的动态控件事实，不再返回由控件能力展开的动作目录；Agent 根据稳定文档规则和当前控件事实构造动作请求。
- 执行过程中增量保存 Agent 已形成的验证判断，结束时只处理未决项和冲突项。
- 保留完整 Scene 和事件作为审计事实，但通过引用、差异和按需展开控制 Agent 上下文体积。

## 9. 明确否定的方向

- 不让 Runtime 根据“登录”“进入学习页”等自由文本业务意图自主规划动作。
- 不把“查看操作后截图”和“决定下一步动作”合并为无 Agent 参与的连续执行。
- 不以减少记录或删除内部证据的方式换取 Agent-facing 响应变小。
- 不在动作结果未知时自动重放可能已经生效的动作。

## 10. Scene 现状分析

### 10.1 Runtime 内部 Scene

Runtime 持久化 Scene 当前包含以下信息：

- Scene 身份与采集信息：`sceneId`、`schemaVersion`、`capturedAt`、`generation`、`warmSessionRef`。
- App 状态：`app`。
- 截图与布局引用：`screenshot`、`layout`、`layoutRef`。
- 页面结构：`elements`、`scrollContainers`、`scrollContexts`。
- 动作能力：`capabilities`、`visual`。
- 动态信号与证据策略：`signals`、`evidenceChannels`、`conflicts`。
- 上一动作事实：`previousAction`。

在 Android 用例 003 的 `scene-0005` 中，内部 Scene 约为 16.2 KB，其中 `capabilities` 约占 47%，`elements` 约占 29%，`previousAction` 约占 11%。这些数据对 Runtime 的动作校验、审计、恢复和按需调查仍有价值，不应仅为减少 Agent 上下文而从内部记录删除。

控件树 `elements` 本身没有内联动作 example，但内部 Scene 同时保存了由控件属性派生的 `capabilities`。因此同一份交互语义在 `elements` 和 `capabilities` 中存在重复表达。

### 10.2 Agent-facing Scene

当前 `projectScene()` 返回：

- `sceneRef`、`capturedAt`、`screenshot`、`app`、`signals`、`conflicts`。
- `evidence`、`previousAction`、`actions`、`inspect`。
- `caseModel`、`plan`、`finish`。

该投影混合了现场事实、操作协议、请求 example 和 Case 级状态。它不是单纯的 Scene 摘要。

`projectScene()` 还会把内部 `capabilities` 再展开为带完整 example 的 `actions`。即使 Agent 调用 `inspect(elements)`，响应外层仍会重新附加完整 Agent-facing Scene，因此一次控件树查询仍会同时返回整份动作目录和 example。

同一个 `scene-0005` 的 Agent-facing 投影约为 20.4 KB，其中：

- `actions` 约为 14.0 KB，占 69%，包含 53 个完整动作 example。
- `previousAction` 约占 9%。
- `caseModel` 约占 7%。
- `inspect`、`plan`、`finish` 继续重复携带调用模板。

### 10.3 目标精简分类

默认 Scene 响应只保留：

- `sceneRef`。
- 可直接查看的截图引用及必要尺寸。
- 目标 App 是否仍在前台；仅异常时返回前台 App 详情。
- 非空冲突和影响当前决策的动态信号。
- 上一动作的精简结果，例如动作类型、投递状态和画面是否变化。
- 精简的可交互控件事实，例如控件引用、文本、角色、边界和交互属性。

改为按需展开的内容：

- 完整 `elements`、布局和滚动上下文。
- 上一动作的完整坐标、设备命令和落点证据。
- 完整动态信号及技术诊断信息。

从 Scene 中移出的内容：

- `caseModel`：属于 Case 级状态，只返回 revision 或变化摘要。
- `plan`、`finish`、`inspect` example：属于稳定协议，在 Agent 启动时提供一次。
- 稳定的证据策略和冲突规则：属于协议或执行配置，不随每个 Scene 重复返回。
- 逐控件 `capabilities` 和展开后的 `actions[].example`：控件属性到动作类型的映射规则及通用 example 放入 Runtime 使用文档；Scene 只返回动态控件事实。

`scene-0005` 当前包含 18 个控件，其中 14 个可交互控件约为 2.1 KB；由这些控件派生的 49 个内部 capability 约为 7.6 KB，进一步展开后的 53 个 Agent-facing action 约为 14.0 KB。仅以精简可交互控件事实替代动作目录，相关负载可减少约 85%。

基于现有 `scene-0005` 的非实现性整体投影估算，以上调整可将单次 Scene 从约 20.4 KB 降至约 3.6 KB，减少约 82%。对 002 和 003 的唯一 Scene 集合估算均可减少约 84%。该数字用于说明优化空间，不是最终协议的性能承诺。

## 11. `finish` 全量复审分析

### 11.1 当前目的

当前 `finish` 要求 Case Agent 为全部 ACTIVE 验证点重新提交最终检查，随后 Runtime 对完整结果执行确定性校验。它实际用于解决：

- 验证点遗漏、重复或引用未知验证点。
- PASS、FAIL 与所有验证点状态汇总不一致。
- PASS、FAIL 缺少 Scene 证据，或引用了不存在的 Scene。
- 结论引用的 Scene 尚未完成视觉登记。
- 负向结论缺少知识调查，搜索不存在结论缺少完整列表覆盖，BLOCKED 引用了无效技术事实。
- Scene、截图、布局、动作落点及知识快照被修改、缺失或彼此不一致。
- 完成事务中断后无法幂等恢复，或结果完成后被不同内容覆盖。

这些问题都需要解决，但其中大多数属于 Runtime 可以根据持久化状态完成的确定性完整性校验，不需要 Agent 在结束时重新理解全部业务过程。

### 11.2 形成全量复审的根本原因

当前执行过程中只增量记录 Scene、动作、视觉事实、知识调查和 Case Model，没有按验证点持续保存 Agent 已形成的结果判断。因此 `finish` 是第一次生成权威 CaseResult，只能要求 Agent 一次性重新提交所有验证点的状态、实际结果和证据引用。

全量复审不是业务执行天然需要的步骤，而是当前“结果只在结束时生成”这一数据模型的结果。

### 11.3 必要性结论

- 最终完整性校验有必要，必须保留，并且应继续由 Runtime 对完整证据图执行。
- Agent 的全量语义复审没有必要。已经在执行过程中形成并持久化的业务判断不应要求 Agent 在结束时重新生成。
- `finish` 应从“全量提交最终结果”改成“确认收口并处理未决项或冲突项”。

### 11.4 候选替代方式

执行过程中由 Agent 按验证点增量提交结果更新：

- `expectationRef`
- 当前状态，例如 PASS、FAIL、BLOCKED 或 INCONCLUSIVE
- 实际结果摘要
- Scene、知识或技术事实引用
- 所依据的 Case Model revision

Runtime 维护验证点结果台账，并在 Case Model revision 变化时确定性处理：

- 保留仍存在且语义未变化的验证点判断。
- 将新增或发生实质变化的验证点标记为未决。
- 将已取消验证点的判断保留在历史中，但不计入当前结果。

结束时 Runtime 先返回 `resolved`、`unresolved` 和 `conflicts`。Agent 只补充未决项、处理冲突并提交最终摘要。全部项目解决后，Runtime 仍对完整结果和证据图执行现有强校验，再原子化完成 execution。

因此，优化目标不是降低结果完整性要求，而是把“完整校验”留在 Runtime，把“重复全量复审”从 Agent 移除。

## 12. 分阶段实施顺序

### Phase 0：建立基线和性能门禁

- 固化 002、003 当前端到端耗时、Agent 思考时间、宿主工具调用数、Runtime 调用数、响应字节数和 `finish` 长尾。
- 为每次 execution 记录分层计时，区分模型、宿主工具、Runtime、设备和报告阶段。
- 定义阶段验收指标，避免只看 Runtime 内部毫秒数而遗漏 Agent 上下文成本。

### Phase 1：先发布服务契约

- 建立 `references/coordinator.md` 和 `references/case-runtime.md` 启动短索引，以及按需方法页、ActionRef 页和错误目录，覆盖全部 11 个公开方法和稳定错误码。
- 为启动索引、单个按需页面和文档总量设置硬字节预算，并由文档生成检查阻止体积回归。
- 建立单一机器接口定义以及文档、Schema、服务端校验的一致性检查。
- Prompt 改为引用启动短索引；确认 Agent 不依赖响应内 example 或预读全部方法页，也能构造常用合法调用。
- 完成上述验证后，再删除成功响应中的 capability card、Schema、usage、template 和通用 example，以及错误响应中的恢复教程。

这一阶段必须先于响应精简，否则会出现“返回变小，但 Agent 在调用前不知道参数”的新问题。

### Phase 2：收敛宿主工具边界

- 正常路径改用现有 stdin 输入，一次 Shell 调用完成一次 Runtime 请求。
- 删除 `requestPath` 路径，并用 stdin 与 MCP parity 测试保证传输不改变业务语义。
- 复测 002、003 的宿主工具调用数和 Agent 等待时间。

### Phase 3：精简 Scene 和通用响应

- 默认 Scene 改为精简控件事实和必要动态状态。
- 完整 elements、布局、滚动上下文和技术诊断改为按需 inspect。
- 移除 `actions[].example`、Case 级模板以及无关的重复状态。
- 建立投影大小预算和字段级快照测试。

### Phase 4：合并同次决策提交并增量维护结果

- 为 act/observe 增加可选 decision updates，承载 Case Model、视觉事实和 expectation verdict。
- 建立 expectation result ledger、revision/hash 失效规则和未决/冲突查询。
- 将 `finish` 改为收口接口，同时保留 Runtime 的全量证据完整性校验。
- 重点验证设备动作结果未知、Scene stale、部分写入和幂等恢复路径。

### Phase 5：发布结构化 MCP 入口

- 从同一机器接口定义生成 MCP tool schema。
- 绑定 execution、dispatch sequence 和唯一写入者，保持现有事务及审计语义。
- 在收益和稳定性验证后，再决定是否下线 Shell 入口；MCP 化不是前面四个阶段的阻塞条件。

## 13. 后续阶段问题

- Phase 5 的 MCP 工具如何在具体宿主中注册，并绑定 execution、dispatch 和唯一写入者？
- Shell 入口在 MCP 稳定后的长期保留策略是什么？该问题不阻塞 Protocol 前四个实施阶段。

## 14. 决策记录

### 2026-09-16

- 确认 Runtime 应继续作为设备代理、确定性执行入口和完整事实记录者。
- 确认主要性能根因是通信颗粒度过细、Agent-facing 数据过重及结束阶段全量复审。
- 确认不能破坏“看图、决策、操作、再看图”的业务因果链。
- 确认优化应聚焦同一决策内的机械步骤合并、按需投影和增量收口，而不是让 Runtime 解释业务意图。
- 确认 Runtime 使用说明、Schema、通用动作映射和 example 应放入独立文档，由 Case Agent Prompt 引用，不随每次响应重复返回。
- 确认 Agent-facing Scene 不再返回由控件树展开的完整动作目录和逐动作 example，只保留动态控件事实及必要引用。
- 确认正常调用优先使用现有 stdin 通道，将请求文件写入和 Runtime command 合并为一次宿主工具调用；MCP 化作为后续结构化入口目标。
- 确认 Case Model 修订、视觉事实和验证点判断等纯记账操作不应在正常路径独占通信回合，应作为同一次 Agent 决策的可选更新随相邻 act 或 observe 提交。
- 确认所有 Agent-facing 服务必须提供独立文档；角色 Prompt 只保留职责边界和文档引用，成功响应不返回使用说明。
- 确认错误响应可以返回错误码、具体原因、相关事实和文档锚点，但解决步骤、重试方法和 example 必须放在服务文档中。
- 确认每个 Agent-facing 能力必须提供 SDK 式方法签名，完整说明必填、可选、条件必填、参数语义、取值范围、动态值来源、返回类型、副作用和错误码。
- 确认机器 Schema、服务端校验、MCP tool schema 和 Markdown 方法文档应由同一接口定义生成并参与 protocol SHA，避免实现与说明书漂移。
- 确认方案按能力发布、调用传输、决策提交、响应投影、结果状态和内部审计六层组织，优化 Agent-facing 协议但不削弱 Runtime 内部记录。
- 确认实施顺序先建立基线和 SDK 式服务契约，再移除响应内说明、收敛工具边界、精简 Scene、引入复合提交与增量结果，最后评估 MCP 化。
- 确认复合请求中的 updates 与设备 effect 不是同一个成败单元：updates bundle 自身原子提交，effect 校验失败不回滚已经成立的 visual、Case Model 或验证点结果。
- 确认历史 Scene 的记账事实可以保存；只有 act 等设备 effect 要求 `basedOnSceneRef` 等于 current Scene。
- 确认 Agent 启动只读取有硬体积预算的服务短索引，方法详情、ActionRef 和错误恢复按需分文件读取；全部文件仍参与 protocol SHA。

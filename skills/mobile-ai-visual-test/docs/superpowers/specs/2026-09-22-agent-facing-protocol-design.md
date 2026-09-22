# Agent-facing 统一请求响应协议改造方案

> 状态：已实现。本文定义 Agent-facing 协议、复杂资源读取、规则文档生成、迁移和验证方案；不改变 Agent 与 Runtime 的职责边界。

## 背景

当前 Case Runtime 已有统一的预绑定客户端、Agent-facing Facade、公开契约、自动生成的方法文档和错误路由，但公开响应仍存在系统性膨胀：

- `projectAgentFacingResponse` 先复制内部响应，再删除部分字段，属于黑名单投影；新增内部字段可能无意间进入 Agent 响应。
- 除 `inspect` 外，多数响应都会重复附加当前 Scene；`recordResult`、`plan` 等不需要 Scene 的操作也会携带完整 Scene 投影。
- Runtime 全局附加 Case State、知识调查状态等公共状态，导致同一复杂数据在多个字段中重复出现。
- `inspect(elements)`、知识候选等复杂数组直接内联；是否返回由实现路径决定，而不是由 Agent 的请求语义决定。
- CLI 使用 pretty JSON 输出，进一步放大机器传输体积。
- 当前只有 Scene 投影的局部体积测试，没有“哪些数据有权进入响应”的统一协议规则。

Case 003 的已有执行数据说明这不是单个接口问题：普通 `act` 响应主要由重复 Scene 构成，`recordResult` 的业务结果很小但仍携带 Scene，`inspect(elements)` 和知识查询则会内联完整集合，知识候选还会经 `knowledgeInvestigation.pendingReviews` 重复出现。

本次改造不以硬性字节上限或截断为主要手段。Agent 在复杂业务中可能确实需要完整控件树、知识候选或计划证据；协议应当避免未请求的数据污染普通响应，同时保证 Agent 明确需要数据时可以完整取得。

## 目标

1. Coordinator、Loader/Bootstrap、Case Brief 和 Case Runtime 使用一致的 Agent-facing 响应外壳；所有可调用能力使用一致的请求外壳。
2. 响应内容由语义白名单决定，不再从内部响应复制后删字段。
3. 简单结果直接返回；未被本次操作明确请求的复杂数据只返回类型化引用。
4. 本次操作明确请求或产生的主复杂结果允许完整返回，不做静默截断、抽样或硬性体积拒绝。
5. Agent 使用一个 `read(ref)` 规则读取复杂资源，只有 `ref` 是必填参数。
6. Agent 保留自主操作权，包括基于控件引用操作和任意坐标视觉操作；Runtime 发布的控件能力不是操作白名单。
7. 复用现有公开契约和自动文档生成机制，不建立第二套手写规则。
8. Runtime 继续只负责确定性执行、校验、持久化和引用解析，不增加业务理解或视觉判断。
9. 协议数据可供后续报告和看板使用，但报告不依赖 Agent 响应作为权威数据源。

## 非目标

- 不使用响应字节上限决定业务数据是否返回。
- 不让 Runtime 判断 Agent 下一步需要哪些业务数据。
- 不要求 Agent 拼接、解析或修改资源引用。
- 不把所有设备操作限制为 Runtime 从控件树枚举出的动作。
- 不在每次响应中重复内联协议说明、方法 Schema 或恢复教程。
- 不重写 Adapter、Scene 采集、Case Flow、知识、检查点或报告的领域实现。
- 不为旧 execution 增加兼容分支、转换器或双协议 Reader。

## 适用范围

统一协议覆盖框架内所有面向 Agent 的正式接口：

| 接口 | 请求来源 | 响应规则 |
|---|---|---|
| Coordinator Facade | `prepareRun`、`confirmRun`、`advanceRun`、`cancelRun` | 使用统一请求和响应外壳；环境候选、绑定候选和批次状态按主数据/资源规则投影 |
| Loader/Bootstrap | 预绑定命令，无 Agent 业务输入 | 使用统一响应外壳，`operation` 固定为 `bootstrap` |
| Case Brief/Handoff | Loader 的成功主数据 | 作为一个 `caseBrief` 主资源返回，不再作为无结构的顶层对象 |
| Case Runtime Facade | Scene、动作、计划、知识、结果和恢复操作 | 使用统一请求和响应外壳及逐操作白名单 |
| MCP Transport | 从各 Facade 的公开契约生成 Tool | 只负责传输映射，不定义另一套请求或响应语义 |

统一的是顶层协议、状态语义、主数据规则、资源描述和错误结构。Coordinator 与 Case Runtime 仍各自维护领域 operation 和资源 resolver；公共结构由共享的 Agent-facing envelope contract 定义，两个 `PUBLIC_CONTRACT` 引用该公共定义，避免形成一个包含所有领域规则的巨型契约。

Case Brief 是一次性启动/continuation 的明确主结果，可以内联 Agent 开始或恢复用例所需的原始用例、目标绑定、初始状态、当前决策 Scene 和已有 Case Flow。它不得附加知识候选、完整日志、全部历史事件或其他非启动必需数据。Brief 本身带不可变 `caseBriefRef` 和内容摘要；同一次 dispatch 重读必须得到相同内容。

## 设计原则

### 1. 语义规则优先于体积规则

响应是否携带数据由本次操作的语义决定，而不是由序列化后的字节数决定。体积统计只用于观测和发现异常，不参与 Runtime 门禁。

复杂数据只允许以下两种返回方式：

1. **主数据**：该数据是本次操作明确请求或合同约定产生的主结果，可以完整内联，并同时拥有稳定引用。
2. **关联资源**：该数据不是本次操作的主结果，只返回引用描述，不内联内容。

例如：

- `observe` 的主结果是新 Scene，可以返回完整 Agent Scene 投影。
- `act` 合同包含动作后观察，新 Scene 是主结果，可以与简单动作结果一起返回。
- `read(sceneRef)` 的主结果是被读取的 Scene，可以完整返回。
- `recordResult` 的主结果只是记录状态和结果引用，不得顺带返回 Scene、完整 Case Flow 或知识候选。
- `plan` 的主结果是 revision、记录状态和 `caseFlowRef`，不得顺带返回当前 Scene。
- `knowledge` 查询的候选集合是主结果，可以完整返回一次；不得再通过待复核状态重复返回同一候选集合。

### 2. Agent 决策，Runtime 执行

Runtime 可以从控件树发布可用控件引用和技术能力，但 Agent 仍可根据截图选择任意坐标执行 `tap`、`doubleTap`、`longPress` 和 `swipe`。Runtime 只校验动作结构、Scene 前置条件和设备执行结果，不判断点击位置是否符合业务目的。

### 3. 引用只能复制，不能拼接

所有复杂资源引用由发布它的 Facade 完整生成。引用是 run/execution scope-bound、类型化、不可变的句柄；Agent 原样复制使用，不根据路径、Scene ID 或资源类型自行构造。

`read` 只接受 `data.ref`、`resources[].ref`，或契约中明确标注为 resource ref 的结果字段。Case Flow node、edge、check node、operation 和 plan 等领域 ID 不能传给 `read`；字段命名使用 `*Id`。业务数据中的可读取句柄统一使用 `*Ref`，并且必须能在资源目录中找到对应 `type`。`error.documentationRef` 和 `error.operationDocumentationRef` 是现有生成文档机制的静态路径，不是业务资源句柄；它们只出现在 `error` 内并由宿主文件读取能力打开。

### 4. 单一事实来源

公开请求 Schema、响应规则、资源类型、错误定义、最小示例、MCP Tool 定义和 Agent 文档必须来自同一份 `PUBLIC_CONTRACT`。生成物不得反向成为实现输入。

## 统一请求模型

CLI/Facade 的规范请求统一为：

```json
{
  "operation": "act",
  "input": {
    "sceneRef": "scene-0042",
    "action": {
      "type": "tap",
      "target": {
        "point": [0.52, 0.73]
      }
    }
  }
}
```

公共规则：

- 顶层只有 `operation` 和 `input`。
- `operation` 是公开契约中的稳定名称，不使用内部 Runtime operation 名称。
- `input` 只包含 Agent 必须决定的业务输入和必要的并发前置条件。
- workspace、execution、平台、App、绑定命令和 Facade 已知的当前状态不由 Agent 重复提交。
- 同一概念跨操作使用同一字段名和数据类型。
- 每个操作只有一个明确目的；避免通过多个互斥字段隐式切换模式。

MCP 可以继续把每个公开操作投影成独立 Tool，以利用 Tool Schema 帮助模型正确填参；MCP Tool 调用在 Facade 内转换为同一个规范请求。CLI 和 MCP 都由相同契约生成并保持传输等价，不能形成两套规则。

CLI transport 与现有 Case Runtime 一致：命令只负责绑定作用域，Agent 通过 stdin 一次提交一个规范 JSON 请求。Workspace 暴露的 Coordinator 启动命令已绑定 workspace，`prepareRun.input` 只需要 `caseNos`；首次成功响应返回一个 run-bound `command`，后续 `confirmRun`、`advanceRun`、`cancelRun` 和 `read` 都原样执行这一个 command 并通过 stdin 传请求。不再发布或消费 `requestPath`，也不再为四个操作生成不同命令。Loader/Bootstrap 的 `loaderCommand` 仍是无业务输入的一次性 transport，不与 run-bound command 混用。

### 操作目录

下表是首轮 Case Runtime operation 目录。首轮改造保留现有领域能力，避免同时重写业务流程；只统一外壳、字段和职责：

| 操作 | 目的 | 主复杂结果 |
|---|---|---|
| `observe` | 采集当前 Scene | Scene |
| `read` | 读取一个复杂资源 | 被引用资源 |
| `inspect` | 登记 Agent 已观察到的视觉或动作事实 | 无 |
| `plan` | 创建或修订 Case Flow | 无，返回 `caseFlowRef` |
| `recordResult` | 记录检查点处置 | 无，返回结果引用 |
| `act` | 执行一个设备动作并采集新 Scene | Scene |
| `runPlan` | 执行确定性短时命令集合 | Plan Result |
| `knowledge` | 查询知识或登记候选复核 | 查询时为 Candidate Set；复核时无 |
| `recover` | 执行授权恢复或登记框架外事实 | 恢复产生 Scene 时为 Scene |
| `finish` | 从检查点台账收口 | 无，返回 `caseResultRef` |

`read` 同时加入 Coordinator operation 目录；Agent 始终通过返回该 ref 的同一绑定 Facade 读取。Bootstrap 是一次性 handoff consumer，不增加自己的 `read` operation；它返回的 `caseBriefRef` 由随后绑定的 Case Runtime `read` 解析。Coordinator 的其他 operation 保留 `prepareRun`、`confirmRun`、`advanceRun`、`cancelRun`，只迁移到统一 `{ operation, input }` 外壳。

本次不以减少操作名称数量为目标。简单性来自统一外壳、清晰目的和最少必填输入，而不是把不同副作用强行合并为一个万能操作。

`inspect` 中现有的 elements/layout 读取职责分别迁移到 `read(elementSetRef)` 和 `read(layoutRef)`；`read(sceneRef)` 只返回规范决策 Scene 及这些关联引用。`inspect` 只保留登记 Agent 观察事实的副作用。现有多模式操作保留名称，但统一增加必填 `input.mode` discriminator，不再通过“某字段存在则切换模式”：

- `inspect.mode`：`visual` 或 `action`。
- `knowledge.mode`：`query` 或 `review`。
- `recover.mode`：`restart`、`prepare` 或 `external`。
- `finish.mode`：`complete` 或 `notRun`。

每个 mode 在 `PUBLIC_CONTRACT` 中是独立的 discriminated-union 分支，生成器分别输出最小签名和示例。Agent 先选择明确 mode，再按该分支填入业务输入；不同 mode 的字段不能混用。

### Case Runtime 响应白名单

每个 `PUBLIC_CONTRACT.methods` 条目必须声明 `responseProjection`。没有 outcome 分支的操作至少包含 `resultFields`、`primaryResourceType` 和 `associatedResourceTypes`；一个 operation/mode 会形成多种主结果时，必须继续按 `result.outcome` 声明互斥分支，不能使用一个宽松的类型并集掩盖条件关系。首轮固定如下：

| operation/mode | `result` 允许字段 | `data.type` | `resources` 允许类型 |
|---|---|---|---|
| `observe` | `outcome`、`sceneRef` | `scene` | `screenshot`、`layout`、`elementSet`、`actionSpatialEvidence`、`technicalFact` |
| `read` | `outcome`、`resourceRef`、`resourceType` | 被读取资源类型 | 仅被读取资源规范内容中声明的关联资源 |
| `inspect.visual/action` | `outcome`、`sceneRef`、`inspectionId`、`checkNodeIds` | 无 | `scene`、`screenshot`、`actionSpatialEvidence` |
| `plan` | `outcome`、`caseFlowRef`、`revision`、`idempotent`、`retiredNodeIds`、`retiredEdgeIds`、`invalidatedResultRefs` | 无 | `caseFlow`、`checkpointLedger`、`checkpointResult` |
| `recordResult` | `outcome`、`recordedResultRefs`、`idempotentCheckNodeIds` | 无 | `checkpointResult`、`checkpointLedger` |
| `act` | `outcome`、`operationId`、`deliveryStatus`、`outcomeKnown`、`sceneRef` | `scene` | `screenshot`、`layout`、`elementSet`、`actionSpatialEvidence`、`technicalFact` |
| `runPlan` | `outcome`、`planResultRef`、`planId`、`idempotent` | `planResult` | `scene`、`screenshot`、`actionSpatialEvidence`、`planEvidence`、`technicalFact` |
| `knowledge.query` | `outcome`、`knowledgeQueryRef`、`candidateSetRef`、`candidateCount`、`reviewRequired` | `candidateSet` | `knowledgeQuery`、`knowledgeDocument` |
| `knowledge.review` | `outcome`、`knowledgeQueryRef`、`knowledgeReviewRef`、`conclusion`、`idempotent` | 无 | `knowledgeQuery`、`candidateSet`、`knowledgeReview` |
| `recover.restart/prepare` | `outcome`、`sceneRef`、`preparationState` | `scene` | `screenshot`、`layout`、`elementSet`、`technicalFact` |
| `recover.external` | `outcome`、`externalActionDeclarationRef`、`verificationRequired` | 无 | `externalActionDeclaration`、`technicalFact` |
| `finish.complete/notRun` | `outcome`、`executionId`、`verdict`、`caseResultRef`、`idempotent` | 无 | `caseResult`、`checkpointLedger`、`technicalFact` |

表中没有声明的字段不得进入成功响应。错误响应使用公共 error projector，并只允许当前错误定义显式声明的恢复资源类型。`knowledge.review` 发布的 `knowledgeReview` 是本次复核事件的引用，不再次返回候选正文；`recover.external` 发布的 `externalActionDeclaration` 明确标记 `evidence: false` 和 `verificationRequired: true`，不返回旧 Scene 造成“已经验证”的误解，后续必须显式 `observe`。

### Coordinator 响应白名单

Coordinator `PUBLIC_CONTRACT` 使用同一个 `responseProjection` 结构。`runDecision` 通过内容字段 `kind` 区分 `ENVIRONMENT`、`DEVICE` 和 `BINDING`，避免为三个结构高度相近的用户决策维护三套读取规则。`advanceRun` 和 `cancelRun` 再按确定性状态机已经产出的 `result.outcome` 选择唯一投影：

| operation/mode/outcome | `result` 允许字段 | `data.type` | `resources` 允许类型 |
|---|---|---|---|
| `read` | `outcome`、`resourceRef`、`resourceType` | 被读取资源类型 | 仅被读取资源规范内容中声明的关联资源 |
| `prepareRun.NEED_USER_CONFIRMATION` | `outcome`、`phase`、`command` | `runDecision` | `coordinatorDiagnostic` |
| `confirmRun.*.NEED_USER_CONFIRMATION` | `outcome`、`phase`、`command` | `runDecision` | `coordinatorDiagnostic` |
| `confirmRun.USE_CURRENT/CONFIRM_BINDING.CONFIRMED` | `outcome`、`phase`、`command` | 无 | 无 |
| `advanceRun.NEED_USER_CONFIRMATION` | `outcome`、`phase`、`command` | `runDecision` | `coordinatorDiagnostic` |
| `advanceRun.CONFIRMED` | `outcome`、`phase`、`command` | 无 | 无 |
| `advanceRun.NEED_CASE_AGENT` | `outcome`、`phase`、`caseNo`、`command` | `caseDispatch` | 无 |
| `advanceRun.WAITING` | `outcome`、`phase`、`waitFor`、`caseNo`、`command` | `runProgress` | `coordinatorDiagnostic` |
| `advanceRun.COMPLETE/BLOCKED` | `outcome`、`phase`、`reportStatus`、`command` | `runSummary` | `coordinatorDiagnostic` |
| `cancelRun.WAITING` | `outcome`、`phase`、`waitFor`、`caseNo`、`command` | `runProgress` | `coordinatorDiagnostic` |
| `cancelRun.COMPLETE/BLOCKED` | `outcome`、`phase`、`reportStatus`、`command` | `runSummary` | `coordinatorDiagnostic` |

每个 Coordinator 主资源都完整内联在当前响应的 `data` 中，并同时发布可重读 ref。`runDecision` 包含当前原因、可选决策、已确认环境或探测设备和所需字段；`caseDispatch` 包含 Case Agent 启动所需的 `loaderCommand` 和 delegation prompt；`runProgress` 包含当前等待对象和已有进度事实；`runSummary` 包含终态、取消/阻塞原因和报告发布结果。`result.command` 始终是同一个 run-bound command；`statePath`、request path 和其他内部绑定不作为 Agent 参数或响应字段暴露。

已知的 `NEED_USER_CONFIRMATION`、`NEED_CASE_AGENT`、`WAITING`、`COMPLETE` 和 `BLOCKED` 都表示 Coordinator 成功处理了当前请求，因此顶层为 `SUCCEEDED`，原状态放入 `result.outcome`。只有请求拒绝、技术失败或 effect 结果未知才使用其他三个公共状态。

### Bootstrap 响应白名单

Bootstrap 不是可反复调用的领域 operation，但它的成功和失败仍使用公共响应外壳：

| operation/outcome | `result` 允许字段 | `data.type` | `resources` 允许类型 |
|---|---|---|---|
| `bootstrap.CASE_BRIEF_READY` | `outcome`、`executionId`、`dispatchMode`、`dispatchSequence` | `caseBrief` | `scene`、`screenshot`、`layout`、`elementSet`、`caseFlow` |
| `bootstrap` 失败 | 无业务字段 | 无 | 仅错误定义显式声明的 `technicalFact` |

成功响应在 claim dispatch lease 后返回完整 `caseBrief`，不再并列返回 `casePrompt`、`brief`、`scene` 等重复顶层对象。Case Agent prompt 作为 Case Brief 的启动字段之一冻结；关联 Scene 和 Case Flow 若已存在，既可在 Brief 内作为启动必需内容出现，也必须带可重读的资源引用。Bootstrap 的 transport 参数仍由不可修改的 `loaderCommand` 预绑定，不要求 Agent 拼装 handoff path、SHA 或 claim token。

### 动作模型

`act` 使用 discriminated union，并保留“Runtime 发布的确定性 ActionRef”和“Agent 自主视觉动作”两条路径。两者是并列能力，ActionRef 不是白名单。

使用 Runtime 发布的控件或屏幕 ActionRef：

```json
{
  "operation": "act",
  "input": {
    "sceneRef": "scene-0042",
    "action": {
      "ref": "button-12:tap"
    }
  }
}
```

使用 Agent 根据截图自主决定的坐标：

```json
{
  "operation": "act",
  "input": {
    "sceneRef": "scene-0042",
    "action": {
      "type": "tap",
      "target": { "point": [0.52, 0.73] }
    }
  }
}
```

- `action.ref` 原样使用 Scene 发布的 ActionRef，可覆盖控件动作和 `screen:back`、`screen:home`、`screen:wait`、`screen:dismissKeyboard`、方向滚动、当前焦点输入等屏幕动作。
- ActionRef 分支允许的动态 `input` 只由该引用声明：`inputText` 使用 `text` 和可选 `mode`，`longPress` 使用 `durationMs`，`wait` 使用 `ms`；无动态输入的引用不得携带 `input`。
- 自主视觉分支只允许 `tap`、`doubleTap`、`longPress` 和 `swipe`。前三者使用归一化 `target.point`；`swipe` 使用归一化 `target.from` 和 `target.to`；`longPress` 额外要求 `durationMs`。
- 首轮不新增 `target.region`，因为当前普通 `act` 没有区域动作语义；区域定位继续属于 `runPlan` 的 locator 能力。
- `sceneRef` 保留为动作并发前置条件，防止 Agent 基于旧画面执行；它不是 Runtime 业务判断。
- `purpose`、平台和内部 capability ID 不作为必填 Agent 参数。
- 现有“视觉坐标动作要求先登记同一 Scene 的视觉事实”规则本次保持不变；本方案不新增其他视觉动作门禁。是否取消该既有登记门禁属于独立行为变更，不在响应协议改造中顺带处理。

公开 Action Schema 固定为：

```text
PublishedAction = { ref, input? }
VisualTap = { type: "tap" | "doubleTap", target: { point } }
VisualLongPress = { type: "longPress", target: { point }, durationMs }
VisualSwipe = { type: "swipe", target: { from, to } }
```

`action.ref` 与 `action.type` 互斥。Facade 将 ActionRef 分支解析为现有内部 capability，将视觉分支翻译为现有 normalized visual gesture，不修改 Adapter 动作契约。

## 统一响应模型

所有响应使用同一外壳：

```json
{
  "protocol": "agent-facing",
  "status": "SUCCEEDED",
  "operation": "recordResult",
  "result": {
    "outcome": "RESULTS_RECORDED",
    "recordedResultRefs": ["checkpoint-result-0091"],
    "idempotentCheckNodeIds": []
  },
  "resources": [
    {
      "ref": "checkpoint-result-0091",
      "type": "checkpointResult",
      "role": "recorded_result"
    },
    {
      "ref": "checkpoint-ledger-0007",
      "type": "checkpointLedger",
      "role": "updated_state"
    }
  ]
}
```

字段职责：

- `protocol`：协议身份。
- `status`：统一执行状态，只允许 `SUCCEEDED`、`REJECTED`、`FAILED`、`UNKNOWN`。
- `operation`：被处理的公开操作；JSON 无法解析或 operation 无法识别时为 `null`。
- `result`：本次操作的简单结果；只允许标量、标量数组和小型固定结构。
- `data`：可选；只在本次操作明确请求或产生一个主复杂结果时出现。
- `resources`：相关复杂资源的类型化引用，不携带资源内容。
- `error`：`status !== "SUCCEEDED"` 时必填，提供稳定错误码、是否可重试、结构化问题和定向文档引用。

公共状态的精确定义：

| `status` | 含义 | 副作用与重试 |
|---|---|---|
| `SUCCEEDED` | 请求已被接受，并形成可审计的权威结果 | 操作特有状态放在 `result.outcome`；`PLAN_PARTIAL`、Coordinator `BLOCKED` 等已知终态仍属于成功处理的结果 |
| `REJECTED` | 请求结构、引用、并发前置条件或业务收口前置条件不满足，且不可逆 effect 尚未开始 | 根据 `error.retryable` 和 issues 修正；例如输入错误、`SCENE_CHANGED`、`CASE_RESULT_INCOMPLETE` |
| `FAILED` | 请求已通过公开校验，但发生结果已知的技术失败 | 不把技术失败解释为产品 FAIL；技术处置后根据错误文档决定是否新建请求 |
| `UNKNOWN` | 设备 effect 可能已经投递，结果无法确定 | `error.retryable` 固定为 `false`；禁止自动重放，先读取已有证据并重新观察 |

领域状态不再占用顶层 `status`。例如：

- `observe`：`status: "SUCCEEDED"`，`result.outcome: "SCENE_CAPTURED"`。
- `runPlan`：结果已知时，`result.outcome` 为 `PLAN_COMPLETED`、`PLAN_PARTIAL` 或 `PLAN_INTERRUPTED`；若中断原因是动作投递结果未知，顶层必须使用 `UNKNOWN`，同时保留 `result.outcome: "PLAN_INTERRUPTED"`。
- `finish` 未满足检查点闭环：`status: "REJECTED"`，错误码 `CASE_RESULT_INCOMPLETE`。
- 动作投递结果未知：`status: "UNKNOWN"`，错误码 `ACTION_OUTCOME_UNKNOWN`。
- Coordinator 推进到终态阻塞：请求本身成功，`status: "SUCCEEDED"`，`result.outcome: "BLOCKED"`，诊断资源按引用返回。

`result` 和 `resources` 在所有响应中必须存在，分别至少为 `{}` 和 `[]`。`data` 只在 `SUCCEEDED` 且存在主复杂结果时出现。MCP `isError` 固定为 `status !== "SUCCEEDED"`，不再维护一套状态名称列表。

带主数据的响应示例：

```json
{
  "protocol": "agent-facing",
  "status": "SUCCEEDED",
  "operation": "observe",
  "result": {
    "outcome": "SCENE_CAPTURED",
    "sceneRef": "scene-0043"
  },
  "data": {
    "ref": "scene-0043",
    "type": "scene",
    "content": {
      "capturedAt": "2026-09-22T10:00:00.000Z",
      "screenshotRef": "screenshot-0043",
      "controls": []
    }
  },
  "resources": [
    {
      "ref": "screenshot-0043",
      "type": "screenshot",
      "role": "visual_evidence"
    },
    {
      "ref": "layout-0043",
      "type": "layout",
      "role": "structural_evidence"
    }
  ]
}
```

### 响应投影规则

1. 每个操作定义独立的允许字段集合，投影器从空对象构建响应。
2. 禁止使用 `{ ...internalResponse }` 后删除字段的黑名单方式。
3. 非主复杂数据只能进入 `resources`，不得作为公共状态自动追加。
4. 同一资源在一次响应中只能有一个权威引用描述，不得经其他状态字段重复携带内容。
5. 未变化的资源继续使用原引用，不重复返回内容。
6. `data` 最多承载一个本次操作的主资源；其关联资源继续放入 `resources`。
7. 请求主资源时返回完整规范内容，不静默截断、不抽样、不因体积超限拒绝。
8. CLI 输出使用紧凑 JSON；格式化只用于人工调试命令，不进入 Agent 正常传输。
9. `requiredBeforeNegativeConclusion` 等已与当前策略不一致的旧字段必须删除，不能继续出现在响应或文档中。

## 复杂资源模型

资源描述统一为：

```json
{
  "ref": "scene-0043",
  "type": "scene",
  "role": "state_after_action",
  "revision": 43,
  "integrity": "sha256:..."
}
```

只有 `ref`、`type`、`role` 必须稳定存在；`revision` 和 `integrity` 仅在权威数据已有对应事实时返回。资源描述不包含读取教程、JSON Schema 或文件系统绝对路径。

首批资源目录固定如下。下表中的 ref 形式只供实现和测试说明，Agent 仍只能复制 Runtime 返回的 ref，不能自行构造。

| `type` | 权威来源 | 规范内容 | 不可变策略 | 所属作用域终态后可读 |
|---|---|---|---|---|
| `runDecision` | Coordinator 当前阶段和环境/设备探测事实 | `kind`、原因、选择项、已知环境或设备、必填字段和当前决策所需的诊断摘要 | 每次响应前按 Coordinator state revision 原子保存，ref 绑定 revision 和 SHA-256 | 是，Coordinator 终态后仍可读 |
| `caseDispatch` | Batch 已发布的 immutable handoff public reference | caseNo、handoff ID、loaderCommand 和 delegation prompt | ref 绑定 handoff ID、dispatch sequence 和 handoff SHA-256 | 是，Coordinator 终态后仍可读 |
| `runProgress` | Coordinator state 与 Batch reconcile 的当前已知进度 | phase、waitFor、case identity 和已持久化进度事实 | 每次对 Agent 发布时原子保存，ref 绑定 state revision 和 SHA-256 | 是，Coordinator 终态后仍可读 |
| `runSummary` | Coordinator terminal state 与 report publication state | outcome、终态原因、报告发布状态和安全报告位置 | 首次进入终态时原子保存；后续幂等调用返回同一 ref 和 SHA-256 | 是 |
| `coordinatorDiagnostic` | Coordinator/Batch 已持久化 diagnostic | code、stage、log refs 和 resource facts | 绑定产生该诊断的不可变 state revision 或 Batch 事实及 SHA-256 | 是 |
| `caseBrief` | 当前 dispatch 的 Handoff 快照 | 原始用例、目标绑定、初始状态、当前决策 Scene、已有 Case Flow、Runtime 绑定摘要 | dispatch 前原子保存，ref 绑定 dispatch sequence 和内容 SHA-256 | 是 |
| `scene` | `scenes/<sceneId>.json` | Agent 决策 Scene，定义见下文 | ref 使用已发布 scene ID；禁止暴露可变的 `current-scene.json` | 是 |
| `screenshot` | 现有 screenshots 证据文件 | 安全路径、尺寸、SHA-256 和媒体类型 | 已有截图 ref + SHA-256 | 是 |
| `layout` | Scene 的 `layoutRef` 及布局证据 | 完整规范化布局内容 | 已有 layout ref + SHA-256；若当前布局只内联于 Scene，发布时落不可变布局产物 | 是 |
| `elementSet` | 对应不可变 Scene 的 `elements` | 该 Scene 的完整元素集合，不做数量截断 | ref 绑定 scene ID；从该 Scene 文件确定性读取 | 是 |
| `caseFlow` | 指定 `caseFlowRevised` 事件 | 指定 revision 的完整 Flow | ref 绑定 revision 和事件 ID；直接读取该不可变事件 | 是 |
| `checkpointLedger` | 检查点 Registry、结果和证据状态投影 | 指定时刻完整 Ledger | 每次改变 Ledger/Flow 有效状态时，在 `operations/resources/` 原子保存带 event high-water mark 和 SHA-256 的快照 | 是 |
| `checkpointResult` | `expectationResultUpdated` 事件 | 单次检查点处置及证据引用 | ref 使用 `resultUpdateId`，事件不可变 | 是 |
| `knowledgeQuery` | `knowledgeQueried` 事件 | 查询、上下文、candidateSetRef 和复核状态引用 | ref 使用 query ID，事件不可变 | 是 |
| `candidateSet` | `knowledgeQueried.candidates` | 完整候选元数据、全部已返回 snippets、诊断和 knowledgeDocument refs | ref 绑定 query ID 和事件 ID | 是 |
| `knowledgeDocument` | `knowledge/<contentSha>.md` | 单个知识候选的完整冻结正文 | content SHA-256 寻址 | 是 |
| `knowledgeReview` | `knowledgeReviewed` 事件 | query ID、结论、逐候选 assessment、自动/人工标记和上下文引用 | ref 绑定 knowledgeReviewed event ID；事件不可变 | 是 |
| `planResult` | terminal plan record | 完整计划状态、步骤、耗时和证据引用 | 仅在计划进入 terminal 状态后发布，ref 绑定 plan ID 和 record SHA-256 | 是 |
| `actionSpatialEvidence` | `action-spatial-evidence/*.json` | 动作目标、命中坐标、截图绑定、标注截图引用和几何证据 | 使用现有不可变 evidence ref 和 SHA-256；冲突写入被拒绝 | 是 |
| `planEvidence` | `operations/plan-evidence/*.json` | locator、check 或 checkpoint 的确定性技术证据 | 使用现有不可变证据 ref；冲突写入被拒绝 | 是 |
| `externalActionDeclaration` | `externalActionDeclared` 事件 | reason、summary、tool、sceneIdBefore、`evidence: false` 和 `verificationRequired: true` | ref 绑定 externalActionDeclared event ID；事件不可变 | 是 |
| `technicalFact` | 带 `technicalFactRef` 的事件 | 技术事实、作用域和有效性依据 | ref 绑定不可变事件；读取内容不把后续有效性重新写回原事实 | 是 |
| `caseResult` | 原子完成后的 `result.json` | 最终 verdict、检查点结果和证据引用 | 只在 finish commit 后发布，execution finalization 后不可改写 | 是 |

不保留含义不明确的通用 `evidence` 类型。证据必须使用 `scene`、`screenshot`、`layout`、`actionSpatialEvidence`、`planEvidence`、`technicalFact` 等具体类型，使 resolver、Agent 和看板都能确定内容 Schema。

资源尽量映射到现有权威产物，不额外复制一份响应专用数据。`caseBrief` 直接由现有不可变 Handoff envelope 解析，不再重复落盘；`runDecision`、`runProgress`、`runSummary` 和 `checkpointLedger` 这类当前没有不可变权威文件的复合投影才需要落原子快照。不能使用“读取时重新计算最新状态”的可变引用代替快照。Coordinator ref 只能由绑定该 run 的 Coordinator Facade 解析，Case Runtime ref 只能由绑定该 execution 的 Case Runtime Facade 解析；`caseBriefRef` 是唯一例外，由 Bootstrap 发布、随后绑定的 Case Runtime 解析。

### Scene 规范内容

`scene` 的规范内容是 Agent 决策投影，不是原始 Scene JSON，也不是当前最多 24 个控件的截断投影。它固定包含：

- scene ID、采集时间和 generation。
- screenshot、layout、elementSet 的资源引用。
- 目标 App 身份、signals、conflicts 和滚动/键盘上下文。
- 当前全部可用 ActionRef 及其 label、kind 和动态输入种类，不按数量截断。
- 上一动作的投递状态、结果是否已知及证据引用。

原始布局和全部非交互元素不内联到 `scene`；Agent 明确需要时分别读取 `layoutRef` 和 `elementSetRef`。因此 `observe`/`act` 可以在同一响应中提供下一步决策所需数据，又不会把原始控件树重复塞入每次响应。

### 知识规范内容

`knowledge(mode="query")` 的主数据是 `candidateSet`：包含查询上下文、所有查询服务实际返回的候选、完整候选元数据、全部已返回 snippets、filter diagnostics 和每个候选的 `knowledgeDocumentRef`。查询服务自身的领域检索结果可以声明 `truncated`，但 Agent-facing 投影不得再次按响应体积截断或抽样。

候选完整正文不重复内联在 candidate set 中；Agent 需要正文时使用同一个 `read(ref)` 读取对应 `knowledgeDocument`。pending review 只返回 `knowledgeQueryRef`、`candidateSetRef`、候选 ID 和复核状态，不重复候选元数据或 snippets。

### 统一读取

读取请求只有一个必填参数：

```json
{
  "operation": "read",
  "input": {
    "ref": "scene-0043"
  }
}
```

规则：

- `ref` 单独使用必须合法，不再要求 execution ID、类型、格式、平台或分页参数。
- 首版不增加 selector、view、fields 等可选读取语法，避免 Agent 因参数组合失败；确有需要时以新的明确需求扩展。
- 读取返回该资源的完整规范内容，作为响应 `data.content`。
- 截图等二进制资源返回可直接交给宿主查看能力的安全资源位置和完整性信息，不把二进制编码塞入 JSON。
- ref 从未发布时返回 `REJECTED / RESOURCE_UNKNOWN`，不猜测相似 ID；ref 属于其他 Facade 作用域时返回 `REJECTED / RESOURCE_SCOPE_MISMATCH`。
- 已发布资源在 run/execution 生命周期内不得过期或改指向其他内容；对应权威文件缺失、摘要不一致或内容无法解析时返回 `FAILED / RESOURCE_INTEGRITY_INVALID`，不能退化为“引用已过期”或临时重算最新内容。
- 引用解析必须限制在当前绑定的 run/execution 权威资源范围内，并复用现有 regular-file、canonical-path 和完整性校验。
- `read` 只读已发布的不可变资源，不追加业务事件、不重新计算可变状态，也不改变 Runtime 或 Coordinator 状态。
- Case Runtime execution finalized 后只允许 `read`；其他操作统一返回 `REJECTED / CASE_RUNTIME_FINALIZED`，不再通过 `finish` 或 `status` 暗中返回一份不同形状的终态响应。
- Coordinator 进入 `COMPLETE` 或 `BLOCKED` 后仍允许 `read`；`advanceRun` 和 `cancelRun` 保留现有终态幂等语义，只返回首次终态时发布的同一个 `runSummary`，不得重新推进 Batch 或生成新快照；`confirmRun` 返回 `REJECTED / COORDINATOR_TERMINAL`。
- Bootstrap 成功 claim handoff 并返回 `caseBrief` 后即结束；重复执行同一 loader 继续由现有 dispatch lease 确定性拒绝，不能为了方便读取而再次 claim。Case Agent 通过 Case Runtime `read(caseBriefRef)` 重读 Brief。

## Agent 快速掌握协议

复用现有“短索引 + 按需方法页 + 错误定向文档”机制，不增加平行文档系统。

### 启动时一次加载

Coordinator Agent 从 Workspace 契约取得启动 command，并只读取一次生成的 `references/coordinator.md`。该短索引说明：stdin 请求外壳、首次 `prepareRun`、后续单一 run-bound command、`read(ref)`、四个领域操作的最小签名，以及资源目录入口；环境、设备和绑定详情由当前 `runDecision` 主数据给出，不写入长期教程。

Bootstrap 通过统一 envelope 返回一个 `caseBrief` 主资源。Case Brief 的 Runtime 绑定摘要只提供协议身份、预绑定命令和文档入口；Case Agent 启动时读取生成的 `references/case-runtime.md`，该页包含：

1. 统一请求外壳。
2. 统一响应外壳。
3. `ref` 原样使用规则。
4. `read(ref)` 规则。
5. 操作目录及每个操作的最小签名。

方法详情和错误恢复仍按需读取，不在每次 Runtime 响应中重复。

### 操作签名要求

每个公开操作必须：

- 只有一个清晰目的。
- 声明最小必填输入和副作用。
- 提供一个可以通过正式 validator 的最小示例。
- 避免隐藏模式、互斥字段和 Runtime 已知参数。
- 对同一概念复用公共类型定义。

### 一次可修正的错误

输入错误响应固定返回：

```json
{
  "protocol": "agent-facing",
  "status": "REJECTED",
  "operation": "act",
  "result": {},
  "resources": [],
  "error": {
    "code": "AGENT_INPUT_INVALID",
    "retryable": true,
    "issues": [
      {
        "field": "input.action.target",
        "expected": "ref | point",
        "code": "FIELD_REQUIRED"
      }
    ],
    "documentationRef": "references/case-runtime/errors/transport.md#error-agent-input-invalid",
    "operationDocumentationRef": "references/case-runtime/methods/act.md"
  }
}
```

`documentationRef` 始终指向稳定错误码的原因和恢复章节；只有 operation 已识别但输入不合法时，额外返回 `operationDocumentationRef` 指向当前方法页。两者都是简单引用，不内联文档正文。错误只说明确定性问题，不返回大段教程、完整方法目录或 Runtime 推测出的下一调用。相同输入错误连续发生时继续使用现有 stalled 保护，阻止 Agent 无限猜字段。

## 现有文档机制改造

### 保留

- `scripts/case-runtime/agent-facing-contract.js` 作为 Case Runtime 公开契约来源。
- `scripts/build-agent-facing-docs.js` 生成启动索引、方法页和错误页。
- `documentationRefFor` 的定向错误路由。
- `scripts/case-runtime/mcp-server.js` 从公开契约生成 Tool Schema。
- 文档链接、预算、最小示例、CLI/MCP 等价性和角色资源测试。

### 修改

1. `PUBLIC_CONTRACT` 增加公共请求外壳、响应外壳、公共类型和资源类型目录。
2. 方法定义改为描述 `operation` 的 `input`，不再为每个方法重复顶层 `capability`。
3. 文档生成器增加统一协议段和资源目录页。
4. 方法页只生成输入、主结果、关联资源、副作用、错误和最小示例。
5. ActionRef 文档改为动作目标规则，明确控件引用与任意坐标操作并存。
6. MCP 仍生成独立 Tool，但 Tool handler 转换到统一规范请求。
7. 生成检查同时验证每个操作的响应投影定义，防止新增内部字段无意暴露。
8. 输入错误同时生成错误章节 `documentationRef` 和当前方法页 `operationDocumentationRef`；其他错误只返回错误章节引用。
9. `agent-contract-manifest` 将各自的统一协议页、`read` 方法页和资源目录加入 Coordinator/Case Agent 角色资源，保证 Prompt digest 与实际文档一致。

不新增手写 `read` 教程、第二套资源 Schema 或独立协议清单。所有生成内容必须由 `PUBLIC_CONTRACT` 派生。

## Runtime 与 Facade 边界

### 公共 Envelope Contract

共享模块只定义：请求外壳、响应外壳、四种公共状态、资源描述、错误结构和通用 Schema 组合函数。它不包含 Coordinator 或 Case Runtime 的业务 operation，不读取 execution，也不执行资源解析。

### Agent-facing Facade

Coordinator Facade 和 Case Runtime Facade 各自负责：

- 校验统一公开请求。
- 把公开 operation 翻译为现有内部 Runtime operation。
- 通过本领域 resource resolver 解析公开资源引用。
- 根据操作白名单构造统一响应。
- 生成错误的 `documentationRef`。

Loader/Bootstrap 使用同一个 response builder，但没有通用 Agent 输入；成功时投影 `bootstrap` 的 `caseBrief` 主数据，失败时投影统一错误结构。

### Runtime Core

继续负责：

- Scene 采集、设备动作、短时计划、知识查询、恢复、结果记录和完成事务。
- 内部 operation 校验和状态机。
- 权威事件与产物持久化。
- 技术事实和完整性校验。

Runtime Core 不负责决定 Agent 是否需要某项复杂数据，也不负责裁剪响应。Agent-facing Facade 根据公开契约决定哪些内部事实是简单结果、主数据或关联资源。

Coordinator Core 同样保持确定性状态机职责：环境探测、用户确认、dispatch、等待、取消和报告发布事实仍由现有服务产生；Coordinator Agent-facing projector 只负责统一外壳和复杂数据引用，不重新解释批次状态。

### Report 与 Dashboard

报告继续从 execution 权威事件、快照和产物投影，不从 Agent 响应回放业务状态。协议改造不会删除看板需要的数据，只改变这些数据是否在每次 Agent 响应中重复出现。

看板首轮不增加新的业务页签。协议可观测性进入 execution metrics/telemetry，供排障和后续优化使用：

- operation
- status
- serialized response bytes
- result bytes
- primary data bytes 和类型
- resource descriptor bytes 和数量
- resource type counts
- `read` 的目标 resource type
- documentationRef 数量
- Runtime/Facade 投影耗时

这些指标使用共享的 telemetry event Schema，但分别写入 Coordinator run 和 Case execution 的现有作用域；不建立跨 run 的可变全局状态。事件只记录组成、耗时和类型，不记录资源正文、loader command、用户输入或知识内容。Report projection 可以聚合 operation/status/资源类型/读取频次和字节组成，首轮看板不展示；后续增加面板时不需要回放 Agent 响应正文。

这些指标只记录事实，不触发截断、拒绝或降级。telemetry 写入失败也不能改变业务响应，只记录非阻塞诊断日志。

## 数据闭环

一次调用的数据流：

```text
Agent 统一请求
  -> Agent-facing validator
  -> request translator
  -> Runtime internal operation
  -> 权威事件/产物持久化
  -> operation response projector
  -> 简单 result + 可选主 data + resources
  -> telemetry 记录响应组成
```

后续读取：

```text
Agent read(ref)
  -> resource resolver
  -> execution 范围和完整性校验
  -> 读取权威产物或确定性投影
  -> data.content 完整返回
```

报告链路独立读取同一权威事件和产物，因此 Agent 是否读取某个资源不会影响看板数据完整性。

## 失败与恢复

- 请求结构错误：返回 `REJECTED / AGENT_INPUT_INVALID`、精确 field/expected、错误文档引用和当前操作文档引用；不执行副作用。
- 引用未知：返回 `REJECTED / RESOURCE_UNKNOWN`；不猜测路径或相似 ID。
- 引用作用域不匹配：返回 `REJECTED / RESOURCE_SCOPE_MISMATCH`；Agent 应使用发布该 ref 的原绑定 Facade，Runtime 不代理跨作用域读取。
- 资源损坏：返回 `FAILED / RESOURCE_INTEGRITY_INVALID` 和技术事实引用。
- 动作 Scene 过期：返回 `REJECTED / SCENE_CHANGED`，含义仍是并发前置条件失败，不代表截图发生变化。
- 动作投递结果未知：返回 `UNKNOWN / ACTION_OUTCOME_UNKNOWN`，保留禁止重放规则，并返回已有 Scene/技术事实引用。
- 主数据读取发生技术失败：不得退化为残缺内容；返回 `FAILED` 和已持久化的诊断引用。

错误响应同样使用操作白名单投影，不自动附加 Scene、Case State、知识状态或其他复杂内容。

## 兼容与迁移

本次修改公开请求、公开响应、资源引用和 execution 内协议绑定，属于不兼容变更：

- execution schema 从 13 升级到 14。
- schema 14 只使用新的统一公开协议。
- Runtime、Batch、Case Agent Client 和 Report Reader 不为 schema 13 execution 增加续写或转换路径。
- 旧 execution 保持原文件不变；需要继续执行时使用当前 Skill 新建 execution。
- 当前代码升级后不再生成或读取 schema 13 报告；需要保留的旧报告应在升级前作为完整静态报告目录归档，不能依赖新 Reader 重新发布。
- 代码中不保留 `v1`/`v2` 双分支、旧 translator 或旧 response projector。
- 文档、Prompt digest、MCP Tool 定义和预绑定客户端随 schema 14 一次更新，协议不一致时返回 `PROTOCOL_MISMATCH`。

Workspace 顶层格式不因本次改造升级；不兼容边界限定在 execution schema 14。新客户端不得续写 schema 13 execution，报告也不增加 schema 13 到 14 的转换逻辑。

## 实现范围

### 核心契约与 Facade

- 新增 `scripts/lib/agent-facing-envelope-contract.js`，只保存共享 envelope/status/error/resource descriptor Schema 和 builder。
- `scripts/case-runtime/agent-facing-contract.js`
- `scripts/case-runtime/agent-facing-client.js`
- `scripts/case-runtime/agent-facing-translator.js`
- `scripts/case-runtime/mcp-server.js`
- `scripts/coordinator/agent-facing-contract.js`
- `scripts/coordinator/agent-facing-service.js`
- `scripts/coordinator-agent.js`
- `scripts/case-agent-bootstrap.js`
- `scripts/case-runtime/lifecycle.js` 的 Case Brief/Handoff 投影
- Coordinator 和 Case Runtime 各自新增聚焦的 resource catalog/resolver；共享模块只提供 descriptor/完整性工具，不能把资源解析堆入 translator 或公共 envelope contract。

### Runtime 与持久化

- `scripts/case-runtime/runtime-core.js`
- `scripts/case-runtime/store.js`
- Scene、Case Flow、知识、Plan、证据和结果服务只补充稳定引用或投影入口，不改变领域职责。
- 移除全局附加 `knowledgeInvestigationStatus` 等无请求语义的响应拼装。

### 文档与 Prompt

- `scripts/build-agent-facing-docs.js`
- `scripts/lib/agent-contract-manifest.js`
- `references/case-runtime.md`
- `references/coordinator.md`
- `references/case-runtime/methods/*.md`
- `references/coordinator/methods/*.md`
- 新增两个 Facade 各自生成的资源目录页。
- `SKILL.md` 和 Case Agent Prompt 只更新启动读取和统一协议原则。

### 观测与报告

- 新增共享的 Agent-facing telemetry event Schema；`scripts/case-runtime/telemetry.js` 和 Coordinator metric sink 分别负责本作用域落盘。
- execution metrics/report projection 仅增加协议响应组成指标。
- 看板首轮不展示新的流程图或业务面板。

### Execution Schema 迁移

schema 14 迁移必须一次性更新所有生产检查点，不能只修改 lifecycle 常量。当前明确包含：

- `scripts/case-runtime/lifecycle.js`
- `scripts/case-runtime/store.js`
- `scripts/case-runtime/agent-facing-client.js`
- `scripts/case-runtime/result-integrity.js`
- `scripts/case-runtime/telemetry.js`
- `scripts/batch/completion-service.js`
- `scripts/batch/completion.js`
- `scripts/batch/dispatch-service.js`
- `scripts/batch/reconcile-service.js`
- `scripts/execution/contracts/validation-profile-contract.js`
- `scripts/lib/completion-contract.js`
- `scripts/lib/execution-artifact-manifest.js`
- `scripts/lib/execution-closure.js`
- `scripts/lib/execution-evidence-graph.js`
- `scripts/lib/execution-lifecycle.js`
- `scripts/lib/readers/current-execution.js`

实现时先通过仓库搜索重新生成该清单，测试必须断言生产代码中不再残留 schema 13 常量。所有 fixture、boundary test、publication、Reader 和三端采集测试同步更新为 schema 14。

## 实施顺序

1. **公共契约先行**：用失败测试固定共享 envelope、四种 status、error、resource descriptor，以及 Coordinator/Bootstrap/Runtime 的传输映射。
2. **领域契约固化**：定义最终 operation 目录、显式 mode 分支、完整 Action union、逐操作主数据和响应 allowlist。
3. **不可变资源**：建立各领域 resource catalog/resolver，复用 Handoff 解析 Case Brief，并先实现 Coordinator 复合资源、Checkpoint Ledger 原子快照和 finalized 后只读行为。
4. **Case Runtime 响应投影**：逐操作实现 allowlist projector，删除 spread-and-delete 路径和公共 Scene/Case State/知识状态追加。
5. **请求统一**：Facade 接受 `{ operation, input }`，内部 translator 继续映射到现有 Runtime operation；保留 ActionRef 与视觉坐标动作。
6. **读取能力**：实现 `read(ref)`，保证单必填参数、完整读取、引用安全、finalized 后只读和稳定错误。
7. **Coordinator 与 Bootstrap 投影**：把现有状态响应和 Case Brief 转为同一 envelope，不改变确定性状态机和 dispatch 行为。
8. **文档与 MCP**：从同一契约生成统一索引、方法页、资源页和 MCP Tool 定义，保持传输等价。
9. **schema 14 迁移清理**：一次更新全部生产检查点和 fixtures，删除旧 Agent-facing translator/projection 兼容路径和过期策略字段。
10. **观测与回归**：记录响应组成，验证高频调用不再携带无关数据，复杂读取仍能完整返回。

## 验证标准

### 契约

1. 所有可调用公开能力都符合 `{ operation, input }` 外壳；无业务输入的 Loader/Bootstrap 只验证预绑定 transport，不伪造请求对象。
2. Coordinator、Loader/Bootstrap、Case Brief 和 Case Runtime 的所有公开响应都符合统一响应 Schema。
3. 顶层 `status` 只出现 `SUCCEEDED`、`REJECTED`、`FAILED`、`UNKNOWN`；现有领域状态全部映射到 `result.outcome` 或稳定错误码。
4. 每个 operation 都有 validator、最小示例、成功投影、错误投影和生成文档。
5. CLI、MCP 和生成文档使用同一 `PUBLIC_CONTRACT`，测试证明传输等价。
6. 无法解析或无法识别 operation 的请求仍能形成 `operation: null` 的合法错误 envelope。
7. 每个公开业务 `*Ref` 字段都能映射到资源目录类型并由所属 Facade 的 `read(ref)` 成功读取；领域 ID 不以 `*Ref` 命名，错误对象中的两个静态文档路径按明确例外验证。
8. Coordinator 首次启动和 run-bound client 都从 stdin 接受统一请求；公开响应、Skill 和生成文档不再包含 `requestPath` 或多命令调用规则。

### 响应语义

1. `recordResult`、`plan`、`finish` 不再返回当前 Scene 或完整 Case State。
2. `observe`、`act` 返回一次完整决策 Scene 及其引用，全部可用 ActionRef 不按数量截断，原始 element/layout 只通过引用按需读取。
3. `knowledge` 候选只在查询主数据中出现一次，pending review 只保留 query/candidate set 引用。
4. `inspect` 不再承担 elements/layout 读取；`read(sceneRef)`、`read(elementSetRef)`、`read(layoutRef)` 分别获得规范 Scene、完整元素集合和完整布局。
5. 任何新增内部 Runtime 字段都不会自动出现在 Agent 响应中。
6. 不存在按字节数截断主数据的代码路径。
7. Case Brief 是唯一主数据资源，不再把 Scene、Case Flow 或来源文本作为未声明顶层字段散落返回。
8. 主资源不在同一响应的 `resources` 中重复出现；descriptor 只描述关联资源。
9. `knowledge.review` 返回可读的复核事件引用而不重复候选正文；`recover.external` 返回未验证声明引用且不附带旧 Scene。

### Agent 可用性

1. Agent 读取一次短索引后，可以仅凭最小签名完成每个操作的成功调用。
2. `read` 只提供 `ref` 时可以成功，不要求补充上下文。
3. 控件/屏幕 ActionRef、视觉 tap/doubleTap/longPress/swipe、输入、等待、返回、Home、方向滚动和收起键盘均有回归测试。
4. 输入错误能根据一个精确 issue 和文档引用完成一次修正；同类错误重复时停止猜测。
5. 033 等时间敏感场景继续使用 `runPlan`，协议改造不得增加计划内部 Agent 往返。
6. 输入错误同时提供错误章节和当前 operation 方法页引用；非输入错误不附带无关方法文档。
7. Coordinator Agent 只需保留一个 run-bound command；Case Agent 只需保留一个 execution-bound command，两者的业务请求外壳完全一致。

### 数据与看板

1. Agent 不读取某资源时，权威 execution 数据和报告内容仍完整。
2. 资源引用可以解析到报告当前使用的权威产物或确定性投影。
3. telemetry 能区分简单结果、主数据和资源描述的响应组成，但不会影响 Runtime 行为。
4. 报告 Reader 不读取 Agent-facing 响应作为业务事实源。
5. 同一个 `checkpointLedgerRef`、`caseBriefRef`、`caseFlowRef` 或 `planResultRef` 在 execution 后续变化及 finalized 后读取时内容和 SHA-256 均保持不变。
6. finalized execution 只允许 `read`，任何写操作都被确定性拒绝且不追加业务事件。
7. Coordinator telemetry 和 Case Runtime telemetry 使用同一事件 Schema，报告可聚合资源类型与读取频次，但原始响应和资源正文不进入 metrics。
8. Coordinator 终态的重复 `advanceRun`/`cancelRun` 返回同一 `runSummary` `data.ref`；Bootstrap 的重复 claim 被拒绝，Case Brief 仍可从 Case Runtime 重读。

### 完整回归

1. Agent-facing contract、Coordinator/Bootstrap/Case Runtime transport、docs、MCP parity、architecture boundary 测试通过。
2. Scene、action、plan、knowledge、checkpoint、finish 和 recovery 测试通过。
3. 三端 Adapter 和 033 时间窗口回归通过。
4. `node scripts/self-test.js`、生成文档检查和 `git diff --check` 通过。
5. 仓库生产代码不再包含 schema 13 判断或常量；schema 13 execution 统一返回格式不支持且不会被新 Reader 重新发布。

## 风险与控制

### 额外读取往返

如果所有复杂数据都只给引用，`act` 和 `observe` 会增加必然的读取调用。通过“主复杂结果允许内联”规则避免该问题；关联数据仍只给引用。

### 操作数量与签名复杂度

盲目减少 operation 数量会形成多模式大接口。以目的单一、必填字段少和无隐藏条件为评审标准，不以名称数量作为指标。

### 文档漂移

只允许修改 `PUBLIC_CONTRACT` 和生成器，生成文档必须通过 `--check`；禁止手工维护平行 Schema。

### Runtime 变重

resource resolver 只做确定性类型映射、作用域校验和读取，不做视觉、业务或下一步判断；响应选择属于 Facade 的公开契约投影，不进入 Runtime Core。

### 看板数据缺失

报告继续读取权威事件和产物，不依赖响应；移除响应字段前必须验证相同事实已持久化且 Reader 有正式读取路径。

## 决策摘要

- 复用并改造现有公开契约与自动文档机制，不新增平行规则系统。
- Coordinator、Loader/Bootstrap、Case Brief 和 Case Runtime 共用同一个响应 envelope 与四态 status 模型。
- 统一请求/响应外壳，但保留语义明确的领域 operation。
- Coordinator 和 Case Runtime 分别只暴露一个作用域绑定 command，通过 stdin 接收同一请求外壳，不使用 `requestPath`。
- 简单结果直接返回；关联复杂数据只返回引用；主复杂结果按请求语义完整返回。
- 新增一个 `read(ref)` 读取规则，不增加按资源类型区分的读取接口。
- 保留现有全部 ActionRef、屏幕动作和 Agent 任意坐标视觉操作能力。
- 每种复杂资源都有明确权威来源和不可变策略；复合投影通过原子快照形成稳定引用。
- Runtime 不增加智能判断和业务门禁。
- 使用逐操作白名单投影替换内部响应复制。
- 响应体积只观测，不作为截断或拒绝依据。
- 新 execution 使用单一新协议，不保留旧协议兼容分支。

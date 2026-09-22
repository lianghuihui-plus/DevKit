# Agent-facing 统一请求响应协议改造方案

> 状态：待评审。本文定义 Agent-facing 协议、复杂资源读取、规则文档生成、迁移和验证方案；不改变 Agent 与 Runtime 的职责边界。

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

1. 所有 Agent-facing 调用使用一致的请求外壳和响应外壳。
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

所有复杂资源引用由 Runtime 完整生成。引用是 execution-scoped、类型化、不可变的句柄；Agent 原样复制使用，不根据路径、Scene ID 或资源类型自行构造。

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
- execution、平台、App、绑定命令和 Runtime 已知的当前状态不由 Agent 重复提交。
- 同一概念跨操作使用同一字段名和数据类型。
- 每个操作只有一个明确目的；避免通过多个互斥字段隐式切换模式。

MCP 可以继续把每个公开操作投影成独立 Tool，以利用 Tool Schema 帮助模型正确填参；MCP Tool 调用在 Facade 内转换为同一个规范请求。CLI 和 MCP 都由相同契约生成并保持传输等价，不能形成两套规则。

### 操作目录

首轮改造保留现有领域能力，避免同时重写业务流程；只统一外壳、字段和职责：

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
| `finish` | 从检查点台账收口 | 无，返回 `resultRef` |

本次不以减少操作名称数量为目标。简单性来自统一外壳、清晰目的和最少必填输入，而不是把不同副作用强行合并为一个万能操作。

`inspect` 中现有的 elements/layout 读取职责迁移到 `read(sceneRef)` 的资源内容；`inspect` 只保留登记 Agent 观察事实的副作用。现有多模式操作保留名称，但统一增加必填 `input.mode` discriminator，不再通过“某字段存在则切换模式”：

- `inspect.mode`：`visual` 或 `action`。
- `knowledge.mode`：`query` 或 `review`。
- `recover.mode`：`restart`、`prepare` 或 `external`。
- `finish.mode`：`complete` 或 `notRun`。

每个 mode 在 `PUBLIC_CONTRACT` 中是独立的 discriminated-union 分支，生成器分别输出最小签名和示例。Agent 先选择明确 mode，再按该分支填入业务输入；不同 mode 的字段不能混用。

### 动作模型

`act` 使用统一动作结构，并保留两类目标：

```json
{
  "operation": "act",
  "input": {
    "sceneRef": "scene-0042",
    "action": {
      "type": "tap",
      "target": { "ref": "element-12" }
    }
  }
}
```

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

- `target.ref` 是 Runtime 基于控件树提供的便利定位。
- `target.point`、`target.region` 由 Agent 根据视觉事实自主决定。
- `sceneRef` 保留为动作并发前置条件，防止 Agent 基于旧画面执行；它不是 Runtime 业务判断。
- 动态输入只保留 `text`、`durationMs`、坐标等 Agent 决策数据。
- `purpose`、平台和内部 capability ID 不作为必填 Agent 参数。

## 统一响应模型

所有响应使用同一外壳：

```json
{
  "protocol": "agent-facing",
  "status": "OK",
  "operation": "recordResult",
  "result": {
    "recorded": 1,
    "resultRef": "check-result-0091"
  },
  "resources": [
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
- `status`：本次请求的技术状态。
- `operation`：被处理的公开操作。
- `result`：本次操作的简单结果；只允许标量、标量数组和小型固定结构。
- `data`：可选；只在本次操作明确请求或产生一个主复杂结果时出现。
- `resources`：相关复杂资源的类型化引用，不携带资源内容。
- `error`：可选；失败时提供结构化问题和定向文档引用。

带主数据的响应示例：

```json
{
  "protocol": "agent-facing",
  "status": "OK",
  "operation": "observe",
  "result": {
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

首批资源类型：

- `scene`
- `screenshot`
- `layout`
- `elementSet`
- `caseFlow`
- `checkpointLedger`
- `knowledgeQuery`
- `candidateSet`
- `planResult`
- `evidence`
- `technicalFact`
- `caseResult`

资源尽量映射到现有权威产物，不额外复制一份响应专用数据：Scene 使用 scenes 目录，截图和布局使用现有证据产物，Plan Result 使用 plan record，Case Result 使用 `result.json`。对事件投影型资源，使用确定性快照或可复现投影，并保存 revision/摘要以保证引用不可变。

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
- 不存在、失效或类型不匹配时返回结构化错误，并在能够确定替代资源时返回替代引用；Runtime 不猜测 Agent 原本想读什么。
- 引用解析必须限制在当前 execution 的权威资源范围内，并复用现有 regular-file、canonical-path 和完整性校验。

## Agent 快速掌握协议

复用现有“短索引 + 按需方法页 + 错误定向文档”机制，不增加平行文档系统。

### 启动时一次加载

Case Brief 继续只提供协议身份和文档入口。Case Agent 启动时读取生成的 `references/case-runtime.md`，该页包含：

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
  "status": "INVALID_REQUEST",
  "operation": "act",
  "result": {},
  "resources": [],
  "error": {
    "code": "FIELD_REQUIRED",
    "issues": [
      {
        "field": "input.action.target",
        "expected": "ref | point"
      }
    ],
    "documentationRef": "references/case-runtime/methods/act.md"
  }
}
```

错误只说明确定性问题，不返回大段教程、完整方法目录或 Runtime 推测出的下一调用。相同输入错误连续发生时继续使用现有 stalled 保护，阻止 Agent 无限猜字段。

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

不新增手写 `read` 教程、第二套资源 Schema 或独立协议清单。所有生成内容必须由 `PUBLIC_CONTRACT` 派生。

## Runtime 与 Facade 边界

### Agent-facing Facade

负责：

- 校验统一公开请求。
- 把公开 operation 翻译为现有内部 Runtime operation。
- 解析公开资源引用。
- 根据操作白名单构造统一响应。
- 生成错误的 `documentationRef`。

### Runtime Core

继续负责：

- Scene 采集、设备动作、短时计划、知识查询、恢复、结果记录和完成事务。
- 内部 operation 校验和状态机。
- 权威事件与产物持久化。
- 技术事实和完整性校验。

Runtime Core 不负责决定 Agent 是否需要某项复杂数据，也不负责裁剪响应。Agent-facing Facade 根据公开契约决定哪些内部事实是简单结果、主数据或关联资源。

### Report 与 Dashboard

报告继续从 execution 权威事件、快照和产物投影，不从 Agent 响应回放业务状态。协议改造不会删除看板需要的数据，只改变这些数据是否在每次 Agent 响应中重复出现。

看板首轮不增加新的业务页签。协议可观测性进入 execution metrics/telemetry，供排障和后续优化使用：

- operation
- status
- serialized response bytes
- result bytes
- primary data bytes 和类型
- resource descriptor bytes 和数量
- documentationRef 数量
- Runtime/Facade 投影耗时

这些指标只记录事实，不触发截断、拒绝或降级。

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

- 请求结构错误：返回 `INVALID_REQUEST`、精确 field/expected 和方法文档引用；不执行副作用。
- 引用未知：返回 `RESOURCE_UNKNOWN`；不猜测路径或相似 ID。
- 引用已过期：返回 `RESOURCE_STALE`，并只在能确定当前替代资源时附替代引用。
- 资源损坏：返回 `RESOURCE_INTEGRITY_INVALID` 和技术事实引用。
- 动作 Scene 过期：保留 `SCENE_CHANGED`，含义仍是并发前置条件失败，不代表截图发生变化。
- 动作投递结果未知：保留禁止重放规则，返回已有 Scene/技术事实引用。
- 主数据读取失败：不得退化为残缺内容；响应返回失败状态和已持久化的诊断引用。

错误响应同样使用操作白名单投影，不自动附加 Scene、Case State、知识状态或其他复杂内容。

## 兼容与迁移

本次修改公开请求、公开响应、资源引用和 execution 内协议绑定，属于不兼容变更：

- execution schema 从 13 升级到 14。
- schema 14 只使用新的统一公开协议。
- Runtime、Batch、Case Agent Client 和 Report Reader 不为 schema 13 execution 增加续写或转换路径。
- 旧 execution 保持原文件不变；需要继续执行时使用当前 Skill 新建 execution。
- 代码中不保留 `v1`/`v2` 双分支、旧 translator 或旧 response projector。
- 文档、Prompt digest、MCP Tool 定义和预绑定客户端随 schema 14 一次更新，协议不一致时返回 `PROTOCOL_MISMATCH`。

Workspace 顶层格式不因本次改造升级；不兼容边界限定在 execution schema 14。新客户端不得续写 schema 13 execution，报告也不增加 schema 13 到 14 的转换逻辑。

## 实现范围

### 核心契约与 Facade

- `scripts/case-runtime/agent-facing-contract.js`
- `scripts/case-runtime/agent-facing-client.js`
- `scripts/case-runtime/agent-facing-translator.js`
- `scripts/case-runtime/mcp-server.js`
- 新增聚焦的 resource catalog/resolver 模块；不能把资源解析继续堆入 translator。

### Runtime 与持久化

- `scripts/case-runtime/runtime-core.js`
- `scripts/case-runtime/store.js`
- Scene、Case Flow、知识、Plan、证据和结果服务只补充稳定引用或投影入口，不改变领域职责。
- 移除全局附加 `knowledgeInvestigationStatus` 等无请求语义的响应拼装。

### 文档与 Prompt

- `scripts/build-agent-facing-docs.js`
- `references/case-runtime.md`
- `references/case-runtime/methods/*.md`
- 新增生成的资源目录页。
- `SKILL.md` 和 Case Agent Prompt 只更新启动读取和统一协议原则。

### 观测与报告

- `scripts/case-runtime/telemetry.js`
- execution metrics/report projection 仅增加协议响应组成指标。
- 看板首轮不展示新的流程图或业务面板。

## 实施顺序

1. **契约先行**：用失败测试定义统一请求/响应、操作白名单和资源描述；确定最终 operation 目录及多模式操作的显式 discriminator。
2. **资源解析**：建立 execution-scoped resource catalog/resolver，覆盖 Scene、截图、布局、Case Flow、知识候选、Plan、证据和结果。
3. **响应投影**：逐操作实现 allowlist projector，删除 spread-and-delete 路径和公共 Scene/Case State/知识状态追加。
4. **请求统一**：Facade 接受 `{ operation, input }`，内部 translator 继续映射到现有 Runtime operation；保留控件与视觉坐标动作。
5. **读取能力**：实现 `read(ref)`，保证单必填参数、完整读取、引用安全和稳定错误。
6. **文档与 MCP**：从同一契约生成统一索引、方法页、资源页和 MCP Tool 定义，保持传输等价。
7. **迁移清理**：升级 execution schema，删除旧 Agent-facing translator/projection 兼容路径和过期策略字段。
8. **观测与回归**：记录响应组成，验证高频调用不再携带无关数据，复杂读取仍能完整返回。

## 验证标准

### 契约

1. 所有公开请求都符合 `{ operation, input }` 外壳。
2. 所有公开响应都符合统一响应 Schema。
3. 每个 operation 都有 validator、最小示例、成功投影、错误投影和生成文档。
4. CLI、MCP 和生成文档使用同一 `PUBLIC_CONTRACT`，测试证明传输等价。

### 响应语义

1. `recordResult`、`plan`、`finish` 不再返回当前 Scene 或完整 Case State。
2. `observe`、`act` 返回一次主 Scene 数据及其引用，不重复嵌套同一 Scene。
3. `knowledge` 候选只在查询主数据中出现一次，pending review 只保留 query/candidate set 引用。
4. `inspect` 不再承担 elements/layout 读取；`read(sceneRef)` 可以完整获得 Scene 及其关联资源引用。
5. 任何新增内部 Runtime 字段都不会自动出现在 Agent 响应中。
6. 不存在按字节数截断主数据的代码路径。

### Agent 可用性

1. Agent 读取一次短索引后，可以仅凭最小签名完成每个操作的成功调用。
2. `read` 只提供 `ref` 时可以成功，不要求补充上下文。
3. 控件引用动作和任意坐标动作均有回归测试。
4. 输入错误能根据一个精确 issue 和文档引用完成一次修正；同类错误重复时停止猜测。
5. 033 等时间敏感场景继续使用 `runPlan`，协议改造不得增加计划内部 Agent 往返。

### 数据与看板

1. Agent 不读取某资源时，权威 execution 数据和报告内容仍完整。
2. 资源引用可以解析到报告当前使用的权威产物或确定性投影。
3. telemetry 能区分简单结果、主数据和资源描述的响应组成，但不会影响 Runtime 行为。
4. 报告 Reader 不读取 Agent-facing 响应作为业务事实源。

### 完整回归

1. Agent-facing contract、docs、MCP parity、architecture boundary 测试通过。
2. Scene、action、plan、knowledge、checkpoint、finish 和 recovery 测试通过。
3. 三端 Adapter 和 033 时间窗口回归通过。
4. `node scripts/self-test.js`、生成文档检查和 `git diff --check` 通过。

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
- 统一请求/响应外壳，但保留语义明确的领域 operation。
- 简单结果直接返回；关联复杂数据只返回引用；主复杂结果按请求语义完整返回。
- 新增一个 `read(ref)` 读取规则，不增加按资源类型区分的读取接口。
- 保留 Agent 的控件引用和任意坐标操作能力。
- Runtime 不增加智能判断和业务门禁。
- 使用逐操作白名单投影替换内部响应复制。
- 响应体积只观测，不作为截断或拒绝依据。
- 新 execution 使用单一新协议，不保留旧协议兼容分支。

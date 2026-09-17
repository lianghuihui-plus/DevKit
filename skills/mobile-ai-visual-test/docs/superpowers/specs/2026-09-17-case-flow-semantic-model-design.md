# Case Flow 语义保真用例模型设计

## 1. 背景

当前执行链路把 Case Agent 对原始用例的处理结果保存为 Case Model：

- `understanding`：整体理解。
- `preconditions`：前置条件。
- `verificationPoints`：扁平验证点列表。
- `items`：线性执行计划。
- `uncertainties`：不确定项。

这个结构解决了任意文本用例的结构化问题，但同一业务语义需要同时写入理解、验证点和计划。条件、可选路径、顺序依赖和探索范围在拆解时容易丢失，最终出现“整体理解正确，执行模型已经偏离原文”的情况。

已确认的典型问题：

1. 用例 001 明确允许系统权限弹窗不出现。Agent 在不确定项中保留了该条件，却把“弹窗出现”拆成强制验证点，最终错误 FAIL。
2. 用例 012 的目标位于可横滑区域。Agent 执行一次横滑后看到列表仍有后续内容，却按照线性计划直接收口，没有继续调查或修订路径。
3. Runtime 已有搜索缺失证据校验，但 Case Model 重构后不再传递 `verificationKind`，所有验证点被投影为 `DIRECT_OBSERVATION`，规则无法进入真实执行链路。

这些问题不应通过让 Runtime 推断业务语义来解决。Runtime 不具备业务智能；持续增加业务门禁会把执行框架变成不完整的规则引擎，并限制 Agent 的判断能力。

## 2. 目标与非目标

### 2.1 目标

1. 使用一个产物同时表达 Agent 对原始用例的理解和执行导航，消除多份语义之间的漂移。
2. 保留原始用例中的顺序、条件、可选路径、循环探索、关键检查点和歧义。
3. 允许 Agent 根据真实现场修订流程，修订只要求记录原因，不需要框架审批业务正确性。
4. 让 Runtime 只负责结构、引用、事务、证据和结果聚合等确定性工作。
5. 把业务判断原则从框架操作 Prompt 中分离，形成简短、可持续补充的业务指导文档。
6. 恢复搜索型验证点到证据校验链路，但验证类型由 Agent 声明，Runtime 不自行推断。

### 2.2 非目标

1. 不实现 BPMN、通用工作流引擎或由 Runtime 自动执行业务流程。
2. 不要求 Runtime 理解自然语言条件、判断分支是否正确或决定业务 PASS/FAIL。
3. 不预编译并冻结一份不可修改的标准答案。
4. 不让 Main Agent 参与单用例理解、流程审批或结果判断。
5. 不一次性建立庞大的业务规则库。

## 3. 核心决策

用 `Case Flow` 替代当前同时包含理解和线性计划的 Case Model。Case Flow 是 Case Agent 根据原始用例生成的、可修订的“业务意图图”：

```text
原始用例
   ↓ Case Agent 理解
Case Flow（操作 + 条件 + 检查点）
   ↓ 根据 Scene 自主选择路径
动作 / 观察 / 调查 / 结果
   ↓ 现场变化时修订并记录原因
Case Flow Revision
```

Case Flow 同时承担当前的“用例理解”和“执行计划”职责，不再维护容易相互矛盾的 `understanding + verificationPoints + items` 三份业务表达。

原始用例仍是不可变事实。Case Flow 是 Agent 的当前工作模型，不是不可挑战的新业务真相，也不能覆盖原文。

## 4. Case Flow 最小模型

### 4.1 节点类型

初始只提供四种节点：

| 类型 | 含义 | 示例 |
|---|---|---|
| `ACTION` | 需要完成的业务操作或状态建立 | 启动 App、点击允许、横向滑动工具区域 |
| `DECISION` | 根据现场事实选择后续路径 | 是否出现系统权限弹窗、列表是否还能继续滑动 |
| `CHECK` | 需要形成结果的关键检查点 | 青少年守护弹窗出现、Kids 入口存在 |
| `END` | 一条业务路径结束 | 正常结束、无法继续但证据不足 |

不单独增加 `OBSERVE`、`KNOWLEDGE`、`RECOVER` 等节点类型。这些是 Agent 为完成业务节点可选择的能力，不是原始用例的业务语义。

循环通过边回到已有节点表达，不新增专用循环语法。

### 4.2 数据结构

建议的 Agent-facing 结构：

```json
{
  "baseRevision": null,
  "summary": "验证首次启动时的授权分支和青少年守护弹窗",
  "entryNodeRef": "N1",
  "nodes": [
    {
      "ref": "N1",
      "type": "ACTION",
      "text": "启动目标 App"
    },
    {
      "ref": "N2",
      "type": "DECISION",
      "text": "是否出现系统权限弹窗",
      "sourceBasis": "若未出现系统权限弹窗，则跳过授权点击"
    },
    {
      "ref": "N3",
      "type": "CHECK",
      "text": "权限弹窗包含权限相关文案",
      "verificationKind": "DIRECT_OBSERVATION",
      "sourceBasis": "预期：弹出系统权限，含‘权限’相关文案的弹出"
    },
    {
      "ref": "N4",
      "type": "ACTION",
      "text": "点击允许"
    },
    {
      "ref": "N5",
      "type": "CHECK",
      "text": "系统权限弹窗关闭",
      "verificationKind": "DIRECT_OBSERVATION",
      "sourceBasis": "预期：系统权限弹窗关闭"
    },
    {
      "ref": "N6",
      "type": "CHECK",
      "text": "出现青少年守护相关弹窗",
      "verificationKind": "DIRECT_OBSERVATION",
      "sourceBasis": "预期：出现‘青少年守护’相关文案弹窗"
    },
    {
      "ref": "N7",
      "type": "END",
      "text": "用例完成"
    }
  ],
  "edges": [
    { "ref": "L1", "from": "N1", "to": "N2" },
    { "ref": "L2", "from": "N2", "to": "N3", "condition": "出现" },
    { "ref": "L3", "from": "N2", "to": "N6", "condition": "未出现，跳过授权处理" },
    { "ref": "L4", "from": "N3", "to": "N4" },
    { "ref": "L5", "from": "N4", "to": "N5" },
    { "ref": "L6", "from": "N5", "to": "N6" },
    { "ref": "L7", "from": "N6", "to": "N7" }
  ],
  "uncertainties": [],
  "reason": null
}
```

结构保持刻意简单：

- `text` 和 `condition` 使用自然语言，不设计条件表达式语言。
- Agent 在一次完整提交中使用简单的 `N1`、`N2` node ref 和 `L1`、`L2` edge ref 连接图；Runtime 校验格式、唯一性和历史 ref 不复用，修订时 Agent 保留仍具有相同业务含义的 ref。
- `verificationKind` 只在 `CHECK` 节点存在，初始仅支持 `DIRECT_OBSERVATION` 和 `SEARCH_EXISTENCE`。
- `DECISION` 和 `CHECK` 必须使用非空 `sourceBasis` 保留判断依据。初始版本优先引用或忠实转述原文；现场修订新增的节点可以简述触发修订的现场新事实。Runtime 只校验字段存在、保存和展示，不根据内容判断业务正确性。
- 不在节点中保存设备坐标、ActionRef、Scene id 或平台命令。
- Agent 可在 `uncertainties` 中保留原文歧义，不要求为了结构化而擅自消除歧义。

原始前置条件不再另存一份平行列表：需要 Agent 建立的状态表达为入口 `ACTION`，需要根据现场确认的前置条件表达为入口 `DECISION`。纯环境绑定事实继续由 execution binding 保存，不进入业务流程图。

Runtime 的图结构校验只包含确定性规则：

- `entryNodeRef` 必须存在，所有 node/edge ref 唯一，edge 两端必须存在。
- 至少存在一个 `CHECK` 和一个 `END`；所有节点必须从入口可达，且每个节点都至少存在一条到达 `END` 的路径。
- `END` 不得有出边；`ACTION` 和 `CHECK` 必须恰有一条不带 `condition` 的出边。
- `DECISION` 至少有两条带非空 `condition` 的出边，不允许其他节点通过多出边或条件边表达隐式分支。
- 允许回边和循环，不要求拓扑排序，也不限制 Agent 选择哪一条条件边。

### 4.3 修订

首次 `plan` 创建 revision 1。后续现场与原计划不一致时，Agent 提交完整 Case Flow 新版本并说明 `reason`。

允许的修订包括：

- 增加诊断或探索路径。
- 将一个模糊节点拆成多个节点。
- 合并重复检查点。
- 根据新事实增加或取消分支。
- 修正之前对原始用例的误解。

框架保存每个 revision 和修改理由，不审批修改是否符合业务。执行事件绑定当时的 Case Flow revision，报告据此还原现场。

CHECK 结果的语义身份不能只取决于 `text`。语义哈希至少包含 `type`、`text`、`verificationKind` 和 `sourceBasis`；这些字段变化或节点被取消时，Runtime 机械失效该 CHECK 已有结果。仅调整图拓扑或边条件时不自动否定已有现场事实，Agent 负责根据新路径把不再适用的结果更新为 `NOT_APPLICABLE`，并把从不适用变为实际经过的 CHECK 更新为真实结果。finish 前必须按当前 revision 重新核对这种适用性变化。

## 5. Agent 执行语义

### 5.1 Case Agent 的职责

Case Agent：

1. 阅读完整原始用例和业务判断指南。
2. 生成 Case Flow，并检查条件、可选内容、顺序和检查点是否忠于原文。
3. 根据当前 Scene 选择路径并使用 Runtime 能力完成节点意图。
4. 现场与当前流程不一致时主动观察、调查或修订 Case Flow。
5. 对实际经过的 `CHECK` 节点形成结果；未进入的条件分支不能造成 FAIL。
6. finish 前重新核对原始用例、当前 Case Flow、实际路径和结果是否一致。

Case Flow 是导航，不是限制。技术异常或框架能力不足时，Agent 仍可在当前 execution 授权范围内使用其他工具调查，随后回到 Runtime 保存可验证事实。

### 5.2 路径记录

Case Flow 初始落地不引入新的流程推进能力，也不让 Runtime 维护强制状态机。

Agent 在已有调用中携带统一的可选 `flowContext`，Runtime 仅验证引用属于当前 revision 并记录到事件：

```json
{
  "flowContext": {
    "nodeRef": "N2",
    "selectedEdgeRef": "L3"
  }
}
```

- `observe`、`inspect`、`knowledge` 可关联正在调查的 `DECISION` 或 `CHECK`。
- `act` 可关联 `ACTION`。
- Agent 对 `DECISION` 形成选择时，在该 DECISION 的 `flowContext` 中用 `selectedEdgeRef` 声明实际选择；Runtime 只校验该边从 `nodeRef` 对应的 DECISION 出发，不判断 condition 是否成立。
- `recordResult` 必须关联 `CHECK`。
- `recover` 可关联发生异常时正在处理的节点；`finish` 可关联实际到达的 `END`。这些关联只用于还原过程，不改变恢复或收口语义。

Runtime 不校验 Agent 是否严格按边顺序移动，也不阻止跳转。`flowContext` 由 Translator 统一接收，不新增 `chooseBranch` 或 `advanceFlow` 能力；选择记录追加为事实事件。报告根据事件顺序、节点引用和 Agent 声明的选择展示实际路径。

### 5.3 未进入的条件分支

检查结果增加由 Agent 声明的 `NOT_APPLICABLE`：

- 表示该检查点所在条件分支本次没有进入。
- 必须提供简短原因，可引用作出分支判断的 Scene。
- 不参与 PASS/FAIL 聚合。
- Runtime 不判断条件是否真的成立，只校验引用和字段完整性。

正常 verdict 收口时，当前 revision 中所有 `CHECK` 最终必须有结果。未经过的条件分支由 Agent 明确提交 `NOT_APPLICABLE`，从而区分“没有进入该分支”和“遗漏检查”；显式 `NOT_RUN` 使用下述独立收口规则。

聚合时先忽略 `NOT_APPLICABLE`，其余结果继续使用 `FAIL > BLOCKED > INCONCLUSIVE > PASS` 的优先级。如果当前 revision 的全部 CHECK 均为 `NOT_APPLICABLE`，且 Case Agent 判断这些 CHECK 只是被原始用例允许的可选分支排除，表示本次行为符合用例允许的路径，Runtime 机械聚合为 `PASS`；每个结果仍必须记录非空原因，报告明确显示“本次未进入任何检查分支”，避免把它误读为已有正向证据。Runtime 不判断“可选分支排除”这一业务前提是否正确。

`NOT_APPLICABLE` 不能表示用例级前置条件不满足。当前实现只在 execution 尚未产生 `sceneObserved` 或 `actionRequested` 时推导 `NOT_RUN`，无法覆盖“先观察现场、再发现前置条件不满足”的情况，因此阶段二必须同时补充显式收口：

```json
{
  "capability": "finish",
  "outcome": "NOT_RUN",
  "reason": "当前账号不具备用例要求的会员前置条件",
  "evidence": {
    "sceneRefs": ["scene-3"],
    "technicalRefs": []
  },
  "summary": "前置条件不满足，用例未进入目标业务验证",
  "uncertainties": []
}
```

- `outcome` 省略时，Runtime 仍从 CHECK ledger 聚合正常 verdict；显式值初始只支持 `NOT_RUN`。
- `NOT_RUN` 由 Case Agent 判断并提供非空原因以及至少一个已登记的 Scene 或技术事实引用；Runtime 只校验引用和字段完整性，不判断前置条件是否真的不满足。
- `NOT_RUN` 收口不要求把所有 CHECK 人工改成 `NOT_APPLICABLE`，也不要求完整 ledger；已产生的结果作为过程事实保留，但不参与本次用例级结果聚合。
- 该路径生成 `result.verdict=NOT_RUN` 和空的最终 `checks`；此前 ledger 更新仍保留在事件中供审计，不混入最终业务结果。Runtime finish 事务仍以现有 `executionStatus=COMPLETED` 完成，不再为同一事实增加一套 executionStatus；completion、Reader 和看板根据 verdict 一致投影为“无法执行”。
- 尚未创建 Case Agent 就被环境或批次前置条件拦截的 execution，继续由 Coordinator 按现有路径形成 `NOT_RUN`。两条路径在看板上使用同一个业务状态。

### 5.4 统一状态模型

不新增一套 Case Flow 专属状态机。内部只保留现有执行生命周期和一套结果枚举，通过一个报告投影函数生成当前看板状态：

1. **执行生命周期**继续使用现有 execution/batch lifecycle，负责运行、收尾、取消和发布恢复，不参与业务 verdict 聚合。
2. **CHECK 结果**只使用 `PASS / FAIL / INCONCLUSIVE / BLOCKED / NOT_APPLICABLE`。`NOT_APPLICABLE` 不能成为用例 verdict。
3. **用例结果**的权威来源只有 `result.verdict`，取值为 `PASS / FAIL / INCONCLUSIVE / BLOCKED / NOT_RUN`。`finish.outcome=NOT_RUN` 只是 Agent-facing 输入，Translator 最终仍写入唯一的 `result.verdict`，不新增第二个持久化结果字段；finish 事务自身仍是 `COMPLETED`。batch state 如需保存 verdict，只镜像已提交结果，不形成独立判定来源。
4. **看板状态**由 Reader/Report Service 集中投影，不反向写入 execution 或 result。

结果边界保持简单：

- `NOT_RUN`：未进入目标业务验证。Case Agent 已接管时必须显式提交；Case Agent 尚未接管就结束时由 Coordinator 的确定性阶段事实投影。不得再用是否出现 `sceneObserved` 或 `actionRequested` 猜测。
- `BLOCKED`：已进入目标业务验证，但技术约束导致某个 CHECK 或整个用例无法继续完成。
- `INCONCLUSIVE`：执行和调查能够进行，但已有证据不足以判断业务满足或不满足。
- `NOT_APPLICABLE`：仅表示某个条件分支未进入。

看板保持当前用户可见状态和过滤方式，不因 Case Flow 增加状态：顶部状态过滤仍只有“全部、通过、失败、阻塞、无法判断、无法执行、未执行”，并继续与平台过滤组合使用。`PENDING` 仍表示没有 execution 的“未执行”；运行、取消、需重跑和报告异常继续按当前规则展示。`FINALIZING`、`PENDING_PUBLICATION` 等只属于内部生命周期，不新增为业务结果或新的顶部过滤项。

统一投影按以下固定优先级执行，集中实现为一个 `projectCaseStatus`，总览、平台摘要和详情页不得再各自维护状态判断：

| 已保存事实 | 投影状态 |
|---|---|
| 没有 execution | `PENDING` |
| execution/报告格式不可读 | 当前的 `NEEDS_RERUN` 或 `REPORT_ERROR` |
| 用例原文已变化 | `NEEDS_RERUN` |
| execution 已取消 | `CANCELLED` |
| 存在已提交 `result.verdict` | 直接使用该 verdict |
| execution 仍在运行、收尾或等待发布 | 保持当前运行态展示 |
| 无结果终止，且没有 `handoffConsumedAt` | `NOT_RUN` |
| 无结果终止，且已有 `handoffConsumedAt` | `BLOCKED` |

`handoffConsumedAt` 只表示 Case Agent 是否已接管 execution，是现有确定性生命周期事实；它不判断业务内容。Case Agent 接管后若业务前置条件不满足，必须通过显式 `finish.outcome=NOT_RUN` 覆盖默认的技术中断投影。

## 6. Runtime 职责边界

Runtime 只做确定性工作：

1. 校验 Case Flow JSON 结构、节点引用和图的基本完整性。
2. 校验并保持 Agent 提交的稳定 node ref，防止历史 ref 被复用，保存 revision 和 reason。
3. 校验业务调用引用的 `flowContext` 是否属于当前 revision，且已声明的选择边从对应 DECISION 出发。
4. 保存 Scene、动作、知识、视觉检查、结果和 revision/node 关联。
5. 根据 Agent 提交的 CHECK 结果聚合最终 verdict。
6. 对 Agent 已声明的 `SEARCH_EXISTENCE` 检查点，机械校验“不存在”的 FAIL 是否包含完整搜索覆盖证据。
7. 维持事务、写入所有权、证据引用和报告发布的一致性。

Runtime 明确不做：

- 从节点文本推断条件或验证类型。
- 判断 Agent 选择的分支是否符合业务。
- 判断某个可选步骤是否应该执行。
- 自动决定是否继续滑动、点击或查询知识。
- 将原始用例编译成不可修改的强制流程。

## 7. 搜索型验证点闭环

当前搜索证据规则已经存在，但 `verificationKind` 在 Case Model 重构中被丢失。修复方式不是让 Runtime 根据“是否存在”等文本猜测，而是恢复 Agent 声明和确定性透传：

```text
Case Agent 声明 CHECK.verificationKind
-> Agent-facing contract
-> Translator
-> Case Flow revision event
-> Narrative projection
-> Expectation coverage
-> Result integrity validation
```

当 `verificationKind=SEARCH_EXISTENCE` 且 Agent 提交 `FAIL` 时，Runtime 要求 `SEARCH_ABSENCE` 证据。没有可靠滚动上下文或未确认边界时，Agent只能继续调查或提交 `INCONCLUSIVE`。

这是一条证据契约，不是业务规则。

## 8. 业务判断指南

新增独立文档：

```text
references/case-reasoning.md
```

Case Prompt 要求每个 Case Agent dispatch 在首次建模或恢复执行前完整读取一次。Runtime 方法文档继续只说明接口调用，不混入业务判断规则。

初始版本只包含以下通用规则：

1. 保留原文中的“若、如果、可选、可能、无需、跳过、直到”等限定词；条件步骤应建模为 `DECISION` 和分支，不能强化为无条件 `CHECK`。
2. 执行结构不得扩大或缩小原始用例的业务要求；无法确定时保留 `uncertainties`，不要自行补全规则。
3. 区分“某次动作后的当前画面不满足预期”和“目标在完整范围内不存在”。前者可以形成动作后检查结果，后者需要完成范围探索。
4. 当前画面只覆盖可探索区域的一部分时，应继续探索、修订路径或形成 `INCONCLUSIVE`，不能直接形成不存在结论。
5. 实际结果与预期不一致时，先区分执行路径、动作位置、观察范围、环境差异和产品结果，再决定下一步。
6. Case Flow 可以根据现场修订；修订必须说明触发的新事实或理解变化。
7. finish 前检查原始用例、当前 Case Flow、实际路径和结果之间是否存在语义冲突。

维护规则：

- 只增加可跨用例复用的判断原则，不写具体产品页面或用例编号。
- 每次真实误判最多沉淀一条最小规则，优先合并重复含义。
- 每条规则保持一到三句话，必要时只附一个短例子。
- 文档变长后先归并和删除重复内容，不通过持续追加维持历史。

## 9. 001 与 012 的目标行为

### 9.1 用例 001

“是否出现系统权限弹窗”建模为 `DECISION`：

- 出现：进入权限文案检查、允许动作和关闭检查。
- 未出现：跳过授权分支，继续青少年守护检查。

未出现弹窗不会让“弹窗必须出现”成为 FAIL，因为 Case Flow 中不存在这个被强化后的无条件检查点。

### 9.2 用例 012

Case Flow 要区分两个业务问题：

1. 一次指定横滑后，当前画面是否符合原始用例描述。
2. Kids 入口是否存在于整个可探索区域。

如果原文明确把“一次滑动后的画面”作为断言，Agent 可以先记录该检查结果；但当右侧仍有内容时，应增加诊断路径继续调查，不能把当前视窗未出现直接表述成整个区域不存在。

如果原文的业务目标是验证入口存在，而“一屏”只是操作描述，则 CHECK 应声明为 `SEARCH_EXISTENCE`，Agent 持续滑动到找到目标或取得完整覆盖事实。

原文无法区分这两种含义时，Agent 保留不确定项，并在结果中明确披露解释口径。

## 10. Agent-facing 接口影响

保持公开能力数量不变：

- `plan`：参数从 `caseModel` 调整为 `caseFlow`。
- `observe`：仅增加可选 `flowContext`。
- `inspect`：增加可选 `flowContext`，用于关联节点和声明 DECISION 选择。
- `recordResult`：`expectationRef` 改为或映射到 `checkNodeRef`，支持 `NOT_APPLICABLE`。
- `act`：增加可选 `flowContext`。
- `knowledge`：增加可选 `flowContext`，继续允许关联检查点。
- `recover`：增加可选 `flowContext`，仅用于报告。
- `finish`：增加可选 `flowContext`；正常路径仍只提交摘要和不确定项并由 ledger 收口，前置条件不满足时允许显式提交 `outcome=NOT_RUN`、原因和证据引用。

不要新增 `chooseBranch`、`advanceFlow` 或通用工作流命令。Agent 选择分支是业务判断，不需要 Runtime 批准。

## 11. 报告设计

总览看板的卡片、用户可见状态、状态过滤和平台过滤保持现状；它只消费 Reader/Report Service 输出的统一摘要，不直接理解 Case Model 或 Case Flow。Case Flow 引起的 UI 调整集中在用例详情页。

新 execution 的用例详情增加 Case Flow 视图：

- 显示执行开始时的流程图。
- 高亮实际关联过事件的节点和 Agent 明确声明的分支。
- 显示 Case Flow revision 和修改理由。
- CHECK 节点显示当时结果和证据。
- 未进入分支显示为未经过或 `NOT_APPLICABLE`，不能显示为失败。
- 执行过程仍按事件时间排序，并展示每一步关联的 flow node。

报告只投影已保存事实，不推断 Agent 实际选择了哪条未记录分支。

报告投影明确分成两种只读模型，但共用同一个页面框架：

- `CASE_FLOW`：存在 `caseFlowRevised` 事件时使用，详情页显示 Case Flow、revision、实际分支和 CHECK node 结果。
- `LEGACY_CASE_MODEL`：只有 `caseModelRevised` 或更早 `caseContextRecorded` 事件时使用，继续显示当前“用例理解 + 线性执行计划 + 验证点”区域，不尝试从旧数据猜测条件边或合成 Case Flow。

两种模型共用结果概览、时间、执行步骤、Scene、动作落点、知识、技术事实和证据区域。实现上由 `execution-narrative` 输出带 `modelKind` 的统一报告视图，`current-report-html` 只对业务模型区域分支渲染，避免维护两套完整报告页面。

## 12. 历史数据与发布策略

1. 不修改、不迁移现有 execution、result、events 和 completion 数据。
2. `CONTEXT.html` 和总览 HTML 是可重新生成的派生产物，当前重建看板时会被新 renderer 重写，因此不能依赖旧 HTML 文件维持兼容；新 renderer 必须通过 `LEGACY_CASE_MODEL` 只读投影重新展示旧结果。
3. 旧数据无法补出原来没有记录的条件、分支和节点关系，因此旧执行不会显示 Case Flow，也不会被转换成 Case Flow；它继续使用旧模型区域，结果、步骤和证据仍可正常展示。
4. 新 Runtime 不继续执行旧协议下尚未完成的 execution；切换前确认没有活动旧批次。
5. Execution schema 保持 12，不因 Case Flow 机械提升；result 与 completion 校验器在同一 reader family 内同时接受既有四种 verdict 和新增 `NOT_RUN`。`caseProtocolSha` 随公开协议变化，阻止新 Runtime 继续执行旧协议的活动 execution。
6. Reader 保留对 schema 12 中既有 `caseModelRevised` 和 `caseContextRecorded` 事件的只读解析，不为其补写 Case Flow。已完成 execution 的读取不要求匹配当前 `caseProtocolSha/runtimeSha`，因此协议升级后仍可进入历史报告投影。
7. 新 execution 只写 Case Flow 事件；Runtime 不同时维护两套可执行模型。旧模型支持仅存在于 Reader 和报告投影层，不进入 Agent-facing contract、Translator、ledger 或 finish。
8. 看板发布回归必须使用真实旧 execution fixture 重新生成总览和详情页，证明旧数据不是只在旧静态 HTML 中可见。
9. 历史只读边界仍是当前支持的 schema 12。schema 10/11 等当前已经不受支持的 execution 继续投影为 `FORMAT_UNSUPPORTED / NEEDS_RERUN`，不迁移、不补写，也不为 Case Flow 改造新增版本兼容层。

## 13. 分阶段实施

### 阶段一：先修复 Agent 指导和搜索链路

目标：用最小改动降低当前误判，不等待 Case Flow 全量重构。

- 新增精简的 `references/case-reasoning.md`。
- Case Prompt 要求每个 dispatch 在首次建模或恢复执行前读取该文档。
- 将该文档加入 Case Executor 的 contract resources，使内容变化自动更新 `caseProtocolSha`。
- 增加“条件不可强化、部分范围不可判不存在、异常时修订计划”的通用规则。
- 恢复 `verificationKind` 在 Agent-facing Case Model 到结果校验的完整透传。
- 将当前 expectation semantic hash 从纯文本扩展为 `text + verificationKind`，类型变化时失效旧结果。
- 增加测试，证明 `SEARCH_EXISTENCE + FAIL` 没有完整覆盖时被证据契约拒绝。

阶段一不增加 Runtime 业务推断。

### 阶段二：引入 Case Flow 最小模型

目标：由一个产物承载理解和计划。

- 定义 Case Flow contract、revision event 和 Agent node ref 校验策略。
- `plan` 改为提交完整 Case Flow。
- 支持四种节点和自然语言边条件。
- Runtime 保存和投影，不执行条件。
- 同步把 `recordResult`、ledger、finish 和结果语义哈希切换到 CHECK node ref，支持 `NOT_APPLICABLE`；阶段结束时必须形成一条可完整收口的执行链路。
- 同步支持 Case Agent 显式 `NOT_RUN` 收口，并更新 result verdict、completion、报告和看板的确定性校验；completion 的 executionStatus 仍使用现有 `COMPLETED`，不得继续依赖是否已有 Scene/Action 来判断业务前置条件。
- 将通用事件 revision 元数据从仅支持 `caseModelRevision` 调整为新事件使用 `caseFlowRevision`；历史事件字段保持只读。
- Case Agent 使用 Case Flow 执行新用例。
- 为 001、012 建立回归场景。

阶段二内部按以下检查点实施，但在 2B 和 2C 都完成前不发布新协议，避免出现只能建模、不能收口或不能发布的半套链路：

- **2A 内部模型**：新增 Case Flow contract、图校验、revision service 和单元测试，尚不改变 Agent-facing `plan`。
- **2B 原子切换**：一次性切换 `plan -> Translator -> revision event -> ledger -> recordResult -> finish`，同步支持 `NOT_APPLICABLE`、显式 `NOT_RUN` 和新的语义哈希。
- **2C 最小发布闭环**：让 Result Integrity、completion、Reader、当前报告和看板读取新结果；建立唯一的看板状态投影，并保留 `LEGACY_CASE_MODEL` 只读报告分支。新 Case Flow 在这一检查点至少以结构化节点、边、revision 和 CHECK 结果列表可读，阶段三再增加实际路径高亮等完整交互。完成 001/012 以及历史数据回归后再启用新 Case Executor contract。

对应当前代码的改动边界是明确的：

- Agent 协议层：`agent-facing-contract`、`agent-facing-translator`、方法文档和生成的 Case Executor contract。
- 模型与事件层：以新的 Case Flow service 替换新执行链路中的 `case-model-service`，并调整 `store` 的 revision 元数据；旧事件只由 Reader/报告读取。
- 结果层：`expectation-result-service`、`result-integrity`、`result-service` 及内部 Runtime contract；CHECK status 增加 `NOT_APPLICABLE`，用例 verdict 增加 `NOT_RUN`，两者不能混用。
- 发布层：`completion-contract`、batch state contract、`execution-reader`、报告投影和看板状态映射必须在 2C 同步接受新结果。
- 指标层：revision 计数从只统计 `caseModelRevised` 调整为新执行统计 Case Flow revision，历史指标不回写。

### 阶段三：执行关联与结果闭环

目标：报告可以还原实际执行路径，同时保持 Agent 自主性。

- 在现有能力中增加统一、可选的 `flowContext`，保存节点关联和 Agent 声明的分支选择。
- `execution-narrative` 输出 `CASE_FLOW / LEGACY_CASE_MODEL` 两种模型类型和共享的步骤、证据视图。
- 新执行的详情页展示节点、选择边、结果、实际关联事件和 revision；历史执行继续使用现有理解与线性计划区域。
- 总览看板布局、状态过滤和平台过滤保持不变，只改为消费统一状态投影。
- Runtime 只做引用和证据校验，不增加路径顺序门禁。

### 阶段四：移除重复业务表达

目标：完成收敛，避免长期双轨。

- 新 execution 不再生成 `understanding + verificationPoints + items` 三份并行表达。
- 删除仅为旧 Case Model 写入服务的运行时代码。
- 保留历史只读投影，不允许旧模型进入新执行链路。
- 更新架构文档、设计决策、Prompt 和生成的接口文档。
- 执行全量自测和 Android/HarmonyOS/iOS 各一条代表用例验证。

每个阶段单独评审、测试和提交，前一阶段稳定后再进入下一阶段。

## 14. 测试策略

### 14.1 模型测试

- 条件节点可以有多个带自然语言 condition 的出边。
- 循环边不会被结构校验误判为非法。
- 不存在的 node ref、重复 ref 和悬空边被拒绝。
- 缺少 CHECK/END、存在不可达节点、存在无法到达 END 的闭合循环，以及非 DECISION 的隐式分支被拒绝。
- revision 保留相同语义节点 ref，取消的 ref 不复用。

### 14.2 Agent 场景测试

- 001：权限弹窗未出现时走跳过分支，青少年守护检查可以独立 PASS。
- 001：权限弹窗出现时执行允许路径并形成对应检查结果。
- 012：局部视窗未见 Kids 且仍可继续滑动时不得形成完整范围不存在结论。
- 012：原文被解释为一次滑动结果时，报告区分动作后断言和后续诊断事实。

### 14.3 Runtime 测试

- `SEARCH_EXISTENCE` 从 Agent 声明完整传递到 Result Integrity。
- `DIRECT_OBSERVATION` 不错误触发搜索覆盖规则。
- `NOT_APPLICABLE` 不参与 verdict 聚合，但保留原因和证据。
- 全部 CHECK 均为 `NOT_APPLICABLE` 时聚合为 PASS，用例级前置条件不满足仍投影为 NOT_RUN。
- 即使已经产生 Scene，Case Agent 显式提交有效原因和证据后仍可收口为 NOT_RUN；该路径不要求完整 CHECK ledger。
- Runtime 不读取节点文本决定分支或验证类型。
- `flowContext` 只做引用、revision 和“选择边属于对应 DECISION”校验。
- Case Agent 显式 `NOT_RUN` 时 `result.verdict=NOT_RUN`、`checks=[]`，finish/completion 的 executionStatus 仍为 `COMPLETED`。
- 状态投影优先使用已提交 verdict；无结果终止时，没有 `handoffConsumedAt` 投影为 NOT_RUN，已有 `handoffConsumedAt` 投影为 BLOCKED。

### 14.4 回归测试

- Handoff、Scene、动作、知识、恢复和 finish 能力数量不增加。
- Main Agent 职责不变化。
- 历史已发布 execution 不被重写。
- 看板仍能展示当前 schema 下已有执行结果。
- 总览看板的用户可见状态、状态过滤项和平台组合过滤保持当前行为，不增加 Case Flow 专属状态。
- 使用只有 `caseModelRevised` 的真实旧 fixture 重建报告时，状态、结果、步骤、证据、旧理解和旧计划均可展示，且不会出现报告数据异常。
- schema 10/11 等当前不支持的 fixture 继续稳定显示“需重新执行”，不会因新 renderer 变成报告数据异常。
- 使用 `caseFlowRevised` 的新 fixture 重建报告时显示 Case Flow，不生成旧理解与线性计划的重复表达。
- `caseProtocolSha` / `runtimeSha` 变化后，旧协议已完成 execution 仍可读取，旧协议活动 execution 被明确拒绝继续执行。
- 修改 `references/case-reasoning.md` 会改变 Case Executor 的 `caseProtocolSha`，但不会使历史已完成 execution 失去可读性。
- 三个平台使用同一 Case Flow 和业务指导规则，平台差异仍留在 Adapter。

## 15. 成功标准

1. Case Agent 只生成一个业务建模产物，不再维护相互重复的理解和计划。
2. 条件、可选步骤和循环探索能够直接从 Case Flow 看出。
3. 001 的未出现权限弹窗分支不会被自动强化为失败断言。
4. 012 的局部观察不会被当作完整范围不存在。
5. Runtime 不增加任何根据业务文本作判断的逻辑。
6. 搜索证据规则由 Agent 声明驱动并在真实执行链路生效。
7. 业务判断指南保持简短，并能通过真实误判逐步维护。
8. 报告能还原 Case Flow revision、Agent 声明的实际分支、关联节点、检查结果和调整原因。
9. 总览看板状态与过滤保持不变，历史 Case Model execution 仍能通过新 renderer 正常展示，但不会被伪转换为 Case Flow。

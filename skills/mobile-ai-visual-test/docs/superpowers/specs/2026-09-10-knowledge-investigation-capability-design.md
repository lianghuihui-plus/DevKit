# Knowledge Investigation Capability Design

- 状态：Implemented
- 日期：2026-09-10
- 范围：`mobile-ai-visual-test` Case Agent、Case Runtime、知识检索与报告链路

## 1. 背景

当前系统已经提供 `knowledge` Runtime operation，但是否查询完全依赖 Case Agent 临场判断。012 用例暴露了这一缺陷：用例原始平台范围与实际执行平台不同，现场结果又与预期不符，Agent 仍然直接形成 FAIL，没有查询已经存在的相关知识。

该 execution 的事实如下：

- `metrics.json` 中 `knowledgeQueries=0`、`knowledgeReviews=0`。
- 10 次 Runtime 调用仅包含 `observe`、`act`、`inspectVisual` 和 `finish`。
- `events.jsonl` 中没有 `knowledgeQueried` 或 `knowledgeReviewed`。
- 最终检查的 `knowledgeRefs` 为空。
- 使用相同平台、App 和现场现象直接调用现有检索逻辑时，可以召回 `K-editor-001`。

因此，本次问题不是知识服务不可用或检索没有命中，而是知识调查从未被触发。

## 2. 问题定义

### 2.1 能力可见性不对等

截图和控件树随 Scene 直接提供，Agent 每次观察都会看到；知识能力只出现在 Runtime allowlist 和提示词中。Agent 在主动查询前不知道是否存在相关知识，容易优先依赖眼前 Scene 直接形成结论。

### 2.2 提示词存在解释空间

当前提示词一方面要求在判断依赖外部规则时查询知识，另一方面允许“直接 Scene 证据足够时不机械查询”。当截图明确显示实际结果与预期不符时，Agent 可能把“观察事实充分”误解为“结论解释也充分”，从而跳过知识调查。

### 2.3 Runtime 只校验已使用的知识

现有完整性校验能够保证：

- 查询候选已完成适用性评估；
- `knowledgeRefs` 只能引用已评估为 `APPLICABLE` 的条目；
- 知识快照与 execution 证据链一致。

但 Runtime 不校验“本应调查的异常结论是否完全没有查询知识”。因此，Agent 可以用零知识查询提交 FAIL、INCONCLUSIVE 或部分 BLOCKED 结果。

### 2.4 知识元数据可能限制召回和适用性

当前 `K-editor-001` 的正文描述的是 HarmonyOS 不支持某编辑器的较宽规则，但 `Page` 和 `Operation` 元数据限定在单一页面和操作。规则实际适用范围与检索范围不一致。当前 Scene 未提供 `app.page`，所以没有触发页面排除；后续补齐页面上下文后可能无法召回。

## 3. 设计目标

1. 将知识查询定义为与截图、控件树并列的常规调查能力。
2. 使用通用的执行场景描述查询时机，不在 Case Agent Prompt 中固化具体业务或产品规则。
3. 正常且无疑问的 PASS 路径允许零查询，避免机械地为所有用例增加步骤。
4. 实际结果与预期不符、无法继续处理或准备形成负向结论时，确保 Agent 至少完成一次相关知识调查。
5. 知识只能解释或补充 Scene 事实，不能替代截图、控件树或修改 Frozen CaseSpec。
6. 查询无候选、候选不适用或候选不足时，仍允许基于现场证据形成原结论。
7. 报告能够区分“无需查询”“已查询无匹配”“已查询但不适用”“已采用知识”和“遗漏必需调查”。
8. Skill、Prompt 或 Runtime 更新以及单用例重跑，不得使其他已完成用例从看板消失或变为协议不兼容。

## 4. 非目标

- 不把知识查询改为每个用例的固定步骤。
- 不在 Case Agent 启动时预加载全部知识正文。
- 不允许知识条目覆盖或改写 Frozen expectation。
- 不因为命中候选就自动改变 verdict。
- 不使用具体业务名称作为通用触发规则。
- 不对已完成的历史 execution 追溯补查或改写结果。

## 5. 核心原则

### 5.1 观察与解释分离

- 截图回答“画面实际显示了什么”。
- 控件树回答“可访问结构、状态和可操作目标是什么”。
- 知识回答“这个事实是否存在已知解释、适用边界或处理规则”。

Scene 证据充分只能说明观察事实充分，不代表对异常事实的解释已经充分。

### 5.2 正常路径可选，异常路径必查

满足以下全部条件时，Agent 可以不查询知识：

- 实际结果符合 Frozen expectation；
- 操作按计划完成；
- 没有未解决的不确定项；
- 最终结论不依赖 Scene 之外的信息。

出现以下任一通用场景时，Agent 必须把知识查询作为下一步调查手段：

- 实际结果与用例预期不一致；
- 当前状态无法由截图和控件树独立解释；
- 操作失败、无效果或重复尝试仍无进展；
- Agent 无法决定继续路径或结果性质；
- 结论可能受运行环境、版本、账号、配置或其他外部条件影响；
- 准备提交 FAIL 或 INCONCLUSIVE；
- 准备提交没有有效 Runtime 技术事实支撑的 BLOCKED。

### 5.3 查询是调查要求，不是 verdict 要求

强制查询不代表强制采用知识：

- 命中且适用：记录 `APPLICABLE`，结论依赖该知识时引用条目。
- 命中但不适用：记录 `NOT_APPLICABLE`，继续使用现场证据。
- 命中但冲突或不足：记录 `CONFLICTING` 或 `INSUFFICIENT`。
- 没有候选：Runtime 自动记录 `NO_MATCH`。

以上情况都视为完成知识调查。

## 6. 总体方案

采用三层协同设计：Prompt 建立决策规则，Runtime 显式暴露能力，finish 契约提供确定性兜底。

```text
Case Brief / Runtime Response
  |-- visual capability
  |-- layout capability
  `-- knowledge capability
             |
             v
       Case Agent 判断现场
        |             |
   正常且无疑问      异常或无法解释
        |             |
    可直接 finish     knowledge query
                          |
                    review / NO_MATCH
                          |
                          v
                    finish validation
```

## 7. Prompt 设计

删除容易让 Agent 把“直接观察充分”等同于“无需解释异常”的表述，改为能力职责和通用场景驱动。

建议核心提示词如下：

```markdown
截图、控件树和知识查询都是可主动选择的调查能力：截图用于确认像素事实，控件树用于理解结构与状态，知识用于调查当前现场之外的已知解释、适用边界和处理规则。

实际结果符合预期、操作过程正常且没有未解决疑问时，可以不查询知识。

出现以下任一情况时必须查询知识：实际结果与预期不符；截图和控件树无法独立解释当前状态；操作失败或重复尝试仍无进展；无法决定下一步或结论性质；结论可能受外部条件影响；准备形成 FAIL、INCONCLUSIVE，或没有有效 Runtime 技术事实支撑的 BLOCKED。

知识查询不能替代 Scene 证据。候选必须结合当前现场评估；无候选或候选不适用时，仍按现有证据形成结论。
```

Prompt 不列举具体页面、功能或产品名称。业务规则只存在于知识条目中。

## 8. 能力显式暴露

### 8.1 Case Brief

在现有 `runtime.allowedOperations` 之外增加结构化调查能力摘要：

```json
{
  "investigationCapabilities": {
    "visual": { "available": true, "operation": "inspectVisual" },
    "layout": { "available": true, "source": "scene.evidenceChannels.layout" },
    "knowledge": {
      "available": true,
      "operation": "knowledge",
      "requiredBeforeNegativeConclusion": true
    }
  }
}
```

该字段只声明能力和当前规则，不预取候选、不暴露知识目录，也不改变 Agent 的协议边界。

### 8.2 Runtime Response

每次响应的 `narrative` 或同级状态中提供简短的知识调查状态：

```json
{
  "knowledgeInvestigation": {
    "available": true,
    "pendingReviews": [],
    "reviewedExpectationRefs": ["E1"]
  }
}
```

这样 Agent 在每次重新判断 Scene 时都能看到该能力，而不是只在初始 Prompt 中看到一次。

## 9. Runtime 收口约束

### 9.1 必需调查范围

对 Agent 提交的每个最终 check 单独判断：

| Check 状态 | 是否要求知识调查 |
|---|---|
| `PASS` | 默认不要求；引用知识时必须完成查询和评估 |
| `FAIL` | 要求 |
| `INCONCLUSIVE` | 要求 |
| `BLOCKED` 且存在有效 `technicalRefs` | 不要求 |
| `BLOCKED` 且没有有效 `technicalRefs` | 要求 |

一次查询可以关联多个 expectation。对每个要求调查的 expectation，必须存在：

1. `knowledgeQueried.expectationRefs` 包含该 expectation；
2. 对应 `knowledgeReviewed` 已完成；
3. 有候选时满足现有完整评估规则，零候选时存在 Runtime 自动生成的 `NO_MATCH`。

### 9.2 finish 行为

`finish` 在现有知识引用完整性校验之外增加 `requiredKnowledgeInvestigation` 校验。

缺少调查时返回：

```json
{
  "status": "RESULT_INCOMPLETE",
  "code": "CASE_RESULT_INCOMPLETE",
  "missing": [
    {
      "field": "checks.E2.knowledgeInvestigation",
      "reason": "负向结论前尚未完成与该验证点关联的知识调查"
    }
  ]
}
```

Runtime 不自动替 Agent 生成查询词，也不自动采用候选。Agent 收到响应后根据当前 Scene 和 expectation 发起一次 `knowledge`，完成 review 后重新 `finish`。

### 9.3 豁免边界

以下情况不触发强制查询：

- Lifecycle 在 Case Agent 创建前因初始状态失败自动生成的技术性 BLOCKED。
- Agent 的 BLOCKED check 已引用仍有效、属于当前 execution 和 expectation 的 Runtime 技术事实。
- 已完成的历史 execution。

技术事实失效、引用不匹配或不足以直接阻止验证时，不享受豁免。

## 10. 检索上下文优化

### 10.1 保留确定性上下文

以下字段继续由 Runtime 决定，Agent 不允许覆盖：

- `platform`
- `appId`
- `appVersion`（可获得时）

### 10.2 页面与操作上下文

页面和操作可能无法从设备层稳定识别，因此分为两类：

- Runtime 已确认的 Scene 上下文：可用于硬兼容过滤。
- Agent 根据业务现场提供的上下文：只用于排序和召回提示，不作为硬排除条件。

避免 Agent 提供的页面别名、概念层级差异或不完整描述直接排除正确知识。

### 10.3 知识条目治理

知识条目的元数据必须与正文适用范围一致：

- 全局平台规则不应被错误限定到单一页面。
- 页面专属规则应保持精确 Page 和 Operation。
- 同一事实跨多个明显不同的业务入口时，优先拆分条目或省略并不构成真实限制的元数据。
- 验证工具增加“正文表述为全局规则但元数据范围过窄”的人工审查提示；不使用不可靠的自动语义判定阻止发布。

012 对应知识应在实现阶段确认是全局规则还是两个独立页面规则，再选择放宽元数据或拆分条目。

## 11. 报告与可观测性

每个 check 展示知识调查状态：

- `NOT_REQUIRED`：正常路径，无需查询。
- `NO_MATCH`：已查询，无候选。
- `NO_APPLICABLE`：已查询，候选均不适用。
- `INSUFFICIENT`：已查询，但不足以支持解释。
- `CONFLICTING`：已查询，知识存在冲突。
- `APPLICABLE_FOUND`：已查询并采用或发现适用知识。

Execution metrics 保留现有查询计数，并增加：

```json
{
  "knowledgeInvestigation": {
    "requiredExpectationRefs": ["E2"],
    "completedExpectationRefs": ["E2"],
    "missingExpectationRefs": []
  }
}
```

报告应明确区分“未要求查询”和“本应查询但遗漏”，避免仅通过 `knowledgeQueries=0` 猜测 Agent 是否正确执行。

## 12. 数据流

1. Lifecycle 创建 execution，并在 Case Brief 中声明三类调查能力。
2. Agent 通过 Scene 的截图和控件树完成观察与操作。
3. 正常结果符合预期时，Agent可以直接提交 PASS。
4. 出现异常、无法处理或负向结论时，Agent 调用 `knowledge` 并关联相关 expectation。
5. Runtime 使用冻结的 App 和平台上下文检索，保存候选快照并记录 `knowledgeQueried`。
6. 零候选由 Runtime 自动记录 `NO_MATCH`；有候选由 Agent 在下一次请求中提交 `knowledgeReview`。
7. Agent 提交 CaseResult。
8. Runtime 校验 expectation 覆盖、Scene 证据、视觉检查、知识调查、知识引用和技术事实。
9. 缺少必需调查时返回 `RESULT_INCOMPLETE`；完整时完成 execution 并生成报告。

## 13. 兼容性与版本

### 13.1 已确认的兼容风险

当前报告读取链路不仅要求 execution 使用当前 schema，还要求历史 execution 的 `caseProtocolSha` 和 `runtimeSha` 与当前 Skill 完全一致。修改 Case Agent Prompt 或 Runtime 后，即使历史数据结构没有变化，也会被报告 Reader 判定为 `AGENT_PROTOCOL_MISMATCH`。

对现有 `MAVT0908-1` 工作空间进行只读检查时，41 个用例的最新 execution 中已有 3 个因为该判断无法被当前 Reader 读取。单用例提交后的看板刷新会重新扫描所有用例，因此一个用例重跑可能把这些原本已发布的历史结果改为“报告数据异常”。

该问题必须作为本方案的前置任务处理，不能仅依赖“不提升 schema”规避。

### 13.2 读写边界

版本和实现绑定按用途区分：

| 场景 | 兼容策略 |
|---|---|
| 创建或写入新 execution | 只使用当前协议 |
| 恢复未完成 execution | 必须匹配其冻结协议和明确支持的 Runtime，不能用新实现盲目续写 |
| 恢复事务草稿 | 严格匹配草稿 schema、状态和绑定关系 |
| 读取已完成 execution | 使用对应版本的只读 Reader，不要求匹配当前 Prompt 或 Runtime 哈希 |
| 验证已发布结果 | 使用对应版本的 Validator 和 execution 自身冻结的 completion、manifest、hash |
| 生成看板 | 将各历史 Reader 输出归一化为稳定的 ReportModel |

`caseProtocolSha`、`runtimeSha` 和 `adapterSha` 对已完成 execution 是来源追溯信息及内部绑定依据，不是“是否允许展示”的条件。它们与当前实现不一致，只能阻止继续写入，不能阻止只读展示。

### 13.3 版本策略

本次知识调查能力是增加 Case Agent 规则、Runtime 收口约束和可选报告字段，不改变 execution 核心持久化结构，因此：

- 保持当前 Execution schema，不因新增可选字段提升版本；
- 提升 Runtime Broker capability 版本，用于区分新旧 execution 是否启用知识调查收口；
- 旧 Broker execution 按冻结规则读取和展示，不追溯要求知识查询；
- 新 Broker execution 启用知识调查新规则；
- 活动中的旧 execution 不能中途切换 Broker 或 finish 约束；
- 只有字段被删除、含义改变或结构发生无法兼容的变化时才提升持久化 schema。

后续确需提升持久化 schema 时，`schemaVersion` 必须作为 Reader/Validator 路由键，而不是只认当前唯一当前版本的拒绝条件：

```text
ExecutionReaderRegistry
  |-- schema 10 -> ExecutionReaderV10
  `-- schema 11 -> ExecutionReaderV11
                         |
                         v
                  Stable ReportModel
```

已经对外生成过 execution 的版本必须保留只读适配器。未知的新版本或真实损坏数据可以标记异常，但不能影响其他用例。

### 13.4 完成态验证

已发布 execution 的可信度继续通过以下冻结事实保证：

- `completion.json` 与 execution、result、metrics 的绑定；
- artifact manifest 的文件集合和摘要；
- 各证据文件的内容哈希；
- 对应 schema 版本的结构校验器。

报告刷新不得使用最新 Runtime 规则重新审判历史业务结果，也不得因为当前 Prompt、Runtime 或 Adapter 哈希变化而拒绝历史完成态。新规则只在新 execution 的写入和 finish 阶段生效。

### 13.5 看板故障隔离

单用例重跑后的报告刷新需要满足：

- 只重写目标用例及其目标平台的详情报告；
- 全局索引可以重新聚合，但通过历史 Reader 读取其他用例，不重新要求它们匹配当前实现；
- 一个用例的数据损坏或版本未知时，只将该用例标记为 `REPORT_ERROR`；
- 其他用例继续展示原状态、摘要、详情链接和证据；
- 不使用某个用例的读取错误覆盖其他用例已经发布的 `CONTEXT.html`；
- 无法读取最新 execution 时不得悄悄回退并把较旧结果伪装成最新结果，应保留用例条目并明确异常 execution；
- 整体索引发布不能因非目标用例的单条异常而失败。

### 13.6 实施顺序

1. 拆分严格写入校验与兼容只读校验。
2. 为当前已发布 execution 建立稳定 Reader/Validator，并移除完成态对当前组件哈希的依赖。
3. 增加混合版本工作空间和单用例重跑的看板回归测试。
4. 完成看板故障隔离后，再启用知识调查 Prompt、capability 和 finish 新约束。

## 14. 测试方案

### 14.1 Prompt 行为验证

使用独立 Case Agent 覆盖以下场景：

- 全流程符合预期：不查询知识并正常 PASS。
- 实际结果与预期不符：在 finish 前主动查询知识。
- 重复操作无进展：停止盲目重试并查询知识。
- 知识无候选：记录 NO_MATCH 后基于 Scene 形成 FAIL 或 INCONCLUSIVE。
- 候选不适用：完成 NOT_APPLICABLE review 后形成现场结论。

### 14.2 Runtime 契约测试

- FAIL 无相关查询：返回 `RESULT_INCOMPLETE`。
- INCONCLUSIVE 无相关查询：返回 `RESULT_INCOMPLETE`。
- 无技术事实的 BLOCKED 无查询：返回 `RESULT_INCOMPLETE`。
- 有有效技术事实的 BLOCKED 无查询：允许完成。
- FAIL 查询零候选且自动 NO_MATCH：允许完成。
- FAIL 查询有候选但未 review：返回 `RESULT_INCOMPLETE`。
- FAIL 查询并完成 NOT_APPLICABLE review：允许完成。
- PASS 无查询：允许完成。
- PASS 引用知识但未评估为 APPLICABLE：继续被现有规则拒绝。
- 一次查询关联多个 expectation：只要 review 完整，可同时满足多个检查。

### 14.3 012 回归验证

重新执行同类场景时应满足：

- Agent 在发现实际结果与预期不符后查询知识；
- 查询能够召回修正适用范围后的对应条目；
- Agent 对候选与当前 Scene 做适用性评估；
- 最终 check 明确记录 Scene 事实和知识依据；
- execution 不再出现负向结论且 `knowledgeQueries=0` 的情况。

### 14.4 历史兼容与看板回归验证

- 已完成 execution 的 Prompt/Runtime 哈希与当前实现不同时，报告仍可读取和展示。
- 同一工作空间同时存在旧 Broker 和新 Broker execution 时，两者均可生成详情报告和看板摘要。
- 重跑一个用例后刷新看板，其他已完成用例的 verdict、摘要、详情链接和证据保持可用。
- 非目标用例存在未知 schema 时，仅该用例显示 `REPORT_ERROR`，目标用例提交和全局索引发布仍能完成。
- 非目标用例存在证据损坏时，不覆盖其最后一次已发布的详情报告，也不影响其他用例。
- 最新 execution 不受支持时，不将旧 execution 伪装成最新结果。
- 使用 `MAVT0908-1` 当前两代协议数据构造混合版本回归夹具，覆盖已经确认的 `AGENT_PROTOCOL_MISMATCH` 场景。

## 15. 实施范围

预计涉及：

- `prompts/case-agent.md`：通用化知识能力定位和触发规则。
- `scripts/case-runtime/lifecycle.js`：Case Brief 能力摘要与 Broker capability 版本。
- `scripts/case-runtime/runtime-core.js`：Runtime 响应中的调查状态。
- `scripts/case-runtime/result-integrity.js`：负向结论知识调查收口校验。
- `scripts/case-runtime/knowledge-service.js`：结构化检索上下文和状态输出。
- `scripts/lib/knowledge-query.js`：硬上下文与软上下文匹配策略。
- `scripts/lib/execution-reader.js`：拆分当前可写 execution 校验和历史完成态读取，增加版本 Reader 路由。
- `scripts/lib/completion-contract.js`、artifact manifest 与 evidence graph：按冻结版本验证完成态，不依赖当前实现哈希。
- `scripts/report/report-service.js`：单用例刷新时隔离其他用例的读取异常，保留历史详情报告。
- Workspace 与 Case contract 的报告读取入口：使用兼容 Reader；写入入口继续严格校验当前 schema。
- 报告 Reader 与 metrics：按 expectation 展示调查状态，并输出稳定 ReportModel。
- Runtime、knowledge、result matrix、report 相关测试。
- Workspace 知识条目：修正或拆分适用范围不一致的条目。

## 16. 风险与控制

### 查询次数增加

只对异常和负向结论强制查询；正常 PASS 不查询。知识库为本地检索，单次成本可控，并可让一次查询关联多个 expectation。

### Agent 为通过校验而机械查询

这是可接受的下限行为。查询无候选不会改变结论，但能够证明 Agent 在负向收口前检查过已有解释。报告按 expectation 记录结果，便于后续识别低质量查询词。

### 错误知识改变 verdict

继续要求候选与当前 Scene 逐项评估；命中本身不改变 verdict，引用必须来自 `APPLICABLE` review，Scene 证据仍是必需项。

### 旧 execution 无法通过新规则

通过 Broker capability 隔离知识调查规则，新规则只用于新 execution。历史完成态由对应版本 Reader/Validator 读取，不再要求匹配当前组件哈希。

### 历史 Reader 的维护成本

各版本 Reader 只负责把冻结产物转换为稳定 ReportModel，不保留旧 Runtime 的写入和恢复能力。兼容代码按已发布的持久化 schema 组织，避免在主流程中散布版本条件。

### 单条损坏数据影响全局看板

报告聚合按用例隔离错误。损坏用例保留可识别的异常状态和最后一次已发布详情，其他用例继续正常读取和发布。

## 17. 验收标准

1. 正常 PASS 用例可以保持零知识查询。
2. Agent 产生的 FAIL 和 INCONCLUSIVE 必须存在与对应 expectation 关联且已关闭的知识调查。
3. 没有有效技术事实的 Agent BLOCKED 必须完成知识调查。
4. 查询无候选或候选不适用不会阻止 Agent 基于 Scene 形成结论。
5. 报告可以直接看出每个 expectation 是否要求、是否完成以及如何结束知识调查。
6. 012 同类场景能够主动查询并召回适用知识，不再以零查询直接形成负向结论。
7. 历史 execution 的读取与报告发布不受影响。
8. 修改 Skill、Prompt、Runtime 或 Adapter 后，已完成 execution 不因当前组件哈希变化而失去展示能力。
9. 重跑一个用例并刷新看板时，其他已完成用例保持原 verdict、摘要、详情链接和证据可用。
10. 未知版本或真实损坏只影响对应单个用例，不阻止目标用例提交和全局索引发布。

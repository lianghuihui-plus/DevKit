# Case Flow、检查点与执行轨迹看板方案

> 状态：已确认并实现；Runtime 契约、Agent 协议、报告投影、离线 Mermaid 看板和回归测试均已落地。

## 背景与问题

当前 Case Agent 在 execution 内根据原始用例创建 Case Flow，并可根据现场持续修订。最终结果只要求覆盖最新 revision 中仍然存在的 `CHECK` 节点。看板同时使用最新 Case Flow 和实际执行事件标记已走节点，因此容易产生两个问题：

1. 现场适配会进入最新 Case Flow，使“原始用例理解”与“本次实际执行轨迹”混在一起。
2. 检查点属于可修订图的一部分；Agent 调整流程时，原检查点可能从最新 revision 中消失，Runtime 只能校验剩余检查点，无法展示原始验证责任是否被执行、未触发或豁免。

013 iOS 是典型案例：初始 Case Flow 来自原始用例；第一次 Scene 发现版本更新弹窗后，Agent 把“关闭版本更新弹窗”加入 revision 2。该动作是本次执行的现场适配，不应让读者误认为它来自原始用例。

## 目标

1. Agent 仍在 execution 开始时理解原始用例并生成可执行流程，不引入独立的人工编排环节。
2. 首次 `plan` 明确形成只基于原始用例理解的 execution 内稳定基线；当前 Scene 引起的适配必须进入后续修订或执行轨迹，不能混入基线。
3. Agent 可以根据现场调整执行路径，也可以豁免检查点；豁免必须留下理由，并可关联知识、Scene 或技术事实。
4. Runtime 只做轻量结构校验、引用校验和证据持久化，不判断自然语言条件、豁免合理性或业务 verdict。
5. Agent 可以通过检查点处置形成带豁免的 `PASS`；看板必须显著披露豁免数量和理由，不能把它展示成无保留的普通 PASS。
6. 看板分别呈现“Agent 对原始用例的流程理解”和“本次实际执行轨迹”，并将复杂流程图切换为 Mermaid 渲染。

## 非目标

- Runtime 不成为规则引擎，不审批 Agent 的业务计划或豁免理由。
- Runtime 不调用模型理解条件，不根据截图或控件树推断检查点是否适用。
- Mermaid 不进入 Runtime 协议，不成为持久化事实源。
- Baseline Flow 只在单次 execution 内固定；首版不建立跨 execution 复用、人工维护的全局标准流程库。
- 本方案不改变 `runPlan` 的职责；`runPlan` 仍是一次 Runtime 调用内的确定性命令集合。

## 已确认原则

### Agent 与 Runtime 的职责

- Agent 读取原始用例，生成流程、检查点和条件，处理现场分支，并决定各检查点结果与豁免；整体 verdict 只是这些 Agent 结论的确定性聚合。
- Runtime 保存 Agent 提交的结构化数据，校验 ID、枚举、非空理由和引用完整性，并生成可审计事件。
- Runtime 不判断理由是否充分，不强制知识库支撑，也不因存在豁免阻止 `PASS`。

### 检查点必须有最终处置

首次 Case Flow 中的每个 `CHECK` 都进入本次 execution 的检查点基线。后续流程修订可以改变导航，但基线检查点必须保留最终处置，不能仅通过删除节点取消责任。

最终处置复用现有检查结果状态，并只新增 `WAIVED`：

| 状态 | 含义 | 最低记录要求 |
| --- | --- | --- |
| `PASS` | 已检查且符合预期 | `actual`，至少一个有效证据引用 |
| `FAIL` | 已检查且不符合预期 | `actual`，至少一个有效证据引用 |
| `NOT_APPLICABLE` | 预先声明的适用条件在本次未成立 | 沿用现有非空 `actual` 描述未触发事实；可附 Scene 或知识 |
| `WAIVED` | 检查点本次适用，但 Agent 决定豁免 | 非空 `actual` 和独立非空 `reason`；支持附 `knowledgeRefs`、`sceneRefs`、`technicalRefs` |
| `INCONCLUSIVE` | 证据不足，无法形成确定结论 | 非空 `actual`；知识和证据可选 |
| `BLOCKED` | 技术或环境约束阻止检查 | 非空 `actual`；技术事实、Scene 和知识可选 |

`NOT_APPLICABLE` 和 `WAIVED` 必须分开：前者表示用例条件未触发，后者表示验证责任存在但本次获得例外。

### PASS 与豁免

Agent 可以把一个或多个检查点处置为 `WAIVED`。现有正常 `finish` 不直接接收 Agent 提交的整体 verdict，而是从检查结果确定性聚合，因此聚合器把 `WAIVED` 与 `NOT_APPLICABLE` 一样排除在负向状态之外：存在 `FAIL`、`BLOCKED`、`INCONCLUSIVE` 时仍按现有优先级聚合；其余检查点只有 `PASS`、`WAIVED`、`NOT_APPLICABLE` 时聚合为 `PASS`。不引入 `PASS_WITH_WAIVERS` 业务状态。报告层展示“PASS · 含 1 个豁免”，并展开理由与支撑，避免覆盖缺口被隐藏。

## 推荐数据模型

### 1. Baseline Flow

`baseRevision: null` 的首次 `plan` 明确形成 execution 内不可变的 `baselineFlow`。Case Agent Prompt 必须说明：即使 Handoff 已经带有当前 Scene，首次 `plan` 也只表达原始用例的流程理解；当前 Scene 的弹窗、恢复和绕路使用 revision 2 或执行事件记录。

Runtime 无法判断自然语言是否忠实于原始用例，也不尝试判断；它只把首次提交作为 Agent 声明的基线并保持不可变。首次 Case Flow 事件已经是追加式事实，因此无需新增 `baseline-flow.json`：报告和检查点服务从第一条 `caseFlowRevised` 事件读取基线。

Baseline Flow：

- 保留 `summary`、入口、节点、边、条件和 uncertainties。
- `CHECK` 节点增加稳定的 `requirement`：`REQUIRED` 或 `CONDITIONAL`。
- `CONDITIONAL` 检查点必须有自然语言 `applicability`，由 Agent 判断是否触发。
- Baseline Flow 只说明 Agent 执行开始时对原始用例的理解，不包含后续现场弹窗、恢复动作或临时绕路。
- Baseline 中出现过的节点和边 ID 是稳定身份；后续 revision 若继续引用这些 ID，必须保持节点初始定义，以及边的 `from`、`to`、`condition` 不变。修改节点含义或分支语义时必须使用新 ID，避免 Execution Trace 回链到同名但不同义的节点或分支。
- 首次 `plan` 后不允许修改同一检查点 ID 的 `text`、`sourceBasis`、`verificationKind`、`requirement` 或 `applicability`；修正语义必须使用新 ID，并对旧检查点提交 `WAIVED` 或其他最终处置。

Runtime 仅校验图结构和字段完整性。它不检查 Agent 是否正确理解了原始用例。

schema 13 中首次 `caseFlowRevised` 的 `basedOnSceneRef` 固定为 `null`：首个 Flow 的声明来源是 `source.snapshot.md`，而不是当前 Scene。首次 Flow 前已经发生过哪些 Scene 采集仍可由事件时序审计；Runtime 不能据此证明 Agent 没有受现场信息影响，也不尝试证明。

### 2. Working Flow

现有可修订 Case Flow 保留为 Agent 的工作导航图：

- 可以增加现场动作、决策、检查点或替代路径。
- revision 继续采用追加式事件并要求修订理由。
- 基线检查点 ID 在 Working Flow 中可以继续引用；路径不再经过某个基线检查点时，该检查点仍必须通过最终处置收口。
- 后续 revision 新增的 `CHECK` 会进入 execution 的 Checkpoint Registry，并记录 `introducedRevision`、`baseline: false`；一旦出现，其语义同样不可用原 ID 改写。
- Working Flow 可以不再包含某个检查点，但这只表示它不再参与当前导航，不会从 Checkpoint Registry 删除。
- 基线检查点始终属于结束闭环；补充检查点只有在最终 Working Flow 中仍然活跃时才属于结束闭环。已经退休的补充检查点保留引入、退休理由和历史结果，但不新增强制处置，避免探索性计划调整卡住 Agent。

这样不需要禁止 Agent 改图，也不需要 Runtime 维护复杂的流程审批状态。

### 3. Execution Trace

Execution Trace 从现有不可变事件投影，不要求 Agent 再提交一张“实际流程图”，也不新增 Runtime 写入接口：

- 默认图使用现有 Narrative Projector 的 Agent decision step 作为主节点，而不是把每条原始事件都画成节点；observe/inspect、动作结果、Scene 和检查结果并入对应 step 详情。
- 轨迹边按事件时序和明确引用生成；条件分支只展示 Agent 实际选择，不由 Runtime推断。
- 版本弹窗处理、失败重试、恢复和临时绕路只进入 Execution Trace。
- Trace 节点可以通过 `baselineNodeRef` 或 `checkpointRef` 回链 Baseline Flow；没有对应关系的节点标记为“现场适配”。
- 连续重试折叠成 attempt group，`runPlan` 折叠成单个节点；详细事件继续在节点检查器、Runtime 计划和日志中展示，避免复杂用例产生不可读的大图。

### 4. Checkpoint Ledger

Checkpoint Registry 是从历次 Case Flow 中每个首次出现的 `CHECK` 追加投影出的稳定集合；Checkpoint Ledger 则把 Registry、当前活跃状态与最新有效结果合并。两者都由事件计算，不新增可被 Agent 直接编辑的文件。该台账是防止流程图弱化验证责任的主视图：

```json
{
  "checkpointRef": "N9",
  "requirement": "REQUIRED",
  "text": "顶部导航栏显示退出并保存和分享代码",
  "sourceBasis": "原始用例步骤 9",
  "disposition": "WAIVED",
  "reason": "当前版本存在已确认的平台限制",
  "sceneRefs": [],
  "knowledgeRefs": ["K-editor-001"],
  "technicalRefs": []
}
```

`recordResult`、`knowledge`、`inspect` 和其他携带 `checkNodeRefs` 的能力不再统一按“当前 revision 的 CHECK”解析：基线检查点始终可引用，补充检查点仅在当前活跃时可引用。因此即使 Working Flow 已经绕过或移除基线节点，Agent 仍能给它提交 `WAIVED` 等最终处置。结果事件继续绑定检查点首次声明时的语义摘要；同一检查点后续重新提交会替换当前有效处置，但不删除历史。

Runtime 的正常结束校验要求“全部基线检查点 + 最终 Working Flow 中活跃的补充检查点”存在结构完整的 disposition。`WAIVED` 除沿用现有非空 `actual` 外必须提交独立非空 `reason`，但不强制支撑引用；`NOT_APPLICABLE` 沿用现有 `actual` 描述条件未触发，不增加重复字段门禁。引用一旦提交就必须可解析并符合 evidence 归属规则。`WAIVED` 可以引用与该检查点绑定且仍有效的技术事实，结果校验需要把它加入现有只允许 `BLOCKED` 使用技术事实的例外。`NOT_RUN` 保持现有例外：当执行在前置阶段即无法开始时，可以携带原因和 Scene/技术证据结束，不要求逐项处置检查点。取消 execution 也不生成虚假的检查点处置。

`NOT_APPLICABLE` 只允许用于 `requirement: "CONDITIONAL"` 的检查点；`REQUIRED` 检查点若未执行，必须明确提交 `WAIVED`、`BLOCKED` 或 `INCONCLUSIVE`，不能借 `NOT_APPLICABLE` 规避责任。该规则只比较枚举字段，不要求 Runtime 理解自然语言条件。

### 5. 契约草图

Baseline 和 Working Flow 继续使用现有 `plan` 能力；CHECK 节点新增两个字段：

```json
{
  "ref": "N9",
  "type": "CHECK",
  "text": "顶部导航栏显示退出并保存和分享代码",
  "sourceBasis": "原始用例步骤 9",
  "verificationKind": "DIRECT_OBSERVATION",
  "requirement": "REQUIRED"
}
```

`requirement` 必须是 `REQUIRED` 或 `CONDITIONAL`。只有 `CONDITIONAL` 必须额外提供非空 `applicability`；`REQUIRED` 携带 `applicability` 时拒绝，避免同一语义有两种表达。

豁免继续通过 `recordResult` 提交，不增加新的 capability：

```json
{
  "capability": "recordResult",
  "results": [{
    "checkNodeRef": "N9",
    "status": "WAIVED",
    "actual": "本次未执行该检查",
    "reason": "适用知识确认当前 iOS 版本存在已知平台限制",
    "evidence": {
      "knowledgeRefs": ["K-editor-001"]
    }
  }]
}
```

`reason` 只允许且强制用于 `WAIVED`，避免给现有状态增加无效重复字段。`expectationResultUpdated` 事件和最终 `checks[]` 都保存该 reason。结果幂等比较必须包含 reason；检查点 semantic hash 增加 `requirement` 和 `applicability`。同一检查点语义禁止修改后，Working Flow 修订不再因为节点暂时移除而使基线结果失效；补充检查点退休后，其结果只退出最终闭环，历史事件保留。

## 轻门禁规则

Runtime 保留以下门禁：

1. 首次 Case Flow 必须有至少一个 `CHECK` 和一个 `END`。
2. 节点、边和检查点 ID 唯一，引用必须存在。
3. 每个基线检查点及最终仍活跃的补充检查点在正常结束时都有一个当前有效 disposition；历史更新继续追加保存。
4. `WAIVED` 必须有非空 `reason`；`NOT_APPLICABLE` 沿用现有非空 `actual`。
5. `NOT_APPLICABLE` 只能处置 `CONDITIONAL` 检查点；`REQUIRED` 检查点必须使用其他明确状态。
6. Baseline 节点和边 ID 不允许在后续 revision 中改写身份或含义；现场适配使用新 ID。
7. 已提交的证据引用必须有效；无证据引用本身不阻塞豁免。
8. revision 冲突、重复提交和失效引用继续返回稳定错误，不猜测 Agent 意图。

Runtime 明确不做以下门禁：

- 不验证自然语言条件真假。
- 不要求豁免必须命中特定知识条目。
- 不因存在 `WAIVED` 强制把整体 `PASS` 降级成其他 verdict。
- 不要求 `WAIVED` 触发知识调查；知识、Scene 和技术事实只是可选支撑。
- 不要求 `FAIL`、`INCONCLUSIVE` 或 `BLOCKED` 必须先查询知识库。
- 不阻止 Agent 调整 Working Flow。
- 不要求实际轨迹逐节点复刻 Baseline Flow。

当前实现把 `FAIL`、`INCONCLUSIVE` 和无有效技术事实的 `BLOCKED` 与强制知识调查绑定，这与本方案的职责边界冲突。本次应显式移除这项完成门禁：知识查询、候选复核和 `knowledgeRefs` 继续保留；Agent 一旦提交知识引用，Runtime 仍校验候选已评估为适用、快照和引用有效，但“没有查询知识”只进入看板质量信号，不阻止记录检查结果或 finish。`PASS/FAIL` 的 Scene 证据要求继续保留，因为它属于证据完整性而不是业务审批。

## 看板信息架构（推荐草案）

### 用例详情顶部

保留最终 verdict，但补充覆盖摘要：

```text
PASS · 检查点已处置 4/4 · 条件检查 1 项未触发 · 豁免 1 项
```

当 verdict 为 `PASS` 且存在 `WAIVED` 时，豁免数量使用独立的警示色和入口；不把 verdict 改成其他状态。

### 流程区域

在现有报告导航中保留“结果概览”和“原始用例”，并用“执行轨迹”替换当前“执行过程”：

1. **用例流程**：宽屏使用左右布局，左侧显示 Baseline Flow，右侧合并节点详情与完整 Checkpoint Ledger；检查点显示 `REQUIRED`/`CONDITIONAL` 和最终处置徽标，并支持必检、条件检查、豁免、无法判断和阻塞筛选。
2. **执行轨迹**：显示本次实际事件路径；现场适配、恢复、重试、知识调查和 `runPlan` 使用不同节点类型。

`Runtime 计划` 仍按存在性显示独立页签，`详细日志` 保持不变。执行轨迹节点的右侧检查器承接当前执行过程中的截图、动作、知识和技术事实详情，避免同一数据出现两个竞争入口。

用例流程宽屏左栏约占 55%，流程图在页面滚动时保持可见；右栏约占 45%，依次显示选中节点详情和检查点台账。流程节点与检查点记录双向联动。移动端改为上下布局，流程图在上，详情与台账在下，避免复杂内容横向压缩。

流程图默认只展示摘要标签；点击节点后在右侧检查器展示完整文本、来源依据、实际结果、理由和证据。复杂图进入全屏查看器，支持缩放、拖拽、适应窗口、方向切换和定位到指定检查点。

### Mermaid 使用边界

- 数据源仍是结构化 Baseline Flow 和 Execution Trace，不能把 Mermaid DSL 当作主数据保存。
- 报告投影层以确定性规则生成 Mermaid `flowchart` 文本，Renderer 只负责渲染。
- Runtime、Adapter 和 Case Agent 不生成 Mermaid 字符串。
- 节点 ID 使用稳定引用，标签统一转义并限制长度；完整内容放入节点检查器。
- Mermaid 只负责布局与 SVG 输出，节点状态、证据面板和筛选仍由看板代码控制。
- 禁止 CDN，使用仓库内固定版本的 Mermaid 资源，确保离线报告可用且渲染结果可复现。
- 使用严格安全配置，不允许节点文本注入任意 HTML 或脚本。

### Mermaid 视觉语义

Baseline Flow 建议：

- `ACTION`：普通矩形。
- `DECISION`：菱形。
- `CHECK REQUIRED`：粗边框检查节点。
- `CHECK CONDITIONAL`：虚线边框检查节点。
- `END`：终止节点。
- `PASS/FAIL/NOT_APPLICABLE/WAIVED/INCONCLUSIVE/BLOCKED` 通过 class 和小型状态标签表达，不改写节点正文。

Execution Trace 建议：

- 业务动作、观察、检查、现场适配、恢复、知识调查和 Runtime plan 使用独立 class。
- 主路径为实线；失败尝试或回退为细线；没有 Baseline 映射的节点标记为“现场适配”。
- `runPlan` 默认折叠为一个节点，展开后查看内部步骤时间线，避免复杂用例图爆炸。

## Mermaid 集成方案

采用浏览器端离线渲染，但不把数 MB 的 Mermaid Runtime 重复内联到每个报告：

1. 技能仓库保存经过版本和许可证核验的固定 Mermaid 构建产物。
2. 报告发布器在 workspace 根目录原子发布内容寻址资源，例如 `report-assets/mermaid-<sha>.min.js`；相同 SHA 已存在时只校验，不重写。
3. 平台报告使用确定的相对路径引用该资源。`publishReportBundle` 增加明确的 `workspaceRoot` 和 dependencies 参数；metadata 以 workspace-root-relative path 记录 bytes 和 SHA-256。校验器先 canonicalize 并确认依赖仍位于 workspace 内，再校验内容，避免允许任意 `../` 路径，也避免 HTML 发布成功但图形资源缺失。
4. Mermaid 以 `securityLevel: "strict"`、`startOnLoad: false` 初始化；DSL 文本由报告层生成并转义，不接受用例原文中的 Mermaid 指令、class 或 click callback。
5. Mermaid 加载或渲染失败时，页面显示同一 ViewModel 生成的可访问节点/边列表和明确错误，不出现空白区域；结果、检查点和证据仍可使用。

该方案不引入发布期浏览器和 Mermaid CLI，符合当前同步 Node 报告发布链路；共享内容寻址资源避免每个用例重复数 MB 脚本。单独复制一份 `CONTEXT.html` 将不保证流程图可用，正式可移植单位仍是完整 workspace 报告目录。

## 与现有 runPlan 的关系

- `runPlan` 是 Execution Trace 中的一种实际执行节点，不进入 Baseline Flow，除非初始 Case Flow 本身就声明需要该业务动作。
- `runPlan` 内部技术 `check` 仍不是业务检查点，不能自动完成 Checkpoint Ledger。
- Agent 读取 `runPlan` 证据后，显式提交业务检查结果或豁免，Ledger 才更新。
- 看板默认折叠 plan，展开后继续使用现有步骤状态、耗时、瞬时截图和技术事实投影。

## 兼容与迁移

- 本变更修改检查状态、Case Flow CHECK schema 和结果闭环，execution schema 升级为 13；schema 13 是唯一受支持的 execution 格式。
- Runtime、Batch、Case Agent Client 和 Report Reader 只处理 schema 13；旧 execution 统一返回 `FORMAT_UNSUPPORTED / 需要重跑`，不读取、不恢复、不迁移。
- 新 schema 不回填或改写历史 `events.jsonl`、`result.json` 和 Scene。
- 当前 `caseFlowRevised` 事件继续保留；schema 13 的首次 revision 是 Baseline Flow，后续 revision 是 Working Flow 历史。
- 当前 `checks[]` 继续作为最终 Ledger 快照；新增 `WAIVED` 和条件检查字段时同步 Agent-facing contract、内部 operation contract、结果服务、完整性校验、Narrative Projector 和 Renderer。
- validation profile 升级版本，并把 `resultContractVersion` 升级为新版本、`knowledgeClosurePolicy` 从 `NEGATIVE_CHECKS` 改为明确的可选策略；不能只删除结果服务中的门禁而保留与实际行为冲突的快照契约。
- 部署前必须确认没有仍在运行或等待 Case Agent 的旧格式 execution；旧活动 execution 不做原地升级，切换后只能基于原始用例创建新的 schema 13 execution。

## 数据与指标

为后续总览和质量分析保留以下聚合字段：

- 基线检查点总数、必检数、条件检查数。
- `PASS`、`FAIL`、`NOT_APPLICABLE`、`WAIVED`、`INCONCLUSIVE`、`BLOCKED` 数量。
- PASS 且包含豁免的用例数。
- 有知识支撑、Scene 支撑和技术事实支撑的豁免数。
- Baseline Flow 节点数、Execution Trace 节点数、现场适配节点数。
- Baseline 映射覆盖率；该指标只描述轨迹关联完整性，不作为业务 verdict。

指标由报告投影从结构化事件和结果计算，不由 Runtime 生成分析结论。

## 验证范围

1. Contract 测试覆盖检查点 requirement、disposition、豁免理由和证据引用。
2. Runtime 测试证明豁免不阻止 PASS，缺少处置或理由时返回可修复的输入错误。
3. 回归测试证明后续 revision 删除或绕过基线检查点时，该检查点仍出现在 Ledger。
4. 013 iOS fixture 证明版本弹窗只出现在 Execution Trace，Baseline Flow 保持原始用例理解。
5. 条件检查测试证明未触发时显示 `NOT_APPLICABLE`，而不是从流程图消失。
6. `runPlan` 测试证明技术 check 不会自动变成业务检查结果。
7. Mermaid 测试覆盖长流程、多分支、长中文标签、循环/重试、全屏缩放和离线加载。
8. 报告视觉回归覆盖桌面左右布局和移动端上下布局，确保流程图、检查点台账及详情面板不重叠、不溢出。
9. 旧格式 execution 明确返回 `FORMAT_UNSUPPORTED / 需要重跑`，不伪造 Baseline Flow 或检查点处置。
10. 补充检查点回归证明：最终仍活跃时必须闭环，修订中已退休时不阻止 finish，但历史仍可见。
11. 发布完整性测试覆盖 Mermaid 依赖缺失、hash 不符、路径越界、重复发布和并发发布。
12. 结果闭环测试证明 `FAIL/INCONCLUSIVE/BLOCKED/WAIVED` 不因未查询知识而被拒绝，但无效 `knowledgeRefs` 仍被拒绝。
13. 状态语义测试证明 `NOT_APPLICABLE` 只能用于 `CONDITIONAL`，`REQUIRED` 检查点不能借此绕过处置。
14. 图身份测试证明 Baseline 节点和边 ID 不能在后续 revision 中改写含义，现场适配必须使用新 ID。
15. Reader 回归证明 schema 13 可正常读写，旧格式 execution 无论是否完成都不能读取或恢复写入。

## 实施影响与顺序

实现可以分为四个可独立验证的阶段，避免一次性同时改 Runtime 和看板：

1. **契约与存储**：execution schema 13；升级 validation profile/result contract；扩展 CHECK 的 `requirement/applicability`；增加 `WAIVED/reason`；从 Case Flow 历史投影 Checkpoint Registry；固定 Baseline 图身份和检查点首次语义；Reader 只接受当前 execution 格式。
2. **结果闭环**：所有 `checkNodeRefs` 按“基线 + 当前活跃补充检查点”解引用；Ledger、finish readiness、verdict 聚合、知识/证据引用和 continuation brief 支持基线检查点与豁免；移除负向状态的强制知识调查门禁；`NOT_RUN` 保持例外。
3. **报告 ViewModel**：分别投影 Baseline Flow、压缩后的 Execution Trace、Checkpoint Ledger 和豁免指标；旧格式 execution 在进入投影前即被拒绝。
4. **Mermaid 与 UI**：发布内容寻址 Mermaid 资源，增加 dependency 完整性校验；替换 Case Flow Renderer，将节点详情与检查点 Ledger 合并进用例流程右栏，并增加执行轨迹页签、全屏查看器及失败回退。

主要代码边界预计包括：`case-flow-service`、Agent-facing 与 internal contracts、`validation-profile-contract`、`expectation-result-service`、`result-integrity`、execution lifecycle/continuation brief、execution reader、Narrative/Trace Projector、report publisher、detail Renderer、index projection，以及对应 contract/runtime/report/publication/visual regression 测试。Adapter 和 Coordinator 的业务编排不需要理解检查点语义；协议摘要和文档需要随接口变更更新。

## 待决策项

1. PASS 且含豁免在总览中的具体颜色、排序和筛选方式。
2. Mermaid 节点的具体密度、配色和图方向。
3. 对照模式是否首版交付，还是先交付页签和全屏查看器。

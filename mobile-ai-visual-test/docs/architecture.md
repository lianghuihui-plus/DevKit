# mobile-ai-visual-test 架构图

本文档用于理解 skill 的整体设计，不作为 agent 执行时的唯一规则来源。执行规则以 `SKILL.md` 和 `references/` 为准，硬守卫以 `scripts/execution/run-case.js`、`scripts/action.sh`、`scripts/observe.sh` 为准。

## 总体架构

```mermaid
flowchart TD
  U["用户输入<br/>Markdown 用例 / case 引用 / Flow 录制请求"] --> SK["SKILL.md<br/>模式分流和硬禁令"]

  SK --> M{"模式"}
  M --> FR["Flow Recording Mode<br/>人工指挥录制业务路径"]
  M --> CE["Case Execution Mode<br/>执行 Markdown 用例"]

  FR --> F1["flow/start-recording.js<br/>创建录制会话"]
  F1 --> F2["flow/observe.sh + flow/action.sh<br/>before/action/after"]
  F2 --> F3["flow/finalize-recording.js<br/>生成 flow.json / flow.md"]
  F3 --> FA["flows/<flow><br/>业务路径资产"]

  CE --> C1["resolve-execution-targets.js<br/>分流已有 case 和 Markdown"]
  C1 --> C2["parse-case.js<br/>生成 source.md / case.json / notes.jsonl"]
  C2 --> C3["preflight-preconditions.js<br/>执行前归纳前置条件"]
  C3 --> C4["probe-env / update-env / prepare-env<br/>环境确认与依赖准备"]
  C4 --> C5["run-case.js --start<br/>创建 execution 并自动 restartApp"]
  C5 --> C6["record-scan.js<br/>全局和步骤级 Flow 扫描"]
  C6 --> C7["observe.sh / action.sh / run-case.js --record-json<br/>步骤观察、动作、断言"]
  C7 --> C8["run-case.js --finalize<br/>结果归一和报告刷新"]
  C8 --> R["result.json / metrics.json / CONTEXT.html / index.html"]
```

## 分层职责

```mermaid
flowchart TB
  L1["Skill 协议层<br/>SKILL.md + references<br/>定义 agent 行为、模式边界和操作协议"]
  L2["稳定入口层<br/>scripts/*.sh / scripts/*.js<br/>agent 可调用的公开入口"]
  L3["执行状态层<br/>scripts/execution/run-case.js<br/>execution、timeline、guard、finalize"]
  L4["平台能力层<br/>scripts/platform/adapters/<platform><br/>Harmony / Android / iOS 能力适配"]
  L5["原子能力层<br/>atoms<br/>tap、input、screenshot、dump-tree、restart-app 等"]
  L6["产物层<br/>case.json、timeline、result、metrics、CONTEXT、index"]

  L1 --> L2 --> L3 --> L4 --> L5
  L3 --> L6
```

职责边界：

| 层级 | 做什么 | 不做什么 |
| --- | --- | --- |
| Skill 协议层 | 约束 agent 怎么执行、怎么记录、不能做什么 | 不直接操作设备 |
| 稳定入口层 | 提供公开 CLI，封装预算、来源和平台分发 | 不承载业务判断 |
| 执行状态层 | 管理 execution、timeline、顺序、证据、结果归一 | 不理解截图语义 |
| 平台能力层 | 适配 Harmony、Android、iOS 的设备能力 | 不写 case 事实 |
| 原子能力层 | 执行最小设备动作或采集 | 不组合业务流程 |
| 产物层 | 保存事实、结果、统计和报告 | 不作为续跑指针 |

## 执行状态机

```mermaid
stateDiagram-v2
  [*] --> WorkspaceChecked
  WorkspaceChecked --> TargetsResolved
  TargetsResolved --> CasePrepared
  CasePrepared --> PreconditionsPreflighted
  PreconditionsPreflighted --> EnvironmentPrepared
  EnvironmentPrepared --> ExecutionStarted
  ExecutionStarted --> PreconditionsRecorded
  PreconditionsRecorded --> GlobalFlowScanned
  GlobalFlowScanned --> StepRunning
  StepRunning --> StepRunning: next step with evidence
  StepRunning --> Finalized
  PreconditionsRecorded --> Finalized: precondition terminal
  ExecutionStarted --> Finalized: restart required but failed
  StepRunning --> Finalized: fail / blocked / budget exceeded
  Finalized --> [*]
```

关键点：

- execution 从 `run-case.js --start` 开始。
- 每个 case 只有一个当前未收尾 execution。
- finalized 后 timeline 锁定。
- 批量执行必须一个 case finalized 后再开始下一个。

## 事实源

```mermaid
flowchart LR
  OBS["observe.sh<br/>observation"] --> TL["timeline.jsonl<br/>事实源"]
  ACT["action.sh<br/>actionResult"] --> TL
  AG["agent via run-case.js --record-json<br/>precondition / assertion / flow / rule"] --> TL
  TL --> RES["result.json"]
  TL --> MET["metrics.json"]
  TL --> CTX["CONTEXT.html"]
  TL --> IDX["index.html"]
```

`timeline.jsonl` 是事实源。报告、结果和统计都是事实源的投影。

## 守卫位置

```mermaid
flowchart TD
  RC["run-case.js"] --> G1["前置条件守卫<br/>preconditionReadiness"]
  RC --> G2["全局 Flow 守卫<br/>globalFlowScanReadiness"]
  RC --> G3["步骤顺序守卫<br/>stepOrderReadiness"]
  RC --> G4["断言证据守卫<br/>assertionEvidenceReadiness"]
  RC --> G5["来源守卫<br/>observationSourceReadiness / actionResultSourceReadiness"]
  RC --> G6["结果归一<br/>normalizeResultStatus"]

  AS["action.sh"] --> A1["动作预算预检"]
  AS --> A2["坐标证据校验"]
  AS --> A3["平台 adapter 分发"]

  OS["observe.sh"] --> O1["scope / stepId 校验"]
  OS --> O2["观察预算预检"]
  OS --> O3["平台 observation 分发"]
```

文档指导 agent 正确调用入口；入口守卫负责拒绝非法事实和非法流程。

## 文档职责

```mermaid
flowchart TD
  SK["SKILL.md<br/>触发、模式、硬禁令、最小流程"]
  WF["workflow.md<br/>端到端执行阶段"]
  IF["interfaces.md<br/>入口、事件、模块边界"]
  CASE["case-format.md<br/>用例契约"]
  ENV["environment-probing.md<br/>环境与依赖"]
  ACT["action-schema.md<br/>动作与坐标"]
  FLOW["flow-format.md<br/>业务路径 Flow"]
  FAIL["failure-policy.md<br/>状态和 failureCode"]
  CTX["context-format.md<br/>产物和报告"]

  SK --> WF
  SK --> IF
  WF --> CASE
  WF --> ENV
  WF --> FLOW
  WF --> FAIL
  IF --> ACT
  FAIL --> CTX
```

规则归属原则：

- 主说明只保留 agent 必须立刻遵守的硬规则。
- reference 文件只拥有自己的领域规则。
- 其他文件需要提及时只做短引用。
- 代码守卫是最终硬约束。

## 核心设计原则

- agent 做视觉理解、业务判断、Flow 选择和断言。
- 脚本做确定性操作、来源控制、预算控制、状态机和报告生成。
- 每个 case 都完整重跑，不从失败步骤续跑。
- 每个 case 都从第一步开始，不复用后续页面跳步。
- 每个步骤都需要当前 execution 内的证据。
- Flow 是参考路径，不是盲目回放脚本。
- 平台 adapter 只做能力适配，不做业务编排。

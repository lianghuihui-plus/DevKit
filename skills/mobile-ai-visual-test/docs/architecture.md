# mobile-ai-visual-test 架构图

本文用于理解整体设计。agent 执行协议以 `SKILL.md` 和 `references/` 为准，硬守卫以 `scripts/execution/run-case.js`、`scripts/action.sh`、`scripts/observe.sh` 为准。

## 总体架构

```mermaid
flowchart TD
  U["用户输入<br/>Markdown 用例 / case 引用"] --> R["resolve + parse<br/>解析和刷新 case"]
  R --> E["probe + update-env<br/>环境探测与人工确认"]
  E --> P["preflight-preconditions<br/>生成前置条件计划"]
  F["flows/preconditions<br/>通用资产 + 平台覆盖"] --> P
  P --> M{"严格同名匹配"}
  M -->|命中| PF["resolution=flow<br/>自动执行"]
  M -->|未命中| PM["framework / confirm<br/>external_setup / unsupported"]
  PF --> B["Batch reconcile<br/>归约遗留 execution"]
  PM --> B
  B --> S["run-case --start<br/>绑定 batch + 固定计划 + 冷启动"]
  S --> AR["Runtime Core + Host Adapter<br/>硬 deadline + 每 case 独立会话"]
  AR --> CE["Case Engine<br/>确定性推进到 DecisionRequest"]
  CE --> C["前置条件阶段<br/>起点判断 → Flow → 终点判断"]
  C --> T["业务步骤阶段<br/>observe → action → assertion"]
  T --> Z["finalize<br/>业务结果归一"]
  Z --> V["Runtime validation + release"]
  V --> PUBLISH["Batch commit<br/>completion 可信发布"]
  PUBLISH --> O["result / metrics / CONTEXT / index"]
```

## Flow 目录和选择

```mermaid
flowchart LR
  D["flows/preconditions/<business>/"] --> U["flow.json<br/>platform=universal"]
  D --> H["harmony/flow.json"]
  D --> A["android/flow.json"]
  D --> I["ios/flow.json"]
  P["本次执行平台"] --> X{"平台覆盖存在?"}
  H --> X
  A --> X
  I --> X
  X -->|是| V["选择平台版本"]
  X -->|否| U
  U --> G["选择通用版本"]
```

通用版本不增加 `universal/` 目录层。Flow `name` 是唯一匹配键，前置条件文本只清理首尾空白后与其严格全等。

## 前置条件执行状态机

```mermaid
flowchart TD
  EntryCheck["入口检查"] -->|已满足 endCondition| AlreadySatisfied["已满足"]
  EntryCheck -->|满足 startCondition| StartMatched["起点匹配"]
  EntryCheck -->|均不匹配| Blocked["阻塞"]
  StartMatched --> FlowStarted["Flow 已开始"]
  FlowStarted --> StepBefore["动作前观察"] --> StepAction["执行动作"] --> StepAfter["动作后观察"]
  StepAfter -->|还有步骤| FlowStarted
  StepAfter -->|步骤完成| EndCheck["终点检查"]
  EndCheck -->|满足 endCondition| Prepared["已准备"]
  EndCheck -->|未满足| Blocked
```

关键约束：

- `entry-check` 在任何 Flow 动作前执行；终点已满足则不重复操作。
- 起点不匹配时不尝试探索或纠偏，直接 `PRECONDITION_FLOW_START_MISMATCH`。
- 每个 Flow step 强制 `before observation -> action -> after observation`。
- Flow observation 必须获得截图、布局或有效前台事实；失败 observation 只保留审计记录，不能作为证据。
- Flow action 在平台执行前严格对照 execution 冻结计划，类型或已定义参数不一致时不触发设备动作。
- Flow 完成后必须重新观察终点；动作成功不等于前置条件达成。
- Flow observation/action 使用独立 `precondition-flow` scope，不绑定 case `stepId`。

## 分层职责

```mermaid
flowchart TB
  L1["Skill 协议层<br/>SKILL.md + references"]
  LR["Agent Runtime 层<br/>Core operation + Host Adapter"]
  CE["Case Engine 层<br/>workToken + DecisionRequest"]
  L2["稳定入口层<br/>按角色收敛的 CLI"]
  L3["计划与执行状态层<br/>precondition-flow.js + run-case.js"]
  L4["平台能力层<br/>Harmony / Android / iOS adapters"]
  L5["原子能力层<br/>tap / input / screenshot / restart"]
  L6["产物层<br/>timeline / result / metrics / reports"]
  L1 --> LR --> CE --> L2 --> L3 --> L4 --> L5
  L3 --> L6
```

| 层级 | 职责 |
| --- | --- |
| Skill 协议层 | 约束执行顺序、Flow 边界和禁止行为 |
| Agent Runtime 层 | 为每个 case 创建无父会话历史的独立 Agent，并只返回结构化结果 |
| Case Engine 层 | 连续推进确定性工作，只把必须看图的单次决定交给 Agent |
| 稳定入口层 | 暴露公开 CLI，封装来源、预算和平台分发 |
| 计划与执行状态层 | 加载资产、严格匹配、固定计划、校验状态机和归一结果 |
| 平台能力层 | 适配设备能力，不做业务判断、不写 case 事实 |
| 原子能力层 | 执行最小动作或采集，不组合业务流程 |
| 产物层 | 保存可审计事实、结果、统计和报告 |

## 事实源和守卫

```mermaid
flowchart LR
  CE["execute-next-work<br/>重新归约 + workToken"] --> OBS["observe.sh<br/>observation"]
  CE --> ACT["action.sh<br/>actionResult"]
  CE --> AG["受保护事实入口<br/>precondition / flow / assertion"]
  OBS --> TL["timeline.jsonl"]
  ACT --> TL
  AG --> TL
  RT["record-agent-runtime.js<br/>Agent 会话绑定 / 失败"] --> TL
  TL --> RES["result.json"]
  TL --> MET["metrics.json"]
  RES --> VAL["Runtime validation"]
  VAL --> BAT["Batch commit-current"]
  BAT --> CMP["completion.json"]
  CMP --> REP["CONTEXT / index"]
```

主要硬守卫：

- `preconditionPlanSha` 防止 preflight 与执行之间资产漂移。
- `protocolSha` 冻结角色规范，`implementationSha` 冻结实际运行脚本，二者贯穿 request、BOUND、Runtime 和结果。
- 启动阶段只有 `executionStart`、`environmentProbe` 和 `scope=execution-bootstrap` 的 restartApp 可以早于 BOUND；所有 Case Engine 事实都要求先绑定 Runtime。
- provider 由 Runtime Core 规范化并写入 requestSha，子 Agent 和 Host Adapter 不能覆盖。
- `workToken` 绑定当前 execution、timeline 位置和 NextWork，拒绝过期或伪造决定。
- 前置条件按 case 顺序写入，全部通过或准备完成后才能进入步骤。
- Flow 事件必须绑定计划中的 `preconditionId`、`flowId` 和合法 `flowStepId`。
- 同一时间只能有一个活动 Flow；起点、步骤前后和终点都要求对应 observation/action 证据。
- Flow 终态不可逆，必须紧接同一前置条件终态；finalize 拒绝活动或悬空 Flow。
- 步骤顺序、assertion evidence 和 observation/action 来源继续由原守卫校验。
- 报告重算当前计划哈希；Flow 资产变化后隐藏旧结果。

## 设计边界

- Flow 当前只服务于前置条件；未来即使增加步骤 Flow，也通过 `usage` 和 scope 使用独立协议。
- skill 不提供 Flow 录制能力；Flow 是受版本控制的静态资产。
- 业务步骤不扫描、不匹配、不执行 Flow。
- 前置条件 Flow 完成只证明执行起点已准备好，不能作为业务步骤通过证据。
- agent 做视觉理解和条件判断；脚本做匹配、状态机、预算、来源控制和报告。
- Agent Runtime 负责会话隔离、硬超时、中断、释放和结果验证，不访问设备 adapter，也不决定业务结果。
- Batch Runtime 不接收调用方提供的验证对象，只从绑定的 Runtime 和 execution 产物生成 completion 并提交当前 case。
- Batch Runtime 在开始时只做一次恢复归约：先判断批次终态和精确所有权；多未完成 execution 判损坏，同 batch 恢复，其他 batch 禁止接管，过期 Runtime 释放，纯启动事实的孤立 execution 由框架收尾。

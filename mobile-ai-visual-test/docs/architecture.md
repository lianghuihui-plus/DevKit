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
  PF --> S["run-case --start<br/>校验 plan SHA 并固定计划"]
  PM --> S
  S --> C["前置条件阶段<br/>起点判断 → Flow → 终点判断"]
  C --> T["业务步骤阶段<br/>observe → action → assertion"]
  T --> Z["finalize<br/>结果归一和报告刷新"]
  Z --> O["result / metrics / CONTEXT / index"]
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
  U --> V2["选择通用版本"]
```

通用版本不增加 `universal/` 目录层。Flow `name` 是唯一匹配键，前置条件文本只清理首尾空白后与其严格全等。

## 前置条件执行状态机

```mermaid
stateDiagram-v2
  [*] --> EntryCheck
  EntryCheck --> AlreadySatisfied: 已满足 endCondition
  EntryCheck --> StartMatched: 满足 startCondition
  EntryCheck --> Blocked: 起点和终点都不匹配
  StartMatched --> FlowStarted
  FlowStarted --> StepBefore
  StepBefore --> StepAction
  StepAction --> StepAfter
  StepAfter --> FlowStarted: 还有 Flow step
  StepAfter --> EndCheck: 所有 Flow step 完成
  EndCheck --> Prepared: 满足 endCondition
  EndCheck --> Blocked: 未达到 endCondition
  AlreadySatisfied --> [*]
  Prepared --> [*]
  Blocked --> [*]
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
  L2["稳定入口层<br/>scripts/*.sh / scripts/*.js"]
  L3["计划与执行状态层<br/>precondition-flow.js + run-case.js"]
  L4["平台能力层<br/>Harmony / Android / iOS adapters"]
  L5["原子能力层<br/>tap / input / screenshot / restart"]
  L6["产物层<br/>timeline / result / metrics / reports"]
  L1 --> L2 --> L3 --> L4 --> L5
  L3 --> L6
```

| 层级 | 职责 |
| --- | --- |
| Skill 协议层 | 约束执行顺序、Flow 边界和禁止行为 |
| 稳定入口层 | 暴露公开 CLI，封装来源、预算和平台分发 |
| 计划与执行状态层 | 加载资产、严格匹配、固定计划、校验状态机和归一结果 |
| 平台能力层 | 适配设备能力，不做业务判断、不写 case 事实 |
| 原子能力层 | 执行最小动作或采集，不组合业务流程 |
| 产物层 | 保存可审计事实、结果、统计和报告 |

## 事实源和守卫

```mermaid
flowchart LR
  OBS["observe.sh<br/>observation"] --> TL["timeline.jsonl"]
  ACT["action.sh<br/>actionResult"] --> TL
  AG["run-case --record-json<br/>precondition / flow / assertion"] --> TL
  TL --> RES["result.json"]
  TL --> MET["metrics.json"]
  TL --> REP["CONTEXT / index"]
```

主要硬守卫：

- `preconditionPlanSha` 防止 preflight 与执行之间资产漂移。
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

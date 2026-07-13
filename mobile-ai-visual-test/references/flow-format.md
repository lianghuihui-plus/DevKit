# 前置条件 Flow

> 本文件负责：Flow 资产结构、严格匹配、执行状态机和证据要求。
> Flow 当前只服务于前置条件；业务步骤不使用 Flow。
> 面向人工或外部 Agent 的产物交付说明见 `../docs/precondition-flow-asset-delivery-guide.md`。

## 目录结构

```text
flows/
  preconditions/
    <business>/
      flow.json                 # 通用版本
      assets/                   # 可选参考图
      harmony/flow.json         # 可选平台覆盖
      android/flow.json
      ios/flow.json
```

通用版本直接放在业务目录，不增加 `universal/` 层。平台文件存在时优先于通用文件，且二者 `name` 必须一致。

## flow.json

```json
{
  "schemaVersion": 2,
  "id": "flow-enter-creation",
  "name": "进入创作页",
  "usage": "precondition",
  "platform": "universal",
  "startCondition": {
    "description": "App 已在首页且底部创作入口可见",
    "referenceImage": "assets/home.png"
  },
  "endCondition": {
    "description": "创作页标题或创作工具区可见",
    "referenceImage": "assets/creation.png"
  },
  "steps": [
    {
      "id": "flow-step-001",
      "instruction": "点击底部创作入口",
      "action": {
        "type": "tap",
        "target": "创作入口"
      }
    }
  ]
}
```

约束：

- `schemaVersion` 固定为 `2`，用于拒绝旧录制格式和支持未来显式迁移。
- `usage` 固定为 `precondition`，为未来步骤 Flow 保留概念边界。
- `platform` 为 `universal`、`harmony`、`android` 或 `ios`，且必须与目录位置一致。
- `name` 是唯一匹配键；同一平台解析后不得出现重名。
- `startCondition` 和 `endCondition` 必填且必须可区分；`referenceImage` 可选、只能是资产目录内的安全相对路径。
- `steps` 至少一项且不超过 5 项，每个 `id` 唯一；动作必须属于安全动作集合并提供该动作所需的完整参数。
- 不需要 `status`。目录中的有效资产即为可用资产；格式错误、歧义或不安全动作会在加载阶段失败。

## 匹配和计划

匹配规则只有一条：

```text
trim(casePrecondition.text) === trim(flow.name)
```

不做别名、关键词、标点归一、大小写转换、模糊或语义匹配。平台覆盖优先，通用版本兜底。

```bash
scripts/preflight-preconditions.js <case-dir...> --cwd <workspace-cwd> --platform <platform>
```

预检对每个前置条件生成一个 resolution：

| resolution | 处理方式 |
| --- | --- |
| `flow` | 自动执行命中的前置条件 Flow |
| `framework` | 用框架已有能力判断 |
| `confirm` | 无人值守开始前由用户确认 |
| `external_setup` | 用户在执行前准备外部业务状态 |
| `unsupported` | 当前不可执行，剔除、跳过或阻塞 |

预检同时返回 `preconditionPlanSha`。执行开始时必须原样传入：

```bash
scripts/run-case.js <case-dir> --platform <platform> --start --precondition-plan-sha <sha>
```

Flow 文件、参考图、平台覆盖或前置条件计划发生变化都会改变哈希，旧计划不得继续执行。

## 执行状态机

对每个 `resolution=flow` 的前置条件，按 case 顺序执行：

1. 用 `observe.sh --scope precondition-flow ... --phase entry-check` 采集入口证据。
2. 若入口已满足 `endCondition`，写 `precondition PASS`，`resolution=already_satisfied`，不执行动作。
3. 若不满足终点且不满足 `startCondition`，写 `flow BLOCKED/PRECONDITION_FLOW_START_MISMATCH`，再写同码 `precondition BLOCKED`。
4. 起点匹配时写 `flow STARTED`。
5. 每个 Flow step 执行 `before observation -> action -> after observation -> flow STEP_COMPLETED`。
6. 全部动作完成后用 `--phase end-check` 采集终点证据。
7. 终点满足时写 `flow COMPLETED`，再写 `precondition PREPARED`；否则写失败 Flow 和同码前置条件终态。

只有 `ok=true` 且包含截图、布局或有效前台应用事实的 Flow observation 才能作为证据。工具失败或没有获得有效观察能力时，框架写 `PRECONDITION_FLOW_OBSERVATION_FAILED` 并收尾。动作执行前会严格比较冻结 action；类型或 Flow 已定义参数不一致时，不调用平台 adapter，写 `PRECONDITION_FLOW_ACTION_MISMATCH` 并收尾。

Flow 的 COMPLETED、FAILED、BLOCKED 都是不可逆终态。写入终态后必须立即写同一前置条件的 PREPARED 或 BLOCKED；在此之前不能写其他事实，也不能重新开始 Flow。finalize 会拒绝活动 Flow、缺少配对前置条件终态或缺少前置条件事实的 execution。

Flow 事件都必须带：

```json
{
  "type": "flow",
  "usage": "precondition",
  "preconditionId": "precondition-001",
  "flowId": "flow-enter-creation",
  "status": "STARTED"
}
```

Flow observation/action 使用 `scope=precondition-flow`，不得绑定 case `stepId`。`before`、`after` 必须绑定 `flowStepId`；`entry-check`、`end-check` 不得绑定 `flowStepId`。

## 作用域示例

```bash
scripts/observe.sh --case-dir <case-dir> --platform <platform> --execution-id <id> \
  --scope precondition-flow --precondition-id <precondition-id> --flow-id <flow-id> --phase entry-check

scripts/action.sh --case-dir <case-dir> --platform <platform> --execution-id <id> \
  --scope precondition-flow --precondition-id <precondition-id> --flow-id <flow-id> \
  --flow-step-id <flow-step-id> --type tap --target "创作入口" ...
```

## 预算和安全

- 每个前置条件默认最多 5 个 Flow 动作，单 case 默认最多 12 个 Flow 动作。
- Flow 资产不能包含清数据、卸载、真实支付、删除、发布、修改真实资料等破坏性动作。
- Flow 动作失败、终点未到达或预算超限都以 `PRECONDITION_FLOW_*` 专用失败码阻塞当前 case。
- Flow 完成只证明前置条件已达成，不能作为任何业务步骤的通过证据。

# 接口契约

> 本文件负责：稳定顶层入口、内部层级、事件类型和关键 JSON 契约。
> 本文件不负责：端到端阶段顺序、动作参数细节、failureCode 语义、报告展示规则。
> 相关文件：`workflow.md`、`action-schema.md`、`failure-policy.md`、`context-format.md`。

## 分层

```text
Skill 协议层
  SKILL.md
  references/*.md

Agent Runtime 层
  Runtime Core operation protocol
  Platform Host Adapter
  CaseAgentRequest / CaseAgentResult

稳定入口层
  scripts/probe-env.sh
  scripts/resolve-execution-targets.js
  scripts/parse-case.js
  scripts/preflight-preconditions.js
  scripts/update-env.js
  scripts/prepare-env.sh
  scripts/build-agent-contract.js
  scripts/build-case-agent-request.js
  scripts/agent-runtime.js
  scripts/batch-runtime.js
  scripts/execute-next-work.js
  scripts/build-case-agent-result.js
  scripts/run-case.js
  scripts/observe.sh
  scripts/action.sh
  scripts/action-observe.sh
  scripts/commit-agent-turn.js
  scripts/record-agent-runtime.js
  scripts/validate-case-agent-result.js

内部实现层
  scripts/case/
  scripts/execution/
  scripts/report/
  scripts/lib/
  scripts/flow/

平台能力层
  scripts/platform/
  scripts/platform/adapters/<platform>/
  scripts/platform/adapters/<platform>/atoms/
```

agent 只调用稳定入口层。内部实现层、平台 adapter 和 atoms 不作为 agent 入口。

## 稳定入口

| 入口 | 职责 |
| --- | --- |
| `scripts/resolve-execution-targets.js` | 分流已有 case 与 Markdown 输入 |
| `scripts/parse-case.js` | 创建或刷新 case 资产 |
| `scripts/preflight-preconditions.js` | 严格匹配前置条件 Flow 并生成带哈希的执行计划 |
| `scripts/probe-env.sh` | 探测平台和设备能力 |
| `scripts/update-env.js` | 固化设备、App 和入口到平台 state |
| `scripts/prepare-env.sh` | 准备平台依赖 |
| `scripts/build-agent-contract.js` | 按 role、provider、platform 生成或校验 SkillContract |
| `scripts/build-case-agent-request.js` | 从已启动 execution 生成经过校验的 CaseAgentRequest |
| `scripts/agent-runtime.js` | 持久化单 case Agent 状态机并产生统一 Host operation |
| `scripts/batch-runtime.js` | 持久化串行批次、当前 case 和校验终态，归约遗留 execution，并通过 completion 可信发布报告 |
| `scripts/execute-next-work.js` | 重新归约 execution、连续推进确定性工作，并通过 workToken 接收单次视觉决定 |
| `scripts/build-case-agent-result.js` | 从已 finalized execution 构造 CaseAgentResult |
| `scripts/run-case.js` | 创建 execution、写 agent 事实、finalize 和守卫；仅无 batch 的兼容执行在 finalize 后直接刷新报告 |
| `scripts/observe.sh` | 采集 observation 并写入 timeline |
| `scripts/action.sh` | 执行动作并写入 actionResult |
| `scripts/action-observe.sh` | 确定性执行当前 action 后立即采集 observation，保留两条独立事实 |
| `scripts/commit-agent-turn.js` | 幂等提交同一步、同截图的 perception 与 decision/assertion |
| `scripts/record-agent-runtime.js` | 写入受保护的 Agent Runtime 绑定或失败事实 |
| `scripts/validate-case-agent-result.js` | 对照 execution/result/metrics 校验 CaseAgentResult |
| `scripts/render-context.js` | 重渲染 case 报告 |
| `scripts/render-index.js` | 重渲染 workspace 总览 |

正式 case-bound 入口必须显式传 `--platform <harmony|android|ios>`。

其中 `build-case-agent-request.js`、`record-agent-runtime.js` 和 `validate-case-agent-result.js` 是 Runtime Core 的受保护子入口，只供 `agent-runtime.js` 调用，不进入 batch-coordinator 或 case-executor SkillContract；它们保留独立 CLI 仅用于框架测试和维护诊断。

## Agent Runtime Provider 边界

统一接口是 `agent-runtime.js next` 产生的 `OPEN_SESSION`、`AWAIT_RESULT`、`INTERRUPT_SESSION`、`RELEASE_SESSION`，以及 Host Adapter 传回的 operation result。Runtime Core 持久化状态和硬 deadline；Codex Host Adapter 由主 Agent把这四种操作机械映射到宿主子 Agent 工具，并严格执行 `remainingMs`。其他平台只需实现相同映射。

Agent Runtime 不操作设备、不写 observation/actionResult、不决定业务断言。Host Adapter 也不直接修改 runtime、timeline 或结果产物；所有状态变化必须通过 `agent-runtime.js apply`。

provider 是 Runtime Core 所有的规范机器标识，初始化时统一转成小写并校验，只写入 `runtime.json`、CaseAgentRequest、RuntimeOperation 和 BOUND。CaseAgentResult 从签名 request 继承 provider；结果构造入口不接受 provider 参数。SkillContract 的 `protocolSha` 冻结 role、provider、platform、`requiredResources`、`allowedEntrypoints` 及资源内容，`implementationSha` 冻结 `implementationFiles` 列出的 Core 和当前平台实现；`environmentSha` 与 `preconditionInputsSha` 冻结本 execution 的设备环境和执行前输入。CaseAgentRequest、Runtime BOUND、runtime.json、CaseAgentResult、result、metrics 与 validation 必须全部一致。

### 参数所有权

稳定入口必须在调用平台 adapter、写 timeline 或触发 finalize 前拒绝未知参数，参数错误统一退出 `2`。平台分发器只选择 adapter，不解释业务参数；adapter 和 atom 继续做防御性校验，不得静默忽略未知参数。

| 参数类型 | 所属层 | 是否下传到 adapter |
| --- | --- | --- |
| `case-dir`、`execution-id`、`step-id`、`scope`、Flow 绑定参数 | 稳定入口 | 否 |
| `reason`、`target`、`coordinate-*`、`settle-ms` | 稳定入口的审计或编排信息 | 否 |
| `type`、坐标、`text`、`mode`、`ms`、`velocity`、`duration-ms` | 统一动作参数 | 是，仅传动作所需字段 |
| `device`、`app/bundle`、`entry/ability` | 平台环境参数；case-bound 时必须等于 execution environmentSnapshot | 是 |
| iOS Appium/WDA 参数 | `update-env.js` 配置并由 `--start` 冻结到 environmentSnapshot | 仅在 case-bound 入口解析完成后注入 iOS adapter |

新增参数时必须先在本节和对应领域契约中确定所有权，再修改稳定入口与 adapter；不能依靠底层忽略多余参数维持兼容。

## PlatformAdapter

平台 adapter 对外提供统一能力：

```ts
interface PlatformAdapter {
  probe(): EnvironmentProbe
  observe(input: ObserveInput): Observation
  action(input: Action): ActionResult
}
```

adapter 内部可以调用 atoms，但不得：

- 读取或修改 case 业务资产。
- 写入 `timeline.jsonl`。
- 做业务判断。
- 把 agent 可审计编排的多步流程封装成黑盒组合。

## EnvironmentProbe

`probe-env` 输出平台能力事实：

```json
{
  "schemaVersion": 1,
  "platform": "android",
  "devices": [{"id": "device-id", "name": "Pixel"}],
  "capabilities": {
    "screenshot": true,
    "layout": true,
    "foreground": true,
    "logs": true,
    "actions": ["launchApp", "restartApp", "tap", "inputText", "swipe", "back", "wait"],
    "dependencies": {"mavtInputIme": {"ok": true}}
  }
}
```

平台可在 `devices[]` 写 `deviceFormFactor`，并在 `capabilities.startupDisplay` 统一声明 `canReadOrientation`、`canSetOrientation`、`canVerifyAfterLaunch` 与 `supportedOrientations`。`deviceFormFactor` 描述产品形态；iOS 既有 `deviceType=simulator|realDevice` 描述执行目标类型，两者不能互相替代。

`update-env.js` 固化统一策略：

```json
{
  "startupDisplayPolicy": {
    "orientation": "portrait",
    "enforcement": "required",
    "appliesTo": ["phone"]
  }
}
```

启动级 `restartApp actionResult.startupDisplay` 使用统一结果契约：

```json
{
  "requestedOrientation": "portrait",
  "enforcement": "required",
  "appliesTo": ["phone"],
  "deviceFormFactor": "phone",
  "deviceFormFactorSource": "environment",
  "required": true,
  "before": {"orientation": "landscape", "rotation": 270, "width": 2720, "height": 1260},
  "afterNormalization": {"orientation": "portrait", "rotation": 0, "width": 1260, "height": 2720},
  "afterLaunch": {"orientation": "portrait", "rotation": 0, "width": 1260, "height": 2720},
  "normalizationApplied": true,
  "retryApplied": false,
  "verified": true,
  "status": "VERIFIED",
  "skippedReason": null,
  "failureStage": null
}
```

`required=true` 时，只有 `status=VERIFIED`、`verified=true` 且 `afterLaunch.orientation` 等于请求值才满足契约；策略不适用时 adapter 返回 `status=SKIPPED` 和稳定 `skippedReason`。已知失败仍应返回结构化 `actionResult`，由 Case Engine 统一映射为冷启动隔离失败。Runtime Core 不解释平台命令，只根据已确认策略和该结果决定隔离是否可信。

目标 App、入口和当前前台状态不由 `probe-env` 固化；目标信息由 `update-env.js` 写入，当前状态由 `observe.sh` 采集。

## Observation

正式 observation 必须由 `scripts/observe.sh` 写入，并带 `source: "observe.sh"`。

```json
{
  "schemaVersion": 1,
  "type": "observation",
  "source": "observe.sh",
  "ok": true,
  "platform": "android",
  "stepId": "step-001",
  "label": "001-step-001-before",
  "app": {
    "inTargetApp": true,
    "appId": "com.example.app",
    "activity": ".MainActivity"
  },
  "artifacts": {
    "screenshot": "screenshots/001-step-001-before.png",
    "layout": "layouts/001-step-001-before.json",
    "logs": "logs/001-step-001-before.log"
  },
  "artifactMetadata": {
    "screenshot": {
      "sha256": "<64-hex>",
      "bytes": 123456,
      "format": "png",
      "width": 1080,
      "height": 2400,
      "decodeStatus": "VALID"
    }
  }
}
```

`artifactMetadata.screenshot` 由顶层观察证据链生成，不由平台 adapter 或 agent 填写。新 observation 的截图必须记录采集时 SHA-256、字节数、尺寸和解码状态；`decodeStatus` 为 `VALID`、`UNSUPPORTED` 或 `INVALID`，其中 `UNSUPPORTED` 表示当前像素检查器不支持该合法编码特征，不等于文件损坏。`trailingBytes` 记录 `IEND` 后被通用图片解码器忽略的附加字节，仅作为采集诊断，不把可完整解码的 PNG 判坏。后续 perception 与 assertion 会重新读取文件并校验 SHA-256。旧 execution 缺少该字段时仍可读取，但不能据此证明采集后文件未变化。

步骤内观察必须传 `--step-id <step-id>`。全局诊断观察必须显式传 `--scope global` 或 `--global-observation`。前置条件 Flow 观察使用 `--scope precondition-flow`，绑定 `preconditionId`、`flowId` 和 `phase`，不得绑定 `stepId`。

前置条件 Flow observation 只有在 `ok=true` 且包含截图、布局或有效前台应用事实时才能作为证据；失败 observation 仍写 timeline，但带 `ok=false` 和专用失败码。

## ActionResult

正式 actionResult 必须由 `scripts/action.sh` 写入，并带 `source: "action.sh"`。

```json
{
  "schemaVersion": 1,
  "type": "actionResult",
  "source": "action.sh",
  "platform": "android",
  "stepId": "step-001",
  "authorization": {
    "source": "case-step",
    "stepId": "step-001",
    "intentSha": "step-intent-0123456789abcdef"
  },
  "action": "tap",
  "ok": true,
  "target": "登录按钮",
  "coordinateSource": "layout",
  "targetBounds": [120, 1680, 900, 1780],
  "coordinateEvidence": "控件树存在登录按钮 bounds"
}
```

动作集合和坐标要求见 `action-schema.md`。前置条件 Flow 动作使用 `scope=precondition-flow`，并绑定 `preconditionId`、`flowId`、`flowStepId`；它不属于 case step。

全局规则动作使用 `scope=global-rule`，必须绑定当前 `stepId`、`ruleId` 和 `authorization={source:"global-rule",ruleId,ruleSha,stepId}`。`ruleSha` 从 `case.snapshot.json` 中的完整规则生成；`action.sh` 在设备调用前、`run-case.js` 在事实写入前分别校验，不能借用业务步骤 intentSha。规则动作成功后必须产生动作后 observation 和 `rule status=HANDLED`，才可回到规则判断或业务步骤。

`inputText actionResult` 必须保存 `inputMode` 与 `inputEffect.status`。status 为 `VERIFIED`、`UNVERIFIABLE` 或 `MISMATCH`；只有平台能够读取最终值且值不符合 `replace` 目标时才写 `MISMATCH`，并以 `ACTION_EFFECT_MISMATCH` 阻塞。无法读取安全输入框或追加后的完整值时允许 `UNVERIFIABLE`，后续仍由动作后 observation 和步骤断言闭环。

业务 ACT decision 必须回传 DecisionRequest 的 `stepIntent.intentSha`，引擎把它归一为 `authorization={source:"case-step",stepId,intentSha}`；`action.sh` 在设备调用前、`run-case.js` 在写入前分别对照 `case.snapshot.json` 校验。业务步骤中的 `actionResult ok=true` 只证明已授权动作执行成功。即使随后已有同步骤 observation，也不能单独完成步骤或进入下一步；每个业务步骤最终都必须写入满足下述视觉证据门禁的 `assertion PASS`。

授权按冻结步骤而不是敏感词生效：步骤明确要求的删除、支付、发布、资料修改等操作不被框架语义拦截；步骤未要求的副作用不能借用该授权。前置条件 Flow 继续使用自身的冻结动作与安全规则，不接受 case-step 授权。

Flow 动作执行前由 `run-case.js` 对照 `execution.json` 中冻结的 action 做硬校验，actionResult 同时保存 `requestedAction` 供执行后复核。

启动阶段自动执行的 restartApp 使用 `scope: "execution-bootstrap"`，不得包含 stepId、preconditionId、flowId 或 flowStepId。它只证明 execution 冷启动隔离，是 BOUND 前唯一允许出现的 actionResult；其他 actionResult 都属于 Case Engine 事实并要求先有 Runtime BOUND。

## Agent 事实

agent 可通过 `run-case.js --record-json` 写入非平台事实。`executionStart`、`environmentProbe`、`observation`、`evidenceCheck`、`actionRejected`、`actionResult`、`budgetExceeded`、`executionRecovery`、`agentRuntime`、`result` 属于框架事件，公开入口一律拒绝：

| 类型 | 用途 |
| --- | --- |
| `precondition` | 当前 execution 内的前置条件结果 |
| `perception` | 影响后续动作的视觉理解 |
| `decision` | 影响后续动作或断言的决策 |
| `rule` | 全局规则判断与处理，status 为 `MATCHED`、`SKIPPED`、`HANDLED`、`FAILED`、`BLOCKED` 或 `UNKNOWN` |
| `flow` | 前置条件 Flow 的开始、步骤完成、完成或失败事实 |
| `assertion` | 步骤断言结果 |

不要为了说明想法写入不会影响执行的事实。

`agentRuntime` 只能由 `record-agent-runtime.js` 写入。`BOUND` 绑定 provider、sessionScope、protocolSha、implementationSha、requestSha、environmentSha 和 preconditionInputsSha；`FAILED`、`INTERRUPTED` 必须使用合法 `AGENT_*` failureCode，并由框架安全收尾当前 execution。

前置条件外部输入只有两类：`confirm` 必须冻结为 `PASS`，`external_setup` 必须冻结为 `PREPARED`。`flow`、`framework` 和 `unsupported` 不接受外部输入；其中 framework 事实必须带计划中的 `checkerId` 和可审计 `evidenceRefs`。

`executionRecovery` 只能由 `run-case.js --recover-orphaned` 写入，用于已经超过 deadline、没有 Agent Runtime 且 timeline 只有合法启动事实的孤立 execution；它必须以 `BLOCKED/EXECUTION_ORPHANED` 收尾。

## 批次恢复归约

`batch-runtime.js reconcile-current` 只读 batch、execution、timeline 和 Runtime 产物并返回一个动作，不执行宿主操作，也不循环监控：

| action | 含义 |
| --- | --- |
| `START_NEW` | 没有活动 execution |
| `RESUME_START` | 当前 batch 的 execution 停在 STARTING，调用 `run-case --resume-start` 幂等恢复 |
| `INIT_RUNTIME` | 当前 batch 的 execution 已 RUNNING 且只有启动事实 |
| `BIND_RUNTIME` | 当前 batch 的 Runtime 已存在，但 batch 尚未保存 execution 绑定 |
| `RESUME_RUNTIME` | 当前 batch 的 Runtime 可继续调用 next |
| `COMMIT_START_RESULT` | 无 Runtime 的框架启动失败已 finalized，调用 `commit-start-result` |
| `COMMIT_FINALIZED` | 当前绑定 execution 已 finalized，可提交可信产物 |
| `RECOVER_FINALIZING` | 存在可重入的 finalize draft |
| `RECOVER_RUNTIME_TERMINAL` | Runtime 已失败并释放但 execution 未收尾；调用一次 Runtime `next` 补齐失败闭环后重新归约 |
| `CLOSE_EXPIRED` | 其他 execution 已过期且存在 Runtime，走超时、中断和释放 |
| `CLOSE_ORPHANED` | 其他 execution 已过期、无 Runtime 且只有启动事实 |
| `BLOCK_CONCURRENT` | 其他 batch 的 execution 尚未过期，禁止抢占 |
| `BLOCK_RUNTIME_RELEASE` | Host 连续三次无法确认 Runtime session 释放，批次必须阻塞 |
| `BATCH_BLOCKED` | 批次已阻塞，重复恢复只返回同一终态 |
| `BATCH_COMPLETE` | 批次已完成，无需继续提交 |
| `CORRUPTED` | 候选 execution 不唯一、存在未绑定业务事实、身份不一致或缺少不可变环境/输入绑定 |

`commit-agent-turn.js` 只接受一个 step 和一个 observation，第一条事实必须是 perception，第二条最多一条 decision 或 assertion。它为事件附加相同 `turnId`，提交前冻结 `<execution>/agent/turns/*.draft.json`，重试时校验原请求并跳过已提交事实，完整提交后删除 draft；不能批量写多个步骤。`execute-next-work decide` 只对命中该 draft 且内容完全一致的旧 workToken 开放恢复，不把普通过期决定重新放行。

业务 ACT 在创建 turn draft 前先经过 `normalizeActionProposal + validateActionExecution(scope=case-step)`。失败时 perception 和 decision 都不写入；Case Engine 通过受保护入口写 `actionRejected`，重新归约为 `DECIDE_STEP`。业务拒绝绑定 stepId、intentSha、workToken、observation、失败字段和原动作提案。Flow 参数补齐经过 `validateActionExecution(scope=precondition-flow)`，失败时写绑定 preconditionId、flowId、flowStepId 和 observation 的 `actionRejected`，重新归约为 `DECIDE_FLOW_ACTION`。规则动作通过 `validateActionExecution(scope=global-rule)` 并逐字段保持冻结动作类型和目标；不合法时直接以 `ACTION_CONTRACT_INVALID` 收尾，不触发设备动作。公开 `--record-json` 与子 Agent均不可伪造框架动作结果。

用于支持业务 `assertion PASS` 的 `perception` 必须绑定当前步骤最新 observation 的截图：

```json
{
  "type": "perception",
  "stepId": "step-001",
  "status": "USABLE",
  "evidence": ["screenshots/001-step-001-after.png"],
  "reason": "已实际查看当前截图，内容完整且足以判断本步骤"
}
```

`status` 可为 `USABLE`、`UNUSABLE` 或 `UNCERTAIN`。只有 `USABLE` 且包含 `reason` 的当前截图 perception 可以支持 PASS；其他 perception 仍可用于记录影响后续动作的视觉理解，但不能作为通过门禁。

当 Agent 图片预览疑似出现黑屏、黑块、花屏或解码异常时，perception 使用结构化声明：

```json
{
  "type": "perception",
  "stepId": "step-001",
  "status": "UNCERTAIN",
  "attemptId": "preview-attempt-001",
  "presentationMode": "scaled",
  "evidence": ["screenshots/001-step-001-after.png"],
  "qualityClaim": {
    "source": "agent_preview",
    "kind": "VERTICAL_BLACK_BLOCKS",
    "coordinateSpace": "normalized",
    "regions": [{"x": 0.4, "y": 0.1, "width": 0.08, "height": 0.8}]
  },
  "reason": "Agent 预览中疑似存在竖向黑块"
}
```

`kind` 支持 `BLACK_SCREEN`、`BLACK_BLOCKS`、`VERTICAL_BLACK_BLOCKS`、`VISUAL_CORRUPTION`、`PREVIEW_DECODE_ERROR`。区域坐标均为相对原图宽高的 `0..1` 值；黑块声明必须提供区域。`run-case.js` 自动补充 `inputArtifact`，其中 `sourceVerified` 表示当前文件哈希仍等于采集时哈希，`presentationVerified=false` 明确表示框架无法证明 Agent 平台最终呈现的预览像素与原图完全相同。

若 Agent 请求 `UNUSABLE`，但原始像素未命中声明或无法确定性验证，框架会保留 `requestedStatus=UNUSABLE` 并把正式 perception 归一为 `UNCERTAIN`。有限重试前写同一步骤的 `decision=retry_visual_input`；第二次 perception 必须使用新的 `attemptId`、`retryOf=<首次 attemptId>` 和 `presentationMode=original|reopen|scaled`。重新查看同一原图是合法重试，不要求重新截图。

## EvidenceCheck

`evidenceCheck` 是 `run-case.js` 根据 `qualityClaim` 生成的框架事实，公开 `--record-json` 不接受手写：

```json
{
  "type": "evidenceCheck",
  "source": "run-case.js",
  "checkId": "evidence-check-001",
  "stepId": "step-001",
  "artifactSha256": "<64-hex>",
  "sourceVerified": true,
  "presentationVerified": false,
  "attemptId": "preview-attempt-001",
  "retryOf": null,
  "presentationMode": "scaled",
  "verdict": "CLAIM_NOT_PRESENT_IN_SOURCE",
  "pixelStats": [],
  "reason": "原始 PNG 的声明区域不存在对应近黑像素特征"
}
```

`verdict` 为 `SOURCE_INVALID`、`SOURCE_CHANGED`、`CLAIM_PRESENT_IN_SOURCE`、`CLAIM_NOT_PRESENT_IN_SOURCE` 或 `UNVERIFIABLE`。`CLAIM_PRESENT_IN_SOURCE` 只证明原始像素包含声明特征，不等同于截图损坏，也不能自动区分合法 UI、设备画面和采集异常。

`precondition` 最小模板：

```json
{
  "type": "precondition",
  "id": "pre-001",
  "status": "PASS",
  "reason": "用户已在执行前确认登录态满足"
}
```

`status` 只允许 `PASS`、`PREPARED`、`FAIL`、`UNKNOWN`、`BLOCKED`。`PASS` 和 `PREPARED` 允许进入步骤，其余状态会收尾当前 execution。

## Assertion

每个业务步骤都必须以 `assertion PASS` 作为通过证据。PASS 必须引用当前步骤最新 observation 的截图，并且此前已有引用同一截图的 `perception status=USABLE`：

```json
{
  "type": "assertion",
  "stepId": "step-001",
  "status": "PASS",
  "reason": "截图显示已进入首页",
  "evidence": ["screenshots/001-step-001-after.png"]
}
```

业务 assertion 的 `evidence` 只能引用 observation 产物路径；`label` 只用于定位和展示。前置条件 Flow 的 `evidenceObservation` 标识协议不受此规则影响。

证据要求和 PASS 归一规则见 `failure-policy.md`。

## Precondition Flow

Flow 事件只允许服务于前置条件：

```json
{
  "type": "flow",
  "usage": "precondition",
  "preconditionId": "precondition-001",
  "flowId": "flow-enter-creation",
  "flowStepId": "flow-step-001",
  "status": "STEP_COMPLETED",
  "reason": "动作成功且 after observation 已确认"
}
```

`status` 允许 `STARTED`、`STEP_COMPLETED`、`COMPLETED`、`FAILED`、`BLOCKED`。`STARTED` 前必须有 `entry-check` observation；`STEP_COMPLETED` 前必须有同 Flow step 的成功 actionResult 和 `after` observation；`COMPLETED` 前必须有 `end-check` observation。完整协议见 `flow-format.md`。

Flow 终态不可逆；终态后的下一条相关事实必须是同一前置条件的对应终态，之后不得重新 entry-check 或 STARTED。

## Result

`result` 事件、`result.json` 和 `metrics.json` 由 `run-case.js --finalize` 写入。报告产物语义见 `context-format.md`。

## 来源守卫

- 公开 `run-case.js --record-json` 不接受正式 `observation`。
- 公开 `run-case.js --record-json` 不接受正式 `actionResult`。
- 正式观察必须走 `observe.sh`。
- 正式动作必须走 `action.sh`。
- `evidenceCheck` 只能由 `run-case.js` 根据结构化 `qualityClaim` 生成。
- 直接手写观察或动作结果会被拒绝。
- 公开入口不得写框架事件；填写伪造的 `source` 不能提升写入权限。
- Agent Runtime 事实必须走 `record-agent-runtime.js`；公开 `--record-json` 不能伪造 `agentRuntime`。

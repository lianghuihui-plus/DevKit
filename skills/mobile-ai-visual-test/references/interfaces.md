# 接口契约

## 批次协调器入口

```bash
node scripts/workspace.js --cwd <workspace>
node scripts/import-case.js <input-file> --workspace <workspace>
scripts/probe-env.sh --platform <platform>
scripts/prepare-env.sh --platform <platform> [platform options]
node scripts/environment.js confirm --workspace <workspace> --binding-json '<json>' --probe-json '<json>' --user-confirmation '<text>'
node scripts/environment.js status --workspace <workspace>
node scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json '<json>' --user-instruction '<text>'
node scripts/execution-request.js status --workspace <workspace> --batch-id <id>
node scripts/knowledge.js validate --workspace <workspace>
node scripts/batch.js init --workspace <workspace> --batch-id <id>
node scripts/batch.js bootstrap --workspace <workspace> --batch-id <id>
node scripts/batch.js reconcile --workspace <workspace> --batch-id <id>
node scripts/batch.js start --workspace <workspace> --batch-id <id>
node scripts/batch.js recover --workspace <workspace> --batch-id <id> --request-json '<json>'
node scripts/batch.js commit --workspace <workspace> --batch-id <id>
node scripts/batch.js status --workspace <workspace> --batch-id <id>
```

`environment.js confirm` 冻结用户确认的 `platform`、`deviceId`、`appId`、平台必要参数、probe 摘要和确认原文，只形成 `environment-confirmation.json`。它不创建 batch，也不启动 App。

`execution-request.js create` 必须由后续明确执行指令触发。`targets-json` 是有序的 `[{"caseKey":"...","caseDir":"..."}]`，caseDir 必须位于当前工作空间的 `cases/`；`SINGLE` 只允许一个 target。请求创建前校验 Skill/Workspace 知识库，随后在 `runs/<batch>/request-targets/` 冻结 source/case 快照，并冻结 case-executor、batch-coordinator 协议摘要和 implementationSha。请求固定为 `UNATTENDED`，创建后不可改写；中断时从 `execution-request.draft.json` 恢复，不重新读取实时用例。环境确认发生变化时，旧请求失效。

`batch.js init` 只消费同一 batchId 的现有执行请求；不再接受 `--binding-json` 或 `--targets-json`，因此不能把环境确认隐式升级为执行。

`batch.js recover` 接受原文明示冷启动、`AGENT_DECIDED_RESTART` 和客观技术/产品事故恢复。原文明示冷启动由 Case Agent 只提交 `SOURCE_REQUIRED_COLD_START` 和原因，Facade 从活动检查点关联 requirement 自动生成 sourceRefs；Agent 主动决定重启时由 Facade 自动生成 `recoveryId/executionId/checkpointId/triggerType/evidenceRefs/decisionReason`。事故恢复仍必须包含 `incidentId/incidentCategory/incidentReason`。同一 recoveryId 重入按已冻结记录中的 executionId 定位原 execution，不使用当前 case 推断目录。

## case Agent 入口

```bash
node scripts/agent/status.js --exec-dir <execution>
node scripts/agent/understand.js --exec-dir <execution> --request-json '<json>'
node scripts/agent/inspect.js --exec-dir <execution> [--request-json '<json>']
node scripts/agent/step.js --exec-dir <execution> --request-json '<json>'
node scripts/agent/mark-start.js --exec-dir <execution> [--request-json '<json>']
node scripts/agent/request-recovery.js --exec-dir <execution> --request-json '<json>'
node scripts/agent/investigate.js --exec-dir <execution> --request-json '<json>'
node scripts/agent/conclude.js --exec-dir <execution> --request-json '<json>'
```

每个语义入口成功后都返回最新 `runtimeState`；`status` 只用于重连、响应不确定和恢复，不返回业务 NextWork。`understand` 自动维护 understanding/plan revision、turnId、planSha 和检查点状态。`inspect` 返回截图原始尺寸与控件树精简元素。`step` 自动生成 operationId/authorization/证据绑定，执行一个动作并采集动作后现场。`mark-start` 显式确认最新 PREPARE observation。`investigate` 负责知识查询与候选评估。`conclude` 自动生成 checkpointFinding、verdictReview、result、metrics 和 AgentResult。

内部 step、turn、operation、知识查询和 phase 草稿由协调器在 `reconcile` 中自动收口，不再交给 Case Agent。`request-recovery` 只接收 Agent 的原因和可选触发类型，其余绑定由框架生成；协调器收到 `RECOVER_APP` 后将返回的 `recoveryRequest` 原样传给 `batch.js recover`。

execution 创建时生成 `agent/contract.json`，并由 Agent request 的 `agentContractPath`、`agentContractSha`、protocol SHA 和 implementation SHA 绑定。该文件是 Case Agent 的字段与命令权威来源；所有入口错误均返回包含 `code`、`entrypoint`、`message`、可选 `fieldPath/expected/allowed` 和 `retryable` 的 JSON。

Case Agent 优先使用 `observationView.elements[].ref` 定位控件；视觉坐标使用相对原始截图的 0..1 值。Facade 将元素 bounds 或归一化坐标转换为平台像素，并自动绑定 basis observation、截图/控件树证据和动作后 observation。状态变更动作完成后默认缓冲 500ms 再启动 observation，可用 `MAVT_POST_ACTION_SETTLE_MS=0..5000` 调整；该等待由框架执行，不要求 Agent 提交 `wait`。底层 actionResult 与 observation 仍分别写入 timeline，并确认冻结 platform、device 和 App。

## 分层

```text
SKILL / references
  -> workspace + case import
  -> environment confirmation + explicit execution request
  -> batch warm session and recovery
  -> isolated case Agent
  -> execution lifecycle and evidence guards
  -> platform adapter
```

平台 adapter 只做 probe、observe 和 action，不读取 case 业务内容、不写 timeline、不形成断言。`conclude` 生成 `agent/result.json`，绑定 Agent request、双角色协议、实现、result/metrics 路径与摘要。batch commit 在释放 Runtime 前校验 AgentResult、Recovery 闭环和引用知识快照，生成覆盖执行与证据产物的 `artifact-manifest.json`，再发布绑定该清单 SHA 的 framework completion。批次完成只需调用一次 `scripts/render-index.js`，它会重建全部用例根概览、平台详情和首页并校验链接；`scripts/render-context.js` 仅用于定向刷新。报告 reader 先校验 completion 与产物清单，再从 timeline、最新版计划和冻结 operation 投影页面，不创建第二份操作日志。

执行实现摘要和报告实现摘要相互独立：`implementationSha` 只覆盖会影响运行与设备行为的代码；`rendererSha` 覆盖报告 service、报告入口和只读依赖，随 `report-metadata.json` 发布。报告代码升级后可重渲染旧 execution，但不能冒充当时的执行实现。

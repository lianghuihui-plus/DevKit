# 接口契约

## 批次协调器入口

```bash
node scripts/workspace.js --cwd <workspace>
node scripts/import-case.js <input-file> --workspace <workspace>
scripts/probe-env.sh --platform <platform>
scripts/prepare-env.sh --platform <platform> [platform options]
node scripts/environment.js confirm --workspace <workspace> --binding-json '<json>' --probe-json '<json>' --user-confirmation '<text>'
node scripts/environment.js status --workspace <workspace>
node scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json '[{"caseNo":"004"}]' --user-instruction '<text>'
node scripts/execution-request.js status --workspace <workspace> --batch-id <id>
node scripts/knowledge.js validate --workspace <workspace>
node scripts/batch.js init --workspace <workspace> --batch-id <id>
node scripts/batch.js bootstrap --workspace <workspace> --batch-id <id>
node scripts/batch.js reconcile --workspace <workspace> --batch-id <id>
node scripts/batch.js start --workspace <workspace> --batch-id <id>
node scripts/batch.js recover --workspace <workspace> --batch-id <id> --request-json '<json>'
node scripts/batch.js commit --workspace <workspace> --batch-id <id>
node scripts/batch.js status --workspace <workspace> --batch-id <id>
node scripts/batch.js teardown --workspace <workspace> --batch-id <id>
```

`environment.js confirm` 冻结用户确认的 `platform`、`deviceId`、`appId`、平台必要参数、probe 摘要和确认原文，只形成 `environment-confirmation.json`。它不创建 batch，也不启动 App。

框架产物统一使用 `deviceId` 表示设备身份，环境确认、execution request、batch contract 和 execution snapshot 都不接受或保留 `device`。平台脚本的命令行参数仍为 `--device`，该名称只属于 adapter 边界，不进入框架数据契约。

`execution-request.js create` 必须由后续明确执行指令触发。`targets-json` 是有序 target 数组，人工指定时优先使用 `[{"caseNo":"004"}]`；框架解析为内部 `caseKey/caseDir`，内部调用仍可直接提交这两个字段。编号必须在当前工作空间唯一存在，caseDir 必须位于 `cases/`；`SINGLE` 只允许一个 target。请求创建前校验 Skill/Workspace 知识库，随后在 `runs/<batch>/request-targets/` 冻结 source/case 快照，并冻结 case-executor、batch-coordinator 协议摘要和 implementationSha。请求固定为 `UNATTENDED`，创建后不可改写；中断时从 `execution-request.draft.json` 恢复，不重新读取实时用例。环境确认发生变化时，旧请求失效。

`batch.js init` 只消费同一 batchId 的现有执行请求；不再接受 `--binding-json` 或 `--targets-json`，因此不能把环境确认隐式升级为执行。

`batch.js bootstrap` 在冷启动 App 前通过平台运行资源接口完成批次级资源绑定。HarmonyOS、Android 当前返回 `NOT_REQUIRED`；iOS 返回包含 `resource.appium`、`resource.wda` 和 `resource.forwarding` 的复合资源，每一项独立记录 `status/ownership`。WDA 身份至少绑定 `deviceId`、`updatedWDABundleId`、PID 和独立进程组；无法建立精确身份时按外部资源保留，不做泛化进程清理。批次 `COMPLETED/BLOCKED` 后，`commit/reconcile` 自动执行幂等清理，`teardown` 用于终态批次的显式补偿。全部框架资源已消失才返回 `RELEASED`；存在确认的外部资源返回 `RETAINED`；所有权不一致、停止失败或端口残留返回 `RELEASE_FAILED`。分项结果写入 `runs/<batch>/platform-runtime.json` 和批次事件，不改变已提交用例结果。

bootstrap/recovery 不直接按某个平台返回字段是否存在来判断成功。Adapter 先返回冷启动客观事实和可选 `startupDisplay`；`device-session` 再结合冻结的 `startupDisplayPolicy` 统一计算 `coldStartVerified`、`startupDisplayVerified` 和校验诊断；Batch 只消费这两个标准结果。Android、iOS 默认 `preserve + none`，显示方向不是启动成功的必要条件；HarmonyOS 命中 `required` 策略时仍必须获得 `VERIFIED` 显示证据。

`batch.js recover` 接受原文明示冷启动、`AGENT_DECIDED_RESTART` 和客观技术/产品事故恢复。原文明示冷启动由 Case Agent 只提交 `SOURCE_REQUIRED_COLD_START` 和原因，Facade 从活动检查点关联 requirement 自动生成 sourceRefs；Agent 主动决定重启时必须绑定当前可用 observation；事故恢复在没有当前可用现场时可以绑定最新状态变化后的不可用 observation。`incidentCategory` 只允许 `PRODUCT/TECHNICAL`，省略时为 `TECHNICAL`，具体故障描述由 `reason` 冻结为 `incidentReason`。Facade 在写控制请求前完成枚举校验，再自动生成 `recoveryId/executionId/checkpointId/triggerType/evidenceRefs` 和决策/事故字段，Batch 复用同一共享契约并校验证据属于当前 execution 与暖会话代次。同一 recoveryId 重入按已冻结记录中的 executionId 定位原 execution，不使用当前 case 推断目录。

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

每个语义入口成功后都返回不含完整证据清单的轻量 `runtimeState`；`status` 只用于重连或响应不确定，返回完整状态和证据清单，不返回业务 NextWork。`runtimeState.conclusionConstraint` 只表达框架收口边界；超时观察缺口时固定允许 `INCONCLUSIVE`，并在知识调查闭合前令 `mayConclude=false`。`understand` 自动维护 understanding/plan revision、turnId、planSha 和检查点状态。`inspect` 返回截图原始尺寸、布局可用性、控件树精简元素和技术信号。`step` 自动生成 operationId/authorization/证据绑定，执行一个动作并采集动作后现场，同时计算状态差异和证据冲突。`mark-start` 显式确认最新 PREPARE observation。`investigate` 负责知识查询与候选评估。`conclude` 先预校验完整候选结论，再以同一 turn 幂等生成 checkpointFinding、verdictReview、result、metrics 和 AgentResult；契约拒绝不会写入半成品事实或切换阶段。

内部 step、turn、operation、知识查询和 phase 草稿由协调器在 `reconcile` 中自动收口，不再交给 Case Agent。`request-recovery` 只接收 Agent 的原因、可选触发类型和枚举事故分类，其余绑定由框架生成；非法分类在控制请求写入前被拒绝。协调器收到 `RECOVER_APP` 后将返回的 `recoveryRequest` 原样传给 `batch.js recover`。若此时已达单用例时限，框架记录 `controlRequestClosed`、删除控制请求并进入超时结论，不再调用设备恢复。

execution 创建时生成 `agent/contract.json`，并由 Agent request 的 `agentContractPath`、`agentContractSha`、protocol SHA 和 implementation SHA 绑定。该文件是 Case Agent 的字段与命令权威来源；所有入口错误均返回包含 `code`、`entrypoint`、`message`、可选 `fieldPath/expected/allowed` 和 `retryable` 的 JSON。

Case Agent 优先使用 `observationView.elements[].ref` 定位控件；视觉坐标使用相对原始截图的 0..1 值。Facade 将元素 bounds 或归一化坐标转换为平台像素，并自动绑定 basis observation、截图/控件树证据和动作后 observation。布局层统一解析 HarmonyOS JSON、Android UiAutomator XML 和 iOS XCUI XML；解析失败写入 `layout.diagnostics`。iOS 键盘与坐标空间冲突时只暴露平台动作 `dismissKeyboard` 解除冲突，其他平台不会获得该动作。状态变更动作完成后默认缓冲 500ms 再启动 observation，可用 `MAVT_POST_ACTION_SETTLE_MS=0..5000` 调整；该等待由框架执行，不要求 Agent 提交 `wait`。底层 actionResult 与 observation 仍分别写入 timeline，并确认冻结 platform、`deviceId` 和 App。

`inputText` 对 Agent 始终是一条整串输入命令；iOS adapter 使用当前 active editable element，在单次设备调用内完成有界备选输入并返回 `inputMethod/inputAttempts/inputEffect`。动作调用前由 Facade 传入页面缓冲，设备层为动作声明时长和一次后置观察检查最低剩余时间；不足时以 `CASE_TIME_LIMIT_INSUFFICIENT` 在设备调用前结束该 step。

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

平台 adapter 只做 probe、运行资源生命周期、observe 和 action，不读取 case 业务内容、不写 timeline、不形成断言。`conclude` 生成 `agent/result.json`，绑定 Agent request、双角色协议、实现、result/metrics 路径与摘要；CLI 随后写入成功 conclude attempt。batch commit 校验 AgentResult、Recovery 闭环和引用知识快照，先释放 Runtime，再生成覆盖执行与证据产物的 `artifact-manifest.json`，最后发布绑定该清单 SHA 的 framework completion。commit 完成后由 batch CLI 增量重建当前用例的平台详情、用例详情和工作区首页，并在 `dashboardRefresh` 返回刷新状态；该耗时不进入 execution metrics，刷新失败不改变已提交结果。批次完成时再调用一次 `scripts/render-index.js` 全量重建并校验链接；`scripts/render-context.js` 仅用于定向刷新。报告 reader 先校验 completion 与产物清单，再从 timeline、最新版计划和冻结 operation 投影页面，不创建第二份操作日志；单个 case 数据损坏时只发布该 case 的“报告数据异常”页面，不阻断其他 case 重建，也不改用其他 execution 掩盖错误。

执行实现摘要和报告实现摘要相互独立：`implementationSha` 只覆盖会影响运行与设备行为的代码；`rendererSha` 覆盖报告 service、报告入口和只读依赖，随 `report-metadata.json` 发布。报告代码升级后可重渲染当前 schema 的已发布 execution，但不能冒充当时的执行实现；旧 schema 直接拒绝。

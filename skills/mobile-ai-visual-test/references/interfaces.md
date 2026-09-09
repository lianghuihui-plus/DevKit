# 接口契约

## 主 Agent CLI

```bash
node scripts/workspace.js --cwd <workspace>
node scripts/import-case.js <input-file> --workspace <workspace>
scripts/probe-env.sh --platform <harmony|android|ios> [platform options]
scripts/prepare-env.sh --platform <harmony|android|ios> [platform options]
node scripts/app-artifact.js register --workspace <workspace> --path <apk|hap|app|ipa> --platform <platform> --app-id <id> --version <version> --build <build> [--device-type <simulator|realDevice>]
node scripts/environment.js confirm --workspace <workspace> --binding-json '<json>' --probe-json '<json>' [--app-provisioning-json '<json>'] --user-confirmation '<text>'
node scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json '<targets-json>' [--bootstrap-policy-json '<policy-json>'] --user-instruction '<text>'
node scripts/batch.js <init|bootstrap|reconcile|start|commit|status|cancel|teardown> --workspace <workspace> --batch-id <id>
```

每个 target 必须在授权前提供 CaseSpec 和初始状态要求。ExecutionRequest 会补齐稳定 ID、哈希和 InitialStatePreflight，并冻结原文、Case Contract、CaseSpec、requirement 与 policy：

```json
{
  "caseNo": "004",
  "caseSpec": {
    "summary": "验证设置保存结果",
    "preconditions": ["用户已登录"],
    "expectations": [
      { "text": "设置入口可用", "verificationKind": "DIRECT_OBSERVATION", "sourceEvidence": [{ "quote": "设置入口可用" }] },
      { "text": "目标条目存在", "verificationKind": "SEARCH_EXISTENCE", "sourceEvidence": [{ "quote": "目标条目存在" }] }
    ],
    "ambiguities": []
  },
  "initialStateRequirement": {
    "schemaVersion": 1,
    "targetState": "APP_LOCAL_STATE_EMPTY",
    "rationale": "该用例验证首次启动页面"
  },
  "preparationPolicy": {
    "schemaVersion": 1,
    "allowedEffects": ["CLEAR_APP_DATA"],
    "targetAppOnly": true,
    "userAuthorization": "允许清除目标 App 本地数据"
  }
}
```

`initialStateRequirement.targetState` 可为 `KEEP_EXISTING`、`APP_LOCAL_STATE_EMPTY` 或 `FRESH_INSTALL`。`preparationPolicy` 是用户允许的副作用，不是业务要求；创建请求时二者不匹配或 `FRESH_INSTALL` 缺少冻结制品，会以 `INITIAL_STATE_PREFLIGHT_FAILED` 拒绝。

`bootstrapPolicy` 默认不重装。需要批次开始前重装冻结制品时必须显式提交：

```json
{
  "schemaVersion": 1,
  "mode": "REINSTALL_FROZEN",
  "allowedEffects": ["UNINSTALL_TARGET_APP", "INSTALL_FROZEN_ARTIFACT"],
  "targetAppOnly": true,
  "userAuthorization": "允许批次启动时重装冻结制品"
}
```

`app-artifact register` 返回的 manifest 包含 expected identity 和实际提取状态。`UNAVAILABLE` 表示登记环境无法解析，不代表已核验；任何实际重装仍必须返回匹配的 `installedIdentity`。

`batch start` 返回从 execution 快照和 Runtime 当前状态派生的 Case Brief，其中只有原文、Frozen CaseSpec、初始状态结果、目标摘要、可选 Scene 和预绑定 Runtime Client；不存在可写的权威 `case-brief.json`。只有 `agentRequired=true` 才创建 Case Agent。`batch reconcile` 对主 Agent 返回 `BOOTSTRAP`、`NEED_CASE_AGENT`、`WAIT_CASE_AGENT`、可重试的 `PUBLISH_REPORTS` 或三类批次终态，内部自动完成 commit、execution settle、平台释放和报告发布。锁竞争最多等待三次，致命错误进入阻塞收口。

## Case Runtime

Case Agent 把一个 RuntimeRequest JSON 写入 `runtime.requestPath`，再不带参数运行 `runtime.command`。Broker 只允许 `observe`、`act`、`knowledge`、`recover`、`finish` 和 `status`；`prepare` 是 Lifecycle 内部能力，通过 Agent Client 调用会返回 `CASE_RUNTIME_OPERATION_FORBIDDEN`。

```json
{ "operation": "observe", "decision": { "purpose": "建立基线", "expectationRefs": [], "planUpdate": { "reason": "初始计划", "next": ["进入目标页", "逐项验证"] } } }
{ "operation": "act", "basedOnSceneId": "scene-0001", "capabilityId": "scene-0001:tap:el-8", "decision": { "purpose": "进入设置", "expectationRefs": ["E1"] } }
{ "operation": "knowledge", "basedOnSceneId": "scene-0002", "query": "当前页面显示异常", "decision": { "purpose": "查询本地经验", "expectationRefs": ["E2"] } }
{ "operation": "recover", "basedOnSceneId": "scene-0002", "reason": "重新建立 App 起点", "decision": { "purpose": "恢复后继续", "expectationRefs": [] } }
{ "operation": "status" }
```

`act` 的 `capabilityId` 与 `visual` 二选一。视觉坐标为 0..1；长按必须提供 `durationMs`。`observationPolicy.duringActionAtMs` 仅适用于长按且满足 `20 <= duringActionAtMs < durationMs`。

每种 operation 使用独立字段白名单，未知字段和旧 `intent` 会被拒绝。`act.decision` 必须包含 `purpose` 与 `expectationRefs`；其余 decision 字段可选，只在确有信息时提交。

Action Result v2 分别公开 `lifecycle`、`command`、`deviceExecution` 和 `observedEffect`。`spatialEvidence` 的当前标注附件为包含操作前底图的 PNG；`DISPATCH_ONLY` 不能证明真实触点，`DEVICE_CONFIRMED` 且 `actual` 非空才表示平台确认。

搜索型验证点的负向 FAIL 只有在滚动上下文 `absenceConclusionSupported=true` 时成立，并提交：

```json
{ "type": "SEARCH_ABSENCE", "sceneRef": "scene-0004", "scrollContextRef": "scroll-context-0001" }
```

CaseResult 必须一对一覆盖 Frozen CaseSpec 全部 expectation。PASS/FAIL 引用 Scene；知识引用必须已评估为 `APPLICABLE`；BLOCKED 的 `technicalRefs` 必须指向仍有效且绑定该 expectation 的 Runtime 技术事实。

Runtime 状态包括 `SCENE`、`SCENE_CHANGED`、`RECOVERY_APPLIED`、`KNOWLEDGE`、`COMPLETED`、`RESULT_INCOMPLETE`、`REQUEST_INVALID`、`TIME_LIMIT` 和 `TECHNICAL`。批次 CLI 的业务失败也输出结构化 `TECHNICAL` JSON；只有 CLI 语法错误使用非零退出码。

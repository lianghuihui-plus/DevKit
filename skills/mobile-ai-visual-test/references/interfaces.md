# 接口契约

## 主 Agent CLI

```bash
node scripts/workspace.js --cwd <workspace>
node scripts/import-case.js <input-file> --workspace <workspace>
node scripts/case-definition.js status --workspace <workspace> --case-no <no>
scripts/probe-env.sh --platform <harmony|android|ios> [platform options]
scripts/prepare-env.sh --platform <harmony|android|ios> [platform options]
node scripts/app-artifact.js register --workspace <workspace> --path <apk|hap|app|ipa> --platform <platform> --app-id <id> --version <version> --build <build> [--device-type <simulator|realDevice>]
node scripts/environment.js confirm --workspace <workspace> --binding-json '<json>' --probe-json '<json>' [--app-provisioning-json '<json>'] --user-confirmation '<text>'
node scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json '<targets-json>' [--bootstrap-policy-json '<policy-json>'] --user-instruction '<text>'
node scripts/batch.js <init|bootstrap|reconcile|start|commit|status|cancel|teardown> --workspace <workspace> --batch-id <id> [--continuation-reason <reason>]
```

每个 target 只提供用例选择器和 READY CaseDefinition 引用。ExecutionRequest 会验证定义与当前 source/case 的绑定，补齐稳定 ID、哈希和 InitialStatePreflight，并冻结原文、Case Contract、CaseDefinition、CaseSpec、requirement 与 policy：

```json
{
  "caseNo": "004",
  "definitionRef": {
    "definitionId": "definition-...",
    "definitionSha": "case-definition-..."
  }
}
```

CaseDefinition 的 `initialStateIntent.targetState` 可为 `KEEP_EXISTING`、`APP_LOCAL_STATE_EMPTY` 或 `FRESH_INSTALL`。Publisher 校验其原文依据；ExecutionRequest 再按平台投影为冻结的 `initialStateRequirement` 和 `preparationPolicy`。Android、HarmonyOS 的 `FRESH_INSTALL` 使用 `CLEAR_APP_DATA` 并允许 `PREINSTALLED` provisioning；iOS 使用 `REINSTALL_APP` 并要求 `ARTIFACT_MANAGED` provisioning。

`bootstrapPolicy` 默认不重装。需要批次开始前重装冻结制品时必须显式提交：

```json
{
  "schemaVersion": 1,
  "mode": "REINSTALL_FROZEN",
  "allowedEffects": ["UNINSTALL_TARGET_APP", "INSTALL_FROZEN_ARTIFACT"],
  "targetAppOnly": true
}
```

`app-artifact register` 返回的 manifest 包含 expected identity 和实际提取状态。`UNAVAILABLE` 表示登记环境无法解析，不代表已核验；任何实际重装仍必须返回匹配的 `installedIdentity`。

`batch start` 的主 Agent 可见响应只包含调度字段：`action`、`agentRequired`、`batchId`、`caseKey`、`executionId` 和可选 `handoff`。`handoff` 只包含 schema、ID、绝对路径、SHA-256 与带 claim token 的 `loaderCommand`，不包含 Prompt、Brief、Scene 或 Runtime 绑定正文。Loader 首次读取时在锁内消费 dispatch；同 token 重试幂等，错误 token 或已被 continuation 替换的 Handoff 会被拒绝。

正常 `batch reconcile` 返回 `WAIT_CASE_AGENT` 时只包含当前 batch/case/execution 标识及可选重试诊断，不返回 Brief。确认原 Agent 句柄丢失后，使用 `batch start --continuation-reason <reason>` 显式生成递增 Handoff；它沿用原 `executionId`。`batch reconcile` 还会返回 `BOOTSTRAP`、`NEED_CASE_AGENT`、可重试的 `PUBLISH_REPORTS` 或三类批次终态，并在内部自动完成 commit、execution settle、平台释放和报告发布。锁竞争经过有界重试，致命错误进入阻塞收口。

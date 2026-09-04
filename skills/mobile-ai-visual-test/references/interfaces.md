# 接口契约

## 主 Agent

```bash
node scripts/workspace.js --cwd <workspace>
node scripts/import-case.js <input-file> --workspace <workspace>
scripts/probe-env.sh --platform <platform>
scripts/prepare-env.sh --platform <platform> [platform options]
node scripts/environment.js confirm --workspace <workspace> --binding-json '<json>' --probe-json '<json>' --user-confirmation '<text>'
node scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json '[{"caseNo":"004"}]' --user-instruction '<text>'
node scripts/batch.js init --workspace <workspace> --batch-id <id>
node scripts/batch.js bootstrap --workspace <workspace> --batch-id <id>
node scripts/batch.js reconcile --workspace <workspace> --batch-id <id>
node scripts/batch.js start --workspace <workspace> --batch-id <id>
node scripts/batch.js start --workspace <workspace> --batch-id <id> --continuation-reason '<native Agent handle 丢失原因>'
node scripts/batch.js commit --workspace <workspace> --batch-id <id>
node scripts/batch.js status --workspace <workspace> --batch-id <id>
node scripts/batch.js teardown --workspace <workspace> --batch-id <id>
```

`batch start` 返回 `brief`，其中包含冻结用例、目标摘要、可选初始 Scene 和预绑定 Runtime 入口。主 Agent 将其一次性交给 Case Agent。

`batch reconcile` 在新 execution 上只返回批次动作，不返回 Case Agent 中间决策：运行中为 `WAIT_CASE_AGENT`，完成后为 `COMMIT_CASE`。

## Case Agent

Case Brief 提供固定 `runtime.command` 和固定 `runtime.requestPath`。Case Agent 将一个请求 JSON 写入该路径，然后不带参数运行 command：

```json
{ "operation": "observe", "caseContext": { "summary": "验证设置保存结果", "preconditions": ["用户已登录"], "expectations": ["设置入口可用", "保存后显示目标状态"], "initialPlan": ["进入设置", "修改并保存", "检查结果"], "uncertainties": [] } }
{ "operation": "act", "capabilityId": "scene-0001:tap:el-8", "intent": "打开设置", "decision": { "observation": "页面显示设置入口", "conclusion": "可以开始验证", "purpose": "进入设置页", "expectedOutcome": "显示目标设置", "expectationRefs": ["E1"] } }
{ "operation": "knowledge", "query": "当前页面显示异常", "decision": { "observation": "结果与预期不一致", "conclusion": "需要确认是否为已知表现", "purpose": "查询本地经验", "expectedOutcome": "获得可用于判断的候选信息", "expectationRefs": ["E2"] } }
{ "operation": "observe", "decision": { "observation": "现场仍与预期不同", "conclusion": "候选知识适用于当前平台", "purpose": "按知识规则复核现场", "expectedOutcome": "形成可追溯的最终判断", "expectationRefs": ["E2"], "knowledgeReview": { "queryId": "knowledge-0001", "conclusion": "APPLICABLE_FOUND", "assessments": [{ "entryId": "K-example-001", "status": "APPLICABLE", "reason": "平台、页面和现象均一致" }] } } }
{ "operation": "recover", "reason": "重新建立 App 起点", "decision": { "observation": "目标 App 已离开前台", "conclusion": "当前现场无法继续", "purpose": "恢复 App 后继续用例", "expectedOutcome": "目标 App 回到可操作状态", "expectationRefs": [] } }
{ "operation": "status" }
```

`caseContext` 放在首次 Runtime 请求中，初始计划至少包含一个步骤；首次用于建立现场的 `observe` 可以不带 decision，之后的 `observe`、`act`、`knowledge`、`recover` 和 `finish` 均随已有业务请求提交 decision，不增加单独调用。知识候选评估放在下一次已有请求的 `decision.knowledgeReview` 中。Runtime 为验证点分配稳定的 `E1`、`E2` 引用，并自动关联 Scene、operationId、时间和计划版本。记录状态统一为 `COMPLETE`、`PARTIAL` 或 `UNAVAILABLE`。

每次调用输出一个 JSON 对象。状态包括 `SCENE`、`SCENE_CHANGED`、`KNOWLEDGE`、`COMPLETED`、`RESULT_INCOMPLETE`、`REQUEST_INVALID`、`TIME_LIMIT` 和 `TECHNICAL`。Runtime 技术错误、时间限制或未知动作/恢复结果会返回稳定的 `technicalFactRef`。请求文件先被原子认领再解析，因此有效或无效请求都会被消费；Case Agent 不提供 executionDir、deviceId、appId、平台参数或 Adapter 命令。

Batch 命令的业务或环境失败同样输出一个 `TECHNICAL` JSON 并正常结束进程；只有命令名、选项和值缺失等调用语法错误使用非零退出码。

复杂视觉动作请求示例：

```json
{
  "operation": "act",
  "visual": { "gesture": "tap", "point": [0.5, 0.72] },
  "intent": "打开截图中可见的确认按钮",
  "decision": { "observation": "截图中显示确认按钮", "conclusion": "需要点击该按钮继续", "purpose": "确认当前设置", "expectedOutcome": "页面显示确认后的状态", "expectationRefs": ["E1"] }
}
```

完成结果：

```json
{
  "verdict": "PASS",
  "summary": "目标交互与预期一致",
  "checks": [
    {
      "expectationRef": "E1",
      "status": "PASS",
      "actual": "页面已显示目标状态",
      "sceneRefs": ["scene-0003"],
      "knowledgeRefs": [],
      "technicalRefs": []
    }
  ],
  "uncertainties": []
}
```

CaseResult 必须覆盖当前全部验证点。负向业务结论必须完成相关知识调查；知识支持的检查通过 `knowledgeRefs` 引用已冻结且评估为适用的条目。只有 Runtime 返回的技术事实属于当前 execution、关联当前验证点与 generation、未被后续成功执行恢复且仍直接阻止验证时，BLOCKED check 才通过 `technicalRefs` 引用该事实并免于知识调查；没有显式有效引用时仍按业务阻塞调查。不属于当前协议的 execution 不恢复或转换，需要重新执行用例。

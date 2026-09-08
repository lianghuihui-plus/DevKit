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
node scripts/batch.js cancel --workspace <workspace> --batch-id <id> --reason '<取消原因>'
node scripts/batch.js teardown --workspace <workspace> --batch-id <id>
```

`batch start` 返回 `brief`，其中包含冻结用例、目标摘要、可选初始 Scene 和预绑定 Runtime 入口。带 `--continuation-reason` 时，Batch 先恢复 Runtime，再返回包含最新 Scene、用例理解、计划、未解决技术事实和待复核知识的 continuation Brief。

`batch reconcile` 在新 execution 上只返回批次动作，不返回 Case Agent 中间决策：运行中为 `WAIT_CASE_AGENT`，完成后为 `COMMIT_CASE`。

## Case Agent

Case Brief 提供固定 `runtime.command` 和固定 `runtime.requestPath`。Case Agent 将一个请求 JSON 写入该路径，然后不带参数运行 command：

```json
{ "operation": "observe", "caseContext": { "summary": "验证设置保存结果", "preconditions": ["用户已登录"], "expectations": [{ "text": "设置入口可用", "verificationKind": "DIRECT_OBSERVATION" }, { "text": "目标条目可以在完整列表中找到", "verificationKind": "SEARCH_EXISTENCE" }], "initialPlan": ["进入设置", "搜索目标", "检查结果"], "uncertainties": [] } }
{ "operation": "act", "basedOnSceneId": "scene-0001", "capabilityId": "scene-0001:tap:el-8", "intent": "打开设置", "decision": { "observation": "页面显示设置入口", "conclusion": "可以开始验证", "purpose": "进入设置页", "expectedOutcome": "显示目标设置", "expectationRefs": ["E1"] } }
{ "operation": "knowledge", "basedOnSceneId": "scene-0002", "query": "当前页面显示异常", "decision": { "observation": "结果与预期不一致", "conclusion": "需要确认是否为已知表现", "purpose": "查询本地经验", "expectedOutcome": "获得可用于判断的候选信息", "expectationRefs": ["E2"] } }
{ "operation": "observe", "decision": { "observation": "现场仍与预期不同", "conclusion": "候选知识适用于当前平台", "purpose": "按知识规则复核现场", "expectedOutcome": "形成可追溯的最终判断", "expectationRefs": ["E2"], "knowledgeReview": { "queryId": "knowledge-0001", "conclusion": "APPLICABLE_FOUND", "assessments": [{ "entryId": "K-example-001", "status": "APPLICABLE", "reason": "平台、页面和现象均一致" }] } } }
{ "operation": "recover", "basedOnSceneId": "scene-0002", "reason": "重新建立 App 起点", "decision": { "observation": "目标 App 已离开前台", "conclusion": "当前现场无法继续", "purpose": "恢复 App 后继续用例", "expectedOutcome": "目标 App 回到可操作状态", "expectationRefs": [] } }
{ "operation": "status" }
```

`caseContext` 放在首次 Runtime 请求中，初始计划至少包含一个步骤；首次用于建立现场的 `observe` 可以不带 decision，之后的 `observe`、`act`、`knowledge`、`recover` 和 `finish` 均随已有业务请求提交 decision，不增加单独调用。知识候选评估放在下一次已有请求的 `decision.knowledgeReview` 中。Runtime 为验证点分配稳定的 `E1`、`E2` 引用，并自动关联 Scene、operationId、时间和计划版本。记录状态统一为 `COMPLETE`、`PARTIAL` 或 `UNAVAILABLE`。

每次调用输出一个 JSON 对象。状态包括 `SCENE`、`SCENE_CHANGED`、`RECOVERY_APPLIED`、`KNOWLEDGE`、`COMPLETED`、`RESULT_INCOMPLETE`、`REQUEST_INVALID`、`TIME_LIMIT` 和 `TECHNICAL`。`RECOVERY_APPLIED` 表示中断事务已恢复且当前旧请求没有执行，Case Agent 必须基于返回的最新 Scene 重新判断。Runtime 技术错误、时间限制或未知动作/恢复结果会返回稳定的 `technicalFactRef`。

Batch 命令的业务或环境失败同样输出一个 `TECHNICAL` JSON 并正常结束进程；只有命令名、选项和值缺失等调用语法错误使用非零退出码。

复杂视觉动作请求示例：

```json
{
  "operation": "act",
  "basedOnSceneId": "scene-0002",
  "visual": { "gesture": "tap", "point": [0.5, 0.72] },
  "intent": "打开截图中可见的确认按钮",
  "decision": { "observation": "截图中显示确认按钮", "conclusion": "需要点击该按钮继续", "purpose": "确认当前设置", "expectedOutcome": "页面显示确认后的状态", "expectationRefs": ["E1"] }
}
```

长按的 `durationMs` 必填；控件能力通过 `input.durationMs` 提交，视觉长按通过 `visual.durationMs` 提交。`observationPolicy.duringActionAtMs` 仅适用于长按，必须满足 `20 <= duringActionAtMs < durationMs`，用于保存释放前的过程截图。

动作后的 Scene 使用 Action Result v2 分层返回事实：`lifecycle.status` 表示 Runtime 事务是否完成，`command.status` 表示命令是否被接受，`deviceExecution.status` 表示平台是否能验证设备执行，`observedEffect.status` 表示前后 Scene 为 `CHANGED`、`UNCHANGED` 或 `UNKNOWN`。命令被接受不等于点击命中、控件响应或业务成功；请求坐标回显写入 `deviceExecution.dispatchedPoint/dispatchedFrom/dispatchedTo`，没有真实触点反馈时 `actualTouchPoint` 为 `null`。

点击、长按、输入和滑动还会在 `Scene.previousAction.spatialEvidence` 返回统一动作空间证据：`requested`、`expectedDispatched`、`dispatched`、可空的 `actual`、`certainty`、`consistency` 以及 `annotatedScreenshot.attachment`。`DISPATCH_ONLY` 表示只有请求和命令投递事实，`DEVICE_CONFIRMED` 表示平台提供了真实触点；标注图是包含操作前截图底图的独立 SVG，不需要消费方重新换算或绘制。持久化事件只保存 `spatialEvidenceRef`，完整内容位于 `action-spatial-evidence/action-N.json`。

布局可识别的单层垂直列表在 Scene 中提供 `scrollContexts`，包含当前边界置信度、连续覆盖状态、未探索方向和自适应滑动距离。Runtime 不规定 Agent 的搜索方向或固定滑动次数；只有当前 generation 的滚动上下文达到两端 `CONFIRMED`、`coverage=CONTIGUOUS` 且 `absenceConclusionSupported=true`，才支持完整列表不存在结论。

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

CaseResult 必须覆盖当前全部验证点。`SEARCH_EXISTENCE` 验证点的 FAIL check 必须提交 `evidenceBasis: { "type": "SEARCH_ABSENCE", "sceneRef": "<覆盖完成的 Scene>", "scrollContextRef": "<该 Scene 中的引用>" }`。知识支持的检查通过 `knowledgeRefs` 引用已冻结且评估为适用的条目；直接 Scene 证据足够时不强制知识调查。只有 Runtime 返回的技术事实仍有效时，BLOCKED check 才通过 `technicalRefs` 引用。不属于当前协议的 execution 不恢复或转换，需要重新执行用例。

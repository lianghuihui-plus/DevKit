# 报告格式

## 何时读取

- 用户要求执行、验证、修复、重跑或查看结果时读取，用于生成或更新 report。
- 需要从历史结果恢复 `planFile`、测试方法、失败码、diagnostics 或 summary 索引时读取。
- 只生成测试代码且不执行时，通常不生成 report，也通常不需要读取本文件。

用户要求执行后，只要进入探测、gate、目标确认、构建、安装或运行任一阶段，或某个用例在生成阶段已经阻塞，就必须生成报告。成功、失败、阻塞、生成阻塞、构建失败、安装失败、设备失败、目标确认未通过都要记录。仅生成测试代码时只生成生成阶段 plan，不生成 report。

默认目录：

```text
harmony-ui-test-workspace/reports/
```

该目录位于被测 HarmonyOS 项目根目录的专属工作目录中，不是 skill 包目录。

报告内容尽量使用项目相对路径。为了复现命令，也可以记录必要的绝对路径。

## 单用例报告

文件名使用稳定 `caseId`：

```text
<case-id>.md
<case-id>.json
```

`caseId` 由人工用例原文内容 hash 生成，正常不需要模块名前缀或时间戳。

## 批量 Summary 索引

批量执行时额外自动生成轻量 summary 索引：

```text
summary.md
summary.json
```

单用例不生成 summary。summary 只用于批量结果矩阵、失败候选选择和 blocked 候选筛选，不是事实来源；执行结果的事实来源始终是每个 case 的 report，执行前上下文的事实来源是每个 case 的 plan。结果类 summary 缺失或过期时，只能扫描当前工作目录的 case reports 重建；不要从 case plans 推断 `PASS`、`FAIL` 或 `BLOCKED` 结果。

case report 是当前结果快照。每次执行、重跑或修复完成后，都根据 plan 和本次执行结果完整重渲染并覆盖写入同一份 JSON 和 Markdown；不要读取旧 report 做字段级合并，也不要保留旧失败字段。

批量场景下，每个 case 到达最终 `PASS`、`FAIL` 或 `BLOCKED` 状态后，必须立即写入或覆盖自己的 case report。批量因基础设施问题中止时，所有受影响且尚未执行的 case 也必须写入 `BLOCKED` case report，`failure.code` 使用对应基础设施失败码。批量全部结束或中止后，再从已经写入的 case reports 派生生成或覆盖 summary 索引。不要等整批全部完成后才一次性写 case reports。

## JSON 字段

最小字段：

```json
{
  "status": "PASS | FAIL | BLOCKED",
  "caseFile": "",
  "caseName": "",
  "planId": "",
  "planFile": "",
  "module": "",
  "testFile": "",
  "testClass": "",
  "testMethod": "",
  "buildMode": "debug",
  "workspace": {
    "root": "harmony-ui-test-workspace",
    "configFile": "harmony-ui-test-workspace/config.json"
  },
  "repairBudget": {
    "configured": 5,
    "used": 0,
    "remaining": 5,
    "source": "user_instruction | workspace_config | skill_default"
  },
  "commands": {
    "buildApp": "",
    "buildTest": "",
    "installApp": "",
    "installTest": "",
    "runTest": ""
  },
  "artifacts": {
    "appHap": "",
    "testHap": ""
  },
  "environment": {
    "device": "",
    "hdcPath": "",
    "bundleName": "",
    "testModuleName": ""
  },
  "targetConfirmation": {
    "required": true,
    "preBuild": {
      "status": "pending | confirmed | blocked",
      "summaryShown": {}
    },
    "preInstall": {
      "status": "pending | confirmed | verified | blocked | stale",
      "summaryShown": {},
      "mismatchAfterBuild": []
    }
  },
  "buildProbe": {
    "devecoSdkHome": "",
    "nodePath": "",
    "hvigorwPath": "",
    "availableTasks": [],
    "selectedBuildAppTask": "",
    "selectedBuildTestTask": "",
    "taskFallbackReason": "",
    "product": "",
    "moduleName": "",
    "ohosTestTargetExists": false,
    "bundleNameCandidates": [],
    "bundleNameSource": "",
    "signedHapSelected": false,
    "signedHapSelectionReason": "",
    "signedAppHap": "",
    "signedTestHap": ""
  },
  "result": {
    "testsRun": 0,
    "pass": 0,
    "failure": 0,
    "error": 0,
    "ignore": 0,
    "rawSummary": ""
  },
  "diagnostics": [],
  "failure": null,
  "preconditions": [],
  "preconditionGate": null
}
```

失败时使用：

```json
{
  "failure": {
    "code": "ASSERTION_FAILED",
    "stage": "run_test",
    "summary": "",
    "details": "",
    "nextAction": ""
  }
}
```

如果执行请求中的用例在生成阶段已经阻塞，写入：

```json
{
  "status": "BLOCKED",
  "failure": {
    "code": "GENERATION_BLOCKED",
    "stage": "generate_test",
    "summary": "生成阶段无法可靠生成测试代码",
    "details": "复制 plan.generation.reason",
    "nextAction": "按 generation.reason.nextAction 补充信息后重新生成或执行"
  }
}
```

当失败来自权限或沙箱限制时，`failure.summary` 必须保留原始错误摘要，`failure.nextAction` 必须写明需要用户授权提权执行，或由用户在本机终端执行同一命令并回贴输出。

`diagnostics` 记录失败后的 hdc 实时诊断证据。没有执行诊断时使用空数组。

```json
{
  "diagnostics": [
    {
      "type": "layout_dump | screenshot | ability_state | bundle_info | process_state | hilog | other",
      "stage": "after_run_failure",
      "command": "hdc shell uitest dumpLayout",
      "status": "success | failed | skipped",
      "artifact": "harmony-ui-test-workspace/logs/tc-a83f21c9d4e5-evidence.md",
      "summary": "当前页面未出现 login_button，存在 login_submit_button",
      "details": "关键输出片段、失败原因，或 evidence 文件中的具体小节"
    }
  ]
}
```

诊断信息只保存与当前失败用例相关的关键证据。诊断失败不阻塞报告生成，`status = failed` 或 `skipped` 时在 `details` 中记录原因。`artifact` 默认指向聚合 evidence 文件；只有截图、控件树 dump 或大体积原始输出确实需要单独保留时，才引用单独附件。

日志文件收敛：

- report 本身应承载命令、结果摘要、关键输出片段和诊断结论。
- 成功用例默认不生成独立 log 文件。
- 失败用例需要保留原始证据时，优先合并到 `logs/<caseId>-evidence.md`，并在 `diagnostics[].artifact` 或 Markdown 报告中引用。
- 不要为同一个 case 的 build、install、runner、dump、screenshot、hilog 默认各生成一个文件；只有确实有定位价值的附件才单独保存。
- 批量共享的构建、安装、设备检查证据使用批量级 evidence 文件，case report 引用同一份证据，不复制多份。

## Markdown 报告

Markdown 必须由最新 report JSON 全量渲染，不要手写自由格式，不要基于旧 Markdown 局部编辑。每次执行、重跑或修复后，都按同一模板覆盖同一份 `<caseId>.md`。

固定模板：

```md
# Harmony UI Test Report: <caseName>

## 结论

## 环境

## 构建探测

## 产物

## 命令

## 结果

## 诊断

## 失败分析
```

章节规则：

- 结论：状态、用例、模块、测试类、测试方法。
- 环境：设备、bundle、测试模块、build mode。
- 构建探测：DevEco SDK、Node、hvigorw、task、product、module、bundleName 来源、signed HAP 选择。
- 产物：app HAP 和 test HAP 路径。
- 命令：实际使用的完整命令。
- 结果：解析后的摘要和关键原始输出片段。
- 诊断：失败后的 hdc 实时诊断命令、关键证据和产物路径。
- 失败分析：阶段、失败码、可能原因、下一步建议。
- 固定标题和章节顺序不能因 `PASS`、`FAIL` 或 `BLOCKED` 改变。
- 某个章节没有内容时仍保留章节，并写 `无` 或 `不适用`。
- `PASS` 报告也必须保留 `诊断` 和 `失败分析` 章节，通常写 `无` 或 `不适用`。
- 重跑或修复后不要保留旧 Markdown 中的历史段落；历史过程不属于当前结果快照。

## 修复时更新报告

报告只保留当前结果快照，不记录过程历史。

JSON：

- 根据 plan 和本次执行结果重新生成完整 JSON，并覆盖写入稳定文件名。
- 更新顶层 `status`、`result`、`failure`。
- 更新 `repairBudget.used` 和 `repairBudget.remaining`。
- 保留实际使用的最终命令、产物、环境和目标确认信息。

Markdown：

- 根据最新 JSON 按固定 Markdown 模板重新渲染完整报告，并覆盖写入稳定文件名。
- 不要复用旧 Markdown 章节、标题或历史内容；旧报告只作为被覆盖目标，不作为渲染来源。

summary：

- 只在批量结束、中止、修复或重跑后更新或重建。
- 只保留索引字段，例如 `caseId`、`caseName`、`status`、`failure.code`、`planFile`、`reportFile`、`testFile`、`testMethod`。
- 不保存独立判断结果；不要把 summary 当作事实来源。

## 与 Execution Plan 的关系

报告是执行后产物，execution plan 是执行前产物。报告必须记录：

- `planId`
- `planFile`
- `preconditions`
- `preconditionGate`

报告可以复制 plan 中的关键前置条件字段，方便单独阅读；但执行前判断的来源是 plan。

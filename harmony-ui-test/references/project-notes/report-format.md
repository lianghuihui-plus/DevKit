# 报告格式

用户要求执行后，只要进入探测、gate、目标确认、构建、安装或运行任一阶段，就必须生成报告。成功、失败、阻塞、构建失败、安装失败、设备失败、目标确认未通过都要记录。仅生成测试代码时会生成 `draft` plan，但不生成 report。

默认目录：

```text
test-reports/ui-test/
```

该目录相对被测 HarmonyOS 项目根目录，不是 skill 包目录。

报告内容尽量使用项目相对路径。为了复现命令，也可以记录必要的绝对路径。

## 单用例报告

写入两个文件：

```text
<timestamp>-<case-name>.md
<timestamp>-<case-name>.json
```

推荐时间戳格式：

```text
YYYYMMDD-HHMMSS
```

## 批量报告

批量执行时额外写入：

```text
<timestamp>-summary.md
<timestamp>-summary.json
```

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
  "referenceDocs": [],
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
    "bundleName": "",
    "testModuleName": ""
  },
  "targetConfirmation": {
    "required": true,
    "preBuild": {
      "status": "pending | confirmed | blocked | stale",
      "summaryShown": {}
    },
    "preInstall": {
      "status": "pending | confirmed | blocked | stale",
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
  "failure": null,
  "preconditions": [],
  "preconditionGate": null,
  "failureHistory": [],
  "rerunHistory": [],
  "repairHistory": []
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

当失败来自权限或沙箱限制时，`failure.summary` 必须保留原始错误摘要，`failure.nextAction` 必须写明需要用户授权提权执行，或由用户在本机终端执行同一命令并回贴输出。

## Markdown 报告

包含：

- 结论：状态、用例、模块、测试类、测试方法。
- 环境：设备、bundle、测试模块、build mode。
- 构建探测：DevEco SDK、Node、hvigorw、task、product、module、bundleName 来源、signed HAP 选择。
- 产物：app HAP 和 test HAP 路径。
- 命令：实际使用的完整命令。
- 结果：解析后的摘要和关键原始输出片段。
- 失败分析：阶段、失败码、可能原因、下一步建议。
- 重跑历史，后续基于运行上下文重跑 blocked 用例时追加。
- 变更文件。
- 修复历史，后续修复时追加。

## 重跑 BLOCKED 时更新报告

重跑 blocked 用例不等同于修复代码。JSON 中追加 `rerunHistory`，记录本次自然语言运行上下文、rerun plan、筛选结果和实际执行结果。

推荐结构：

```json
{
  "rerunHistory": [
    {
      "attempt": 1,
      "planFile": "test-reports/ui-test/20260608-162000-blocked-rerun-plan.json",
      "runContext": {
        "source": "user_statement",
        "text": "账号已登录，测试数据已准备好，重跑 blocked"
      },
      "selection": {
        "decision": "rerun | keep_blocked",
        "coveredPreconditions": [],
        "coveredTargetConfirmations": [],
        "unresolvedPreconditions": [],
        "unresolvedTargetConfirmations": []
      },
      "result": "PASS | FAIL | BLOCKED"
    }
  ]
}
```

summary report 中应同步更新：

- 可重跑并已执行的用例：更新最新 `status`、`result`、`failure`。
- 仍不可重跑的用例：保持 `BLOCKED`，追加本次 `rerunHistory` 和未覆盖前置条件。

## 修复时更新报告

不要删除之前的失败历史。

JSON：

- 更新顶层 `status`、`result`、`failure`。
- 必要时把旧失败详情追加到 `failureHistory`。
- 向 `repairHistory` 追加新的修复记录。

Markdown：

- 保留原始执行记录。
- 追加 `修复历史` 或新的修复尝试条目。
- 修复条目中记录本次 repair plan 文件。

summary：

- 更新对应用例的最新状态。
- 保留足够信息，以便追踪原始失败和修复尝试。

## 与 Execution Plan 的关系

报告是执行后产物，execution plan 是执行前产物。报告必须记录：

- `planId`
- `planFile`
- `preconditions`
- `preconditionGate`

报告可以复制 plan 中的关键前置条件字段，方便单独阅读；但执行前判断的来源是 plan。

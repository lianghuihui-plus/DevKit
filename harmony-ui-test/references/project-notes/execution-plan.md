# Execution Plan

Execution Plan 是执行前产物，负责承载人工用例解析、前置条件、闸门决策、命令计划和产物路径。

Report 是执行后产物，负责记录执行结果并引用 plan。

## 文件位置

默认写入被测 HarmonyOS 项目根目录：

```text
test-reports/ui-test/
```

单用例：

```text
<timestamp>-<case-name>-plan.json
```

批量：

```text
<timestamp>-summary-plan.json
```

修复：

```text
<timestamp>-<case-name>-repair<attempt>-plan.json
```

## 何时生成

只要从人工用例生成或更新测试代码，就必须生成 plan。若用户只要求生成测试代码，plan 保持 `draft`，不做完整探测和 gate，不生成 report。

如果用户要求执行、验证、跑一下、看结果，或进入修复流程，必须先读取已有 plan；如果不存在，再从用户指定的人工用例生成 plan。

生成或更新测试代码流程：

```text
解析人工用例
-> 定位模块和入口
-> 生成 execution plan
-> 生成或更新测试代码，并写入 CASE_ID 和 PLAN_ID 或 planFile 注释
```

执行或修复前流程：

```text
读取已有 execution plan
-> 探测构建环境、task、bundleName 候选和 signed HAP 选择规则
-> 检查前置条件
-> 更新 preconditions 和 preconditionGate
-> 构建前展示目标计划和构建命令摘要，等待用户确认
-> gate 和目标确认都允许后再构建
-> 安装或运行前展示实际 signed HAP、bundleName、test module 和命令摘要，等待用户确认
-> 确认后再安装、执行测试
```

如果 gate 或目标确认阻塞：

```text
生成 plan
-> preconditionGate = blocked 或 targetConfirmation.*.status = blocked/stale
-> 不执行后续阶段
-> 生成 BLOCKED report，引用 plan
```

preconditionGate 默认阻塞执行，不默认阻塞测试代码生成。只有当前置条件导致人工预期、目标页面、测试入口或断言策略无法确定时，才阻塞测试生成；设备、hdc、构建环境、签名产物等执行环境问题通常只阻塞执行。

单个用例执行和批量执行都默认无人值守。前置条件无法自动判断且会影响执行或断言时，不要中途询问用户；将当前用例标记为 `blocked`，失败码记录 `PRECONDITION_UNKNOWN`，生成 report，并结束当前用例的执行流程。若处于批量模式，继续后续用例。只在生成测试代码前的需求歧义阶段询问用户。

## 单用例 Plan JSON

```json
{
  "version": 1,
  "planId": "20260608-153012-login-account",
  "createdAt": "2026-06-08T15:30:12+08:00",
  "mode": "single",
  "status": "draft",
  "case": {
    "caseId": "login-account-success",
    "caseName": "账号密码登录成功",
    "caseFile": "test-cases/ui/login-account.md"
  },
  "target": {
    "projectRoot": "",
    "module": "featuresLunar/LunarLogin",
    "testFile": "featuresLunar/LunarLogin/src/ohosTest/ets/test/AccountLoginUi.test.ets",
    "testClass": "AccountLoginUiTest",
    "testMethod": "loginAccountSuccess"
  },
  "manualCase": {
    "preconditionsRaw": [],
    "steps": [],
    "expected": []
  },
  "preconditions": [
    {
      "id": "pc-debug-build",
      "description": "使用 debug 包",
      "type": "app_build",
      "status": "unknown",
      "checkMethod": "检查 BuildProfile.ets",
      "evidence": "",
      "impact": "blocks_execution",
      "nextAction": ""
    }
  ],
  "preconditionGate": {
    "status": "pending",
    "decision": "",
    "reason": "",
    "userDecision": ""
  },
  "execution": {
    "buildMode": "debug",
    "hdcPath": "",
    "device": "",
    "bundleName": "",
    "testModuleName": "",
    "probe": {
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
    "targetConfirmation": {
      "required": true,
      "preBuild": {
        "status": "pending",
        "confirmedAt": "",
        "summaryShown": {
          "product": "",
          "moduleName": "",
          "buildMode": "debug",
          "bundleNameCandidates": [],
          "testModuleNameCandidates": [],
          "device": "",
          "buildAppTask": "",
          "buildTestTask": "",
          "buildAppCommand": "",
          "buildTestCommand": ""
        }
      },
      "preInstall": {
        "status": "pending",
        "confirmedAt": "",
        "summaryShown": {
          "product": "",
          "moduleName": "",
          "buildMode": "debug",
          "bundleName": "",
          "testModuleName": "",
          "device": "",
          "appHap": "",
          "testHap": "",
          "installAppCommand": "",
          "installTestCommand": "",
          "runTestCommand": ""
        },
        "mismatchAfterBuild": []
      },
      "reason": ""
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
    }
  },
  "riskNotes": []
}
```

`status` 更新规则：

- `draft`：刚生成，尚未完成探测或 gate。
- `probed`：已完成探测，但尚未完成 gate 或目标确认。
- `ready`：探测、gate 和当前阶段目标确认均已完成，可以进入下一阶段。
- `built`：已完成构建，等待或已进入安装/运行前确认。
- `blocked`：gate、探测或目标确认阻塞执行。
- `executed`：已用于一次执行，report 必须引用它。

`execution.targetConfirmation.preBuild.status` 和 `execution.targetConfirmation.preInstall.status` 取值：

```text
pending
confirmed
blocked
stale
```

- `pending`：尚未向用户确认目标产物。
- `confirmed`：用户已确认当前阶段，可以进入下一阶段。
- `blocked`：用户未确认或拒绝确认，不构建、不安装、不执行。
- `stale`：构建后实际 signed HAP、bundleName、testModuleName 或设备与确认摘要不一致，需要重新确认。

## Precondition 字段

- `id`：稳定 id，供 case 引用。
- `description`：来自人工用例或 agent 提取的描述。
- `type`：`environment` / `device` / `app_build` / `entry` / `ui_state` / `account` / `data` / `service` / `permission`。
- `status`：`satisfied` / `unsatisfied` / `unknown` / `not_applicable`。
- `checkMethod`：检查方式。
- `evidence`：检查证据。
- `impact`：`blocks_execution` / `affects_assertion` / `low_risk`。
- `nextAction`：报告后的人工处理建议，例如确认账号状态、调整断言、补数据等。

## Gate 规则

```text
unsatisfied + blocks_execution
-> blocked，不执行，生成 BLOCKED report

unknown + blocks_execution
-> blocked，不执行，生成 BLOCKED report，failure.code = PRECONDITION_UNKNOWN

unknown + affects_assertion
-> blocked，不执行，生成 BLOCKED report，failure.code = PRECONDITION_UNKNOWN

unknown + low_risk
-> warning，可以继续，但 report 必须记录

satisfied
-> passed，可以继续
```

`preconditionGate.status` 取值：

```text
pending
passed
warning
blocked
```

`preconditionGate.decision` 取值：

```text
continue
stop
```

## 与测试代码的关系

测试代码只保留轻量追踪信息，不放完整 plan。`CASE_ID` 和 `PLAN_ID` 或 `planFile` 必须写入，便于后续执行时找回人工用例、前置条件和预期：

```ts
const CASE_ID = 'login-account-success';
const PLAN_ID = '20260608-153012-login-account';
```

或使用注释：

```ts
// caseId: login-account-success
// planId: 20260608-153012-login-account
// planFile: test-reports/ui-test/20260608-153012-login-account-plan.json
```

完整前置条件状态只在 plan/report 中维护。

## 与报告的关系

报告 JSON 必须引用 plan：

```json
{
  "planId": "20260608-153012-login-account",
  "planFile": "test-reports/ui-test/20260608-153012-login-account-plan.json",
  "preconditions": [],
  "preconditionGate": {}
}
```

报告可以复制关键前置条件字段，方便独立阅读；但执行前判断的来源是 plan。

## 重跑 BLOCKED 用例

重跑 blocked 用例不是修复代码。只有在用户提供新的自然语言运行上下文、agent 找到新的自动检查方式，或已有证据发生变化时，才生成 rerun plan。适用失败码包括 `PRECONDITION_UNKNOWN`、`PRECONDITION_UNSATISFIED`、`TARGET_CONFIRMATION_BLOCKED` 和 `TARGET_CONFIRMATION_STALE`。

用户不需要编辑 plan。agent 将用户自然语言写入 `runContext`，并自动生成 `rerunSelection`：

```json
{
  "runContext": {
    "source": "user_statement",
    "text": "账号已登录，测试数据已准备好，确认使用这个 bundle，重跑 blocked",
    "createdAt": "2026-06-08T16:20:00+08:00"
  },
  "rerunSelection": [
    {
      "caseId": "logout-success",
      "decision": "rerun",
      "coveredPreconditions": ["pc-account-logged-in"],
      "coveredTargetConfirmations": ["preInstall"],
      "unresolvedPreconditions": [],
      "unresolvedTargetConfirmations": [],
      "reason": "用户声明已登录，覆盖全部阻塞型前置条件"
    },
    {
      "caseId": "create-order",
      "decision": "keep_blocked",
      "coveredPreconditions": ["pc-account-logged-in"],
      "coveredTargetConfirmations": [],
      "unresolvedPreconditions": ["pc-test-data-ready"],
      "unresolvedTargetConfirmations": [],
      "reason": "测试数据前置条件仍未覆盖"
    }
  ]
}
```

筛选规则：

- `decision = rerun`：所有 `blocks_execution` 或 `affects_assertion` 的阻塞型前置条件，以及目标确认阻塞都被覆盖。
- `decision = keep_blocked`：没有新上下文、只覆盖部分前置条件或目标确认、无法判断覆盖关系，或仍存在未满足前置条件。
- 不要因为用户说“继续跑”就忽略未覆盖前置条件或目标确认；必须能解释覆盖关系。
- 批量重跑只执行 `decision = rerun` 的子集，其他用例保持 `BLOCKED`。

重跑 plan 文件名：

```text
<timestamp>-blocked-rerun-plan.json
```

单个用例也可以使用：

```text
<timestamp>-<case-name>-rerun<attempt>-plan.json
```

## 修复流程

修复失败用例时：

```text
读取 report
-> 读取 planFile
-> 继承原 plan 中的 preconditions 和 preconditionGate
-> 如果有新证据，生成新的 repair plan
-> 重跑目标用例
-> 更新 report 的 repairHistory
```

不要覆盖旧 plan。修复时生成新 plan：

```text
<timestamp>-<case-name>-repair1-plan.json
```

report 中追加：

```json
{
  "repairHistory": [
    {
      "attempt": 1,
      "planFile": "test-reports/ui-test/20260608-162033-login-account-repair1-plan.json",
      "result": "PASS"
    }
  ]
}
```

## 批量模式

批量先生成 summary plan。共享前置条件放在 `sharedPreconditions`，单个 case 引用自己的 plan。

```json
{
  "mode": "batch",
  "sharedPreconditions": [
    {
      "id": "pc-device-online",
      "description": "设备在线",
      "status": "satisfied"
    }
  ],
  "targetConfirmationGroups": [
    {
      "groupId": "lunar-login-debug",
      "product": "lunar",
      "moduleName": "LunarLogin",
      "bundleName": "com.example.app",
      "testModuleName": "LunarLogin_test",
      "device": "",
      "preBuildStatus": "confirmed",
      "preInstallStatus": "pending"
    }
  ],
  "rerunSelection": [],
  "cases": [
    {
      "caseId": "login-account-success",
      "planFile": "20260608-153012-login-account-plan.json",
      "preconditionGate": {
        "status": "passed"
      }
    }
  ]
}
```

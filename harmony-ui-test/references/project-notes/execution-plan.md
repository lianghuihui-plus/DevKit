# Execution Plan

## 何时读取

- 从人工用例生成或更新测试代码时读取，用于生成 plan、caseId 和测试方法映射。
- 执行、修复、重跑 blocked 用例前读取，用于恢复人工用例、前置条件 gate、目标确认和测试定位信息。
- 只查询 UI API 或构建命令细节时，优先读取对应专项文档。

Execution Plan 是执行前产物，负责承载人工用例解析、前置条件、闸门决策、命令计划和产物路径。

Report 是执行后产物，负责记录执行结果并引用 plan。

## 文件位置

默认写入被测 HarmonyOS 项目根目录的专属工作目录：

```text
harmony-ui-test-workspace/plans/
```

单用例：

```text
<caseId>-plan.json
```

批量：

```text
summary-plan.json
```

`summary-plan.json` 只在批量场景生成，作为批量 case plan、共享前置条件分组和目标确认分组的轻量索引缓存。单用例不生成 summary plan。summary plan 不是事实来源；每个 case 的事实来源仍是对应 `plans/<caseId>-plan.json`。任何会影响某个 case 执行决策的共享前置条件、目标确认结果或阻塞原因，必须同步到对应 case plan，或在 case plan 中记录可追溯引用。

## 何时生成

只要从人工用例生成或更新测试代码，就必须生成 plan。若用户只要求生成测试代码，plan 保持生成阶段状态，不做完整探测和 gate，不生成 report。

批量输入必须先按人工用例边界切分，再分别生成 case plan 和计算 `caseId`。每个 `caseId` 的 hash 输入只能是该用例自己的原文片段，不能使用整份批量文件。若无法可靠切分出单个用例边界，则视为整体输入不可用，停下来让用户明确指定或拆分用例。

plan 使用稳定文件名。每次重新生成或更新同一个 `caseId` 的测试代码时，完整重写 `plans/<caseId>-plan.json`。批量场景可以完整重写 `plans/summary-plan.json` 作为索引缓存；如果 summary plan 缺失，可以从 case plans 重建。不要创建时间戳 plan、rerun plan 或 repair plan。

生成阶段的解析、定位或代码生成问题也写入 case plan。单个用例生成不了时，若用户只要求生成测试代码，不生成 report；若用户本次要求执行，必须转成 `BLOCKED/GENERATION_BLOCKED` report。批量生成时，能生成的继续，生成不了的用例在对应 case plan 中标记，不阻塞其他用例；summary plan 只同步这些状态作为索引。

如果用户要求执行、验证、跑一下、看结果，或进入修复流程，必须先读取已有 plan；如果不存在，再从用户指定的人工用例生成 plan。

生成或更新测试代码流程：

```text
解析人工用例
-> 建立人工步骤到测试代码动作的逐条映射
-> 定位模块和入口
-> 生成 execution plan
-> 若生成条件不足，写入 status = generation_blocked、generation.status = blocked 和 reason
-> 若可生成，生成或更新测试代码，并在 plan 中记录 testFile、testClass 和 testMethod
```

执行或修复前流程：

```text
读取已有 execution plan
-> 探测构建环境、task、bundleName 候选和 signed HAP 选择规则
-> 检查前置条件
-> 更新 preconditions 和 preconditionGate
-> 构建前展示目标计划和构建命令摘要，等待用户确认
-> gate 和目标确认都允许后再构建
-> 构建后自动校验实际 signed HAP、bundleName、test module、设备和命令
-> 校验一致则安装、执行测试；不一致或无法确认一致性时展示差异并等待用户确认
-> 执行失败时按失败策略判断是否可自动修复
-> 可修且未超预算则修复并重跑目标用例
-> 不可修、预算耗尽或同类失败连续达到阈值时写入最终报告
```

如果 gate 或目标确认阻塞：

```text
生成 plan
-> preconditionGate = blocked 或 targetConfirmation.*.status = blocked/stale
-> 不执行后续阶段
-> 生成 BLOCKED report，引用 plan
```

preconditionGate 默认阻塞执行，不默认阻塞测试代码生成。只有人工用例的明确前置条件导致目标页面、测试入口或执行对象无法确定时，才阻塞测试生成；不得从测试步骤、人工预期或断言策略推导阻塞条件。设备、hdc、构建环境、签名产物等执行环境问题通常只阻塞执行。

生成、执行和批量处理都默认无人值守。生成阶段无法解析或无法可靠生成测试代码时，先更新 plan 的 generation 状态；如果本次只是生成测试代码，不生成 report；如果本次包含执行，则该用例不进入构建和运行，直接生成 `BLOCKED/GENERATION_BLOCKED` report。执行阶段只有阻塞型前置条件无法自动判断且会影响启动被测对象、确认目标产物或满足人工用例明确声明的准备条件时，才将当前用例标记为 `blocked`，失败码记录 `PRECONDITION_UNKNOWN`，生成 report，并结束当前用例的执行流程。若处于批量模式，继续后续用例。人工用例已明确给出的测试输入，不在执行前验证其有效性。

## 单用例 Plan JSON

`caseId` 是同一个人工用例跨生成、执行、修复的唯一身份。不要用标题翻译、路径或时间戳生成 `caseId`。

计算规则：

```text
normalizedManualCaseText = 人工用例原文做机械规范化
caseId = "tc-" + sha1(normalizedManualCaseText).slice(0, 12)
planId = caseId
planFile = harmony-ui-test-workspace/plans/<caseId>-plan.json
```

规范化只允许：去掉首尾空白，换行统一为 `\n`，连续空白折叠为单个空格。不翻译、不改写、不提取语义。

```json
{
  "version": 1,
  "planId": "tc-a83f21c9d4e5",
  "createdAt": "2026-06-08T15:30:12+08:00",
  "mode": "single",
  "status": "draft",
  "workspace": {
    "root": "harmony-ui-test-workspace",
    "configFile": "harmony-ui-test-workspace/config.json",
    "plansDir": "harmony-ui-test-workspace/plans",
    "reportsDir": "harmony-ui-test-workspace/reports",
    "logsDir": "harmony-ui-test-workspace/logs"
  },
  "repairBudget": {
    "configured": 5,
    "used": 0,
    "remaining": 5,
    "source": "skill_default"
  },
  "case": {
    "caseId": "tc-a83f21c9d4e5",
    "caseName": "账号密码登录成功",
    "caseFile": "test-cases/ui/login-account.md",
    "identity": {
      "method": "sha1-normalized-manual-case-text",
      "normalizedTextHash": "a83f21c9d4e5"
    }
  },
  "generation": {
    "status": "generated",
    "reason": null,
    "generatedAt": "2026-06-08T15:30:12+08:00"
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
      "buildApp": {
        "script": "",
        "actual": ""
      },
      "buildTest": {
        "script": "",
        "actual": ""
      },
      "installApp": {
        "script": "",
        "actual": ""
      },
      "installTest": {
        "script": "",
        "actual": ""
      },
      "runTest": {
        "script": "",
        "actual": ""
      }
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

- `draft`：刚生成，尚未完成探测或 gate，且生成阶段未阻塞。
- `generation_blocked`：生成阶段无法可靠生成测试代码，详情见 `generation.reason`。当 `generation.status = blocked` 时，顶层 `status` 必须同步为 `generation_blocked`。
- `probed`：已完成探测，但尚未完成 gate 或目标确认。
- `ready`：探测、gate 和当前阶段目标确认均已完成，可以进入下一阶段。
- `built`：已完成构建，等待构建后目标自动校验、差异确认或安装运行。
- `blocked`：gate、探测或目标确认阻塞执行。
- `executed`：已用于一次执行，report 必须引用它。

## Generation 字段

`generation` 记录生成阶段状态，只服务于 plan，不产生 report。

```json
{
  "generation": {
    "status": "generated | blocked",
    "reason": {
      "code": "MISSING_REQUIRED_INPUT",
      "message": "人工用例缺少可生成测试代码所必需的入口或预期结果",
      "nextAction": "补充入口和预期结果后重新生成"
    },
    "generatedAt": ""
  }
}
```

`generation.status`：

- `generated`：已生成或更新测试代码。
- `blocked`：生成阶段无法可靠生成测试代码；此时顶层 `status` 必须是 `generation_blocked`。

常用 `generation.reason.code`：

```text
MANUAL_CASE_NOT_FOUND
MISSING_REQUIRED_INPUT
ENTRY_UNRESOLVED
MODULE_UNRESOLVED
EXPECTED_RESULT_AMBIGUOUS
NAVIGATION_EXPECTATION_CONFLICT
STEP_MAPPING_UNRESOLVED
REFERENCE_API_UNRESOLVED
ASSERTION_UNREPRESENTABLE
UNSUPPORTED_FLOW
```

如果无法把人工用例的关键步骤逐条映射为测试代码动作，使用 `STEP_MAPPING_UNRESOLVED`。如果涉及的 UI 测试 API、等待、输入、键盘、滑动或启动方式无法按参考文档确认，使用 `REFERENCE_API_UNRESOLVED`。如果人工预期无法转换为可信断言且继续生成会弱化用例，使用 `ASSERTION_UNREPRESENTABLE`。

批量生成时，某个 case 的 `generation.status = blocked` 只影响该 case；summary plan 可以记录其他 case 的生成结果作为索引。只有没有任何有效人工用例输入时，才停止并询问用户。若用户本次要求执行，所有 `generation.status = blocked` 的 case 必须生成 `BLOCKED/GENERATION_BLOCKED` report，并在批量 summary 索引中记录。

`execution.targetConfirmation.preBuild.status` 取值：

```text
pending
confirmed
blocked
```

- `pending`：尚未完成构建前目标确认。
- `confirmed`：用户已确认构建前目标摘要，可以进入构建阶段。
- `blocked`：用户未确认或拒绝确认，不构建。

`execution.targetConfirmation.preInstall.status` 取值：

```text
pending
confirmed
verified
blocked
stale
```

- `pending`：尚未完成构建后目标校验或安装前确认。
- `confirmed`：用户已确认构建后执行摘要，可以进入安装或执行阶段。
- `verified`：构建后实际产物、bundleName、testModuleName、设备和命令已自动校验通过，可以安装或执行。
- `blocked`：用户未确认或拒绝确认，不安装、不执行。
- `stale`：构建后实际 signed HAP、bundleName、testModuleName 或设备与构建前确认摘要不一致，或无法自动确认一致性，需要重新确认。

## Precondition 字段

阻塞型前置条件只包含：

- 设备、hdc、构建环境等执行环境可用性。
- debug/buildMode、bundleName、testModuleName、signed HAP 等目标产物确认。
- 人工用例的“前置条件/准备条件”中明确声明且不满足就无法开始步骤的 App 状态或外部状态，例如启动弹窗、权限弹窗、登录态。

不要从测试步骤中反推出阻塞条件；步骤应该直接执行，执行不到、执行错或断言失败后写入报告。人工用例中明确给出的账号、密码、手机号、验证码、商品 ID 等输入数据属于步骤或测试数据，由执行结果验证，不进入阻塞型前置条件。仅影响断言可信度、但不影响开始执行步骤的未知项，不作为阻塞条件。

- `id`：稳定 id，供 case 引用。
- `description`：来自人工用例或 agent 提取的描述。
- `type`：`environment` / `device` / `app_build` / `entry` / `ui_state` / `account` / `data` / `service` / `permission`。`account` 和 `data` 只用于人工明确声明的准备条件或非阻塞记录，不用于从步骤输入推导 gate。
- `status`：`satisfied` / `unsatisfied` / `unknown` / `not_applicable`。
- `checkMethod`：检查方式。
- `evidence`：检查证据。
- `impact`：`blocks_execution` / `affects_assertion` / `low_risk`。
- `nextAction`：报告后的人工处理建议，例如清理登录态、处理启动弹窗、确认目标包等。

## Gate 规则

以下 gate 规则只应用于阻塞型前置条件白名单内的条件；其他未知项进入步骤、测试数据、riskNotes 或运行期断言处理。不得从测试步骤推导新的 blocking gate。

```text
unsatisfied + blocks_execution
-> blocked，不执行，生成 BLOCKED report

unknown + blocks_execution
-> blocked，不执行，生成 BLOCKED report，failure.code = PRECONDITION_UNKNOWN

unknown + affects_assertion
-> warning，可以继续，但 report 必须记录

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

测试代码只负责表达测试行为，不写入 `CASE_ID`、`PLAN_ID`、`planFile` 或其他 workflow 追踪信息。一个测试文件可以包含多个 `it`/测试方法，因此不要用文件级常量或注释承载单个用例身份。

人工用例与测试方法的映射只在 execution plan 中维护：

- `case.caseId`：由人工用例原文稳定 hash 生成。
- `case.caseFile` 和 `manualCase`：记录人工用例来源与解析结果。
- `target.testFile`、`target.testClass`、`target.testMethod`：记录生成或更新的测试方法位置。

执行、修复和重跑必须从 report 读取 `planFile`，再从 plan 定位 `target.testFile`、`target.testClass` 和 `target.testMethod`。不要从测试代码中的注释或常量恢复 workflow 上下文。

## 与报告的关系

报告 JSON 必须引用 plan：

```json
{
  "planId": "tc-a83f21c9d4e5",
  "planFile": "harmony-ui-test-workspace/plans/tc-a83f21c9d4e5-plan.json",
  "preconditions": [],
  "preconditionGate": {}
}
```

报告可以复制关键前置条件字段，方便独立阅读；但执行前判断的来源是 plan。

## 重跑 BLOCKED 用例

重跑 blocked 用例不是修复代码。只有在用户提供新的自然语言运行上下文、agent 找到新的自动检查方式，或已有证据发生变化时，才重跑。适用失败码包括 `PRECONDITION_UNKNOWN`、`PRECONDITION_UNSATISFIED`、`TARGET_CONFIRMATION_BLOCKED` 和 `TARGET_CONFIRMATION_STALE`。

agent 根据用户自然语言判断哪些 blocked 用例的阻塞条件已被覆盖。这个筛选本身就是一次 gate 重新评估，必须写回同一个 case plan，而不是只在对话中口头判断。

重跑流程：

```text
读取 report 和 plan
-> 读取用户本次 runContext 或新的自动检查证据
-> 重新评估原 blocked 的 preconditions、preconditionGate 和 targetConfirmation
-> 能覆盖：更新同一个 case plan 的执行状态字段和 evidence
-> 不能覆盖：保持 BLOCKED，不执行
-> 按更新后的 case plan 重跑
-> 覆盖更新 report；批量场景同步或重建 summary 索引
```

允许更新同一个 case plan 的字段：

- `preconditions[].status`、`evidence`、`nextAction`
- `preconditionGate.status`、`decision`、`reason`、`userDecision`
- `execution.targetConfirmation.preBuild`、`execution.targetConfirmation.preInstall`
- `execution.probe`、`execution.hdcPath`、`execution.device`、`execution.commands`、`execution.artifacts` 中因本次重跑重新确认的执行信息
- `riskNotes` 中与本次 runContext 相关的说明

禁止在 blocked 重跑中修改：

- `case.caseId`、`case.caseFile`、`manualCase`
- `target.testFile`、`target.testClass`、`target.testMethod`
- 人工步骤、人工预期和测试代码
- `generation` 状态

blocked 重跑不生成额外 plan，不生成 rerun plan，不占用修复预算。不能覆盖阻塞条件的用例保持 `BLOCKED`，只在需要刷新当前结果快照时覆盖对应 report。重跑完成后覆盖更新对应 case report；批量场景同步或重建 summary 索引，不记录过程历史。

## 修复流程

修复失败用例时：

```text
读取 report
-> 如果入口是 summary 索引，先筛选失败且可修的 case
-> 如果存在多个候选且用户未指定 case/report，列出候选并等待用户选择
-> 只有一个候选时才自动继续
-> 读取 planFile
-> 继承原 plan 中的 preconditions 和 preconditionGate
-> 判断失败码是否可修、修复预算是否可用、同类失败是否达到停止阈值
-> 运行期失败先按人工步骤执行 hdc 复现定位，记录 observations、hypothesis 和 fixBasis
-> 做最小化修改
-> 重跑目标用例
-> 更新 report 为最新结果
```

修复动作只更新测试代码和当前 report 结果快照。只有当人工用例解析、目标映射、测试文件路径或前置条件定义发生变化时，才完整重写同一个稳定 plan 文件；不要生成新的 repair plan。

从 summary 索引恢复上下文时，不要跨工作目录猜测目标用例。候选列表至少包含 `caseId`、`caseName`、`status`、`failure.code`、`planFile` 和 `testMethod`，方便用户选择。若结果类 summary 索引缺失或过期，先扫描当前工作目录的 case reports 重建失败或 blocked 候选；case plans 只能用于恢复待生成、待执行或目标映射候选，不能用来推断已有执行结果。

## 批量模式

批量可以生成 summary plan 作为轻量索引。共享前置条件和目标确认分组可以放在 `sharedPreconditions`、`targetConfirmationGroups` 中用于分组展示和候选选择，但不替代 case plan。凡是影响 case 是否可执行、是否 blocked、使用哪个目标产物或如何恢复上下文的信息，都必须同步到对应 case plan，或在 case plan 中记录明确引用，例如 `sharedPreconditionRefs`、`targetConfirmationGroupId` 和已解析后的 gate 决策。

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
  "cases": [
    {
      "caseId": "tc-a83f21c9d4e5",
      "planFile": "harmony-ui-test-workspace/plans/tc-a83f21c9d4e5-plan.json",
      "status": "draft",
      "generation": {
        "status": "generated",
        "reason": null
      },
      "preconditionGate": {
        "status": "passed"
      }
    },
    {
      "caseId": "tc-b72c0a9f1162",
      "planFile": "harmony-ui-test-workspace/plans/tc-b72c0a9f1162-plan.json",
      "status": "generation_blocked",
      "generation": {
        "status": "blocked",
        "reason": {
          "code": "MODULE_UNRESOLVED",
          "message": "无法确定人工用例对应的目标模块"
        }
      },
      "preconditionGate": {
        "status": "pending"
      }
    }
  ]
}
```

# 用例状态与执行计划

## 何时读取

- 从人工用例生成或更新测试代码时读取，用于生成 `caseId`、用例目录、`state.json` 和测试方法映射。
- 执行、修复、重跑 blocked 用例前读取，用于恢复人工用例、前置条件 gate、目标确认和测试定位信息。
- 只查询 UI API 或构建命令细节时，优先读取对应专项文档。

本文件保留 `execution-plan` 名称是为了延续引用；新结构中不再写入独立 `plans/<caseId>-plan.json`。执行前事实收敛到：

```text
harmony-ui-test-workspace/cases/<safeCaseName>__<caseId>/state.json
```

`state.json` 是用例唯一结构化状态，承载原 plan 的核心字段和最近执行结果摘要。`case.md` 是对应的人类可读用例卡片。

## 用例身份

`caseId` 是同一个人工用例跨生成、执行、修复的稳定身份。第一阶段继续使用人工用例原文内容 hash，不引入额外 `caseKey`。

计算规则：

```text
normalizedManualCaseText = 人工用例原文做机械规范化
caseId = "tc-" + sha1(normalizedManualCaseText).slice(0, 12)
contentHash = sha1(normalizedManualCaseText).slice(0, 12)
```

规范化只允许：去掉首尾空白，换行统一为 `\n`，连续空白折叠为单个空格。不翻译、不改写、不提取语义。

批量输入必须先按人工用例边界切分，再分别计算每个用例的 `caseId`。每个 `caseId` 的 hash 输入只能是该用例自己的原文片段，不能使用整份批量文件。若无法可靠切分出单个用例边界，则视为整体输入不可用，停下来让用户明确指定或拆分用例。

## 用例目录

用例目录名使用：

```text
<safeCaseName>__<caseId>
```

`safeCaseName` 来自人工用例名称或 agent 提取的简短标题。保留中文，移除文件系统不安全字符，长度建议不超过 40 个字符。目录后缀必须保留 `__<caseId>`。

同一个 `caseId` 已存在时，复用已有目录。如果 `caseName` 变化导致可读目录名不一致，可以重命名目录并同步更新 `index.json`；不能安全重命名时保留旧目录名，但 `state.json.caseName` 必须更新。

## 何时生成和更新

只要从人工用例生成或更新测试代码，就必须创建或更新该用例目录：

```text
cases/<safeCaseName>__<caseId>/case.md
cases/<safeCaseName>__<caseId>/state.json
```

若用户只要求生成测试代码，不执行构建和运行，`state.json` 保持生成阶段状态，`latestResult.status = NOT_RUN`。

生成阶段的解析、定位或代码生成问题也写入 `state.json` 和 `case.md`。单个用例生成不了时，仍创建用例目录，并设置：

```text
status = GENERATION_BLOCKED
generation.status = blocked
```

如果用户本次要求执行，生成阻塞的用例不进入构建和运行，但必须写入本次 run 快照，并在 `case.md` 中记录阻塞原因和下一步。

执行或修复前流程：

```text
读取 index.json、目标 run 或用户指定 case
-> 定位 cases/*__<caseId>/state.json
-> 探测构建环境、task、bundleName 候选和 signed HAP 选择规则
-> 检查前置条件
-> 更新 state.json 的 preconditions、preconditionGate、execution 和 status
-> 构建前展示目标计划和构建命令摘要，等待用户确认
-> gate 和目标确认都允许后再构建
-> 构建后自动校验实际 signed HAP、bundleName、test module、设备和命令
-> 校验一致则安装、执行测试；不一致或无法确认一致性时展示差异并等待用户确认
-> 执行失败时按失败策略判断是否可自动修复
-> 可修且未超预算则修复并重跑目标用例
-> 不可修、预算耗尽或同类失败连续达到阈值时写入最终状态
```

如果 gate 或目标确认阻塞：

```text
更新 state.json
-> preconditionGate = blocked 或 targetConfirmation.*.status = blocked/stale
-> 不执行后续阶段
-> 更新 case.md 和本次 run 快照
```

## `state.json` 最小结构

`state.json` 字段必须保持精简，只保存 agent 恢复和批量筛选必须的信息。完整人工步骤、长证据、详细分析放入 `case.md`。

```json
{
  "version": 1,
  "caseId": "tc-a83f21c9d4e5",
  "caseName": "账号密码登录成功",
  "caseDir": "cases/账号密码登录成功__tc-a83f21c9d4e5",
  "source": {
    "file": "test-cases/ui/login-account.md",
    "contentHash": "a83f21c9d4e5"
  },
  "status": "READY_TO_RUN",
  "repairBudget": {
    "configured": 5,
    "used": 0,
    "remaining": 5,
    "source": "skill_default"
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
  "preconditions": [],
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
      "selectedBuildAppTask": "",
      "selectedBuildTestTask": "",
      "taskFallbackReason": "",
      "product": "",
      "moduleName": "",
      "bundleNameSource": "",
      "signedAppHap": "",
      "signedTestHap": ""
    },
    "targetConfirmation": {
      "required": true,
      "preBuild": {
        "status": "pending",
        "confirmedAt": "",
        "summary": {
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
        "summary": {
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
    "startupWarmup": {
      "status": "not_applicable",
      "triggeredBy": "none",
      "reason": "本次未重新安装 app HAP",
      "secondLaunchVerified": false,
      "forceStoppedBeforeTest": false,
      "evidence": ""
    },
    "artifacts": {
      "appHap": "",
      "testHap": ""
    }
  },
  "latestResult": {
    "status": "NOT_RUN",
    "runId": "",
    "failureCode": null,
    "evidence": ""
  },
  "issueRefs": [],
  "nextAction": "可执行",
  "updatedAt": "2026-06-08T15:30:12+08:00"
}
```

字段缩减原则：

- `manualCase.steps`、`manualCase.expected`、完整命令输出、完整 dump、详细 failure analysis 不进入 JSON，写入 `case.md`。
- `execution.probe` 只保留最终采用值和关键 fallback 原因，不保存所有候选列表。
- `targetConfirmation.preBuild.summary` 和 `targetConfirmation.preInstall.summary` 必须保留用于自动校验的结构化摘要；`case.md` 或 run 可以展示更完整的人类可读摘要。
- `latestResult` 只保留最近执行摘要和失败码；详细结果写入 `case.md`。

## 状态取值

`state.json.status` 和 run 看板使用统一状态：

```text
DRAFT
READY_TO_RUN
NEEDS_CONFIRMATION
NEEDS_PRECONDITION
GENERATION_BLOCKED
RUNNING
PASS
RUN_FAILED_FIXABLE
RUN_FAILED_MANUAL
BLOCKED
```

含义：

- `DRAFT`：刚创建，尚未完成生成或检查。
- `READY_TO_RUN`：已生成测试，当前判断可执行。
- `NEEDS_CONFIRMATION`：需要用户确认目标产物、设备或执行范围。
- `NEEDS_PRECONDITION`：缺少或无法确认前置条件。
- `GENERATION_BLOCKED`：无法忠实生成测试代码。
- `RUNNING`：当前 run 正在处理该用例。
- `PASS`：最近一次执行通过。
- `RUN_FAILED_FIXABLE`：执行失败，按策略可自动修复。
- `RUN_FAILED_MANUAL`：执行失败，需要人工补充信息或介入。
- `BLOCKED`：基础设施、目标确认或 gate 阻塞。

## Generation 字段

`generation` 记录生成阶段状态，服务于 `state.json` 和 `case.md`。

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
- `blocked`：生成阶段无法可靠生成测试代码；此时顶层 `status` 必须是 `GENERATION_BLOCKED`。

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

## 目标确认字段

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

`state.json` 必须保存构建前和安装前目标摘要的结构化快照，用于构建后自动校验和 blocked 重跑判断。`case.md` 或 `runs/*.md` 负责展示给用户看的完整摘要。

最少结构化字段：

- 构建前：`product`、`moduleName`、`buildMode`、`bundleNameCandidates`、`testModuleNameCandidates`、`device`、`buildAppTask`、`buildTestTask`、`buildAppCommand`、`buildTestCommand`。
- 安装前：`product`、`moduleName`、`buildMode`、`bundleName`、`testModuleName`、`device`、`appHap`、`testHap`、`installAppCommand`、`installTestCommand`、`runTestCommand`。

这些字段不要只写入 Markdown，否则后续 agent 必须解析自然语言才能判断 `TARGET_CONFIRMATION_STALE`。

## Precondition 字段

阻塞型前置条件只包含：

- 设备、hdc、构建环境等执行环境可用性。
- debug/buildMode、bundleName、testModuleName、signed HAP 等目标产物确认。
- 人工用例的“前置条件/准备条件”中明确声明且不满足就无法开始步骤的 App 状态或外部状态，例如启动弹窗、权限弹窗、登录态。

不要从测试步骤中反推出阻塞条件；步骤应该直接执行，执行不到、执行错或断言失败后写入 `case.md` 和 `state.json.latestResult`。人工用例中明确给出的账号、密码、手机号、验证码、商品 ID 等输入数据属于步骤或测试数据，由执行结果验证，不进入阻塞型前置条件。仅影响断言可信度、但不影响开始执行步骤的未知项，不作为阻塞条件。

首次安装/首次启动产生的隐私协议、权限授权、启动引导、初始化遮罩等持久阻塞，可以作为 `ui_state` 或 `permission` 前置条件记录；只有本次重新安装 app HAP 时才通过 `execution.startupWarmup` 执行恢复和二次启动验证。未重新安装 app HAP 时不触发 warm-up，只保留已有状态判断或普通前置条件 gate。

`preconditions[]` 字段：

- `id`：稳定 id，供 case 引用。
- `description`：来自人工用例或 agent 提取的描述。
- `type`：`environment` / `device` / `app_build` / `entry` / `ui_state` / `account` / `data` / `service` / `permission`。
- `status`：`satisfied` / `unsatisfied` / `unknown` / `not_applicable`。
- `checkMethod`：检查方式。
- `evidence`：简短检查证据；长证据写入 `case.md`。
- `impact`：`blocks_execution` / `affects_assertion` / `low_risk`。
- `nextAction`：报告后的人工处理建议，例如清理登录态、处理启动弹窗、确认目标包等。

`account` 和 `data` 只用于人工明确声明的准备条件或非阻塞记录，不用于从步骤输入推导 gate。

## Gate 规则

以下 gate 规则只应用于阻塞型前置条件白名单内的条件；其他未知项进入步骤、测试数据、`issueRefs` 或运行期断言处理。不得从测试步骤推导新的 blocking gate。

```text
unsatisfied + blocks_execution
-> blocked，不执行，status = NEEDS_PRECONDITION 或 BLOCKED

unknown + blocks_execution
-> blocked，不执行，failureCode = PRECONDITION_UNKNOWN，status = NEEDS_PRECONDITION

unknown + affects_assertion
-> warning，可以继续，但 case.md 和 state.json 必须记录

unknown + low_risk
-> warning，可以继续，但 case.md 和 state.json 必须记录

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

测试代码只负责表达测试行为，不写入 `CASE_ID`、`PLAN_ID`、`planFile`、`stateFile` 或其他 workflow 追踪信息。一个测试文件可以包含多个 `it`/测试方法，因此不要用文件级常量或注释承载单个用例身份。

人工用例与测试方法的映射只在 `state.json` 中维护：

- `caseId`：由人工用例原文稳定 hash 生成。
- `source.file` 和 `case.md`：记录人工用例来源与解析结果。
- `target.testFile`、`target.testClass`、`target.testMethod`：记录生成或更新的测试方法位置。

执行、修复和重跑必须从 `index.json`、`runs/*.json` 或用户指定的 case 目录定位 `state.json`，再从 `state.json.target` 定位测试文件和测试方法。不要从测试代码中的注释或常量恢复 workflow 上下文。

## 重跑 BLOCKED 用例

重跑 blocked 用例不是修复代码。只有在用户提供新的自然语言运行上下文、agent 找到新的自动检查方式，或已有证据发生变化时，才重跑。适用失败码包括 `PRECONDITION_UNKNOWN`、`PRECONDITION_UNSATISFIED`、`TARGET_CONFIRMATION_BLOCKED` 和 `TARGET_CONFIRMATION_STALE`。

agent 根据用户自然语言判断哪些 blocked 用例的阻塞条件已被覆盖。这个筛选本身就是一次 gate 重新评估，必须写回同一个 `state.json`，不是只在对话中口头判断。

重跑流程：

```text
读取 index.json、run 或目标 state.json
-> 读取用户本次 runContext 或新的自动检查证据
-> 重新评估原 blocked 的 preconditions、preconditionGate 和 targetConfirmation
-> 创建新的 run 快照
-> 能覆盖：更新同一个 state.json 的执行状态字段、latestResult.runId 和 evidence 摘要
-> 不能覆盖：保持 blocked，不执行，但同步本次 run 的 skipped/blocked 记录
-> 按更新后的 state.json 重跑
-> 覆盖更新 case.md/state.json；同步更新 run 和 index
```

允许更新同一个 `state.json` 的字段：

- `preconditions[].status`、`evidence`、`nextAction`
- `preconditionGate.status`、`decision`、`reason`、`userDecision`
- `execution.targetConfirmation.preBuild`、`execution.targetConfirmation.preInstall`
- `execution.probe`、`execution.hdcPath`、`execution.device`、`execution.commands`、`execution.artifacts` 中因本次重跑重新确认的执行信息
- `execution.startupWarmup` 中因本次重新安装 app HAP 或跳过 warm-up 产生的最新状态
- `latestResult`
- `issueRefs`
- `nextAction`

禁止在 blocked 重跑中修改：

- `caseId`、`source.contentHash`
- 人工步骤、人工预期和测试代码
- `generation` 状态

blocked 重跑不生成额外 plan，不占用修复预算。不能覆盖阻塞条件的用例保持 `BLOCKED` 或 `NEEDS_PRECONDITION`，只刷新当前状态快照。重跑完成后覆盖更新对应 `case.md`/`state.json`，并同步更新 run 和 index。

## 修复流程

修复失败用例时：

```text
读取 index.json、run 或用户指定 case
-> 如果存在多个失败且可修用例，列出候选并等待用户选择
-> 只有一个候选时才自动继续
-> 读取目标 state.json
-> 继承 state.json 中的 preconditions 和 preconditionGate
-> 判断失败码是否可修、预算是否可用、同类失败是否达到停止阈值
-> 创建新的 run 快照，并把目标 case 标记为 RUNNING
-> 运行期失败先按人工步骤执行 hdc 复现定位，记录 observations、hypothesis 和 fixBasis
-> 做最小化修改
-> 重跑目标用例
-> 更新 case.md/state.json 为最新结果
```

修复动作只更新测试代码、`case.md`、`state.json`、本次 run 和 index。只有当人工用例解析、目标映射、测试文件路径或前置条件定义发生变化时，才更新同一个稳定 `state.json` 的对应字段；不要生成新的 repair plan。

从 run 快照恢复上下文时，不要跨工作目录猜测目标用例。候选列表至少包含 `caseId`、`caseName`、`status`、`failureCode`、`caseDir` 和 `testMethod`，方便用户选择。若 `index.json` 缺失或过期，先扫描当前工作目录的 `cases/*/state.json` 重建索引。

## 多用例模式

不区分单用例和批量用例。每次用户实质操作都创建一个 run；run 可以包含一个或多个 case。

共享前置条件、目标确认分组、构建/安装命令和共享产物可以在 run 快照中展示并结构化记录，用于分组确认和候选选择，但不替代各 case 的 `state.json`。

凡是影响某个 case 是否可执行、是否 blocked、使用哪个目标产物或如何恢复上下文的信息，都必须同步到对应 `state.json`。共享命令和共享证据可以只在 case 中保留摘要或引用，完整内容放在 `runs/*.json.shared`、`runs/*.md` 或 `logs/`。

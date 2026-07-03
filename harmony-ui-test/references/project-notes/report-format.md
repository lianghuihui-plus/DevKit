# 结果呈现与 Run 快照

## 何时读取

- 用户要求执行、验证、修复、重跑或查看结果时读取，用于生成或更新 `case.md`、`state.json`、`runs/*.md/json` 和 `index`。
- 需要从历史结果恢复测试方法、失败码、diagnostics 或 run 快照时读取。
- 只生成测试代码且不执行时，仍需要按本文件更新 `case.md`、`state.json`、本次 run 和 index。

用户发起一次实质操作后，必须创建本次 run 快照。成功、失败、阻塞、生成阻塞、构建失败、安装失败、设备失败、目标确认未通过都要记录。

默认目录：

```text
harmony-ui-test-workspace/
  index.md
  index.json
  cases/<safeCaseName>__<caseId>/case.md
  cases/<safeCaseName>__<caseId>/state.json
  runs/run-YYYYMMDD-HHMMSS.md
  runs/run-YYYYMMDD-HHMMSS.json
```

## 核心原则

- `case.md` 是单个用例的人类卡片，始终覆盖更新，表示当前状态快照。
- `state.json` 是单个用例唯一结构化状态，始终覆盖更新，供 agent 恢复和筛选。
- `runs/*.md/json` 是单次操作快照，每次实质操作新建，不覆盖旧 run。
- `index.md/json` 是全局当前入口，始终覆盖更新。
- 单用例和多用例不做规则分叉；一次操作涉及几个用例，run 就记录几个用例。
- 不再写入新的 `plans/`、`reports/<caseId>.md/json` 或 `summary.md/json`。

## `case.md` 模板

`case.md` 必须由最新 `state.json`、人工用例解析和本次结果全量渲染，不要基于旧 Markdown 局部编辑。每次生成、执行、重跑或修复后，都按同一模板覆盖同一份 `case.md`。

固定模板：

```md
# 用例：<caseName>

## 当前状态

## 人工用例

## 测试映射

## 前置条件

## 最近执行

## 构建与环境

## 命令

## 证据

## 问题与下一步
```

章节规则：

- 当前状态：状态、caseId、最近 run、下一步。
- 人工用例：来源、前置条件原文、步骤和预期。内容可以摘要，但不得改变人工预期。
- 测试映射：模块、测试文件、测试类、测试方法。
- 前置条件：`preconditions`、`preconditionGate` 和当前判断证据。
- 最近执行：最近一次结果、失败码、runner 摘要、修复预算。
- 构建与环境：设备、bundle、测试模块、build mode、DevEco SDK、Node、hvigorw、product、module、signed HAP 摘要。
- 命令：逐阶段展示 `commands.<stage>.script` 和 `commands.<stage>.actual`；某阶段未执行时写 `未执行` 或 `不适用`；展示 `startupWarmup` 的触发原因、处理结果和证据路径。
- 证据：runner 关键输出、hdc 步骤复现目标、执行步骤、观察结果、修复假设、fixBasis 和短日志片段。
- 问题与下一步：阻塞原因、失败分析、用户需要提供的信息、可执行/可修复建议。

固定标题和章节顺序不能因 `PASS`、`FAIL`、`BLOCKED` 或 `GENERATION_BLOCKED` 改变。某个章节没有内容时仍保留章节，并写 `无` 或 `不适用`。

`case.md` 是当前结果快照，不保留旧过程历史。历史过程由 `runs/*.md` 表示。

## `state.json.latestResult`

执行、重跑或修复后，更新 `state.json.latestResult`。只保留恢复和筛选必须字段：

```json
{
  "latestResult": {
    "status": "PASS | FAIL | BLOCKED | NOT_RUN",
    "runId": "run-20260616-143012",
    "testsRun": 1,
    "pass": 1,
    "failure": 0,
    "error": 0,
    "ignore": 0,
    "failureCode": null,
    "failureStage": "",
    "summary": "",
    "evidence": ""
  }
}
```

失败时使用：

```json
{
  "latestResult": {
    "status": "FAIL",
    "runId": "run-20260616-143012",
    "failureCode": "ASSERTION_FAILED",
    "failureStage": "run_test",
    "summary": "登录后未进入首页",
    "evidence": "case.md#证据"
  }
}
```

如果执行请求中的用例在生成阶段已经阻塞：

```json
{
  "status": "GENERATION_BLOCKED",
  "generation": {
    "status": "blocked",
    "reason": {
      "code": "STEP_MAPPING_UNRESOLVED",
      "message": "无法可靠映射图片选择步骤",
      "nextAction": "补充图片来源和选择路径"
    }
  },
  "latestResult": {
    "status": "BLOCKED",
    "runId": "run-20260616-143012",
    "failureCode": "GENERATION_BLOCKED",
    "failureStage": "generate_test",
    "summary": "生成阶段无法可靠生成测试代码",
    "evidence": "case.md#问题与下一步"
  }
}
```

当失败来自权限或沙箱限制时，`latestResult.summary` 和 `case.md` 必须保留原始错误摘要，`case.md` 的下一步必须写明需要用户授权提权执行，或由用户在本机终端执行同一命令并回贴输出。

## 诊断记录

失败后的 hdc 步骤复现证据写入 `case.md` 的 `## 证据` 章节。`state.json.latestResult.evidence` 只保存锚点或外置日志路径。

建议在 `case.md` 中表达：

```md
## 证据

### hdc 步骤复现

- 目标：复现到第 3 步点击登录后、等待首页前
- 操作：
  - 启动 app
  - 输入账号和密码
  - 点击登录按钮
- 状态：success / failed / skipped
- 观察：
  - 复现后仍停留在登录页
  - 密码输入框为空，说明输入动作未生效
- 假设：测试失败原因是输入未生效导致登录未触发目标跳转
- 修复依据：修复输入方式，改用 Driver.inputText(point, text)
- 外置证据：logs/<groupId>-device-evidence.md
```

复现信息只保存与当前失败用例、复现目标和修复假设相关的关键证据。复现失败不阻塞状态更新，`failed` 或 `skipped` 时在 `case.md` 中记录原因。

## 命令记录

`state.json.execution.commands` 中每个执行阶段使用相同结构：

```json
{
  "script": "<skillRoot>/scripts/run-test.sh --hdc /path/to/hdc ...",
  "actual": "COMMAND: /path/to/hdc shell aa test ..."
}
```

- `script`：agent 调用固定脚本时使用的完整命令。
- `actual`：脚本输出的 `COMMAND:` 行；未执行到脚本或该阶段不适用时为空字符串。
- 安装阶段默认分两次调用脚本：安装 app HAP 写入 `commands.installApp`，安装 test HAP 写入 `commands.installTest`。
- 首次启动 warm-up 不是固定脚本阶段；只在本次重新安装 app HAP 后触发，结果写入 `execution.startupWarmup`，命令和观察证据写入 `case.md`。
- 设备检查不是固定脚本；优先记录 `devecocli device list/view` 的关键输出，必要时记录 hdc fallback 命令。设备检查证据可放入 `case.md`、`runs/*.md` 或 `logs/`，不写入构建/安装/执行阶段命令字段。

## `runs/*.md` 模板

每次用户发起生成、执行、修复或重跑，都创建新的 run Markdown。

固定模板：

```md
# Run <runId>

## 本次操作

## 结果总览

## 用例看板

## 共享环境与命令

## 共享问题

## 下一步
```

章节规则：

- 本次操作：动作、时间、用户输入来源、涉及用例数。
- 结果总览：总数、可执行、通过、失败、阻塞、缺前置条件、生成阻塞。
- 用例看板：每个 case 的 `caseName`、`caseId`、状态、原因、下一步和 `case.md` 链接。
- 共享环境与命令：本次共享的构建、安装、设备、目标确认摘要。
- 共享问题：影响多个 case 的基础设施问题、目标确认问题或构建问题。
- 下一步：用户或 agent 最应该继续做的动作。

run Markdown 是本次操作快照，不因后续操作覆盖。后续操作新建新的 run。

## `runs/*.json`

run JSON 是单次操作的轻量结构化快照：

```json
{
  "version": 1,
  "runId": "run-20260616-143012",
  "action": "generate_and_run",
  "createdAt": "2026-06-16T15:30:12+08:00",
  "updatedAt": "2026-06-16T15:40:00+08:00",
  "cases": [
    {
      "caseId": "tc-a83f21c9d4e5",
      "caseName": "账号密码登录成功",
      "caseDir": "cases/账号密码登录成功__tc-a83f21c9d4e5",
      "source": "new | existing | migrated",
      "stage": "generated | gated | built | installed | executed | repaired | skipped | blocked",
      "status": "PASS",
      "failureCode": null,
      "stateUpdatedAt": "2026-06-16T15:40:00+08:00",
      "nextAction": "无"
    }
  ],
  "shared": {
    "environment": {
      "device": "",
      "product": "",
      "moduleName": "",
      "bundleName": "",
      "testModuleName": ""
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
      }
    },
    "artifacts": {
      "appHap": "",
      "testHap": ""
    },
    "evidence": ""
  },
  "summary": {
    "total": 1,
    "ready": 0,
    "pass": 1,
    "fail": 0,
    "blocked": 0,
    "needsPrecondition": 0,
    "generationBlocked": 0
  }
}
```

run JSON 只用于恢复本次操作范围、共享执行上下文和候选筛选，不替代每个 case 的 `state.json`。

字段要求：

- `cases[].source`：标识该 case 是本次新生成、已有用例还是旧结构迁移而来。
- `cases[].stage`：记录本次操作到达的阶段，便于继续上次 run 或定位中断点。
- `cases[].stateUpdatedAt`：记录本次同步 case 状态的时间，便于发现 run 与 state 漂移。
- `shared.environment`、`shared.commands`、`shared.artifacts`：记录本次 run 共享的设备、目标、构建/安装命令和产物。单个 case 的 `state.json.execution.commands` 仍保留对该 case 生效的最终命令；共享命令不要只写在 Markdown。
- `shared.evidence`：记录跨用例共享证据路径，例如 `logs/<groupId>-build-evidence.md`。

## `index.md/json`

每次生成、执行、修复或重跑后，都从 `cases/*/state.json` 和最近 runs 重新渲染并覆盖 `index.md/json`。

`index.md` 至少包含：

- 全局统计。
- 当前需要处理的问题分组。
- 用例看板。
- 最近 runs。

`index.json` 至少包含：

- `cases[]`：`caseId`、`caseName`、`caseDir`、`status`、`latestRunId`、`updatedAt`。
- `runs[]`：`runId`、`file`、`action`、`total`、`updatedAt`。

`index` 是当前索引，不是历史事实来源。某个用例的事实来源始终是对应 `state.json`；某次操作的事实来源始终是对应 `runs/*.json`。

## 更新顺序

生成、执行、重跑和修复时按以下顺序落盘：

```text
创建 run-*.md/json
-> 对本次涉及的 case 标记 DRAFT、RUNNING、NEEDS_CONFIRMATION、NEEDS_PRECONDITION 或 GENERATION_BLOCKED
-> 立即更新对应 case.md/state.json
-> 每个 case 到达 PASS/FAIL/BLOCKED 后立即覆盖自己的 case.md/state.json
-> 同步更新本次 run-*.md/json
-> 本次操作结束或中止后重建 index.md/json
```

只生成测试代码时也要创建 run：可生成的 case 在 run 中记录 `stage = generated`，`latestResult.status = NOT_RUN`；生成阻塞的 case 记录 `stage = blocked`，`latestResult.status = BLOCKED` 和 `failureCode = GENERATION_BLOCKED`。

基础设施失败导致整次操作中止时，所有受影响且未执行的 case 都必须更新为 `BLOCKED`，`latestResult.failureCode` 使用对应基础设施失败码，并同步到 run 看板。

## RUNNING 恢复

`RUNNING` 只表示当前正在处理，不应长期保留为稳定状态。

每次生成、执行、修复或重跑开始前，读取本次目标 case 时必须检查旧的 `RUNNING` 状态：

```text
state.status = RUNNING
且 state.latestResult.runId 不是本次新 run
-> 视为上次操作中断
-> 创建或使用本次恢复 run 记录这次状态修正
-> 将 state.status 更新为 BLOCKED
-> latestResult.status = BLOCKED
-> latestResult.runId = 本次恢复 runId
-> latestResult.failureCode = RUN_INTERRUPTED
-> latestResult.summary = "上次 run 未完成，状态停留在 RUNNING"
-> case.md 记录中断原因和下一步
-> 同步本次 run 的 cases[] 记录
-> index.md/json 重建
```

如果能从旧 run 明确判断该 case 实际已经完成，但未同步 index，则以 `state.json.latestResult` 为准重建 index，不要保留 `RUNNING`。

## 旧结构兼容

如果入口来自旧 `reports/<caseId>.json`、旧 `reports/summary.json` 或旧 `plans/<caseId>-plan.json`：

1. 只读旧文件恢复 `caseId`、`caseName`、测试映射、失败码和当前结果。
2. 生成或更新新结构 `cases/<safeCaseName>__<caseId>/case.md` 和 `state.json`。
3. 创建迁移 run 或本次操作 run。
4. 后续只写新结构。

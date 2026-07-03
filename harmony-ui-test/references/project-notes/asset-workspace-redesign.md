# 用例资产工作区重构方案

## 背景

当前工作区以 `plans/`、`reports/`、`summary` 为核心。它适合 agent 恢复执行上下文，但不适合用户长期维护 UI 用例资产。

主要问题：

- 批量生成多个用例后，用户需要打开多份 plan/report 才能判断哪些可执行、哪些缺条件、哪些生成有问题。
- `caseId` 使用 hash，文件名和目录名缺少可读性，用户难以按用例名称查找。
- plan/report 字段较多，阅读成本高，且很多字段只是机器恢复需要，不应该暴露成主要阅读入口。
- 用户可能多次、分批、混合新旧用例生成和执行，不适合用一个全局 batch 或单一 summary 表示长期状态。

## 目标

- 以“用例”为长期维护单位，每个用例拥有自己的目录和当前状态。
- 以“单次操作”为视图单位，每次生成、执行、修复或重跑生成一次 run 快照。
- 用户默认阅读 `index.md`、`case.md` 和 `runs/*.md`，不需要直接理解大量 JSON。
- JSON 只保留 agent 恢复和批量筛选必须字段，避免变成大而全的 plan/report。
- 不区分单个用例和多个用例；单个用例也是一次 run，多个用例也是一次 run。

## 非目标

- 不在本方案中引入新的稳定资产 ID。第一阶段继续使用现有 `caseId = "tc-" + sha1(normalizedManualCaseText).slice(0, 12)`。
- 不保留历史执行明细到每个 case 中。case 始终表示当前状态快照；历史过程由 `runs/` 承载。
- 不把大型原始日志、完整 dump 或长构建输出塞进 JSON。

## 新目录结构

```text
harmony-ui-test-workspace/
  README.md
  config.json
  index.md
  index.json
  cases/
    账号密码登录成功__tc-a83f21c9d4e5/
      case.md
      state.json
    退出登录后返回登录页__tc-b72c0a9f1162/
      case.md
      state.json
  runs/
    run-20260616-143012.md
    run-20260616-143012.json
  logs/
    group-build-evidence.md
    group-device-evidence.md
```

## 文件职责

### `index.md`

全局人类入口，回答“现在有哪些用例、状态如何、最近做了什么、下一步看哪里”。

建议内容：

- 用例总览统计。
- 当前需要处理的问题分组，例如缺前置条件、生成阻塞、待目标确认、失败待修复。
- 所有用例或最近活跃用例的看板。
- 最近 runs 列表。
- 指向每个 `case.md` 和 `runs/*.md` 的链接。

### `index.json`

全局轻量索引，方便 agent 快速定位用例目录和筛选状态。

只保存索引字段，不保存完整 plan/report。

示例：

```json
{
  "version": 1,
  "updatedAt": "2026-06-16T15:40:00+08:00",
  "cases": [
    {
      "caseId": "tc-a83f21c9d4e5",
      "caseName": "账号密码登录成功",
      "caseDir": "cases/账号密码登录成功__tc-a83f21c9d4e5",
      "status": "READY_TO_RUN",
      "latestRunId": "run-20260616-143012",
      "updatedAt": "2026-06-16T15:40:00+08:00"
    }
  ],
  "runs": [
    {
      "runId": "run-20260616-143012",
      "file": "runs/run-20260616-143012.md",
      "action": "generate",
      "total": 1,
      "updatedAt": "2026-06-16T15:40:00+08:00"
    }
  ]
}
```

### `cases/<readableName>__<caseId>/case.md`

单个用例的人类卡片，是用户查看某个用例的主入口。

它融合展示原 plan 和 report 的关键摘要，但不承担机器事实恢复的职责。

固定章节建议：

```md
# 用例：账号密码登录成功

## 当前状态

## 人工用例

## 测试映射

## 前置条件

## 最近执行

## 证据

## 问题与下一步
```

`## 证据` 用于收纳单用例关键证据，例如 runner 摘要、hdc 复现目标、观察结果、修复假设和关键日志片段。默认不再为单用例单独创建 `evidence.md`。

### `cases/<readableName>__<caseId>/state.json`

单个用例唯一结构化状态文件，合并原 plan/report 的核心机器字段。

它回答：

- 这个用例是谁。
- 测试代码在哪里。
- 当前生成和执行状态是什么。
- 前置条件 gate 是否通过。
- 最近执行结果是什么。
- 若失败，失败码和证据入口是什么。
- 下一步建议是什么。

示例：

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
  "generation": {
    "status": "generated",
    "reason": null
  },
  "target": {
    "module": "featuresLunar/LunarLogin",
    "testFile": "featuresLunar/LunarLogin/src/ohosTest/ets/test/AccountLoginUi.test.ets",
    "testClass": "AccountLoginUiTest",
    "testMethod": "loginAccountSuccess"
  },
  "preconditionGate": {
    "status": "passed",
    "reason": ""
  },
  "latestResult": {
    "status": "NOT_RUN",
    "runId": "",
    "failureCode": null,
    "evidence": ""
  },
  "nextAction": "可执行",
  "updatedAt": "2026-06-16T15:40:00+08:00"
}
```

### `runs/run-*.md`

单次生成、执行、修复或重跑的人类入口，回答“这次操作涉及哪些用例、每个结果如何、下一步是什么”。

每次用户发起一次实质操作都新建一个 run。run 不覆盖旧文件。

建议内容：

- 本次动作、时间、输入来源。
- 本次涉及用例列表。
- 本次结果统计。
- 用例看板，链接到各自 `case.md`。
- 本次共同失败原因或基础设施问题。
- 下一步建议。

### `runs/run-*.json`

单次操作的轻量结构化快照，方便后续“继续上次”“重跑这次失败的用例”。

示例：

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
      "status": "PASS",
      "nextAction": "无"
    }
  ],
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

### `logs/`

只保存跨用例共享的大体积证据。

适用场景：

- 一次构建失败影响多个用例。
- 设备检查失败影响整次 run。
- 长日志或完整 dump 不适合放进单个 `case.md`。

单用例证据默认写入对应 `case.md` 的 `## 证据` 章节。

## 目录名规则

用例目录名使用：

```text
<safeCaseName>__<caseId>
```

规则：

- `safeCaseName` 来自人工用例名称或 agent 提取的简短标题。
- 保留中文，提升可读性。
- 替换或移除文件系统不安全字符，例如 `/ : * ? " < > |` 和换行。
- 连续空白折叠为单个空格或 `-`。
- 建议限制到 40 个字符以内，避免路径过长。
- 目录后缀必须保留 `__<caseId>`，用于唯一性和反查。

示例：

```text
账号密码登录成功__tc-a83f21c9d4e5
退出登录后返回登录页__tc-b72c0a9f1162
```

查找规则：

- 用户提供 `caseId`：扫描 `cases/*__<caseId>/state.json`。
- 用户提供中文名：优先查 `index.json` 的 `caseName` 和 `caseDir`。
- 用户提供目录：读取该目录下 `state.json` 确认稳定身份。

## 状态模型

`state.json.status` 和 run 看板使用统一状态。

建议取值：

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

## 创建和更新时机

### 初始化工作区

首次进入 workflow 时创建：

```text
config.json
README.md
index.md
index.json
cases/
runs/
logs/
```

### 生成测试

无论单个还是多个用例，流程一致：

```text
解析人工用例
-> 计算 caseId
-> 生成 safeCaseName__caseId 目录
-> 写入或覆盖 case.md
-> 写入或覆盖 state.json
-> 创建本次 run-*.md/json
-> 更新 index.md/json
```

生成失败也创建 case 目录，并设置：

```text
state.status = GENERATION_BLOCKED
generation.status = blocked
```

### 执行测试

每次用户发起执行都创建新的 run：

```text
解析本次涉及的 cases
-> 创建 run-*.md/json
-> 将相关 case 标记为 RUNNING、NEEDS_CONFIRMATION 或 NEEDS_PRECONDITION
-> 每个 case 达到 PASS/FAIL/BLOCKED 后立即更新对应 case.md 和 state.json
-> 同步更新当前 run-*.md/json
-> 本次操作结束后更新 index.md/json
```

若本次混合旧用例和新用例：

- 旧用例复用已有 case 目录。
- 新用例创建新的 case 目录。
- 本次共同出现在同一个新的 run 文件中。

### 修复和重跑

每次修复或重跑都创建新的 run：

```text
通过用户指定 case、run 或 index 定位目标 case
-> 创建 run-*.md/json
-> 执行修复或重跑
-> 每个 case 完成后立即更新 case.md 和 state.json
-> 同步更新 run-*.md/json
-> 更新 index.md/json
```

### 覆盖和保留规则

```text
case.md       覆盖更新，表示该用例当前状态
state.json    覆盖更新，表示该用例当前结构化状态
index.md      覆盖更新，表示全局当前索引
index.json    覆盖更新，表示全局当前结构化索引
runs/*.md     每次实质操作新建，不覆盖
runs/*.json   每次实质操作新建，不覆盖
logs/*        仅跨用例或大体积证据需要时创建
```

## 与旧结构的映射

| 旧文件 | 新位置 | 说明 |
|---|---|---|
| `plans/<caseId>-plan.json` | `cases/<name>__<caseId>/state.json` | 只保留测试映射、生成状态、前置条件 gate 等核心字段 |
| `reports/<caseId>.json` | `cases/<name>__<caseId>/state.json` | 最近执行摘要合并到 `latestResult` |
| `reports/<caseId>.md` | `cases/<name>__<caseId>/case.md` | 详细人类可读内容合并进用例卡片 |
| `reports/summary.md` | `runs/run-*.md` 和 `index.md` | run 表示单次操作，index 表示当前全局入口 |
| `reports/summary.json` | `runs/run-*.json` 和 `index.json` | run 表示单次结构化快照，index 表示全局索引 |
| `logs/<caseId>-evidence.md` | `case.md` 的 `## 证据` | 单用例证据默认内联 |
| 批量级 evidence | `logs/group-*.md` | 跨用例共享证据仍外置 |

## Markdown 与 JSON 分工

Markdown：

- 面向用户阅读。
- 可以包含完整人工步骤、预期、证据摘要、失败分析、下一步建议。
- 允许为阅读体验调整表达，但必须保留固定章节。

JSON：

- 面向 agent 恢复和批量筛选。
- 字段必须稳定且精简。
- 不保存大段自然语言、完整日志、完整 dump 或 Markdown 内容。

## 兼容策略

第一阶段可以支持旧结构只读迁移：

1. 如果发现旧 `plans/` 和 `reports/`，优先读取旧 plan/report 恢复 case。
2. 为每个旧 case 生成新的 `cases/<name>__<caseId>/case.md` 和 `state.json`。
3. 从旧 summary 生成一个迁移 run，例如 `runs/run-migrated-<timestamp>.md/json`。
4. 后续写入只使用新结构。

如果不做自动迁移，也应在文档中明确：新结构只对新生成或新执行的用例生效，旧 plan/report 仍可按旧流程读取。

## 风险与取舍

- 继续使用内容 hash 作为 `caseId`，人工用例原文变化仍可能产生新用例。该问题可在第二阶段通过 `caseKey + contentHash` 解决。
- 单用例证据内联到 `case.md` 会让失败复杂的 case 文件变长。通过“长证据外置到 `logs/`”缓解。
- run 文件每次实质操作新建，会积累历史文件。可以后续增加归档或只在 `index.md` 展示最近 N 个。
- `state.json` 合并 plan/report 后，字段设计必须克制，否则会重新膨胀。

## 推荐落地顺序

1. 更新 `workspace-and-config.md`，定义新目录结构和初始化文件。
2. 更新 `execution-plan.md`，将 plan 概念收敛为 `state.json` 的生成阶段字段。
3. 更新 `report-format.md`，将 report 概念收敛为 `case.md` 的当前结果章节和 `state.json.latestResult`。
4. 更新主 `SKILL.md` 的执行/修复/重跑路由，改为读取 `index.json`、`runs/*.json` 和 `cases/*/state.json`。
5. 更新日志策略，单用例证据默认写入 `case.md`，跨用例或大体积证据才写入 `logs/`。
6. 增加迁移说明或兼容读取规则，避免旧工作区立即失效。

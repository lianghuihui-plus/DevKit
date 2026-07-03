# 工作目录与配置

## 何时读取

- 生成、执行、修复或重跑前需要解析工作目录、`config.json`、用例资产目录、run 快照或修复预算时读取。
- 需要使用环境默认值减少 DevEco、Node、hvigor 或 hdc 探索时读取。
- 需要从旧 `plans/`、`reports/` 工作区兼容恢复上下文时读取。
- 只查询 ArkTS UI API 细节时，优先读取测试代码或官方 API 文档。

该 skill 的运行产物必须集中写入被测 HarmonyOS 项目根目录下的专属工作目录。不要把用例卡片、状态、run 快照和日志散落到项目其他目录。

## 默认工作目录

默认目录：

```text
harmony-ui-test-workspace/
```

如果用户在本次指令中指定工作目录，以用户指定为准。否则使用默认目录。

生成、执行或修复前必须：

1. 定位被测 HarmonyOS 项目根目录。
2. 解析工作目录路径。
3. 如果工作目录不存在，创建目录、默认 `config.json`、全局入口和必要子目录。
4. 如果工作目录已存在，先读取 `config.json`。
5. 如果存在 `index.json`，读取 `index.json` 和相关用例 `state.json`。
6. 如果不存在 `index.json`，先检查是否存在旧 `plans/`、`reports/`；存在则按“旧结构兼容”迁移到新结构，或只读恢复候选后等待用户补充缺失信息。
7. 如果既没有 `index.json` 也没有旧结构，创建全局入口和必要子目录。
8. 后续用例状态、run 快照和必要日志都写入该工作目录。

## 目录结构

推荐结构：

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
  runs/
    run-20260616-143012.md
    run-20260616-143012.json
  logs/
    group-build-evidence.md
    group-device-evidence.md
```

用途：

- `README.md`：工作区使用说明。
- `config.json`：当前项目的 UI 测试 workflow 配置。
- `index.md`：全局人类入口，展示用例看板、待处理问题和最近 run。
- `index.json`：全局轻量索引，帮助 agent 快速定位用例目录和筛选状态。
- `cases/`：长期用例资产；每个用例一个目录。
- `cases/<safeCaseName>__<caseId>/case.md`：单个用例的人类卡片，展示当前状态、人工用例、测试映射、前置条件、最近执行、证据和下一步。
- `cases/<safeCaseName>__<caseId>/state.json`：单个用例唯一结构化状态，供 agent 恢复和批量筛选。
- `runs/`：每次生成、执行、修复或重跑的单次操作快照。
- `logs/`：跨用例共享或大体积证据。单用例证据默认写入对应 `case.md`。

## 用例目录命名

用例目录名使用：

```text
<safeCaseName>__<caseId>
```

规则：

- `safeCaseName` 来自人工用例名称或 agent 提取的简短标题。
- 保留中文，提升阅读性。
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

## 创建和更新时机

初始化工作区时创建：

```text
config.json
README.md
index.md
index.json
cases/
runs/
logs/
```

每次用户发起一次实质操作，都创建新的 run：

```text
runs/run-YYYYMMDD-HHMMSS.md
runs/run-YYYYMMDD-HHMMSS.json
```

实质操作包括：

- 生成测试代码。
- 执行测试。
- 修复失败用例。
- 重跑 blocked 或失败用例。

覆盖和保留规则：

```text
case.md       覆盖更新，表示该用例当前状态
state.json    覆盖更新，表示该用例当前结构化状态
index.md      覆盖更新，表示全局当前索引
index.json    覆盖更新，表示全局当前结构化索引
runs/*.md     每次实质操作新建，不覆盖
runs/*.json   每次实质操作新建，不覆盖
logs/*        仅跨用例或大体积证据需要时创建
```

无论用户输入单个用例还是多个用例，规则都相同：本次操作涉及的所有用例共同写入同一个新的 run；每个用例各自更新自己的 `case.md` 和 `state.json`。

如果本次混合旧用例和新用例：

- 旧用例复用已有 case 目录。
- 新用例创建新的 case 目录。
- 本次共同出现在同一个新的 run 文件中。

## 日志与证据文件策略

默认优先把命令、结果摘要、关键输出片段和步骤复现结论写入 `case.md` 的 `## 证据` 章节，不额外创建单用例 evidence 文件。

只有以下情况才写入 `logs/`：

- 原始输出过长，放入 `case.md` 会影响阅读。
- 失败定位必须保留大体积原始证据，例如完整控件树、截图路径、关键 hilog 长片段或构建失败长日志。
- 多个 case 共用同一次构建、安装或设备检查证据，需要复用同一份批量级证据。

构建、安装、设备检查这类共享阶段优先写批量级证据文件：

```text
logs/<groupId>-build-evidence.md
logs/<groupId>-device-evidence.md
```

截图、控件树 dump 等较大的诊断附件只在确实有定位价值时保存，并从 `case.md`、`runs/*.md` 或 `state.json.latestResult.evidence` 引用。成功用例通常不写 `logs/` 附件。

## 共享执行信息

一次 run 中多个 case 共用的设备、构建、安装、产物和证据，优先写入 `runs/*.json.shared` 和 `runs/*.md`。

每个 case 的 `state.json.execution` 只保留对该 case 生效的最终摘要和命令引用，避免把同一批构建/安装长命令和长证据重复复制到每个 case。

如果共享阶段失败影响多个 case：

- 共享失败详情写入 run 和 `logs/<groupId>-*.md`。
- 每个受影响 case 仍必须更新 `state.json.latestResult.failureCode` 和 `case.md` 的当前状态。
- case 中的 `latestResult.evidence` 指向共享证据路径。

## 默认配置

工作目录不存在时创建默认配置：

```json
{
  "version": 1,
  "environment": {
    "devecoSdkHome": "/Applications/DevEco-Studio.app/Contents/sdk",
    "nodePath": "/Applications/DevEco-Studio.app/Contents/tools/node/bin/node",
    "hvigorwPath": "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js",
    "hdcPath": "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
  },
  "repairBudget": {
    "defaultAttemptsPerCase": 5,
    "stopOnSameFailureCodeRepeats": 3
  },
  "artifacts": {
    "casesDir": "cases",
    "runsDir": "runs",
    "logsDir": "logs",
    "indexFile": "index.json"
  }
}
```

## 环境配置

`environment` 用于减少 DevEco、Node、hvigor 和 hdc 路径探索。配置项有值时优先使用；配置项为空或路径不可用时，按项目探测规则继续查找。

```json
{
  "environment": {
    "devecoSdkHome": "/Applications/DevEco-Studio.app/Contents/sdk",
    "nodePath": "/Applications/DevEco-Studio.app/Contents/tools/node/bin/node",
    "hvigorwPath": "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js",
    "hdcPath": "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
  }
}
```

环境配置只作为工具路径默认值，不代表探测事实。实际使用的 `DEVECO_SDK_HOME`、`node`、`hvigorw.js` 和 `hdc` 路径仍必须写入 `state.json.execution.probe` 或 `state.json.execution.hdcPath`，并在 `case.md`/`runs/*.md` 中展示关键摘要。

agent 不得把这些环境值写入用户 shell 配置、系统环境或 DevEco Studio 全局配置。`DEVECO_SDK_HOME` 等环境变量只能作为单次命令临时传入，不能持久化。

## 配置优先级

同一配置项按以下优先级解析：

1. 用户本次指令。
2. 工作目录 `config.json`。
3. skill 默认值。

用户可以用自然语言覆盖修复预算，例如：

```text
这次每个用例最多自动修 0 次。
批量执行，每条最多修 3 次。
这个用例失败后最多修 5 轮。
```

`0` 表示只执行不自动修复。

## 修复尝试计数

一次自动修复尝试定义为：

```text
一次失败结果
-> agent 修改测试代码、测试配置或必要稳定定位点
-> agent 重新构建、安装或执行目标用例
```

不计入修复次数：

- 初始生成测试代码。
- 第一次执行。
- 读取文件、查日志、查文档、分析 UI 代码。
- 只更新 `case.md`、`state.json`、`index` 或 run 快照。
- hdc 权限提权后重跑同一条命令。
- 构建 task 探测和等价 fallback，例如 `genOnDeviceTestHap` 不存在时改用已确认可用的 `assembleHap`。
- blocked 重跑。

计入 1 次修复尝试：

- 改 selector 后重跑。
- 补稳定 `.id()` 后重跑。
- 改等待策略后重跑。
- 改断言策略后重跑。
- 修测试代码编译错误后重跑。
- 修键盘、焦点或输入处理后重跑。

## 记录要求

每个 `state.json` 都应记录本次生效的修复预算快照：

```json
{
  "repairBudget": {
    "configured": 5,
    "used": 0,
    "remaining": 5,
    "source": "user_instruction | workspace_config | skill_default"
  }
}
```

自动修复完成后，只更新用例当前状态快照和预算计数；run 快照记录本次操作范围和结果，不记录无限制过程历史。blocked 重跑若本次运行上下文覆盖了原阻塞条件，先更新同一个 `state.json` 的 gate、目标确认和证据摘要，再执行。

修复、重跑和续跑只读取当前工作目录内的 `index.json`、`runs/*.json` 和 `cases/*/state.json`。不要跨工作目录或历史目录猜测要恢复的上下文。

## 旧结构兼容

如果发现旧结构：

```text
plans/
reports/
reports/summary.json
reports/summary.md
```

agent 可以只读旧 plan/report 恢复上下文，并在下一次写入时生成新结构：

1. 为每个旧 case 创建 `cases/<safeCaseName>__<caseId>/case.md` 和 `state.json`。
2. 从旧 summary 生成一个迁移 run，例如 `runs/run-migrated-YYYYMMDD-HHMMSS.md/json`。
3. 从生成后的 `cases/*/state.json` 重建 `index.md` 和 `index.json`。
4. 后续写入只使用新结构。

如果无法安全迁移，说明缺失字段或冲突原因，只能把旧结构作为只读候选来源；在缺失信息补齐前不要执行会产生新状态的操作。任何新状态都不得写回旧 `plans/`、`reports/`。

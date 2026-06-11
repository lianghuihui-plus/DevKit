# 工作目录与配置

## 何时读取

- 生成、执行、修复或重跑前需要解析工作目录、`config.json`、产物目录或修复预算时读取。
- 需要使用环境默认值减少 DevEco、Node、hvigor 或 hdc 探索时读取。
- 只查询 ArkTS UI API 细节时，优先读取测试代码或官方 API 文档。

该 skill 的运行产物必须集中写入被测 HarmonyOS 项目根目录下的专属工作目录。不要把 plan、report 和日志散落到项目其他目录。

## 默认工作目录

默认目录：

```text
harmony-ui-test-workspace/
```

如果用户在本次指令中指定工作目录，以用户指定为准。否则使用默认目录。

生成、执行或修复前必须：

1. 定位被测 HarmonyOS 项目根目录。
2. 解析工作目录路径。
3. 如果工作目录不存在，创建目录和默认 `config.json`。
4. 如果工作目录已存在，先读取 `config.json`。
5. 后续 plan、report、批量 summary 索引和必要日志都写入该工作目录。

## 目录结构

推荐结构：

```text
harmony-ui-test-workspace/
  config.json
  plans/
  reports/
  logs/
```

用途：

- `config.json`：当前项目的 UI 测试 workflow 配置。
- `plans/`：从人工用例生成的 execution plan。
- `reports/`：case report 和批量 summary 索引。
- `logs/`：必要的原始证据附件。默认不为成功用例生成独立日志文件。

## 日志与证据文件策略

默认优先把命令、结果摘要、关键输出片段和诊断结论写入 case report，不额外创建日志文件。

只有以下情况才写入 `logs/`：

- 原始输出过长，放入 report 会影响阅读。
- 失败定位必须保留原始证据，例如控件树、截图、关键 hilog 片段或构建失败长日志。
- 多个 case 共用同一次构建、安装或设备检查证据，需要复用同一份批量级证据。

失败用例优先写入单个聚合证据文件：

```text
logs/<caseId>-evidence.md
```

该文件可包含 runner 关键原始输出、诊断命令、关键片段和附件路径。不要为同一个 case 的每条命令都创建独立 log 文件。

构建、安装、设备检查这类批量共享阶段优先写批量级证据文件：

```text
logs/<groupId>-build-evidence.md
logs/<groupId>-device-evidence.md
```

截图、控件树 dump 等较大的诊断附件只在确实有定位价值时保存，并从 case report 的 `diagnostics[].artifact` 或 evidence 文件中引用。成功用例通常不写 `logs/` 附件。

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
    "plansDir": "plans",
    "reportsDir": "reports",
    "logsDir": "logs"
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

环境配置只作为工具路径默认值，不代表探测事实。实际使用的 `DEVECO_SDK_HOME`、`node`、`hvigorw.js` 和 `hdc` 路径仍必须写入 execution plan 的 `execution.probe` 或 `execution.hdcPath`，并复制到 report。

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
- 只更新 plan 或 report。
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

每个 plan/report 都应记录本次生效的修复预算：

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

自动修复完成后，只更新 case report 的当前结果快照和预算计数；批量场景同步或重建 summary 索引，不记录详细过程历史。blocked 重跑若本次运行上下文覆盖了原阻塞条件，先按 `execution-plan.md` 更新同一个 case plan 的 gate、目标确认和 evidence，再覆盖 case report。

修复、重跑和续跑只读取当前工作目录内的 plan、report 和批量 summary 索引。不要跨工作目录或历史目录猜测要恢复的上下文。结果类 summary 索引缺失时，只扫描当前工作目录的 case reports 重建失败或 blocked 候选；case plans 只能用于恢复待生成、待执行或目标映射候选，不能用来推断已有执行结果。

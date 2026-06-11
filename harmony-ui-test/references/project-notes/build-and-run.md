# 构建与执行说明

## 何时读取

- 执行测试前需要探测 DevEco、Node、hvigor、hdc、product、module、bundleName 或 signed HAP 时读取。
- 构建、安装、`aa test`、目标产物确认、hdc 权限或失败后实时诊断相关问题时读取。
- 只生成测试代码且不涉及构建执行时，通常不需要读取本文件。

这些命令作为默认模板使用。如果用户指定文档、项目内文档或 DevEco 构建日志给出了项目特定参数，优先使用项目特定参数。

## 需要先确认的值

执行前先确认：

- `node`：DevEco 或项目使用的 Node 可执行文件。
- `hvigorw.js`：DevEco 或项目的 hvigor wrapper。
- `product`：产品名，例如 `lunar`。
- `buildMode`：app 构建模式；登录和账号类测试通常使用 `debug`。
- `moduleName`：目标模块名，例如 `LunarLogin`。
- `bundleName`：应用包名。
- `testModuleName`：测试模块名，通常类似 `<ModuleName>_test`。
- `describeName` 和 `itName`：Hypium 测试套件名和用例名。
- `hdc`：能够看到目标设备的 hdc 可执行文件。

## 项目探测阶段

构建前必须先做项目探测。不要直接套用固定命令。

探测前先读取工作目录 `config.json` 的 `environment` 配置。`devecoSdkHome`、`nodePath`、`hvigorwPath` 和 `hdcPath` 有值时优先使用；为空或不可用时，再按下方规则查找。配置值只是路径默认值，实际可用性仍需通过命令执行或文件存在性确认。

## 环境安全边界

agent 不得为了构建或执行测试而持久修改用户机器环境。禁止写入或修改：

- `~/.zshrc`、`~/.zprofile`、`~/.bashrc`、`~/.bash_profile`、`~/.profile`
- `/etc/profile`、`/etc/zshrc` 等系统级 shell 配置
- `launchctl setenv`、全局 `PATH`、全局 SDK 环境变量
- DevEco Studio 安装目录或 IDE 全局配置

`DEVECO_SDK_HOME`、`PATH` 等只允许作为单次命令的临时环境传入。例如：

```bash
DEVECO_SDK_HOME=<devecoSdkHome> node <hvigorw.js> ...
```

不要使用 `export DEVECO_SDK_HOME=...` 后再执行多条命令，也不要把环境修复写回用户 shell 配置。实际采用的环境值只记录到 plan/report。

默认不要使用 hvigor daemon。agent 自动构建时优先使用非 daemon 命令，避免 daemon 缓存错误 SDK 或环境后影响 DevEco Studio。禁止主动添加 `--daemon`；如果项目 hvigor 支持显式禁用 daemon 的参数，应优先使用。若怀疑 daemon 已缓存错误环境，先停止 daemon 或提示用户重启 DevEco Studio，再继续。

探测项：

- `DEVECO_SDK_HOME`：优先使用 `config.environment.devecoSdkHome`；如果 hvigor 报 `Invalid value of 'DEVECO_SDK_HOME'`，再定位 DevEco SDK，并仅对下一次 hvigor 命令临时传入该环境变量，或让用户确认环境。
- `node`：优先使用 `config.environment.nodePath`、DevEco Studio 内置 Node 或项目文档指定 Node。
- `hvigorw.js`：优先使用 `config.environment.hvigorwPath`，其次为项目本地 hvigor wrapper、DevEco Studio 内置 `tools/hvigor/bin/hvigorw.js`、用户指定路径。
- 可用 task：不要假设 `genOnDeviceTestHap` 一定存在，也不要只因 `hvigor tasks` 未列出它就判定不可用。task 列表、`taskTree`、DevEco 构建日志、模板命令试跑结果和实际构建反馈都可作为证据；如果 task 列表不完整，应优先用模板构建命令或项目日志中的等价命令验证，再决定是否记录 `BUILD_TASK_UNAVAILABLE`。
- `product`：从用户指定、项目 build-profile、DevEco 日志或构建命令中确认。
- `moduleName`：从人工用例目标模块、路由归属、源码目录和 build-profile 中确认。
- ohosTest target：构建 test HAP 前确认 product/module build-profile 中存在 ohosTest target。若 product/module 已确认，且缺失项只是测试 target 配置，可以在修复预算内补齐测试构建配置并继续构建；若 product/module 或构建目标不确定，记录 `OHOSTEST_TARGET_MISSING` 并阻塞。
- `bundleName`：配置文件中的 bundleName 只作候选，最终以安装包/设备 `bm dump`/构建产物元数据为准。
- HAP 产物规则：构建前确认将优先选择 `*-signed.hap`；构建后再从实际输出中选择 signed app/test HAP。非 signed HAP 可能导致 `install sign info inconsistent`。

探测结果写入 execution plan 的 `execution.probe`，`hdc` 实际路径写入 `execution.hdcPath`，并复制到 report。构建后产物选择也要回写到同一个 `execution.probe`。如果使用了配置中的环境路径，应在对应字段记录实际采用的路径；如果配置路径不可用，应在日志或 report 中记录 fallback 原因。

## 目标产物确认闸门

多 product、多 module、多 bundleName 项目必须防止跑错产物。单个用例执行和批量执行都要做目标确认。

构建前先展示目标计划摘要：

```text
product:
moduleName:
buildMode:
app bundleName candidates:
testModuleName candidates:
device:
build app task:
build test task:
build app command:
build test command:
```

用户确认后再构建。

构建完成、实际 signed HAP 和最终 bundleName 可确认后，在安装 app HAP、安装 test HAP 或执行 `aa test` 前，先自动生成最终执行摘要：

```text
product:
moduleName:
buildMode:
app bundleName:
testModuleName:
device:
app signed HAP:
test signed HAP:
install app command:
install test command:
run test command:
```

如果最终执行摘要与构建前确认的目标一致，将 `targetConfirmation.preInstall.status` 记为 `verified`，并继续安装或执行，不再二次人工确认。报告中仍必须记录该摘要，便于追溯。

如果构建后实际选择的 `*-signed.hap`、最终 `bundleName`、`testModuleName` 或设备与构建前确认目标不一致，或 agent 无法自动确认一致性，必须再次展示差异并等待确认。用户确认后继续安装或执行，并将 `targetConfirmation.preInstall.status` 记为 `confirmed`。用户未确认或拒绝确认时，不安装、不执行，记录 `BLOCKED`；实际产物与已确认摘要不一致或无法自动确认一致性时，failure code 使用 `TARGET_CONFIRMATION_STALE`；用户明确拒绝继续时使用 `TARGET_CONFIRMATION_BLOCKED`。

批量执行时按相同 `product/moduleName/bundleName/testModuleName/device` 分组展示构建前确认摘要；同一组用户确认一次即可。构建后逐组自动校验，校验一致的组直接安装执行；组内任一实际产物与确认摘要不一致，或无法自动确认一致性时，该组需要重新确认。

## hdc 权限与沙箱处理

`hdc` 经常受 agent 沙箱、系统权限、签名、USB/模拟器连接状态影响。设备检查失败时，不要继续猜测或反复执行。

推荐处理顺序：

1. 优先使用用户指令、工作目录 `config.environment.hdcPath` 或项目文档指定的 hdc 绝对路径。
2. 如果未指定，尝试项目/DevEco 常见 hdc 路径或 PATH 中的 `hdc`。
3. 执行 `hdc list targets`。
4. 如果出现 `Connect server failed`、权限、沙箱、server connect、USB 访问、签名或系统拦截类错误，立即使用当前 agent 平台的提权/沙箱外执行机制重跑同一条 `hdc list targets`。
5. 提权后如果能列出设备，后续 `hdc install` 和 `hdc shell aa test` 必须沿用同一个 hdc 路径和同一种提权/沙箱外执行方式。
6. 如果当前 agent 平台不支持提权执行，请把完整命令交给用户在本机终端执行，并要求用户回贴输出。
7. 用户确认其终端可执行时，记录 agent 环境受限，不要把它误判为设备真实不可用。

如果无法在 agent 环境内完成设备检查，报告中记录：

```json
{
  "failure": {
    "code": "DEVICE_UNAVAILABLE",
    "stage": "device_check",
    "summary": "agent 环境无法执行 hdc list targets",
    "nextAction": "请求用户授权提权执行，或让用户在本机终端执行同一条命令并回贴输出"
  }
}
```

如果平台支持更具体的权限失败分类，也可以使用 `PERMISSION_DENIED`，但 summary 中必须保留原始错误摘要。

## 构建 debug app HAP

```bash
node <hvigorw.js> \
  --mode project \
  -p product=<product> \
  -p buildMode=debug \
  assembleApp --analyze=normal --parallel --incremental
```

如果测试数据只适用于 debug 包，必须确认构建产物确实是 debug。可以检查生成的 build profile 或等价元数据，例如：

```text
BUILD_MODE_NAME = 'debug'
DEBUG = true
```

如果当前是 release 包且用例或用户明确要求 debug 包，应记录目标产物不匹配，走目标确认或构建产物失败路径；不要把它归因于账号、密码等测试输入不可用。

## 构建 ohosTest HAP

目标模块通常需要带 `@ohosTest`，但 task 名需要以项目探测结果为准。

候选命令：

```bash
node <hvigorw.js> \
  --mode module \
  -p module=<moduleName>@ohosTest \
  -p isOhosTest=true \
  -p product=<product> \
  -p buildMode=test \
  genOnDeviceTestHap --analyze=normal --parallel --incremental
```

常见坑：

- `-p module=<moduleName>` 可能只构建业务 HAP，不会生成测试 HAP。通常需要使用 `-p module=<moduleName>@ohosTest`。
- 有些项目的 `hvigor tasks` 不会完整列出真实可用的测试构建 task，但直接使用模板命令、`taskTree` 或项目日志里的等价命令可能可以构建成功。此时应记录验证方式和 fallback 原因，不要把 task 列表缺失直接当成 `BUILD_TASK_UNAVAILABLE`。
- 如果缺少 ohosTest target，先判断是否只是目标模块的测试构建配置缺失。若 product/module 已确认且改动范围明确，可以补充 ohosTest target 后继续构建；若会影响 product、bundleName、签名、发布 target 或无法确认改动范围，记录 `OHOSTEST_TARGET_MISSING` 并等待用户确认。

fallback 示例：

```bash
node <hvigorw.js> \
  --mode module \
  -p module=<moduleName>@ohosTest \
  -p isOhosTest=true \
  -p product=<product> \
  -p buildMode=test \
  assembleHap --analyze=normal --parallel --incremental
```

## 检查设备

```bash
hdc list targets
```

如果 agent 环境无法访问 hdc，但用户终端可以访问，优先请求提权执行或让用户执行同一命令并回贴输出；不要继续安装或运行测试。若仍无法继续，记录 `DEVICE_UNAVAILABLE` 并生成报告。

如果普通执行返回 `Connect server failed`，但提权/沙箱外执行成功，这是 agent 沙箱限制，不是设备不可用；报告中应记录普通执行失败和提权执行成功的事实。

## 安装 HAP

先安装 app HAP，再安装 test HAP：

```bash
hdc install -r <app.hap>
hdc install -r <test.hap>
```

安装前优先选择 `*-signed.hap`。如果安装非 signed HAP 出现 `install sign info inconsistent`，切换 signed HAP，并在 report 中记录选择原因。

## 执行单条测试

```bash
hdc shell aa test \
  -b <bundleName> \
  -m <testModuleName> \
  -s unittest OpenHarmonyTestRunner \
  -s class <describeName>#<itName> \
  -s timeout 60000
```

执行报告中必须记录实际使用的完整命令。

`-b <bundleName>` 必须是最终安装到设备上的应用 Bundle 名称。不要只依赖 `AppScope/app.json5` 或根 `build-profile.json5` 的候选值；优先使用安装包元数据、`bm dump` 或实际测试包挂载的 bundleName。

## 结果解析

优先查找类似结果摘要：

```text
Tests run: <n>, Failure: <n>, Error: <n>, Pass: <n>, Ignore: <n>
```

如果 runner 超时或没有结果摘要，记录关键原始输出片段，并用最接近的失败码分类。

## 失败后 hdc 实时诊断

测试执行失败后、进入自动修复前，可以根据当前失败类型使用 hdc 做实时诊断。诊断用于辅助判断当前页面、控件树、Ability 状态、bundleName、进程状态和关键系统日志，不替代 runner 输出。

诊断原则：

- 聚焦当前失败用例和当前被测 app，不做无关设备、无关应用或全量日志扫描。
- 优先选择能解释当前失败的最小诊断命令组合。
- 诊断失败不阻塞报告生成，不改变原始 runner 失败事实。
- 诊断结果用于辅助失败分类和修复决策；不要因为诊断信息不完整就反复诊断。
- 诊断命令、关键输出片段、截图或控件树文件路径写入 report 的 `diagnostics`。默认不为每条诊断命令创建独立日志文件；只有原始输出过长或附件确有定位价值时，才写入工作目录 `logs/`，并优先合并到 `logs/<caseId>-evidence.md`。

常见诊断：

- `SELECTOR_NOT_FOUND` / `TEST_TIMEOUT`：优先 dump 当前控件树；只有控件树不足以解释问题时再截图，确认目标控件是否存在、id/text 是否变化、页面是否停在预期位置。
- `ASSERTION_FAILED`：优先选择截图或 dump 当前控件树中的一种；只有单一证据不足时才同时保留两者，确认实际页面状态和人工预期差异。
- `NAVIGATION_AMBIGUOUS`：检查当前窗口、Ability 或页面根节点，辅助判断停留页面。
- `BUNDLE_NAME_UNRESOLVED`：使用 `bm dump`、安装包元数据或测试包挂载信息确认最终 bundleName。
- runner 无结果、app 启动失败或执行卡死：检查进程、Ability 状态和关键 hilog 片段。

可选命令示例，具体命令以设备和系统版本支持为准：

```bash
hdc shell uitest dumpLayout
hdc shell uitest screenCap
hdc shell bm dump -n <bundleName>
hdc shell aa dump
hdc shell pidof <bundleName>
hdc shell hilog
```

日志收敛规则：

- 成功执行不保存独立 runner log，结果摘要和命令写入 report 即可。
- 失败执行只保存与当前失败直接相关的关键证据。
- 同一个 case 的文本证据优先合并到一个 evidence 文件。
- 构建或设备检查失败影响整批时，写批量级 evidence 文件，不为每个受影响 case 复制同一份日志。

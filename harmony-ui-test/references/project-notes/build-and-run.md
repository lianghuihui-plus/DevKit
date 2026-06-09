# 构建与执行说明

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

探测项：

- `DEVECO_SDK_HOME`：如果 hvigor 报 `Invalid value of 'DEVECO_SDK_HOME'`，先定位 DevEco SDK 并设置环境变量，或让用户确认环境。
- `node`：优先使用 DevEco Studio 内置 Node 或项目文档指定 Node。
- `hvigorw.js`：优先级为项目本地 hvigor wrapper、DevEco Studio 内置 `tools/hvigor/bin/hvigorw.js`、用户指定路径。
- 可用 task：不要假设 `genOnDeviceTestHap` 一定存在，应先通过项目 task 列表、DevEco 构建日志或实际构建反馈确认。
- `product`：从用户指定、项目 build-profile、DevEco 日志或构建命令中确认。
- `moduleName`：从人工用例目标模块、路由归属、源码目录和 build-profile 中确认。
- ohosTest target：构建 test HAP 前确认 product/module build-profile 中存在 ohosTest target；缺失时记录 `OHOSTEST_TARGET_MISSING`，不要盲目构建。
- `bundleName`：配置文件中的 bundleName 只作候选，最终以安装包/设备 `bm dump`/构建产物元数据为准。
- HAP 产物规则：构建前确认将优先选择 `*-signed.hap`；构建后再从实际输出中选择 signed app/test HAP。非 signed HAP 可能导致 `install sign info inconsistent`。

探测结果写入 execution plan 的 `execution.probe`，并复制到 report。构建后产物选择也要回写到同一个 `execution.probe`。

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

构建完成、实际 signed HAP 和最终 bundleName 可确认后，在安装 app HAP、安装 test HAP 或执行 `aa test` 前，再展示执行确认摘要：

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

用户确认后再继续安装或执行。

如果构建后实际选择的 `*-signed.hap`、最终 `bundleName`、`testModuleName` 或设备与确认摘要不一致，必须再次展示差异并等待确认。用户未确认或拒绝确认时，不构建、不安装、不执行，记录 `BLOCKED`，failure code 使用 `TARGET_CONFIRMATION_BLOCKED`；如果实际产物与已确认摘要不一致且需要重新确认，使用 `TARGET_CONFIRMATION_STALE`。

批量执行时按相同 `product/moduleName/bundleName/testModuleName/device` 分组展示确认摘要；同一组用户确认一次即可。组内任一实际产物与确认摘要不一致时，该组需要重新确认。

## hdc 权限与沙箱处理

`hdc` 经常受 agent 沙箱、系统权限、签名、USB/模拟器连接状态影响。设备检查失败时，不要继续猜测或反复执行。

推荐处理顺序：

1. 优先使用用户或项目文档指定的 hdc 绝对路径。
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
  assembleApp --analyze=normal --parallel --incremental --daemon
```

如果测试数据只适用于 debug 包，必须确认构建产物确实是 debug。可以检查生成的 build profile 或等价元数据，例如：

```text
BUILD_MODE_NAME = 'debug'
DEBUG = true
```

如果当前是 release 包，不要继续执行 debug 账号相关用例。

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
  genOnDeviceTestHap --analyze=normal --parallel --incremental --daemon
```

常见坑：

- `-p module=<moduleName>` 可能只构建业务 HAP，不会生成测试 HAP。通常需要使用 `-p module=<moduleName>@ohosTest`。
- 有些项目没有 `genOnDeviceTestHap` task，实际需要使用 `assembleHap` 或项目日志里的其他 task。此时应记录 fallback 原因，不要把模板 task 当成唯一正确命令。
- 如果缺少 ohosTest target，应先记录 `OHOSTEST_TARGET_MISSING`，由用户确认是否允许修改 build-profile。

fallback 示例：

```bash
node <hvigorw.js> \
  --mode module \
  -p module=<moduleName>@ohosTest \
  -p isOhosTest=true \
  -p product=<product> \
  -p buildMode=test \
  assembleHap --analyze=normal --parallel --incremental --daemon
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

# 安装教程

> 本文档面向人工环境准备。正式执行以 `workspace -> import-case -> probe/prepare -> 环境确认 -> 显式执行请求与初始状态预检 -> batch -> isolated case Agent -> reconcile 自动提交与收尾` 为唯一主链。

## Codex 插件安装与路径

将交付归档解压为完整 marketplace 后注册目录，ZIP 不是直接安装入口：

```bash
codex plugin marketplace add /absolute/path/mavt-marketplace
codex plugin add mavt@mavt-local
codex plugin list --marketplace mavt-local --json
```

以上命令已在 Codex CLI `0.163.0-alpha.10.2` 验证，不作为最低版本承诺；桌面会话重载需人工确认。安装后核对 `mavt:author-cases`（MAVT 用例编写）、`mavt:run-tests`（MAVT 测试执行）、`mavt:manage-knowledge`（MAVT 知识管理）三个入口，并人工停用同用途的旧独立 Skill；安装器不删除旧入口或修改设备配置。插件 `0.1.1` 已统一入口名称；更新安装源后重新执行 `plugin add` 并新开或重载会话。

插件 Skill 目录和运行时目录不同。下文人工诊断中的 `scripts/...` 应相对于启动响应的固定 `runtimeRoot` 执行，文档中的 `<skill-root>` 也指该根。正常协调通过 `mavt_workspace_open({workspace,role:"coordinator"})` 获取绑定；继续或取消已有 Run 时传入 `batchId`，使用返回的 Run `contextRef` 调用对应 MCP 工具，不重新 prepare。Case Agent 使用 Loader 返回的 execution `contextRef`。`scripts/mavt-entry.js resume` 仅供开发维护诊断，不能代替 MCP 恢复入口；旧接口 Run 需使用其原兼容插件版本。插件加载和安装都不会自动操作设备或安装系统依赖。

## 通用要求

- macOS 或具备 Bash/Node.js 的本地环境。
- Node.js 可用：`node -v`。
- 基础命令可用：`perl`、`mktemp`、`sed`、`awk`。
- 当前目录必须为空目录或已有有效 `workspace.json` 的测试工作空间。

验证：

```bash
node -v
perl -v
```

## Android

需要安装：

- Android SDK Platform Tools。
- Android SDK Platform。
- Android SDK Build Tools。
- JDK，用于构建 MAVT Input IME。

环境变量：

- `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 指向 Android SDK。
- `platform-tools` 加入 `PATH`，确保 `adb` 可用。

设备准备：

- 打开 USB 调试。
- 连接设备或启动模拟器。
- `adb devices` 中设备状态必须是 `device`。

验证：

```bash
adb devices
scripts/probe-env.sh --platform android --device '<serial>' --android-ui-backend auto
scripts/prepare-env.sh --platform android --device '<serial>' --android-ui-backend auto
```

说明：

- Android UI 后端策略为 `auto`（默认）、`helper` 或 `uiautomator`。`auto` 优先使用内置 ARTEMIS Accessibility Helper，Helper 不可用时只对观察和投递前动作降级；`helper` 要求 Helper 可用；`uiautomator` 固定使用现有 ADB/UIAutomator 路径。
- Helper 是 Android Adapter 的内部依赖，不向主 Agent 或 Case Agent 暴露。Helper 原子采集 PNG 和 XML，并提供 tap、doubleTap、toggle、longPress、inputText、swipe、back、home 动作。
- Helper 需要 Android 11（API 30）或更高版本。`prepare-env` 可以安装或升级内置 APK，但验证结束后不会保留临时 accessibility service、adb forward 或认证 token；APK 会保留以缩短后续批次启动时间。
- batch acquire 只撤销本批次创建的 forward 和 service 变更，release 会清除本批次 token，并恢复进入批次前的 accessibility services，不覆盖设备上原有的其他辅助功能服务。
- Android 中文输入的具体后端属于 Runtime/Adapter 内部实现，不向主 Agent 或 Case Agent 暴露，也不要求 Agent 安装、启用或切换输入组件。
- `auto` 会同时准备 Helper 和 MAVT Input IME，确保 Helper 只读失败后仍可完整降级；`uiautomator` 只准备 IME；严格 `helper` 不要求 IME。
- Coordinator 在创建 ExecutionRequest 前自动准备并校验所选策略的依赖；必要依赖准备失败时流程停在环境阶段，不能进入用例执行。
- `scripts/prepare-env.sh --platform android [--device <serial>] [--android-ui-backend <policy>]` 只供人工安装和环境诊断使用；如果构建失败，检查 SDK Platform、Build Tools、JDK 或 `ANDROID_HOME`。

## HarmonyOS

需要安装：

- DevEco Studio 或 HarmonyOS Command Line Tools。
- `devecocli`，用于枚举设备并记录静态设备形态诊断信息。
- 可被 `devecocli` 识别的 DevEco/HarmonyOS 工具链。

设备准备：

- 连接真机或启动模拟器。
- `devecocli device list` 能看到目标设备。
- 设备支持 `uitest`、`screenCap`、`dumpLayout`、`aa dump` 和 `DisplayManagerService` 状态读取。

验证：

```bash
devecocli device list
devecocli device view -t <device-name-or-serial>
scripts/probe-env.sh --platform harmony
```

说明：

- HarmonyOS 当前没有额外自动安装依赖。
- 如果 `dumpLayout -m true` 或 `-b` 不可用，adapter 会自动回退到默认 `dumpLayout`。

## iOS 模拟器

需要安装：

- Xcode。
- Appium。
- Appium XCUITest Driver。

安装 Appium driver：

```bash
npm install -g appium
appium driver install xcuitest
```

设备准备：

- 启动一个 iOS Simulator。
- 目标 App 已安装到模拟器。
- Appium server 可启动，默认地址为 `http://127.0.0.1:4723`。

验证：

```bash
xcodebuild -version
xcrun simctl list devices booted
appium -v
appium driver list --installed
scripts/probe-env.sh --platform ios
```

## iOS 真机

设备发现使用 `xcdevice`；应用查询优先使用 `devicectl`，不可用时自动通过已安装 XCUITest 驱动的 `appium-ios-device` 使用 Installation Proxy，兼容旧系统的应用发现、安装状态和版本读取，不需要另装 tidevice 等工具。查询失败返回未知状态，不能据此认定设备不存在或应用未安装。该通道只读取元数据，不启动 Appium/WDA session。

`devicectl` 要求 iOS/iPadOS 17+，不是 MAVT 的统一最低系统版本；真实执行的系统范围由本机 Xcode、Appium XCUITest Driver 和 WDA 共同决定。Developer Mode 仅适用于 iOS/iPadOS 16 及以上。若兼容通道提示驱动路径或模块缺失，请修复 XCUITest 驱动安装后重试，勿仅因旧系统而升级设备。

需要安装：

- Xcode。
- Appium。
- Appium XCUITest Driver。
- 有效 Apple Developer 账号或团队签名能力。

需要准备的信息：

- 设备 UDID：`--device <udid>`。
- App bundle id：`--app <bundleId>`。
- Team ID：`--xcode-org-id <teamId>`。
- Signing ID：通常是 `Apple Development`。
- WDA bundle id：`--updated-wda-bundle-id <bundleId>`。

正常插件流程会自动核验证书私钥和 provisioning profile，将团队与开发证书类别分别传给 Xcode；完整证书名称或指纹只用于匹配，不直接作为自动签名的 `CODE_SIGN_IDENTITY`。真实设备系统版本随探测结果冻结，不要求用户填写。

本机 Appium 的真机 WDA 先单独执行 `build-for-testing`，成功后才创建 Appium session 并使用 `usePrebuiltWDA` 启动；构建失败不会继续运行旧产物。增量产物位于临时目录 `mavt-ios-wda-builds/<配置哈希>/`，哈希包含 Xcode、驱动/WDA、设备系统和签名信息；指定 `derivedDataPath` 时，在该目录下使用同样的哈希子目录。相同配置复用增量缓存，各 Case 共用批次 session；仅在创建或恢复 session 时验证构建，不按 Case 重复执行。

构建日志保存到 `runs/<batchId>/diagnostics/ios/`，启动失败同时保留本次 Appium 日志片段和结构化错误，Run 诊断提供具体文件路径。外部 WDA 或远程 Appium 仍由其服务端管理构建，不向远端传入本机缓存路径；独立维护命令缺少 Run 上下文时，诊断写入系统临时目录。以上不保证任意 Xcode/WDA 与旧系统组合均兼容，实际兼容性由真机验证。

设备准备：

- 真机已连接并信任当前 Mac。
- 真机已解锁。
- 目标 App 已安装。
- 如首次运行 WDA，需要在真机上信任开发者证书。

预热诊断：

```bash
scripts/platform/adapters/ios/prepare-real-device.sh \
  --device <udid> \
  --app <bundleId> \
  --xcode-org-id <teamId> \
  --xcode-signing-id "Apple Development" \
  --updated-wda-bundle-id <wdaBundleId>
```

说明：

- `prepare-real-device.sh` 只用于人工预热和诊断，不是正式 case 执行入口。
- 正式执行时，把真机参数写入环境确认 binding；同一批次不得隐式切换设备或签名参数。

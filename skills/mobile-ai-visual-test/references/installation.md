# 安装教程

> 本文档面向人工环境准备。正式执行以 `workspace -> import-case -> probe/prepare -> 环境确认 -> 显式执行请求 -> batch -> isolated case Agent -> batch commit` 为唯一主链。

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
scripts/probe-env.sh --platform android
```

说明：

- Android 中文输入依赖 MAVT Input IME。
- `scripts/prepare-env.sh --platform android [--device <serial>]` 会自动构建、安装、启用 MAVT Input IME。
- 如果 IME 构建失败，通常是 SDK Platform、Build Tools、JDK 或 `ANDROID_HOME` 缺失。

## HarmonyOS

需要安装：

- DevEco Studio 或 HarmonyOS Command Line Tools。
- `devecocli`，用于枚举设备并记录静态设备形态诊断信息。
- 可被 `devecocli` 识别的 DevEco/HarmonyOS 工具链。

设备准备：

- 连接真机或启动模拟器。
- `devecocli device list` 能看到目标设备。
- 设备支持 `uitest`、`screenCap`、`dumpLayout`、`aa dump`、`hilog` 和 `DisplayManagerService` 状态读取。

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
- iOS 真机日志当前不作为可用能力；截图、控件树、前台 App 和动作能力由 Appium/WDA 提供。

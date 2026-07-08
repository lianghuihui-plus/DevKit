# 环境探测

执行用例前先探测环境并让用户确认。确认后进入无人值守执行。

探测结果遵守 `EnvironmentProbe`；执行观察遵守 `Observation`。

## 平台参数

所有平台相关脚本都支持 `--platform <platform>`：

```bash
scripts/probe-env.sh --platform harmony
scripts/observe.sh --case-dir <case-dir> --execution-id <id> --platform harmony ...
scripts/action.sh --case-dir <case-dir> --execution-id <id> --platform harmony ...
```

平台只使用 `harmony`、`android`、`ios` 三类，不细分 debug/release。正式执行时必须显式传 `--platform <platform>`；顶层执行入口会拒绝缺少平台参数的 case-bound observe/action/run-case。旧工作空间无平台根运行态仅用于兼容历史产物，需要显式 `--legacy-runtime`。

## 探测内容

需要收集：

- 平台：`harmony`、`android` 或 `ios`
- 可用设备
- 屏幕尺寸
- 截图能力
- 控件树或可访问性树能力
- 应用标识候选（adapter 能力支持时 best-effort 收集）
- 启动入口候选（adapter 能力支持时 best-effort 收集）

`scripts/probe-env.sh` 只探测平台/设备能力，必须显式传 `--platform <harmony|android|ios>`，可选 `--device`，不默认选择平台，不接收 `--app`、`--entry`、`--bundle` 或 `--ability`。目标 App 和启动入口由用户确认、已有工作空间级 `platforms/<platform>.json` 或 case 平台 `state.json` 提供，再通过 `scripts/update-env.js` 固化；目标 App 当前是否在前台属于观察证据，由 `scripts/observe.sh` 采集。

平台前置依赖采用通用准备入口：

```bash
scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>
```

`probe-env` 只报告依赖状态，不安装、不启用、不修复；`prepare-env` 在创建 execution 前执行安装、启用或本地工具准备，把结果写入 `caseDir/platforms/<platform>/state.json` 的 `dependencies`，并刷新当前平台 `CONTEXT` 与工作空间总览。`scripts/run-case.js --start` 会检查当前平台必需依赖，未准备时拒绝创建 execution。

## HarmonyOS

agent 只调用 `scripts/probe-env.sh --platform harmony`。以下命令是 Harmony adapter 内部实现和排障参考，其中截图、布局、前台和日志能力通过 atoms 复用：

```bash
hdc list targets
hdc -t <device> shell uitest --version
hdc -t <device> shell uitest screenCap -p /data/local/tmp/probe.png
hdc -t <device> shell uitest dumpLayout -p /data/local/tmp/probe.json -m true
hdc -t <device> shell uitest dumpLayout -p /data/local/tmp/probe.json
hdc -t <device> shell aa dump -l
hdc -t <device> shell hidumper -s WindowManagerService -a "-a"
hdc -t <device> shell hilog --help
```

观察时 best-effort 采集 `aa dump`、窗口信息、目标进程和 hilog，写入 `platforms/<platform>/executions/<executionId>/logs/`。
`dumpLayout -m true` 在部分 uitestkit 版本中不支持；探测和观察必须在拉回 layout 文件失败或文件为空时回退到不带 `-m` 的默认命令。
`dumpLayout -b <bundle>` 在部分 uitestkit 版本中也不支持；观察时若带 bundle 的命令未产出可用 layout，必须继续回退到不带 `-b` 的默认命令。

## Android

agent 只调用 `scripts/probe-env.sh --platform android`。以下命令是 Android adapter 内部实现和排障参考，其中截图、布局、前台和日志能力通过 atoms 复用：

```bash
adb devices
adb -s <device> exec-out screencap -p
adb -s <device> shell uiautomator dump /sdcard/mavt-probe.xml
adb -s <device> shell dumpsys window
adb -s <device> shell dumpsys activity activities
adb -s <device> shell wm size
adb -s <device> logcat -d -t 200
```

观察时 best-effort 采集 `dumpsys window`、`dumpsys activity`、目标进程和 logcat，写入 `platforms/<platform>/executions/<executionId>/logs/`。

平台探测和观察 adapter 应通过 atoms 组合确定性能力：`screenshot`、`dump-tree`、`foreground` 和 `logs` 是可独立验证的最小能力；`probe.sh` 只负责能力可用性探测，`observe.sh` 只负责在同一 label 下协调这些 atoms 并汇总为 `Observation`。

Android Unicode 输入依赖 MAVT Input IME。`probe-env` 只在 `capabilities.dependencies` 中报告 `mavtInputIme` 是否已安装并启用；`prepare-env` 负责构建/安装/启用该 IME；正式执行中的 `inputText` 只临时切换到已准备好的 IME 发送文本并恢复原输入法，禁止在业务步骤中安装或启用输入依赖。

## iOS

iOS 通过 Appium / WDA 适配。`probe-env` 检查 Xcode、simctl、Appium、XCUITest Driver 等基础能力；`prepare-env` 准备 Appium/WDA 会话并写入 `iosAutomation` 依赖状态。依赖未准备或能力不可用时，正式 execution 不应开始，已进入 execution 的平台能力问题按 `PLATFORM_UNIMPLEMENTED` 或 `TOOL_ERROR` 收尾为 `BLOCKED`。

## 确认规则

- 一个执行请求只做一次环境确认，即使包含多个用例。
- 多个候选存在时，在执行前让用户指定。
- 关键能力不可用时，不开始执行。
- 用户确认后，用 `scripts/update-env.js <case-dir> --platform <platform> --device <device> --app <appId> --entry <entry>` 写入每个用例的 `platforms/<platform>/state.json`，并同步工作空间级 `platforms/<platform>.json`。
- 创建 execution 前，用 `scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>` 准备平台前置依赖；依赖准备失败时不进入无人值守执行。

## 与前置条件的边界

- 环境探测只负责平台/设备级事实，例如设备、连接器、截图、控件树、日志和平台动作能力。
- 目标 App、启动入口和目标 App 前台状态不由 `probe-env` 固化或确认；目标信息由 `update-env.js` 固化，当前前台状态由 `observe.sh` 作为观察证据采集。
- 业务级前置条件不通过环境探测自动确认，例如登录态、账号数据、订单状态、权限首次弹窗或特定业务资源。
- 业务级前置条件需要 agent 结合页面证据和用户上下文判断；无法可靠验证时，按 `PRECONDITION_UNKNOWN` 或 `PRECONDITION_UNSUPPORTED` 处理。

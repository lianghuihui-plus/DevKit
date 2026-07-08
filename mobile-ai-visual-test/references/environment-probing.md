# 环境探测

> 负责：平台探测、环境确认、目标信息固化、平台依赖准备。
> 不负责：业务前置条件、步骤证据、动作坐标。
> 参见：`workflow.md`、`interfaces.md`、`action-schema.md`。

## 原则

- 支持平台：`harmony`、`android`、`ios`。
- 正式执行必须显式传 `--platform <platform>`。
- 先探测、再用户确认、再固化、再准备依赖。
- 用户确认后进入无人值守执行，执行中不再补问用户或现场安装依赖。

## 入口

```bash
scripts/probe-env.sh --platform <platform> [--device <device>]
scripts/update-env.js <case-dir> --platform <platform> --device <device> --app <appId> --entry <entry>
scripts/prepare-env.sh --case-dir <case-dir> --platform <platform>
```

`probe-env` 只探测平台和设备能力，不接收目标 App 或入口参数。`update-env.js` 固化目标信息。`prepare-env.sh` 准备平台依赖并写入 `caseDir/platforms/<platform>/state.json.dependencies`。

批量执行时，一次用户确认可以复用，但 `update-env.js` 和 `prepare-env.sh` 必须对每个待执行 case 分别调用，因为 `run-case.js --start` 读取的是当前 case 自己的 `platforms/<platform>/state.json`。

面向人工的安装教程见 `installation.md`。执行流程中只输出简短诊断和修复提示，不展开完整安装教程。

## 探测内容

- 可用设备和屏幕尺寸。
- 截图、控件树、前台识别、日志能力。
- App 标识和启动入口候选，adapter 支持时 best-effort 收集。
- 平台依赖状态。

目标 App 当前是否在前台属于 observation，不属于 `probe-env` 固化内容。

`probe-env` 必须输出机器可读诊断：

```json
{
  "ready": false,
  "diagnostics": [
    {
      "id": "adbMissing",
      "level": "ERROR",
      "message": "未找到 adb",
      "howToFix": "安装 Android SDK Platform Tools，并把 platform-tools 加入 PATH；详见 references/installation.md#android",
      "check": "command -v adb"
    }
  ]
}
```

诊断级别：

| level | 含义 | 执行处理 |
| --- | --- | --- |
| `ERROR` | 缺少关键能力 | 不进入环境确认 |
| `WARN` | 非核心能力缺失或降级 | 提示用户，可继续 |
| `INFO` | 下一步提示 | 不阻塞 |

`ready` 只表示 `diagnostics` 中没有 `ERROR`。真正开始执行仍以 `prepare-env.sh` 和 `run-case.js --start` 的守卫为准。

## 平台说明

| 平台 | 探测/准备要点 |
| --- | --- |
| HarmonyOS | adapter 内部使用 `hdc`、`uitest screenCap`、`dumpLayout`、`aa dump`、`hilog`；`dumpLayout -m true` 或 `-b` 不可用时必须回退默认命令 |
| Android | adapter 内部使用 `adb`、`screencap`、`uiautomator dump`、`dumpsys window/activity`、`logcat`；Unicode 输入依赖 MAVT Input IME |
| iOS | 通过 Appium/WDA；检查 Xcode、simctl、Appium、XCUITest Driver；`prepare-env` 准备 `iosAutomation`；模拟器日志可用，真机日志暂不作为可用能力 |

iOS 真机配置通过 `update-env.js` 固化到 case state，支持 `--device-type realDevice`、`--xcode-org-id`、`--xcode-signing-id`、`--updated-wda-bundle-id`、`--allow-provisioning-device-registration`、`--wda-launch-timeout` 等 WDA 参数；`scripts/platform/adapters/ios/prepare-real-device.sh` 仅作为人工预热/诊断入口，不写死业务变量。

Android MAVT Input IME：

- `probe-env` 只报告状态。
- `prepare-env` 构建、安装、启用。
- 正式 `inputText` 只使用已准备好的 IME，禁止业务步骤中安装或启用。

## 确认规则

- 一个执行请求只做一次环境确认。
- 多个候选存在时，执行前让用户指定。
- 关键能力不可用时，不开始执行。
- 用户确认后同步写入每个目标 case 的平台 state 和工作空间级 `platforms/<platform>.json`。
- `run-case.js --start` 会拒绝未准备的必需依赖。

## 与业务前置条件的边界

环境探测只负责设备、连接器、截图、控件树、日志、动作能力和平台依赖。

不自动确认：

- 登录态、账号、角色、权限、灰度。
- 订单、资源、服务端数据。
- 权限首次弹窗或特定业务状态。

这些由执行前预检和 execution 内 `precondition` 事实处理。

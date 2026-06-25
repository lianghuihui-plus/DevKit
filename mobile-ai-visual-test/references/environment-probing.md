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

默认平台是 `harmony`。

## 探测内容

需要收集：

- 平台：`harmony`、`android` 或 `ios`
- 可用设备
- 屏幕尺寸
- 截图能力
- 控件树或可访问性树能力
- 应用标识候选
- 启动入口候选

## HarmonyOS

```bash
hdc list targets
hdc -t <device> shell uitest --version
hdc -t <device> shell uitest screenCap -p /data/local/tmp/probe.png
hdc -t <device> shell uitest dumpLayout -p /data/local/tmp/probe.json -m true
hdc -t <device> shell aa dump -l
hdc -t <device> shell hidumper -s WindowManagerService -a "-a"
hdc -t <device> shell hilog --help
```

观察时 best-effort 采集 `aa dump`、窗口信息、目标进程和 hilog，写入 `executions/<executionId>/logs/`。

## 未实现平台

Android、iOS 当前仅预留接口。

## 确认规则

- 一个执行请求只做一次环境确认，即使包含多个用例。
- 多个候选存在时，在执行前让用户指定。
- 关键能力不可用时，不开始执行。
- 用户确认后，用 `scripts/update-env.js <case-dir> --platform <platform> --device <device> --app <appId> --entry <entry>` 写入每个用例的 `state.json`。

## 与前置条件的边界

- 环境探测只负责平台级事实，例如设备、连接器、截图、控件树、日志、启动入口和目标 App 前台状态。
- 业务级前置条件不通过环境探测自动确认，例如登录态、账号数据、订单状态、权限首次弹窗或特定业务资源。
- 业务级前置条件需要 agent 结合页面证据和用户上下文判断；无法可靠验证时，按 `PRECONDITION_UNKNOWN` 或 `PRECONDITION_UNSUPPORTED` 处理。

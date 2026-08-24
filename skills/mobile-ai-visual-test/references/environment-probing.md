# 环境探测与绑定

正式执行必须显式指定 `harmony`、`android` 或 `ios`。先运行：

```bash
scripts/probe-env.sh --platform <platform>
```

探测只报告设备和平台能力，不猜测目标 App。必要依赖准备完成后应重新探测，再把 probe 结果、目标 binding 和用户确认原文交给 `scripts/environment.js confirm`。确认产物固定平台、deviceId、appId、入口及平台必要参数。

环境确认是准备状态，不是执行授权。确认后协调器必须停下并等待用户另行给出“单独执行某用例”或“按指定顺序批量执行这些用例”的明确指令；不得创建 batch、bootstrap App 或根据已导入用例自行决定范围。

执行请求绑定环境确认摘要。设备、App、平台或入口发生变化时重新确认环境，已有但尚未初始化的执行请求自动失效，必须基于新确认创建新的 batchId 和请求。

在 batch bootstrap 前运行 `scripts/prepare-env.sh` 完成平台必要依赖。无人值守执行开始后不安装依赖、不修改 adapter、不切换设备。

HarmonyOS 手机 bootstrap/recovery 按既有平台能力验证启动和显示方向；Android、iOS 按各自 adapter 契约验证。观察只有在 adapter 明确确认目标设备、目标 App 且截图有效时才可作为可用证据，前台状态未知不能按可用处理。

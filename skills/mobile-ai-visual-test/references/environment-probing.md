# 环境探测与绑定

正式执行必须显式指定 `harmony`、`android` 或 `ios`。先运行：

```bash
scripts/probe-env.sh --platform <platform>
```

探测只报告设备和平台能力，不猜测目标 App。必要依赖准备完成后应重新探测，再把 probe 结果、目标 binding 和用户确认原文交给 `scripts/environment.js confirm`。确认产物固定平台、`deviceId`、`appId`、入口及平台必要参数。Android probe 为兼容旧调用可同时返回同值的 `device`，但环境确认会在写入前将设备身份规范化，后续正式产物只保留 `deviceId`；两个字段值冲突时不得确认。

环境确认是准备状态，不是执行授权。确认后协调器必须停下并等待用户另行给出“单独执行某用例”或“按指定顺序批量执行这些用例”的明确指令；不得创建 batch、bootstrap App 或根据已导入用例自行决定范围。

执行请求绑定环境确认摘要。设备、App、平台或入口发生变化时重新确认环境，已有但尚未初始化的执行请求自动失效，必须基于新确认创建新的 batchId 和请求。

在 batch bootstrap 前运行 `scripts/prepare-env.sh` 完成平台必要依赖。无人值守执行开始后不安装依赖、不修改 adapter、不切换设备。

iOS `prepare-env` 会复用可连接的外部 Appium，或启动并登记框架托管的本地 Appium。WDA 验证使用临时所有权记录；验证结束即释放本次准备阶段启动的 WDA，既有外部 WDA 保留。登记只用于后续批次认领和安全关闭，不构成执行授权；未进入批次时可再次运行环境准备复核。框架不得关闭无精确所有权记录的外部 Appium 或 WDA。

bootstrap/recovery 的冷启动验证分为两类事实：Adapter 必须明确返回 `ok=true` 和 `coldStartVerified=true`；启动显示则由公共层根据环境冻结的 `startupDisplayPolicy` 判断是否必需。Android、iOS 默认策略为 `preserve + none`，Adapter 可显式返回 `startupDisplay.status=SKIPPED` 便于审计，旧结果缺少该对象也不应阻断已验证的冷启动。HarmonyOS 命中 `required` 策略时必须返回匹配策略的 `startupDisplay.status=VERIFIED`，缺失或不匹配仍阻断 bootstrap/recovery。

观察只有在 adapter 明确确认目标 `deviceId`、目标 App 且截图有效时才可作为可用证据，前台状态未知不能按可用处理。

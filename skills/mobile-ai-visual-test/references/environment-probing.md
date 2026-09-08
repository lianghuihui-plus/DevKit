# 环境探测与绑定

正式执行必须显式指定 `harmony`、`android` 或 `ios`。先运行：

```bash
scripts/probe-env.sh --platform <platform>
```

探测只报告设备和平台能力，不猜测目标 App。必要依赖准备完成后应重新探测，再把 probe 结果、目标 binding 和用户确认原文交给 `scripts/environment.js confirm`。确认产物固定平台、`deviceId`、`appId`、入口及平台必要参数。当前框架领域对象只接受 `deviceId`；Adapter CLI 的 `--device` 仅是平台命令参数名。

环境确认是准备状态，不是执行授权。确认后协调器必须停下并等待用户另行给出“单独执行某用例”或“按指定顺序批量执行这些用例”的明确指令；不得创建 batch、bootstrap App 或根据已导入用例自行决定范围。

执行请求绑定环境确认摘要。设备、App、平台或入口发生变化时重新确认环境，已有但尚未初始化的执行请求自动失效，必须基于新确认创建新的 batchId 和请求。

在 batch bootstrap 前运行 `scripts/prepare-env.sh` 完成平台必要依赖。无人值守执行开始后不安装依赖、不修改 adapter、不切换设备。

iOS `prepare-env` 会复用可连接的外部 Appium，或启动并登记框架托管的本地 Appium。WDA 验证使用临时所有权记录；验证结束即释放本次准备阶段启动的 WDA，既有外部 WDA 保留。登记只用于后续批次认领和安全关闭，不构成执行授权；未进入批次时可再次运行环境准备复核。框架不得关闭无精确所有权记录的外部 Appium 或 WDA。

bootstrap/recovery 的冷启动验证分为独立事实：Adapter 必须明确返回 `command.status=ACCEPTED` 和 `coldStartVerified=true`；启动显示再由公共层按策略单独验证。Android、iOS 当前默认策略为 `preserve + none`，因此 `startupDisplay` 是可选审计事实，Adapter 可显式返回 `startupDisplay.status=SKIPPED`。HarmonyOS 每次重启在杀 App 前读取有效显示宽高，按长短边比例分类为 `PHONE_LIKE` 或 `TABLET_LIKE`：前者执行竖屏归一化并要求 `startupDisplay.status=VERIFIED`，后者保持当前方向；无法分类时在杀 App 前失败。静态 `deviceFormFactor` 只保留为诊断信息。

观察只有在 adapter 明确确认冻结 `deviceId`、目标 App 绑定且截图有效时才可作为可用证据；`foregroundApp/inTargetApp` 只描述当前前台上下文，系统设置、应用市场等外部页面的合法截图仍可作为当前观察和后续动作依据。

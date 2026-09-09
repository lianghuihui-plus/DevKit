# 环境探测与绑定

正式执行必须显式指定 `harmony`、`android` 或 `ios`。先运行：

```bash
scripts/probe-env.sh --platform <platform>
```

探测只报告设备和平台能力，不猜测目标 App。必要依赖准备完成后应重新探测，再把 probe 结果、目标 binding、App Provisioning 和用户确认原文交给 `scripts/environment.js confirm`。确认产物固定平台、`deviceId`、`appId`、入口、平台必要参数及安装资产模式。当前框架领域对象只接受 `deviceId`；Adapter CLI 的 `--device` 仅是平台命令参数名。

默认 App Provisioning 为 `PREINSTALLED`，只能使用设备现有 App。用例原文要求卸载并重新安装时，上层固定声明 `FRESH_INSTALL`：Android、HarmonyOS 以清除数据等效实现，继续使用 `PREINSTALLED` 且不得索要安装资产；iOS 必须实际重装，需在执行请求创建前用 `scripts/app-artifact.js register` 把用户或 CI 已提供的 `.app` 或 IPA 登记到工作空间内容寻址缓存，再用返回的 `ARTIFACT_MANAGED` manifest 确认环境。batch bootstrap 明确要求物理重装时也必须预先登记对应平台的 APK、HAP、`.app` 或 IPA。登记时 CLI identity 是期望断言；工具可用时同时保存实际提取值，不可用时明确标为 `UNAVAILABLE`。iOS 模拟器使用 `.app`，真机使用与目标设备签名匹配的 IPA 或 `.app`。安装资产不进入知识库，也不在 Case Brief 中暴露。

环境确认是准备状态，不是执行授权。确认后协调器必须停下并等待用户另行给出“单独执行某用例”或“按指定顺序批量执行这些用例”的明确指令；不得创建 batch、bootstrap App 或根据已导入用例自行决定范围。授权时主 Agent 还必须为每个 target 从用例业务语义声明 `initialStateRequirement`，不能让 Case Agent 临场选择。安装资产需求必须按已确认平台和 InitialStatePreflight 的实际策略判断，不能仅根据上层 `FRESH_INSTALL` 推断。

执行请求绑定环境确认摘要。设备、App、平台或入口发生变化时重新确认环境，已有但尚未初始化的执行请求自动失效，必须基于新确认创建新的 batchId 和请求。

在 batch bootstrap 前运行 `scripts/prepare-env.sh` 完成平台必要依赖。`ARTIFACT_MANAGED` 仅表示制品可用，默认 `bootstrapPolicy=KEEP_EXISTING` 不安装；只有独立配置 `REINSTALL_FROZEN` 及卸载/安装两个副作用时才在批次启动阶段重装。用例执行指令已经覆盖其前置状态准备，ExecutionRequest 根据 initial-state requirement 和平台自动派生 preparation policy，再与 App Provisioning 组合成冻结 Preflight，不追加一次用户确认。iOS 缺少实际重装所需制品时提前失败。安装后必须读取并匹配 `installedIdentity`；结果未知或身份不符时不重放并进入批次阻塞收口。无人值守执行开始后不下载安装资产、不安装依赖、不修改 adapter、不切换设备。

iOS `prepare-env` 会复用可连接的外部 Appium，或启动并登记框架托管的本地 Appium。WDA 验证使用临时所有权记录；验证结束即释放本次准备阶段启动的 WDA，既有外部 WDA 保留。登记只用于后续批次认领和安全关闭，不构成执行授权；未进入批次时可再次运行环境准备复核。框架不得关闭无精确所有权记录的外部 Appium 或 WDA。

bootstrap/recovery 的冷启动验证分为独立事实：Adapter 必须明确返回 `command.status=ACCEPTED` 和 `coldStartVerified=true`；启动显示再由公共层按策略单独验证。Android、iOS 当前默认策略为 `preserve + none`，因此 `startupDisplay` 是可选审计事实，Adapter 可显式返回 `startupDisplay.status=SKIPPED`。HarmonyOS 每次重启在杀 App 前读取有效显示宽高，按长短边比例分类为 `PHONE_LIKE` 或 `TABLET_LIKE`：前者执行竖屏归一化并要求 `startupDisplay.status=VERIFIED`，后者保持当前方向；无法分类时在杀 App 前失败。静态 `deviceFormFactor` 只保留为诊断信息。

观察只有在 adapter 明确确认冻结 `deviceId`、目标 App 绑定且截图有效时才可作为可用证据；`foregroundApp/inTargetApp` 只描述当前前台上下文，系统设置、应用市场等外部页面的合法截图仍可作为当前观察和后续动作依据。

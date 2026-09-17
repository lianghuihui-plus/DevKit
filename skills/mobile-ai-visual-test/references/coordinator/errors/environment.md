# Coordinator environment 错误

只在响应指向本页时读取对应错误章节。

<a id="error-environment-not-ready"></a>
## ENVIRONMENT_NOT_READY

平台、设备或 App 探测未就绪。

**可重试：** 是

**处理：** 按 facts 中缺失的设备、App 或工具事实完成环境处置，再执行当前 commands.advance 重新探测。

<a id="error-ios-signing-required"></a>
## IOS_SIGNING_REQUIRED

iOS 真机绑定缺少明确签名字段。

**可重试：** 是

**处理：** 补齐响应 requiredBindingFields 指定的签名字段，再使用 CONFIRM_BINDING 提交同一设备绑定。

<a id="error-input-capability-not-ready"></a>
## INPUT_CAPABILITY_NOT_READY

设备输入能力尚未准备完成。

**可重试：** 是

**处理：** 检查 facts 中的平台输入准备结果；恢复平台依赖后执行当前 commands.advance，Agent 不自行安装输入组件。

<a id="error-platform-unavailable"></a>
## PLATFORM_UNAVAILABLE

目标平台或设备当前不可用。

**可重试：** 是

**处理：** 根据 facts 核对设备连接、平台工具和资源所有权；恢复后创建新的 run 或执行当前允许的 advanceRun。

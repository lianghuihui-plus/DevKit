# Coordinator environment 错误

只在响应指向本页时读取对应错误章节。

<a id="error-environment-not-ready"></a>
## ENVIRONMENT_NOT_READY

设备环境尚未就绪。

**可重试：** 是

**处理：** 恢复环境后通过原 command 提交 advanceRun。

<a id="error-ios-signing-required"></a>
## IOS_SIGNING_REQUIRED

iOS 真机缺少签名字段。

**可重试：** 是

**处理：** 补齐 requiredBindingFields 后提交 CONFIRM_BINDING。

<a id="error-input-capability-not-ready"></a>
## INPUT_CAPABILITY_NOT_READY

设备输入能力准备未完成。

**可重试：** 是

**处理：** 恢复环境后通过原 command 提交 advanceRun。

<a id="error-platform-unavailable"></a>
## PLATFORM_UNAVAILABLE

平台或设备不可用。

**可重试：** 是

**处理：** 根据诊断核对连接和工具。

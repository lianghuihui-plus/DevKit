---
name: reporting
description: Use when the user asks to configure MAVT Dashboard reporting, check its connection, submit or retry an upload, inspect upload status, or reset a reporting identity.
---

# MAVT 数据上报

通过 MCP 的 `mavt_reporting_*` 工具管理上报。工具返回的是本地安全状态；`QUEUED`、`UPLOADING`、`PARTIAL` 或 HTTP 请求送达都不代表 `COMMITTED`。测试结论和本地报告由 Coordinator 决定，上报失败不改变它们。

配置时先调用无需工作区 context 的 `mavt_reporting_settings_read({})`。仅把用户明确要求更改的 `serverUrl`、`autoUpload`、`acknowledgeNotice` 字段交给 `mavt_reporting_settings_update`；不要为了暂缓手动上传而改动自动上报开关。需要 Token 时调用 `mavt_reporting_credentials_prepare({serverUrl?})` 获取对应目标的私有文件路径，让用户在本机打开并填写 Dashboard 生成的个人 Token。Agent 不读取、展示或代填文件正文，也不把 Token 放进工具输入、命令或聊天。保存后，按用户请求调用 `mavt_reporting_check({})` 显式检查连接。

工作区操作先用 `mavt_workspace_open({workspace,role:"reporting"})` 取得固定 `contextRef`。手动补报调用 `mavt_reporting_submit({contextRef,scope:"workspace"})`；查询用 `mavt_reporting_status({contextRef,jobId?})`；重试指定任务用 `mavt_reporting_retry({contextRef,jobId})`。只有用户明确接受用当前目标的新凭据继续旧任务时，才附带 `acceptCredentialChange:true`。`mavt_reporting_identity_reset({contextRef})` 是独立的身份重置操作，仅在用户明确要求时调用。

读取 `state`、`failureCode`、`nextAction` 和每个 session 的状态后汇报实际进度。`WAITING_PUBLICATION` 表示本地报告尚未满足发布门槛；`RENDER_INDEX` 只适用于 `RETRY_REQUIRED`，须使用已验证的原固定 runtime 执行维护命令，随后重新检查发布状态。`DEGRADED` 不会由普通 retry 或 render-index 自动修复。缺少 Token 时测试仍继续，自动上报可呈现 `SKIPPED_UNCONFIGURED`；无需额外强制确认问题。

工作区操作需要详细说明时，只读 `mavt_workspace_open` 返回的固定 `<documentationRoot>/references/reporting.md`，不改用其他安装版本或开发源码。

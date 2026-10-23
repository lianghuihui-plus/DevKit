# 数据上报

上报是本地测试完成后的独立任务。测试结果以固定 Run 的 `runSummary` 为准；上报状态以 `mavt_reporting_status` 为准。任务入队或上传进行中不代表 Dashboard 已提交成功。

全局工具无需工作区 context：`mavt_reporting_settings_read({})`、`mavt_reporting_settings_update({serverUrl?,autoUpload?,acknowledgeNotice?})`、`mavt_reporting_credentials_prepare({serverUrl?})`、`mavt_reporting_check({})`。配置工具只接受非秘密字段。Token 只由用户在返回的私有本地文件中填写，工具不接收或返回 Token。

工作区工具先使用 `mavt_workspace_open({workspace,role:"reporting"})`，然后原样传入 `contextRef`：`mavt_reporting_submit({contextRef,scope:"workspace"})`、`mavt_reporting_status({contextRef,jobId?})`、`mavt_reporting_retry({contextRef,jobId,acceptCredentialChange?:true})`、`mavt_reporting_identity_reset({contextRef})`。手动 submit 使用当前工作区定义及各平台最新已开始的终态执行；自动提交由固定 Run 内部处理。

`RETRY_REQUIRED` 的发布维护命令为 `node <verified-runtime-root>/scripts/render-index.js <workspace-root>`；路径必须取自已验证的原固定 bundle，完成后仍须重新查询发布状态。`DEGRADED` 不在该维护命令的恢复范围内，保留原始报告错误并处理来源或环境问题。只读查询不触发修复或上报。

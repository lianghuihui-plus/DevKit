# 数据上报

上报是本地测试完成后的独立任务。测试结果以固定 Run 的 `runSummary` 为准；上报状态以 `mavt_reporting_status` 为准。任务入队或上传进行中不代表 Dashboard 已提交成功。

全局工具无需工作区 context：`mavt_reporting_settings_read({})`、`mavt_reporting_settings_update({serverUrl?,autoUpload?,acknowledgeNotice?})`、`mavt_reporting_credentials_prepare({serverUrl?})`、`mavt_reporting_check({})`。配置工具只接受非秘密字段。Token 只由用户在返回的私有本地文件中填写，工具不接收或返回 Token。

工作区工具先使用 `mavt_workspace_open({workspace,role:"reporting"})`，然后原样传入 `contextRef`：`mavt_reporting_submit({contextRef,scope:"workspace"})`、`mavt_reporting_status({contextRef,jobId?})`、`mavt_reporting_retry({contextRef,jobId,acceptCredentialChange?:true})`、`mavt_reporting_identity_reset({contextRef})`。手动 submit 使用当前工作区定义及各平台最新已开始的终态执行；自动提交由固定 Run 内部处理。

`RETRY_REQUIRED` 的发布维护命令为 `node <verified-runtime-root>/scripts/render-index.js <workspace-root>`；路径必须取自已验证的原固定 bundle，完成后仍须重新查询发布状态。`DEGRADED` 不在该维护命令的恢复范围内，保留原始报告错误并处理来源或环境问题。只读查询不触发修复或上报。

现代 Run 的手动补报也必须确认发布记录为 `PUBLISHED`，缺失记录不能当作已发布；历史独立执行仅在没有 Run 元数据时兼容。会话返回 410 时保留原始 Manifest 和修订，持久化 key 轮换关系；成功回执与最终 key 一起参与清理授权。

采集开始前写入私有 stage 的身份、时间、进程和任务归属，失败时尽量立即释放临时数据；中断或清理失败的快照由显式上报写操作在七天后分批回收。活跃进程、归属不明、未来版本和仍被任务引用的包受保护；状态查询和 Coordinator 自动入队不回收附件。

`REPORTING_LOCK_RECOVERY_REQUIRED` 表示元数据锁的回收进程也已崩溃，需要离线维护。先停止使用同一配置目录或工作区的所有 MAVT MCP/worker 进程，确认没有写入者后备份锁 owner 记录，再移除对应 `.config.lock.reap` 或 `.metadata.lock.reap` 并显式重试；普通死亡 owner 的锁仍会自动回收。不能仅凭文件年龄删除锁，也不要清空凭据、身份或修订记录；上报维护失败不改变本地测试结论。

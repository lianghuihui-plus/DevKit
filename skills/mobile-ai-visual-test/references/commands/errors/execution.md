# execution 命令错误

<a id="request-invalid"></a>
## REQUEST_INVALID

命令、参数、枚举或 JSON 输入不符合当前命令契约。按 `issues` 修正，并使用响应中的 `usage` 和 `example` 重试一次。

<a id="domain"></a>
## 领域错误

输入格式正确，但当前业务对象、状态或资源不允许该操作。保留响应中的稳定 `code`，按 `message` 修复对应领域事实；不要把它当作参数错误反复改字段。

<a id="technical"></a>
## TECHNICAL

命令已通过输入校验，但执行时发生技术异常。保留 `stage`、`logRefs` 和安全资源事实，完成技术处置后回到当前正式入口。

<a id="error-batch-implementation-mismatch"></a>
## BATCH_IMPLEMENTATION_MISMATCH

批次冻结的实现与当前 Skill 实现不同，不能继续业务执行。

**可重试：** 否

**处理：** 不要修改批次文件或反复重试 reconcile；可以继续 status、cancel 和 teardown，若要继续业务执行则创建新批次。

<a id="error-batch-protocol-mismatch"></a>
## BATCH_PROTOCOL_MISMATCH

批次冻结的 Agent 协议与当前协议不同。

**可重试：** 否

**处理：** 保留旧批次事实并通过 cancel、teardown 完成收尾；使用当前协议创建新批次执行。

<a id="error-batch-binding-mismatch"></a>
## BATCH_BINDING_MISMATCH

批次状态与其冻结契约、目标或环境绑定不一致。

**可重试：** 否

**处理：** 停止业务推进，不要直接编辑 JSON；保留批次文件进行诊断，只在所有权可证明时执行取消和资源清理。

<a id="error-report-publication-incomplete"></a>
## REPORT_PUBLICATION_INCOMPLETE

批次目标中至少一个用例报告尚未成功生成。

**可重试：** 是

**处理：** 读取响应中的失败用例和报告错误，修复缺失或被占用的产物后重新执行 reconcile；在全部目标成功前不要把批次视为已发布。

<a id="error-ios-appium-service-in-use"></a>
## IOS_APPIUM_SERVICE_IN_USE

iOS Appium 服务由另一个活动批次持有。

**可重试：** 是

**处理：** 根据 diagnostic.resourceFacts 定位 owner batch，等待其终态或明确取消该批次；不要手工终止无法确认所有权的共享服务。

<a id="error-platform-runtime-release-failed"></a>
## PLATFORM_RUNTIME_RELEASE_FAILED

框架持有的平台运行资源未能完成释放。

**可重试：** 是

**处理：** 保留 ownerKey、stage 和 logRefs，修复底层服务问题后重试 teardown；不得用新批次覆盖原所有权。

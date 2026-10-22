# reporting 命令错误

<a id="request-invalid"></a>
## REQUEST_INVALID

命令、参数、枚举或 JSON 输入不符合当前命令契约。按 `issues` 修正，并使用响应中的 `usage` 和 `example` 重试一次。

<a id="domain"></a>
## 领域错误

输入格式正确，但当前业务对象、状态或资源不允许该操作。保留响应中的稳定 `code`，按 `message` 修复对应领域事实；不要把它当作参数错误反复改字段。

<a id="technical"></a>
## TECHNICAL

命令已通过输入校验，但执行时发生技术异常。保留 `stage`、`logRefs` 和安全资源事实，完成技术处置后回到当前正式入口。

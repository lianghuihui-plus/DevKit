# Case Runtime transport 错误

只在响应指向本页时读取对应错误章节。

<a id="error-case-runtime-finalized"></a>
## CASE_RUNTIME_FINALIZED

Execution 已完成，只能读取已保存资源。

**可重试：** 否

**处理：** 使用 read 读取已有资源。

<a id="error-resource-unknown"></a>
## RESOURCE_UNKNOWN

资源引用尚未发布。

**可重试：** 是

**处理：** 原样复制当前绑定发布的资源 ref。

<a id="error-resource-scope-mismatch"></a>
## RESOURCE_SCOPE_MISMATCH

资源引用属于其他作用域。

**可重试：** 否

**处理：** 使用发布该引用的已绑定 command。

<a id="error-agent-input-invalid"></a>
## AGENT_INPUT_INVALID

请求结构、类型或条件字段不合法。

**可重试：** 是

**处理：** 根据 issues 修正当前方法请求一次；字段只取自当前方法页和 Runtime 响应。

<a id="error-agent-input-stalled"></a>
## AGENT_INPUT_STALLED

同类输入错误连续发生，停止自动猜测。

**可重试：** 否

**处理：** 停止修改参数，读取当前方法页并核对绑定命令；仍不一致时保留请求和响应进行技术排障。

<a id="error-protocol-mismatch"></a>
## PROTOCOL_MISMATCH

Prompt、文档、客户端或 execution 协议不一致。

**可重试：** 否

**处理：** 停止执行该 execution，保留 Loader 输出和摘要；使用当前 Skill 新建 execution，不修改旧 execution。

<a id="error-binding-invalid"></a>
## BINDING_INVALID

Execution 或 dispatch 绑定无效。

**可重试：** 否

**处理：** 按 technicalFact 资源核对绑定：sequence 不匹配时原样复用当前 Loader/Brief 中的 command；只有 HANDOFF_REPLACED 才表示该 dispatch 已被真实 continuation 取代；HANDOFF_NOT_CLAIMED 表示 Loader 尚未成功 claim。

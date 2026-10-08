# Case Runtime sequence 错误

只在响应指向本页时读取对应错误章节。

<a id="error-sequence-invalid"></a>
## SEQUENCE_INVALID

动作序列请求无效。

**可重试：** 是

**处理：** 检查步骤和当前 Scene 后重新提交。

<a id="error-sequence-record-incomplete"></a>
## SEQUENCE_RECORD_INCOMPLETE

动作序列记录不完整。

**可重试：** 否

**处理：** 保留 execution 进行技术排障，避免重放动作。

<a id="error-sequence-action-outcome-unknown"></a>
## SEQUENCE_ACTION_OUTCOME_UNKNOWN

动作可能已投递，结果未知。

**可重试：** 否

**处理：** 禁止重放；先检查返回的 Scene 与证据。

<a id="error-sequence-timeout"></a>
## SEQUENCE_TIMEOUT

动作序列超时。

**可重试：** 是

**处理：** 读取已完成步骤和最终 Scene，再决定下一步。

<a id="error-sequence-step-failed"></a>
## SEQUENCE_STEP_FAILED

动作序列步骤失败。

**可重试：** 是

**处理：** 读取失败步骤和最终 Scene，再决定下一步。

<a id="error-sequence-action-failed"></a>
## SEQUENCE_ACTION_FAILED

设备报告动作失败。

**可重试：** 是

**处理：** 读取最终 Scene 和动作证据后决定下一步。

<a id="error-sequence-capture-failed"></a>
## SEQUENCE_CAPTURE_FAILED

序列采集失败。

**可重试：** 是

**处理：** 读取可用证据后重新观察现场。

<a id="error-sequence-final-capture-failed"></a>
## SEQUENCE_FINAL_CAPTURE_FAILED

最终 Scene 采集失败。

**可重试：** 是

**处理：** 读取序列记录与技术事实，再观察当前现场。

<a id="error-sequence-interrupted"></a>
## SEQUENCE_INTERRUPTED

动作序列被中断。

**可重试：** 否

**处理：** 读取恢复后的现场与已完成步骤，不要盲目重放。

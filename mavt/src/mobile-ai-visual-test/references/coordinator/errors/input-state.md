# Coordinator input-state 错误

只在响应指向本页时读取对应错误章节。

<a id="error-agent-input-stalled"></a>
## AGENT_INPUT_STALLED

同类 Coordinator 输入错误连续发生。

**可重试：** 否

**处理：** 读取方法页和 issues 后修正请求。

<a id="error-coordinator-input-invalid"></a>
## COORDINATOR_INPUT_INVALID

Coordinator 请求字段不合法。

**可重试：** 是

**处理：** 根据 issues 与方法页修正当前请求。

<a id="error-coordinator-state-invalid"></a>
## COORDINATOR_STATE_INVALID

Coordinator 绑定状态无效。

**可重试：** 否

**处理：** 保留诊断，重新创建 run。

<a id="error-coordinator-terminal"></a>
## COORDINATOR_TERMINAL

Coordinator 已终止，不能再确认。

**可重试：** 否

**处理：** 使用 read 或 advanceRun 读取终态。

<a id="error-decision-not-allowed"></a>
## DECISION_NOT_ALLOWED

决策不适用于当前阶段。

**可重试：** 是

**处理：** 按当前 runDecision 选择确认分支。

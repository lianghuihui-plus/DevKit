# Coordinator input-state 错误

只在响应指向本页时读取对应错误章节。

<a id="error-agent-input-stalled"></a>
## AGENT_INPUT_STALLED

同类 Coordinator 输入错误连续发生，停止自动猜测。

**可重试：** 否

**处理：** 停止修改字段，读取当前方法页和响应 issues；保留 run 状态，需要时进行技术排障。

<a id="error-coordinator-input-invalid"></a>
## COORDINATOR_INPUT_INVALID

Coordinator 请求字段不合法。

**可重试：** 是

**处理：** 根据 issues 修正当前方法请求；只重试一次，不添加方法签名之外的字段。

<a id="error-coordinator-state-invalid"></a>
## COORDINATOR_STATE_INVALID

Coordinator run 状态缺失、损坏或绑定不一致。

**可重试：** 否

**处理：** 保留 run 文件和诊断事实，重新从 prepareRun 建立新 run；不要直接修改状态文件。

<a id="error-decision-not-allowed"></a>
## DECISION_NOT_ALLOWED

确认决策不适用于当前阶段。

**可重试：** 是

**处理：** 读取当前 reason、choices 和 required fields，选择该响应允许的 confirmRun 分支。

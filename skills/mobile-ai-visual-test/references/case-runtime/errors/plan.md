# Case Runtime plan 错误

只在响应指向本页时读取对应错误章节。

<a id="error-plan-invalid"></a>
## PLAN_INVALID

命令计划不满足步数、时限、引用或定位类型约束。

**可重试：** 是

**处理：** 按 issues 修正有限步骤和前向引用；不要添加循环、脚本或未注册定位类型。

<a id="error-plan-step-failed"></a>
## PLAN_STEP_FAILED

计划在指定步骤发生确定性技术失败。

**可重试：** 是

**处理：** 检查已完成前缀、失败步骤和证据；根据当前 Scene 重新形成新的 submissionId。

<a id="error-plan-submission-conflict"></a>
## PLAN_SUBMISSION_CONFLICT

同一 submissionId 对应了不同的规范化请求。

**可重试：** 否

**处理：** 原请求重试必须保持内容不变；业务上确需新计划时使用新的 submissionId。

<a id="error-plan-record-incomplete"></a>
## PLAN_RECORD_INCOMPLETE

计划快照缺失、未终结或摘要校验失败。

**可重试：** 否

**处理：** 停止重放可能已执行的动作，保留 execution 进行技术排障。

<a id="error-locator-unsupported"></a>
## LOCATOR_UNSUPPORTED

当前 Runtime 不支持所声明的定位类型。

**可重试：** 是

**处理：** 改用当前 Scene 可验证的 ELEMENT_REF、POINT 或 REGION；不能可靠定位时交回 Agent。

<a id="error-target-not-found"></a>
## TARGET_NOT_FOUND

声明的 Scene、控件或定位目标不存在。

**可重试：** 是

**处理：** 查看计划已采集的 Scene 证据，重新选择可验证引用；不要猜测目标坐标。

<a id="error-plan-check-failed"></a>
## PLAN_CHECK_FAILED

技术检查无法执行或谓词不受支持。

**可重试：** 是

**处理：** 只使用文档列出的确定性技术谓词；业务判断留给 Agent。

<a id="error-plan-action-outcome-unknown"></a>
## PLAN_ACTION_OUTCOME_UNKNOWN

计划动作可能已投递，结果未知。

**可重试：** 否

**处理：** 禁止重放计划或动作；先检查已有证据并 observe 当前现场。

<a id="error-plan-timeout"></a>
## PLAN_TIMEOUT

计划未能在声明的有限时限内完成。

**可重试：** 是

**处理：** 检查已完成前缀和各步耗时；缩短计划或在新 Scene 上使用新的 submissionId。

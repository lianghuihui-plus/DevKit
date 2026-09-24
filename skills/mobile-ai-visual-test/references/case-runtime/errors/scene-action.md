# Case Runtime scene-action 错误

只在响应指向本页时读取对应错误章节。

<a id="error-scene-required"></a>
## SCENE_REQUIRED

当前方法需要 Scene，但 execution 尚无 Scene。

**可重试：** 是

**处理：** 先调用 observe 采集当前 Scene，再使用返回的 sceneRef 调用原方法。

<a id="error-scene-changed"></a>
## SCENE_CHANGED

动作所依据的 Scene 已不是当前 Scene。

**可重试：** 是

**处理：** 调用 observe 获取新 Scene，重新 inspect 并从新 Scene 选择 ActionRef；不要复用旧动作。

<a id="error-action-not-available"></a>
## ACTION_NOT_AVAILABLE

ActionRef 对当前 Scene 不成立。

**可重试：** 是

**处理：** 读取当前 Scene 的 action 投影；必要时重新 observe，不手工拼接或猜测 ActionRef。

<a id="error-action-input-invalid"></a>
## ACTION_INPUT_INVALID

动作输入缺失、越界或包含不支持字段。

**可重试：** 是

**处理：** 按当前 ActionRef 返回的输入约束修正 input；视觉坐标使用 0 到 10000 的整数标尺值。

<a id="error-action-effect-mismatch"></a>
## ACTION_EFFECT_MISMATCH

动作结果已知，但技术核验未满足所请求的输入效果。

**可重试：** 是

**处理：** 读取动作技术证据和当前 Scene；Agent 自主选择安全且有信息增益的恢复，不直接据此判定产品 FAIL。

<a id="error-visual-inspection-required"></a>
## VISUAL_INSPECTION_REQUIRED

当前视觉动作或结论要求先登记图片事实。

**可重试：** 是

**处理：** 对同一 Scene 调用 inspect(mode="visual") 登记实际看到的事实，再重试视觉动作或结果记录。

<a id="error-action-outcome-unknown"></a>
## ACTION_OUTCOME_UNKNOWN

动作可能已经投递，禁止自动重放。

**可重试：** 否

**处理：** 禁止重放动作；先 observe 当前现场，并结合 action 落点证据判断下一步。

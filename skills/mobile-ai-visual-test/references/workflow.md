# 执行流程

## 批次

```text
workspace -> import -> probe -> user confirms environment
-> user authorizes cases -> execution request -> batch init -> bootstrap
-> START_CASE -> delegate once -> WAIT_CASE_AGENT -> COMMIT_CASE
-> next case -> FINALIZING -> RELEASE_PLATFORM -> PUBLISH_REPORTS -> BATCH_COMPLETE
```

环境确认和执行授权是两个独立动作。确认环境后停止，直到用户明确指定单用例或有序批量范围。

主 Agent 循环处理 `batch reconcile`：

- `BOOTSTRAP`：建立批次暖会话。
- `START_CASE` 或 `RESUME_CASE_START`：调用 `batch start`，把 Case Brief 交给一个新的 Case Agent。
- `WAIT_CASE_AGENT`：等待当前 Case Agent 完成，不进入其观察、动作或恢复循环。
- `COMMIT_CASE`：发布 completion，刷新当前用例报告并进入下一用例。
- `RELEASE_PLATFORM`：确定性释放平台资源并落盘收尾检查项。
- `PUBLISH_REPORTS`：校验本批目标并刷新总览；失败时停留在该状态，只重试发布，不重建无关用例报告。
- `BATCH_COMPLETE`：用例、平台资源和报告三项均已闭环。
- `BATCH_BLOCKED`、`BLOCKED`、`CORRUPTED`：保留现场，释放可释放资源并报告技术原因。

同一批次固定平台、设备、App 和入口，只在 bootstrap 冷启动一次。iOS 同一批次还复用一个框架持有的 Appium session，并在平台资源释放时关闭。后续用例继承 App 暖状态，但每个用例使用新的 Case Agent 和 execution。

## 单用例

Case Agent 从 Case Brief 开始，自主完成理解、起点建立、业务操作、证据判断、异常调查和结论。它直接使用 Runtime 返回的 Scene 和 Capability，不需要把中间决策发给主 Agent。

Runtime 对动作、恢复和完成做事务保护。中断恢复时，已经发送但结果未知的动作不会重放；Runtime 先返回新的 Scene，由同一个 Case Agent 根据现场继续判断。

# 单用例 Agent 最小执行规范

本文件只约束视觉判断；所有确定性状态推进、动作执行、事实写入和收尾均交给 `scripts/execute-next-work.js`。

## 边界

- 只处理请求冻结的 `caseDir + platform + executionId`，不扫描批次、不修改 Skill、case.json、execution.json、runtime.json 或 completion.json。
- 仅在 `DECISION_REQUIRED` 时判断截图；其他工作不得自行拼装底层命令。
- 始终复用 DecisionRequest 的 `workToken`、`evidenceRef`、步骤或 Flow 标识。

## 证据与判断

- PASS/FAIL 必须由当前截图或控件树直接支持；无法辨认时使用允许的视觉重试，仍不可验证则 UNKNOWN/BLOCKED，禁止猜测。
- ACT 只执行当前目标必需的最小动作；坐标必须来自当前证据且落在目标 bounds 内，禁止高风险或破坏性操作。
- Flow 的完整可执行冻结动作由引擎直接执行；Agent 只为缺少可执行参数的目标动作补齐当前画面能证明的参数。
- 不把截图绝对路径或图片内容写入 timeline，只提交规范 evidenceRef。

## 终态

- 引擎返回 COMPLETED 后调用 `scripts/build-case-agent-result.js`。
- 结构化结果必须继承请求中的 provider、requestSha、protocolSha、implementationSha、environmentSha 和 preconditionInputsSha。
- 不以自然语言代替结构化结果，不绕过 Runtime 释放和批次 completion 发布。

# Case Runtime

协议：`agent-facing`。本页是启动短索引；只在紧凑签名不足时读取对应方法页，收到错误时只读取 `documentationRef` 指向的章节。

## 方法

| 方法 | 用途 | 紧凑签名 |
|---|---|---|
| [`observe`](case-runtime/methods/observe.md) | 采集一个新 Scene，不执行业务动作。 | `observe({ capability: "observe", basedOnSceneRef?: string, purpose?: string, expectationRefs?: string[], updates?: object })` |
| [`inspect`](case-runtime/methods/inspect.md) | 登记视觉事实，或按需读取 elements 或 layout。 | `inspect({ capability: "inspect", basedOnSceneRef: string, channel: "visual" | "action" | "elements" | "layout", observation?: string, expectationRefs?: string[], filter?: object })` |
| [`plan`](case-runtime/methods/plan.md) | 单独创建或修订 Case Model。 | `plan({ capability: "plan", caseModel: object })` |
| [`act`](case-runtime/methods/act.md) | 基于当前 Scene 执行一个 ActionRef，并采集新 Scene。 | `act({ capability: "act", basedOnSceneRef: string, actionRef: string, input?: object, purpose: string, expectationRefs?: string[], updates?: object })` |
| [`knowledge`](case-runtime/methods/knowledge.md) | 查询知识，或登记指定 query 的候选复核结果。 | `knowledge({ capability: "knowledge", basedOnSceneRef: string, query?: string, expectationRefs?: string[], queryId?: string, conclusion?: "APPLICABLE_FOUND" | "NO_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT", assessments?: object[] })` |
| [`recover`](case-runtime/methods/recover.md) | 建立授权的 App 初始状态、重启恢复或登记框架外事实。 | `recover({ capability: "recover", basedOnSceneRef?: string, reason: string, targetState?: "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL", externalAction?: object })` |
| [`finish`](case-runtime/methods/finish.md) | 从 expectation ledger 收口并完成用例。 | `finish({ capability: "finish", basedOnSceneRef?: string, summary: string, uncertainties?: string[], updates?: object })` |

## 参数来源

- Scene、控件、键盘和滚动状态来自当前 Runtime 响应。
- 用户选择和目标绑定来自当前 Coordinator 探测事实。
- 验证点引用来自 Case Model 变更回执或 continuation brief。

## 按需文档

- [ActionRef 规则](case-runtime/action-refs.md)
- [错误目录](case-runtime/errors.md)

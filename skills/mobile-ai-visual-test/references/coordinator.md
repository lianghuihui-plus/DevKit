# Coordinator

协议：`agent-facing`。本页是启动短索引；只在紧凑签名不足时读取对应方法页，收到错误时只读取 `documentationRef` 指向的章节。

## 方法

| 方法 | 用途 | 紧凑签名 |
|---|---|---|
| [`prepareRun`](coordinator/methods/prepare-run.md) | 为指定工作空间和用例创建一次 Coordinator run。 | `prepareRun({ capability: "prepareRun", workspace: string, caseNos: string[] })` |
| [`confirmRun`](coordinator/methods/confirm-run.md) | 选择当前环境、平台设备或确认完整目标绑定。 | `confirmRun({ capability: "confirmRun", decision: "CONFIRM_BINDING", userInstruction?: string, platform?: "harmony" | "android" | "ios", deviceId?: string, binding?: object })` |
| [`advanceRun`](coordinator/methods/advance-run.md) | 推进或恢复当前 run 的确定性状态机。 | `advanceRun({ capability: "advanceRun" })` |
| [`cancelRun`](coordinator/methods/cancel-run.md) | 仅在用户明确取消时停止当前 run。 | `cancelRun({ capability: "cancelRun", reason: string })` |

## 参数来源

- Scene、控件、键盘和滚动状态来自当前 Runtime 响应。
- 用户选择和目标绑定来自当前 Coordinator 探测事实。
- 验证点引用来自 Case Model 变更回执或 continuation brief。

## 按需文档

- [错误目录](coordinator/errors.md)

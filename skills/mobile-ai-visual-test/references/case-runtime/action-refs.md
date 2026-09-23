# Case Runtime 动作目标

发布的 ActionRef 或 Agent 自主视觉坐标动作。ActionRef 原样取自已发布控件或屏幕事实；Agent 可以自主选择任意归一化坐标。Runtime 不判断视觉目标或业务意图。

## 动作分支

```typescript
action: { ref: string; input?: { durationMs?: number; text?: string; mode?: "replace" | "append"; ms?: number } }
action: { type: "tap" | "doubleTap"; target: { point: Array<number> } }
action: { type: "longPress"; target: { point: Array<number> }; durationMs: number }
action: { type: "swipe"; target: { from: Array<number>; to: Array<number> } }
```

坐标必须在 0 到 1 范围内；视觉动作先读取截图并通过 `inspect(mode="visual")` 登记事实。完整请求及响应见 [act](methods/act.md)。

- action.ref 与 action.type 互斥；ActionRef 所需 action.input 字段必须存在。
- 下一步需要根据新 Scene 作视觉理解、业务判断或重新规划时使用 act。
- ActionRef、动态输入或 Scene 无效时拒绝 effect；业务判断通过 inspect 和 recordResult 单独提交。

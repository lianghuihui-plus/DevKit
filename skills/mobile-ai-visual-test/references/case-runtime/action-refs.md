# Case Runtime ActionRef

ActionRef 是 Runtime 发布事实的稳定引用，Agent 不解析内部 capabilityId。

## 格式

| 类型 | 格式 | 示例 |
|---|---|---|
| 控件动作 | `<elementRef>:<actionType>` | `button-1:tap` |
| 全局动作 | `screen:<actionType>` | `screen:swipeUp` |
| 视觉动作 | `visual:<gesture>` | `visual:longPress` |

## 控件映射

- `clickable`：`tap`、`doubleTap`、`longPress`。
- `checkable`：`tap`、`toggle`。
- `editable`：`tap`、`inputText`。
- 多个属性同时成立时取并集。

## 动态约束

- 屏幕动作由 `interactionContext` 的滚动、焦点和键盘事实约束。
- 视觉动作必须出现在 `interactionContext.visualGestures`，且 Scene 已通过 `inspect(channel="visual")` 登记视觉事实。
- Runtime 在完整当前 Scene 上重建能力；无效引用返回 `ACTION_NOT_AVAILABLE`，不会返回整份替代动作目录。

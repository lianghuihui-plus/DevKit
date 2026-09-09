# Case Agent 视觉检查能力设计

## 背景

当前 Scene 把控件树直接内联到 Runtime JSON，却只给出截图路径。Case Agent 虽然可以调用宿主 `view_image`，但 Prompt 同时要求只使用 Runtime Client，导致视觉能力的可发现性、授权边界和使用记录不一致。实际执行中部分 Agent 主动查看了图片，部分 Agent 只分析控件树；控件树为空时也可能漏掉系统权限弹窗。

## 目标

- 让 Case Agent 明确知道每个 Scene 同时提供视觉和控件树两种证据通道。
- 保留 Agent 根据业务现场选择证据通道的自主性，同时为异常现场提供强制视觉复核规则。
- 对最终结论所引用的 Scene 建立可审计的视觉检查记录。
- 不破坏不具备新能力声明的历史 execution。

## 方案比较

### 仅加强 Prompt

改动最小，但无法审计 Agent 是否执行，模型差异仍会导致用例间行为不一致，因此不单独采用。

### 每次 Runtime 返回自动内联图片

视觉输入最直接，但当前 Runtime Client 通过 shell 标准输出返回 JSON，不能产生宿主工具的图片内容块；同时会强制消费所有中间截图，因此当前架构下不采用。

### 显式视觉能力与 Runtime 闭环

采用该方案。Scene 暴露可直接交给 `view_image` 的附件信息；Prompt 明确授权该宿主只读工具；Agent 查看后调用 `inspectVisual` 登记观察；Runtime 在 `finish` 时校验最终证据覆盖。

## 协议

Scene 增加 `evidenceChannels`：

- `visual.available=true`，包含 PNG 的 `attachment.mediaType` 和绝对 `attachment.path`。
- `layout.available` 表示控件树是否可用，并明确其内容已内联。
- 两个通道是并列证据，控件树不是截图的替代品。

新增 Case Runtime 操作：

```json
{
  "operation": "inspectVisual",
  "basedOnSceneId": "scene-0001",
  "decision": {
    "purpose": "记录已完成的截图视觉检查",
    "expectationRefs": ["E1"],
    "observation": "页面显示系统麦克风权限弹窗"
  }
}
```

Agent 必须先调用 `view_image(scene.evidenceChannels.visual.attachment.path)`，再提交 `inspectVisual`。Runtime 校验 Scene、截图引用和 `decision.observation`，写入 `visualInspected` 事件并返回 `VISUAL_INSPECTED`。该事件表示 Agent 已声明完成视觉检查；共享文件系统无法从 Runtime 内部验证宿主工具调用本身。

## Agent 策略

Prompt 明确以下规则：

- 每个最终 check 引用的 Scene 都要先完成视觉检查登记。
- 控件树为空、缺失或冲突时不得推断页面空白，必须查看截图。
- 系统权限弹窗、Toast、遮罩、浮层、键盘、长按中状态、动画和纯视觉结果必须查看截图。
- 普通中间 Scene 是否查看仍由 Agent 根据业务判断决定。
- `view_image` 只允许读取当前 execution 的 Scene 视觉附件，不扩大设备、业务或文件访问边界。

## 完成校验

对声明支持 `inspectVisual` 的新 execution，`finish` 校验每个 check 的全部 `sceneRefs` 是否存在对应 `visualInspected` 事件。缺失时返回 `RESULT_INCOMPLETE`，列出需要补查的 Scene，Agent查看并登记后可再次提交。

历史 execution 的 Runtime allowlist 不包含 `inspectVisual`，继续按旧规则读取和收口；新建 execution 使用新 allowlist 并启用校验。

## 测试

- Runtime 契约接受合法 `inspectVisual`，拒绝缺少 Scene、decision 或视觉观察的请求。
- Scene 同时暴露 visual/layout 通道和视觉附件。
- `inspectVisual` 记录与当前 Scene、截图和验证点绑定的事件，并支持幂等登记。
- 未检查最终引用 Scene 时 `finish` 返回 `RESULT_INCOMPLETE`；完成登记后可正常结束。
- 历史 Runtime allowlist 仍可恢复，且不启用新视觉覆盖校验。
- Prompt 和接口文档明确双通道、宿主 `view_image` 用法及异常触发条件。

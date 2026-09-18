# Runtime Command Plan 方案

## 目标

为 Case Agent 增加一个受约束的 `runPlan` 能力，让 Agent 可以一次提交由动作、等待、采集、定位和确定性检查组成的短流程，由 Runtime 在设备侧连续执行并返回完整过程证据。该能力解决视频控制栏、Toast、弹窗按钮和动画状态等生命周期短于一次 Agent 决策周期的交互问题，重点覆盖 033“取消童锁”场景。

## 核心原则

1. Agent 负责业务目标、流程选择、语义解释和 PASS/FAIL/INCONCLUSIVE 判断。
2. Runtime 负责命令校验、设备动作投递、截图或完整 Scene 采集、确定性定位、技术条件检查、证据持久化和失败恢复事实。
3. Runtime 不调用大模型，不替 Agent 解释自由文本，不直接形成业务结论。
4. `runPlan` 是声明式、有限步数、有限时间的命令计划，不是 Shell 执行器，也不是任意脚本语言。
5. 计划中的每一步都必须可审计、可重放判断、可说明失败位置；未知设备 effect 不得自动重放。

## 为什么需要新能力

当前 `act` 的语义是“投递一个动作并采集新的完整 Scene”。Android 033 的动作后 Scene 采集实际约 4.6 至 6.5 秒，而视频控制栏约 3 秒自动隐藏；即使先返回瞬时截图，Agent 仍需要新一轮判断，第二次点击仍可能错过窗口。因此解决点不是单纯加快截图，而是让短时连续交互在一次 Runtime 调用内完成。

## 公共接口

新增 Agent-facing capability `runPlan`，并增加对应的内部 Runtime operation。请求绑定当前 Scene、Case Flow 节点和业务目的：

```json
{
  "capability": "runPlan",
  "basedOnSceneRef": "scene-0012",
  "purpose": "唤起视频控制栏并解除童锁",
  "steps": [
    { "id": "reveal", "type": "act", "actionRef": "visual:tap", "visual": { "gesture": "tap", "point": [0.5, 0.5] } },
    { "id": "controls", "type": "capture", "mode": "SCREENSHOT_ONLY", "afterMs": 300 },
    { "id": "lock", "type": "locate", "source": "controls", "locator": { "kind": "POINT", "point": [0.098, 0.501] } },
    { "id": "unlock", "type": "act", "actionRef": "visual:tap", "pointRef": "lock.point" },
    { "id": "after", "type": "capture", "mode": "SCREENSHOT_ONLY", "afterMs": 300 },
    { "id": "technical-check", "type": "check", "predicate": { "kind": "CAPTURE_AVAILABLE", "source": "after" } }
  ],
  "flowContext": { "nodeRef": "N5" }
}
```

Runtime 返回计划状态、每一步的状态、技术事实和 Scene/截图证据引用；Agent 读取结果后调用现有 `inspect`/`recordResult` 完成视觉事实和业务结论。`runPlan` 不自动调用 `recordResult`，也不把 `technical-check` 转换成业务 PASS。

## 命令模型

第一版只允许以下命令：

| 命令 | Runtime 责任 | 结果 |
| --- | --- | --- |
| `act` | 复用现有 ActionRef/visual gesture 投递一个设备动作 | action result、命令状态、可选空间证据 |
| `wait` | 等待有限毫秒，受计划总预算约束 | 实际等待时间 |
| `capture` | 截取截图或执行完整 Scene 采集；`SCREENSHOT_ONLY` 不等待控件树 | Scene ref、capture timing、截图证据 |
| `locate` | 按声明的 locator provider 解析坐标或控件引用 | 坐标、匹配状态、置信度和定位证据 |
| `check` | 执行确定性技术谓词 | `SATISFIED`/`NOT_SATISFIED`/`UNAVAILABLE` 技术事实，不是用例结论 |
| `checkpoint` | 标记需交回 Agent 的证据集合 | checkpoint ref，不执行设备动作 |

计划禁止任意循环、Shell、文件写入、业务 API 和未注册的 locator/check provider。第一版的 locator provider 为 `ELEMENT_REF`、`POINT`、`REGION`；`TEMPLATE` 保留扩展接口，但没有可靠模板时必须返回 `LOCATOR_UNSUPPORTED`，不得猜坐标。后续若加入本地 CV/OCR，必须作为 provider 并返回匹配置信度、输入截图和算法版本。

## Scene 与证据

`capture` 产生不可变的 Scene 事实。`SCREENSHOT_ONLY` Scene 明确标记 `captureMode: "SCREENSHOT_ONLY"`，布局通道可用性为 false，但视觉附件、时间、尺寸、sha256 和来源计划步骤必须完整记录。它可以被 `inspect(channel="visual")` 和结果证据引用，但默认不覆盖当前完整 Scene；只有计划显式声明 `promote: true` 时才更新当前 Scene。

每个计划步骤写入追加式事件，至少包括 `planRequested`、`planStepStarted`、`planStepCompleted` 或 `planStepFailed`、`planCompleted`/`planInterrupted`。每一步保存输入摘要、实际动作、采集证据、耗时和技术错误；文本输入按现有规则脱敏。

## 条件、失败与恢复

- `check` 只允许确定性谓词，例如截图存在、目标已定位、控件可见且 enabled、App 身份匹配、截图 hash 改变、前后 Scene ref 不同。
- `check` 失败时，计划按 `onFailure: "STOP"` 停止并返回已完成前缀；`CONTINUE` 仅允许对非设备动作步骤使用。
- 设备动作结果未知时，计划状态为 `UNKNOWN`，禁止自动重放；后续必须先 `observe` 或按恢复事实重新规划。
- 计划超时、步骤 schema 非法、引用过期或 provider 不支持时返回明确的技术错误和失败步骤，不伪造后续结果。
- Runtime 锁覆盖整个计划，避免同一 execution 的其他调用穿插；计划中每个设备动作仍保留操作 ID 和事务状态。

## 033 的执行方式

033 不应拆成“点击视频中心 -> Agent 读取截图 -> Agent 再点击童锁”两次 Agent 决策。Agent 在第一次决策时提交完整计划；Runtime 在约 300ms 的窗口内截屏、解析预声明区域并点击童锁，再在解锁后截屏。Agent 最后只处理两张证据和技术结果，判断锁图标状态及控制栏内容。

如果定位目标只依赖固定坐标，计划必须披露其平台、方向和来源；如果目标需要模板/CV，而当前平台没有可用 provider，Runtime 应停止并返回 `LOCATOR_UNSUPPORTED`，而不是让设备动作盲点。

## 兼容性与边界

- 现有 `observe`、`act`、`inspect`、`recordResult` 的默认语义不变；普通用例不自动改用计划。
- `act` 继续保证单动作加完整 Scene 的稳定路径；`runPlan` 是需要时间窗口时的显式选择。
- Coordinator 不读取计划内部步骤，不替 Case Agent 编排计划；它只等待 execution 的持久化结果。
- 计划响应必须保持紧凑，不返回 capability 卡片、方法说明或 Agent 指令。

## 验证标准

1. 单元测试证明 schema 只接受允许的命令、引用、预算和 locator/check provider。
2. Runtime 测试证明计划按顺序执行、短时截图可落盘、步骤事件完整、失败前缀可恢复、未知动作不重放。
3. Android、HarmonyOS、iOS 适配器测试证明 `SCREENSHOT_ONLY` 不隐式执行控件树采集，并保留真实截图 hash 与尺寸。
4. Agent-facing 测试证明 `runPlan` 出现在公开能力、文档和错误映射中，且不暴露 Runtime 内部实现细节。
5. 033 回归测试证明计划可以在控制栏 3 秒窗口内完成唤起、定位、点击和前后截图；结果仍由 Agent 通过视觉检查和结果记录收口。

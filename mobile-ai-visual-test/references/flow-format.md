# 业务路径 Flow

BusinessFlow 用于沉淀“业务上怎么走”的人工经验，适合登录、进入创作页、打开某个业务入口等 agent 单靠用例文字不容易稳定理解的路径。

它不是强制回放脚本。执行时仍由 agent 观察当前页面、判断是否适用、选择下一步动作，并把使用过程写入当前用例 execution 的事实时间线。

## 创建方式

Flow 由 agent 在人工指挥下创建：

0. 进入 Flow Recording Mode，确认这次不是执行 case。
1. 人工给出业务目标和每一步指令。
2. agent 调用观察和动作脚本执行。
3. 脚本记录截图、控件树、动作结果和人工指令。
4. 录制结束后生成 `flow.json` 和 `flow.md`。

录制前置约束：

- 必须有明确的 Flow `name`，例如“进入创作页”。
- 必须有明确的 `intent`，例如“进入创作页,打开创作入口”。
- 应明确录制环境；创建录制时可写入 `--platform`、`--device`、`--app`、`--entry`，后续 Flow 观察和动作默认继承这些参数。
- 用户明确说明本次执行 skill 是为了录制时，agent 必须进入录制模式，不能执行 case。
- 如果用户没有提供名称或 intent，agent 必须先询问，不能自行执行历史 case 或最近 case。
- 录制期间禁止调用 case 执行入口：`scripts/run-case.js <case-dir> --start`、顶层 `scripts/observe.sh --case-dir ...`、顶层 `scripts/action.sh --case-dir ...`。
- 录制期间只允许调用 `scripts/flow/start-recording.js`、`scripts/flow/observe.sh`、`scripts/flow/action.sh`、`scripts/flow/finalize-recording.js`。
- 每个人工步骤按固定顺序处理：`observe before` -> `action` -> `observe after`。
- 只有用户明确说“完成录制 / 结束录制 / finalize”时，才生成 Flow；生成 `READY` 前必须至少有 1 个完整步骤，且每步都有 action、before observation 和 after observation。

录制期间的 agent 回复应该保持为“录制会话状态”，例如：

```text
已进入 Flow Recording Mode。
Flow：进入创作页
recordingId：...
请给出下一步人工指令，或说“完成录制”。
```

如果 agent 发现自己准备调用 case 相关命令，必须停止并回到录制流程。

```bash
scripts/flow/start-recording.js --name "进入创作页" --intent "进入创作页,打开创作入口" --cwd <workspace-cwd> --platform harmony --device <device> --app <appId> --entry <entry>
scripts/flow/observe.sh --flow-dir <flow-dir> --recording-id <id> --label 001-before
scripts/flow/action.sh --flow-dir <flow-dir> --recording-id <id> --instruction "点击底部创作入口" --type tap --x 520 --y 1800 --target "创作" --coordinate-source visual --target-bounds 500,1760,560,1840 --coordinate-evidence "截图中底部创作入口像素区域" --success-hint "进入创作页"
scripts/flow/observe.sh --flow-dir <flow-dir> --recording-id <id> --label 001-after
scripts/flow/finalize-recording.js <flow-dir> --recording-id <id> --status READY
```

## 存储结构

```text
ai-visual-test/
  flows/
    <flow-slug>__<flowId>/
      flow.md
      flow.json
      state.json
      recordings/
        <recordingId>/
          timeline.jsonl
          screenshots/
          layouts/
          logs/
```

## flow.json

```json
{
  "schemaVersion": 1,
  "id": "flow-xxxxxxxxxxxx",
  "name": "进入创作页",
  "intent": ["进入创作页", "打开创作入口"],
  "status": "READY",
  "latestRecordingId": "20260623-161900-123-abcd",
  "updatedAt": "2026-06-23T16:19:00.000+08:00",
  "steps": [
    {
      "id": "flow-step-001",
      "humanInstruction": "点击底部创作入口",
      "beforeObservation": {
        "screenshot": "recordings/<recordingId>/screenshots/001-before.png",
        "layout": "recordings/<recordingId>/layouts/001-before.json"
      },
      "action": {
        "type": "tap",
        "x": "520",
        "y": "1800",
        "target": "创作",
        "coordinateSource": "visual",
        "targetBounds": [500, 1760, 560, 1840],
        "coordinateEvidence": "截图中底部创作入口像素区域"
      },
      "actionResult": {
        "ok": true
      },
      "afterObservation": {
        "screenshot": "recordings/<recordingId>/screenshots/001-after.png",
        "layout": "recordings/<recordingId>/layouts/001-after.json"
      },
      "successHint": "进入创作页"
    }
  ],
  "safety": {
    "destructive": false,
    "requiresConfirmation": false
  }
}
```

## 执行接入

Case Execution Mode 创建 execution 后、开始业务步骤探索前，agent 必须调用 `scripts/flow/list-flows.js --cwd <workspace-cwd>`，读取所有可用 Flow，形成候选 Flow 清单，并立即写入 `flowScan` 事实。

```bash
scripts/flow/list-flows.js
scripts/flow/list-flows.js --cwd <workspace-cwd>
```

当用例步骤出现“登录账号”“进入创作页”“进入 AI 精灵页面”“打开某业务入口”等业务语义时，agent 必须选择 intent、name、humanInstruction 或 successHint 匹配的 Flow。即使用例步骤没有显式写“进入页面”，只要当前页面不在步骤所需业务上下文，也必须先检查是否已有可用 Flow。

使用规则：

- 先观察当前页面，判断是否接近 Flow 的起点。
- 只把 Flow 当作参考路径，不盲目连续执行全部步骤。
- 每次步骤级匹配前必须先写入 `flowScan` 事实，记录候选数量和命中 Flow；没有命中时 `matchedFlowIds` 使用空数组。
- 执行 Flow 时使用 `list-flows.js` 输出中的 `steps`；如果需要查看完整 Markdown 说明，再打开对应 `flow.md`。
- 每执行或跳过一个 Flow 步骤，都写入 `flow` 事件。
- 匹配到 Flow 但决定不用时，必须写入 `SKIPPED` 并说明原因。
- Flow 完成后仍要用当前页面证据写入断言事件。
- Flow 不匹配或不安全时，写 `flow` 的 `FAILED`/`BLOCKED` 事件，并按失败策略结束或改走普通探索。
- 在判定页面加载阻塞、目标找不到或上下文丢失前，必须确认失败步骤已有对应 `flowScan` 且没有可用匹配，或每个匹配 Flow 都已有同 `stepId` 的终态 `flow` 事实：`COMPLETED`、`FAILED`、`SKIPPED` 或 `BLOCKED`；缺少失败步骤、对应扫描事实或匹配 Flow 处理事实时不能直接下结论。

`flow` 事件示例：

```json
{"type":"flow","flowId":"flow-xxxxxxxxxxxx","status":"STARTED","stepId":"step-001","reason":"当前步骤要求进入创作页"}
{"type":"flow","flowId":"flow-xxxxxxxxxxxx","flowStepId":"flow-step-001","status":"STEP_COMPLETED","stepId":"step-001","reason":"已点击创作入口"}
{"type":"flow","flowId":"flow-xxxxxxxxxxxx","status":"COMPLETED","stepId":"step-001","reason":"已进入创作页"}
```

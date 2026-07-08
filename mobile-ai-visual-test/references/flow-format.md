# 业务路径 Flow

> 负责：Flow 录制、存储、扫描、匹配、使用和终态事实。
> 不负责：通用步骤证据、环境确认、完整动作规则。
> 参见：`workflow.md`、`interfaces.md`、`action-schema.md`、`failure-policy.md`。

## 定位

BusinessFlow 沉淀“业务上怎么走”的人工经验，例如登录、进入创作页、打开业务入口。Flow 是参考路径，不是强制回放脚本；执行时仍由 agent 观察、判断、选择动作并记录事实。

## 录制前置

必须明确：

- `name`：如“进入创作页”。
- `intent`：如“进入创作页,打开创作入口”。
- `platform`：录制平台。
- `flowScope`：`universal` 或 `platform`。

缺少 `name` 必须询问；缺少 `intent` 可给候选但必须等用户确认。

## 录制入口

```bash
scripts/flow/start-recording.js --name "进入创作页" --intent "进入创作页,打开创作入口" --platform android --flow-scope universal --cwd <workspace-cwd> --device <device> --app <appId> --entry <entry>
scripts/flow/observe.sh --flow-dir <flow-dir> --recording-id <id> --label 001-before
scripts/flow/action.sh --flow-dir <flow-dir> --recording-id <id> --instruction "点击底部创作入口" --type tap --x 520 --y 1800 --target "创作" --coordinate-source visual --target-bounds 500,1760,560,1840 --coordinate-evidence "截图中底部创作入口像素区域" --success-hint "进入创作页"
scripts/flow/observe.sh --flow-dir <flow-dir> --recording-id <id> --label 001-after
scripts/flow/finalize-recording.js <flow-dir> --recording-id <id> --status READY
```

每条人工指令都按 `observe before -> action -> observe after` 记录。只有用户明确说完成录制时才能 finalize。READY 前至少要有 1 个完整步骤。

## 录制禁止

Flow Recording Mode 禁止：

- 自动查找、解析、启动或执行 case。
- 调用 `scripts/run-case.js`。
- 调用顶层 case-bound `observe.sh --case-dir` 或 `action.sh --case-dir`。
- 使用最近 case、execution 或失败现场作为录制入口。
- 没有用户步骤指令时自行探索。
- 用户未确认结束前 finalize。

## 存储

```text
flows/
  <flow-slug>__<flowId>/
    flow.md
    flow.json
    state.json
    recordings/<recordingId>/
      timeline.jsonl
      screenshots/
      layouts/
      logs/
```

`flow.json` 核心字段：

```json
{
  "schemaVersion": 1,
  "id": "flow-xxxxxxxxxxxx",
  "name": "进入创作页",
  "intent": ["进入创作页", "打开创作入口"],
  "recordingPlatform": "android",
  "flowScope": "universal",
  "status": "READY",
  "steps": [
    {
      "id": "flow-step-001",
      "humanInstruction": "点击底部创作入口",
      "beforeObservation": {"screenshot": "...", "layout": "..."},
      "action": {"type": "tap", "x": 520, "y": 1800, "target": "创作", "coordinateSource": "visual", "targetBounds": [500,1760,560,1840]},
      "afterObservation": {"screenshot": "...", "layout": "..."},
      "successHint": "进入创作页"
    }
  ],
  "safety": {"destructive": false, "requiresConfirmation": false}
}
```

## 执行接入

创建 execution 后，步骤前写全局扫描：

```bash
scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform android --execution-id <id>
```

每个步骤动作或匹配前写步骤扫描：

```bash
scripts/flow/record-scan.js <case-dir> --cwd <workspace-cwd> --platform android --execution-id <id> --step-id step-002 --matched-flow-ids flow-xxxxxxxxxxxx
```

默认只返回当前平台专用 Flow 和通用 Flow；其他平台专用 Flow 只用于审计或调试。

## 匹配和使用

必须检查 Flow 的场景：

- 登录、进入页面、打开入口、选择 tab、从首页进入功能。
- 用例步骤从页面内操作开始，但当前页面不在目标业务上下文。

匹配依据：`name`、`intent`、`humanInstruction`、`successHint`、当前 observation、步骤文本和前置条件。

使用规则：

- 平台专用 Flow 优先，通用 Flow 兜底；`recordingPlatform` 不是适用平台。
- Flow 只作为参考，不盲目连续执行全部步骤。
- 每执行、跳过、失败或完成一个 Flow，都写 `flow` 事件。
- 匹配到但不用时写 `SKIPPED` 并说明原因。
- Flow 完成后仍要用当前 case 的 observation 写步骤断言。

`flow` 事件示例：

```json
{"type":"flow","flowId":"flow-xxxxxxxxxxxx","status":"STARTED","stepId":"step-001","reason":"当前步骤要求进入创作页"}
{"type":"flow","flowId":"flow-xxxxxxxxxxxx","flowStepId":"flow-step-001","status":"STEP_COMPLETED","stepId":"step-001","reason":"已点击创作入口"}
{"type":"flow","flowId":"flow-xxxxxxxxxxxx","status":"COMPLETED","stepId":"step-001","reason":"已进入创作页"}
```

## 失败判定前置

判定 `PAGE_LOAD_BLOCKED`、`ACTION_TARGET_NOT_FOUND`、`APP_CONTEXT_LOST` 前，失败步骤必须已有对应 `flowScan`。若命中 Flow，每个命中 Flow 都必须已有同 `stepId` 的终态事实：`COMPLETED`、`FAILED`、`SKIPPED` 或 `BLOCKED`。

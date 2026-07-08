# 用例格式

> 负责：Markdown 输入、`case.json`、`source.md`、`notes.jsonl`、执行契约。
> 不负责：执行流程、平台动作、报告展示、failureCode。
> 参见：`workflow.md`、`context-format.md`、`failure-policy.md`。

## 输入和目录

支持 Markdown 文件、Markdown 目录、已有 caseNo、caseKey、标题或 case 目录。输入先由 `resolve-execution-targets.js` 分流，Markdown 再由 `parse-case.js` 创建或刷新。

case 目录：

```text
cases/C001__ck-xxxxxxxxxxxx/
  source.md
  case.json
  notes.jsonl
  CONTEXT.md
  CONTEXT.html
  platforms/<platform>/
    state.json
    CONTEXT.md
    CONTEXT.html
    executions/
```

共享资产是 `source.md`、`case.json`、`notes.jsonl`；平台运行态写入 `platforms/<platform>/`。

## Markdown 约定

Markdown 应尽量包含标题、前置条件、测试步骤、预期结果、全局规则或补充说明。格式不要求完全统一；无法稳定结构化的内容保留到 `source.md` 和 notes，由 agent 执行时结合上下文判断。

## case.json

```json
{
  "schemaVersion": 1,
  "identity": {
    "caseNo": "C001",
    "caseKey": "ck-xxxxxxxxxxxx",
    "title": "AI 精灵单条语音播放按钮展示",
    "sourceSha1": "source-xxxxxxxxxxxx"
  },
  "preconditions": [
    {"id": "pre-001", "text": "用户已登录", "checkMode": "confirm"}
  ],
  "steps": [
    {"id": "step-001", "kind": "action", "sourceText": "进入 AI 精灵页面", "expected": "页面展示 AI 精灵入口"},
    {"id": "step-002", "kind": "assertion", "sourceText": "确认最新回复展示语音播放按钮", "assertions": ["最新 AI 回复区域展示单条语音播放按钮"]}
  ],
  "globalRules": [],
  "isolation": {"requireCleanRestart": "auto"}
}
```

## identity

| 字段 | 含义 |
| --- | --- |
| `caseNo` | 人读短编号 |
| `caseKey` | 稳定身份 key |
| `title` | 用例标题 |
| `sourceSha1` | `source.md` 内容摘要 |

## preconditions

每条包含 `id`、`text`、`checkMode`。

| checkMode | 含义 |
| --- | --- |
| `ready` | 技术上可直接判断 |
| `confirm` | 需要用户确认 |
| `needs_setup` | 需要执行前准备 |
| `unknown` | 无法可靠判断 |
| `unsupported` | 当前框架不支持自动判断 |

执行前预检见 `workflow.md`；运行期状态见 `failure-policy.md`。

## steps

步骤 id 形如 `step-001`。常见 kind：

- `action`：需要操作并验证结果。
- `assertion`：主要验证预期结果。
- `setup`：用例内准备动作。

断言型步骤必须满足 `failure-policy.md` 的证据规则。

## globalRules

用于表达跨步骤规则，例如系统弹窗处理、禁止破坏性操作、页面稳定条件、业务入口偏好。运行期 `rule` 事件 schema 见 `interfaces.md`。

## isolation

| 值 | 含义 |
| --- | --- |
| `true` / `required` | 必须真实冷启动，失败直接 `BLOCKED/CASE_RESTART_FAILED` |
| `false` / `optional` | 冷启动失败可降级继续 |
| `auto` | 框架根据用例语义识别是否冷启动敏感 |

## source.md

保存原始用例文本，是稳定输入源。原始 Markdown 变化会更新 `sourceSha1`；报告发现 `sourceSha1` 或 `caseContractSha` 不匹配时，应隐藏旧结果并提示重新执行。

## notes.jsonl

保存用户补充和修正：

```json
{"time":"2026-07-08T10:00:00+08:00","type":"stepHint","stepId":"step-002","text":"语音播放按钮可能在最新回复右下角"}
```

用户补充不能直接改写 source；解析或刷新 case 时重放有效 notes，失效 notes 应在报告中标记。

## caseContractSha

执行契约摘要，至少覆盖 `sourceSha1`、`preconditions`、`steps`、`globalRules`、notes 重放 hints 和 `isolation`。result 的 contract 与当前 case 不一致时，不展示为当前有效结果。

## 编号与刷新

- 新用例自动分配 `caseNo`。
- 刷新已有用例时尽量保持 `caseNo` 和 `caseKey` 稳定。
- 重复导入同一 source 时应复用或刷新，不静默创建重复 case。
- 不支持从失败步骤续跑；每次执行都是完整重跑。

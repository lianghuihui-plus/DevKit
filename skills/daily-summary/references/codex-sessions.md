# Codex CLI 数据采集细节

## 数据存储

- **会话文件**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（活跃）
- **归档文件**：`~/.codex/archived_sessions/rollout-*.jsonl`（已归档）
- **全局索引**：`~/.codex/session_index.jsonl`

## 索引格式

`session_index.jsonl` 每行一个对象：

```json
{
  "id": "019eb5a1-fe86-7640-82aa-a9fa6cdfd475",
  "thread_name": "Use harmony-ui-test skill",
  "updated_at": "2026-06-11T07:42:33.117Z"
}
```

## 消息格式

Codex JSONL 每行为一个事件对象，`type` 字段区分类型：

| type | 用途 |
|------|------|
| `session_meta` | 会话元数据（id, cwd, cli_version, model_provider 等） |
| `response_item` | 实际消息，`payload.role` 为 user/assistant/system |
| `event_msg` | 任务状态事件（task_started, task_completed 等） |

`response_item` 消息结构：

```json
{
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "user",
    "content": [
      {"type": "input_text", "text": "用户输入内容..."}
    ]
  }
}
```

- user 消息的 content type 为 `input_text`
- assistant 消息的 content type 为 `output_text`

## 会话 ID 与文件名映射

文件名格式：`rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`

UUID 段包含 5 个 `-` 分隔的部分，通过 `rsplit("-", 5)` 提取后 5 段拼接还原 session_id。

## 时间戳注意事项

- 索引中的 `updated_at` 为 UTC ISO 格式，末尾可能为 `Z` 或 `+00:00`
- 部分条目微秒精度不固定（5 位或 6 位），解析时需容错
- 统一转为北京时间（UTC+8）后按日期过滤

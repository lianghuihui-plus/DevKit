# OpenClaw 会话目录结构

## 数据目录

`~/.openclaw/agents/main/sessions/`

## 文件类型

| 文件模式 | 说明 | 采集策略 |
|----------|------|----------|
| `sessions.json` | 当前活跃会话索引。会话 reset 后从索引移除。 | 第一路：按 `updatedAt` 过滤日期，通过 `sessionFile` 字段读取 `.jsonl` |
| `*.jsonl` | 活跃会话的完整消息 JSONL。每行一个 JSON 消息对象。 | 通过 `sessions.json` 的 `sessionFile` 间接引用 |
| `*.jsonl.reset.<ISO>` | 已 reset 会话的历史快照。不在 `sessions.json` 中，但保留了 reset 前的完整对话。 | **第二路**：扫描目录，从文件名提取 reset 时间戳过滤日期 |
| `*.jsonl.deleted.<ISO>` | 已删除会话的残留。通常只有几 KB，无实际内容。 | 跳过 |
| `*.trajectory.jsonl` | Agent 思考轨迹，非对话数据。 | 跳过 |
| `*.trajectory-path.json` | 轨迹文件路径引用。 | 跳过 |
| `.usage-cost-cache.json` | Token 用量缓存（不完整，仅覆盖部分历史会话）。 | 跳过 |

## `.reset` 文件名格式

```
<uuid>.jsonl.reset.<YYYY-MM-DD>THH-MM-SS.sssZ
```

**⚠️ 关键陷阱：时间分隔符是破折号（`-`），不是冒号（`:`）。**

| | 标准 ISO 8601 | OpenClaw `.reset` 实际格式 |
|---|---|---|
| 示例 | `2026-05-09T02:07:21.281Z` | `2026-05-09T02-07-21.281Z` |
| 正则 | `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` ❌ | `\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}` ✅ |
| strptime | `%Y-%m-%dT%H:%M:%S.%fZ` ❌ | `%Y-%m-%dT%H-%M-%S.%fZ` ✅ |

## sessions.json 结构

```json
{
  "agent:main:tui-<uuid>": {
    "sessionFile": "/path/to/<uuid>.jsonl",
    "updatedAt": 1778296245778,    // epoch millis (UTC)
    "model": "deepseek-v4-pro",
    "totalTokens": 12345
  },
  "agent:main:subagent:<uuid>": { ... },
  "agent:main:main": { ... }
}
```

## 两路采集策略

1. **第 1 路（sessions.json）**：遍历活跃会话，按 `updatedAt / 1000` 转为北京时间过滤。优势：有 `model` 和 `totalTokens` 元数据。
2. **第 2 路（.reset 文件扫描）**：`os.listdir()` 遍历目录，正则匹配 `\.jsonl\.reset\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)$`，从捕获组解析 ISO 时间戳（UTC → 转北京时间）。优势：捕获已 reset 的历史会话。

通过 `seen_files`（`os.path.realpath`）去重，避免同一会话在两路中重复采集。

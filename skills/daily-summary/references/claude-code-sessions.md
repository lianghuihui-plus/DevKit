# Claude Code 会话目录结构

## 数据目录

`~/.claude/`

## 关键文件/目录

| 路径 | 说明 | 采集策略 |
|------|------|----------|
| `projects/` | 按项目分组的会话 JSONL 文件。子目录名为路径编码（`/` → `-`，`.` → `-`，中文 → `-`） | **主数据源**：递归扫描所有 `*.jsonl`，按消息内 `timestamp` 过滤日期 |
| `sessions/*.json` | 活跃会话元数据（pid, sessionId, cwd, startedAt, updatedAt, status） | 辅助参考，非主数据源 |
| `history.jsonl` | 命令历史（display, timestamp, project, sessionId） | 辅助参考，非主数据源 |

## 项目目录编码规则

```
/Users/cm              → -Users-cm
/Users/cm/.claude      → -Users-cm--claude
/Users/cm/GitProj/foo  → -Users-cm-GitProj-foo
```

编码规则：去掉前导 `/`，将 `/`、`.` 及其他非 ASCII 字符替换为 `-`，前缀 `-`。

## JSONL 消息格式

每条消息是一个 JSON 对象，关键字段：

```json
{
  "type": "user",                    // 消息类型
  "timestamp": "2026-05-25T09:39:12.302Z",  // ISO 8601 UTC
  "sessionId": "8067cf7a-...",       // 会话 ID
  "message": {
    "role": "user",
    "content": "用户输入文本"           // str 或 [{type: "text", text: "..."}]
  },
  "cwd": "/Users/cm/.claude",        // 工作目录
  "uuid": "31fea018-..."
}
```

### 消息类型

| type | 说明 | 标题提取 |
|------|------|----------|
| `user` | 用户输入 | `message.content` → 提取纯文本作为标题备选 |
| `assistant` | 助手回复 | 仅计数 |
| `ai-title` | AI 生成的会话标题 | `aiTitle` 字段，优先级最高 |
| `system` | 系统事件（`/exit`、`/status` 等命令） | 跳过 |
| `queue-operation` | 消息队列操作（enqueue/dequeue） | 跳过 |
| `permission-mode` | 权限模式变更 | 跳过 |
| `file-history-snapshot` | 文件历史快照 | 跳过 |
| `last-prompt` | 最后一条 prompt 标记 | 跳过 |

## ⚠️ 关键陷阱

### 1. 前两行可能没有 timestamp

JSONL 文件的前几行（如 `permission-mode`、`file-history-snapshot`）**没有 `timestamp` 字段**。需要遍历前 N 行找到第一条有 `timestamp` 的消息作为会话时间。

### 2. 标题可能包含 skill 加载内容

当用户使用 `/workflow-session` 等斜杠命令时，skill 加载内容会出现在 `user` 消息的 `content` 中。采集脚本使用 `_claude_clean_title()` 剥离 XML 标签和 skill 元数据，剩余内容由 LLM 在归纳阶段处理。

### 3. 同一 sessionId 可能跨多个项目目录

部分会话可能在不同项目目录下出现（通过 symlink 或跨项目引用）。采集时按 `sessionId` 去重，只保留最早的一个。

### 4. 时间戳是 UTC 格式

`timestamp` 字段为 ISO 8601 UTC（如 `2026-05-25T09:39:12.302Z`），需转为北京时间后用 `HH:MM` 输出。

### 5. 与 OpenClaw 不同：无需两路采集

Claude Code 的 `projects/**/*.jsonl` **持久保留**，不因会话结束而删除。而 `~/.claude/sessions/*.json` 仅含活跃会话元数据（pid、cwd、status），进程退出后文件即被移除。

因此**不需要**像 OpenClaw 那样区分「活跃会话索引 + reset 历史快照」两路采集。扫描 `projects/` 目录下的所有 `.jsonl` 即可同时覆盖活跃和非活跃会话。

## 采集函数

`collect_claude()` — 见 `scripts/generate.py`

核心流程：
1. 遍历 `~/.claude/projects/` 下所有子目录
2. 在每个子目录中扫描 `*.jsonl` 文件
3. 找到每条 JSONL 的第一条有 `timestamp` 的消息
4. 按日期范围过滤
5. 提取 `ai-title`（优先）或第一个 user 消息作为标题
6. 统计 `user` + `assistant` 消息数作为交换轮数

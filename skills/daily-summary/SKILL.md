---
name: daily-summary
description: 生成每日工作总结，采集 Git / Hermes / Cursor / OpenClaw / Claude Code 数据，按时间线输出。
trigger:
  - 日报
  - 每日总结
  - daily summary
  - 今天干了什么
  - 工作总结
---

# 每日工作总结

采集五个数据源，按时间线生成日报。**只落盘，不在对话中输出完整内容**——保存后告知用户文件路径即可。

## 执行流程

### 1. 加载配置

读取 `{skill_dir}/config.yaml`，获取仓库列表、数据源开关、输出路径。

### 2. 去重检查

如果配置了 `output.path`，检查当天日报文件是否已存在。存在则直接覆盖，不询问。

### 3. 运行数据采集脚本

```bash
python3 {skill_dir}/scripts/generate.py [YYYY-MM-DD]
```

脚本输出 JSON，包含 Git / Cursor / OpenClaw / Claude Code 事件。日期参数可选，默认今天。

> OpenClaw 数据采集细节见 `references/openclaw-sessions.md`：两路扫描（sessions.json + .reset 历史快照），时间戳格式陷阱（破折号非冒号）。

> Claude Code 数据采集细节见 `references/claude-code-sessions.md`：扫描 `~/.claude/projects/` 下所有 `.jsonl`，按消息 timestamp 过滤日期。

> Git 数据采集见 `references/git-collection.md`：`--since`/`--until` 按 committer date 过滤，需要额外按 author date 二次校验以避免 rebase/cherry-pick 引入的日期污染。

### 4. 采集 Hermes 会话

**不要**用 `session_search()` 浏览模式——它会漏掉进行中的会话且只返回摘要。

改用 `terminal` 执行 Python 直查 `~/.hermes/state.db`：

```python
import sqlite3, os
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
day_start = int(datetime(YYYY, M, D, 0, 0, 0, tzinfo=TZ).timestamp())
day_end = day_start + 86400

db = sqlite3.connect(os.path.expanduser('~/.hermes/state.db'))
rows = db.execute('''
    SELECT id, title, source, started_at, ended_at, message_count
    FROM sessions WHERE started_at >= ? AND started_at < ?
    ORDER BY started_at
''', (day_start, day_end)).fetchall()

for r in rows:
    sid, title, source, started, ended, msg_count = r
    # 转换为 HH:MM 格式，记录 started_at/ended_at 用于计算耗时
```

这样能拿到**所有**当天会话（含进行中的 `ended_at IS NULL` 的会话）。

拿到会话列表后，对每个会话用 `session_search(session_id, around_message_id)` 滚动查看其开头、中间和结尾的关键消息，以理解全天的工作内容。

**尤其注意跨度超过 2 小时的会话**——它们可能包含上午到下午的持续工作，只取开头消息会漏掉下午的内容。对此类会话至少取样开头、中间、结尾三个位置。

### 5. 合并排序

将所有事件按时间升序排列。

**如果事件列表为空**（当天没有任何活动）：保存文件内容为「今日无工作记录」，告知用户后结束，不执行后续步骤。

### 6. 归纳与分组

对每个事件进行 LLM 加工：

- **Hermes 会话**：从 session_search 返回的上下文（bookend/messages）中提取讨论主题、关键决策、最终结果
- **Git 提交**：展开 commit message 全文，说明修改了什么
- **Cursor 会话**：解释做了什么操作（编辑/生成/审查），涉及什么文件
- **OpenClaw 会话**：概括对话主题和结论
- **Claude Code 会话**：根据标题和交换轮数概括对话主题和结论

然后将事件按主题合并为不超过 5 个工作项。相关的连续事件（如同一工作流的多个会话）应合并为一个工作项。每个工作项记录：

- 简述（一行）
- 起止时间（合并后最早和最晚时刻）
- 耗时（结束减开始，以分钟为单位）

### 7. 格式化输出

```markdown
# 📋 {date} 工作总结

## 📊 工作概览

| # | 工作内容 | 起止 | 耗时 |
|---|---------|------|------|
| 1 | AIWorkFlow 工作流推进与规范调整 | 10:07-11:20 | ~73min |
| 2 | Hermes 环境配置与故障排查 | 20:05-21:10 | ~65min |

## 时间线

### 10:07 💬 Hermes

**Hermes Web UI 替代方案讨论**

- 询问 Hermes 是否有 Web UI，探讨了可行的替代方案
- 确认了终端 TUI 是当前主要的交互方式

### 10:38 💬 Hermes

**Workflow Session —「上课系统核心埋点」**

- 继续已有 AIWorkFlow 工作流，完成 T-001~T-015 共 15 个 specs 审核
- 全部标记为"已审核"，推进至 code-generator 阶段

### 11:00 📝 Git [LunarHarmony2]

**`abc1234` feat: 新增 AI 辅导模块入口**

- 分支: `feature/ai-tutor-entry`
- 修改文件: `src/entry/Index.ets`, `src/model/TutorModel.ets`

### 15:48 🤖 Claude Code

**Claude CLI 在其他目录无法识别 API key**

- 排查 Claude Code CLI 的 API key 识别机制，确认 `settings.json` 和 `~/.claude.json` 的读取优先级
- 解决多项目间 key 共享问题
```

要求：
- 每个事件至少 2-3 行实质描述
- 概览表放在标题下方、时间线之前，最多 5 行
- 耗时的计算：Hermes 会话用 `ended_at - started_at`（进行中的用当前时间）；Git/Cursor/OpenClaw/Claude Code 用相邻事件间隔估算；无明显结束时间的取合理默认值
- 合并工作项时，「工作内容」列写一句概括性总结（如「AIWorkFlow 技能重构与工作流推进」），**不要**用 `+` 拼多个任务名
- **只有同类工作才能合并**——同一主题/同一项目的相关事件可合并，不同主题的工作即使时间相邻也分列

### 8. 保存文件

如果 `output.path` 不为空：确保输出目录存在，将日报保存到 `{path}/{filename}`。

如果 `output.path` 为空：跳过保存。

### 9. 告知用户

**不要**在对话中输出日报全文。只告知用户保存路径，如：

```
日报已保存至 ~/Documents/daily-reports/daily-2026-05-20.md
```

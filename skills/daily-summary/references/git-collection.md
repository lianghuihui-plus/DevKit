# Git 数据采集 — `scripts/generate.py`

## ⚠️ 关键陷阱：`--since`/`--until` 按 committer date 过滤

Git 的 `--since`/`--until` 过滤条件使用的是 **committer date**（提交时间），而非 **author date**（作者时间）。

### 问题现象

```python
result = subprocess.run([
    "git", "-C", repo_path, "log",
    f"--since={since}",       # 过滤 committer date
    f"--until={until}",
    f"--author={author}",
    "--format=%H|%ai|%s",     # %ai = author date (ISO)
])
```

当传入日期 `2026-05-25` 时，`--since`/`--until` 匹配的是 **committer date**。如果一个 commit 的 author date 是 `2026-05-22`，但通过 rebase/cherry-pick 使得 committer date 变成了 `2026-05-25`，它就会：

1. 被 `--since`/`--until` 放行（committer date 在范围内）
2. 携带 `%ai`（author date `2026-05-22`）出现在输出中
3. 污染当天的事件列表

### 解决方案（已在 generate.py 中实现）

在解析 `%ai` 后做二次日期校验：

```python
dt = datetime.strptime(commit_time[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
if dt < day_start or dt >= day_end:
    continue   # 作者日期不在范围内，跳过
```

### 相关函数

- `collect_git()` — 入口，调用 `git log` 并遍历结果
- `parse_date()` — 生成 `day_start`/`day_end`（北京时间）

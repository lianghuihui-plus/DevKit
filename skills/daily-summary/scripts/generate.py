#!/usr/bin/env python3
"""每日工作总结数据采集脚本。

采集 Git / Cursor / OpenClaw 的事件，输出 JSON 行，由 SKILL.md 中的 Agent
结合 Hermes session_search 结果合并为时间线日报。

用法: python3 generate.py [YYYY-MM-DD]
      默认采集当天。
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 北京时间
TZ = timezone(timedelta(hours=8))


def load_config(skill_dir: Path) -> dict:
    """加载 config.yaml"""
    import yaml  # type: ignore

    config_path = skill_dir / "config.yaml"
    if not config_path.exists():
        print(json.dumps({"error": f"config not found: {config_path}"}))
        sys.exit(1)
    with open(config_path) as f:
        return yaml.safe_load(f)


def parse_date(date_str: str) -> tuple[datetime, datetime]:
    """解析日期字符串，返回当天起止时间（北京时间）"""
    if date_str:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    else:
        dt = datetime.now(TZ)
    start = dt.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=TZ)
    end = start + timedelta(days=1)
    return start, end


# ── Git ────────────────────────────────────────────────────────────


def collect_git(config: dict, day_start: datetime, day_end: datetime) -> list[dict]:
    """采集 Git 提交事件"""
    events = []
    repos = config.get("git", {}).get("repos", [])
    author = config.get("git", {}).get("author", "")

    since = day_start.strftime("%Y-%m-%d 00:00:00")
    until = day_end.strftime("%Y-%m-%d 00:00:00")

    for repo in repos:
        repo_path = os.path.expanduser(repo)
        if not os.path.isdir(os.path.join(repo_path, ".git")):
            continue

        try:
            result = subprocess.run(
                [
                    "git", "-C", repo_path, "log",
                    f"--since={since}",
                    f"--until={until}",
                    f"--author={author}",
                    "--format=%H|%ai|%s",
                ],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                continue

            repo_name = os.path.basename(repo_path)
            for line in result.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|", 2)
                if len(parts) < 3:
                    continue
                commit_hash, commit_time, message = parts
                try:
                    dt = datetime.strptime(
                        commit_time[:19], "%Y-%m-%d %H:%M:%S"
                    ).replace(tzinfo=TZ)
                except ValueError:
                    continue

                events.append({
                    "time": dt.strftime("%H:%M"),
                    "timestamp": dt.isoformat(),
                    "source": "git",
                    "repo": repo_name,
                    "hash": commit_hash[:8],
                    "message": message.strip(),
                    "branch": _git_branch(repo_path, commit_hash),
                    "files": _git_changed_files(repo_path, commit_hash),
                })
        except Exception as e:
            print(f"# git error [{repo}]: {e}", file=sys.stderr)

    return events


def _git_branch(repo_path: str, commit_hash: str) -> str:
    """获取提交所在分支名"""
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "name-rev", "--name-only", commit_hash],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            # "name-rev" returns "master" or "master~1" — keep it simple
            return branch.split("~")[0].split("^")[0]
    except Exception:
        pass
    return ""


def _git_changed_files(repo_path: str, commit_hash: str) -> list[str]:
    """获取提交修改的文件列表"""
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "diff-tree", "--no-commit-id",
             "--name-only", "-r", commit_hash],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return [f for f in result.stdout.strip().split("\n") if f]
    except Exception:
        pass
    return []


# ── Cursor ─────────────────────────────────────────────────────────


def collect_cursor(day_start: datetime, day_end: datetime) -> list[dict]:
    """采集 Cursor 会话事件"""
    events = []
    chats_dir = os.path.expanduser("~/.cursor/chats")
    if not os.path.isdir(chats_dir):
        return events

    for root, dirs, files in os.walk(chats_dir):
        for f in files:
            if f != "store.db":
                continue
            db_path = os.path.join(root, f)

            # 用文件 mtime 作为会话时间
            mtime = os.path.getmtime(db_path)
            dt = datetime.fromtimestamp(mtime, tz=TZ)

            # 过滤当天（按文件 mtime）
            if dt < day_start or dt >= day_end:
                continue

            # 提取标题（第一个真实用户查询）
            title = _cursor_extract_title(db_path)
            if not title:
                continue

            events.append({
                "time": dt.strftime("%H:%M"),
                "timestamp": dt.isoformat(),
                "source": "cursor",
                "title": title,
            })

    return events


def _cursor_extract_title(db_path: str) -> str:
    """从 Cursor store.db 提取第一个用户查询作为标题"""
    try:
        db = sqlite3.connect(db_path)
        rows = db.execute("SELECT data FROM blobs ORDER BY rowid").fetchall()
        db.close()

        found_system_info = False
        for (bdata,) in rows:
            try:
                text = bdata.decode("utf-8", errors="replace")
            except Exception:
                continue

            # 找 JSON 起始位置
            idx = text.find('{"role"')
            if idx < 0:
                idx = text.find('{"role":')
            if idx < 0:
                continue

            try:
                msg = json.loads(text[idx:])
            except json.JSONDecodeError:
                continue

            role = msg.get("role", "")
            content = msg.get("content", "")

            # 跳过 system prompt 和 user_info
            if role == "system":
                continue
            if role == "user":
                # 提取文本
                texts = _extract_texts(content)
                full = "".join(texts)
                if "<user_info>" in full:
                    found_system_info = True
                    continue
                if found_system_info and full.strip():
                    # 找到 <user_query> 内容
                    if "<user_query>" in full:
                        qs = full.find("<user_query>") + len("<user_query>")
                        qe = full.find("</user_query>")
                        if qe > qs:
                            return _clean_title(full[qs:qe].strip()[:100])
                        return _clean_title(full.strip()[:100])
                    return _clean_title(full.strip()[:100])
    except Exception:
        pass
    return ""


def _extract_texts(content) -> list[str]:
    """从 content（str 或 list）提取文本"""
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        ]
    return []


def _clean_title(text: str) -> str:
    """清理标题：去除时间戳前缀、markdown 标题前缀等"""
    import re
    # 去掉 OpenClaw 时间戳前缀 [Day YYYY-MM-DD HH:MM GMT+8]
    text = re.sub(r'^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d+\]\s*', '', text)
    # 去掉开头的 # Role 等 markdown 标题块
    text = re.sub(r'^#\s*(Role|Task|Output Format|Input)\s*\n+', '', text)
    text = re.sub(r'\n*#\s*(Task|Output Format|Input).*$', '', text, flags=re.DOTALL)
    return text.strip()


# ── OpenClaw ───────────────────────────────────────────────────────


def collect_openclaw(day_start: datetime, day_end: datetime) -> list[dict]:
    """采集 OpenClaw 会话事件"""
    events = []
    sessions_path = os.path.expanduser(
        "~/.openclaw/agents/main/sessions/sessions.json"
    )
    if not os.path.isfile(sessions_path):
        return events

    with open(sessions_path) as f:
        sessions = json.load(f)

    for key, sess in sessions.items():
        updated_at = sess.get("updatedAt", 0)
        if not updated_at:
            continue

        dt = datetime.fromtimestamp(updated_at / 1000, tz=TZ)
        if dt < day_start or dt >= day_end:
            continue

        session_file = sess.get("sessionFile", "")
        model = sess.get("model", "")
        tokens = sess.get("totalTokens", 0)

        # 从 jsonl 提取上下文
        title = ""
        assistant_preview = ""
        exchange_count = 0
        if session_file and os.path.isfile(session_file):
            title, assistant_preview, exchange_count = _openclaw_extract_context(session_file)

        events.append({
            "time": dt.strftime("%H:%M"),
            "timestamp": dt.isoformat(),
            "source": "openclaw",
            "title": title,
            "context": assistant_preview,
            "exchanges": exchange_count,
            "model": model,
            "tokens": tokens,
        })

    return events


def _openclaw_extract_context(jsonl_path: str) -> tuple[str, str, int]:
    """从 OpenClaw jsonl 提取标题、助手回复预览、交换轮数"""
    title = ""
    assistant_preview = ""
    user_count = 0
    assistant_count = 0
    try:
        with open(jsonl_path) as f:
            found_first_user = False
            for line in f:
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") != "message":
                    continue
                inner = msg.get("message", {})
                role = inner.get("role", "")
                content = inner.get("content", "")
                texts = _extract_texts(content)
                full = "".join(texts).strip()

                if role == "user":
                    user_count += 1
                    if not found_first_user and full:
                        title = _clean_title(full)[:150]
                        found_first_user = True
                elif role == "assistant":
                    assistant_count += 1
                    if not assistant_preview and full:
                        assistant_preview = full[:200]
    except Exception:
        pass
    return title, assistant_preview, user_count + assistant_count


# ── Main ───────────────────────────────────────────────────────────


def main():
    skill_dir = Path(__file__).resolve().parent.parent
    config = load_config(skill_dir)
    sources = config.get("sources", {})

    date_str = sys.argv[1] if len(sys.argv) > 1 else ""
    day_start, day_end = parse_date(date_str)

    all_events = []

    if sources.get("git", True):
        all_events.extend(collect_git(config, day_start, day_end))

    if sources.get("cursor", True):
        all_events.extend(collect_cursor(day_start, day_end))

    if sources.get("openclaw", True):
        all_events.extend(collect_openclaw(day_start, day_end))

    # 按时间排序
    all_events.sort(key=lambda e: e["time"])

    # 输出 JSON（Hermes 事件由 Agent 在 SKILL.md 流程中通过 session_search 补充）
    print(json.dumps({
        "date": day_start.strftime("%Y-%m-%d"),
        "events": all_events,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

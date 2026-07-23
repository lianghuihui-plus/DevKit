#!/usr/bin/env python3
"""
解析测试团队提供的用例表格（CSV/Excel），提取前置条件和操作步骤。

用法：
  python3 parse-table.py <file.xlsx> [--sheet <name>]

输出：JSON 数组，每条用例包含 title / preconditions / steps。
"""

import csv
import json
import re
import sys
from pathlib import Path
from typing import Optional


def parse_csv(filepath: str) -> list[dict]:
    """解析 CSV 文件。"""
    cases = []
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            case = _extract_case(row)
            if case:
                cases.append(case)
    return cases


def parse_xlsx(filepath: str, sheet_name: Optional[str] = None) -> list[dict]:
    """解析 Excel 文件。"""
    try:
        import openpyxl
    except ImportError:
        print("错误：需要 openpyxl 库。运行: pip install openpyxl", file=sys.stderr)
        sys.exit(1)

    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    ws = wb[sheet_name] if sheet_name else wb.active
    if ws is None:
        wb.close()
        return []

    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []

    # 第一行为表头
    headers = [str(h).strip() if h else "" for h in rows[0]]
    cases = []

    for row in rows[1:]:
        if all(v is None or str(v).strip() == "" for v in row):
            continue
        row_dict = {headers[i]: str(row[i]) if row[i] is not None else "" for i in range(len(headers))}
        case = _extract_case(row_dict)
        if case:
            cases.append(case)

    wb.close()
    return cases


def _extract_case(row: dict) -> Optional[dict]:
    """从一行中提取用例的 title / preconditions / steps。"""
    # 找到对应的列名（支持常见变体）
    title = None
    pre_text = ""
    steps_text = ""

    for key, val in row.items():
        key_lower = key.lower().strip()
        # 标题
        if re.search(r"(用例名称|用例标题|测试点|名称|title)", key_lower) and title is None:
            title = val.strip()
        # 前置条件
        elif re.search(r"前置条件", key_lower):
            pre_text = val.strip()
        # 步骤
        elif re.search(r"(自动化执行步骤|测试步骤|操作步骤|步骤)", key_lower):
            steps_text = val.strip()

    if not title and not steps_text:
        return None

    # 解析前置条件：按换行或序号分隔
    preconditions = _split_lines(pre_text) if pre_text else []

    # 解析步骤：按换行或序号分隔
    steps = _split_lines(steps_text) if steps_text else []

    return {
        "title": title or "(无标题)",
        "preconditions": preconditions,
        "steps": steps,
    }


def _split_lines(text: str) -> list[str]:
    """将多行文本或序号列表拆分为数组。"""
    # 先按换行拆分
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if len(lines) <= 1:
        # 尝试按序号拆分（如 "1. xxx 2. yyy 3. zzz"）
        parts = re.split(r"(?<!\d)(?=\d+[\.\)、])", text)
        lines = [p.strip() for p in parts if p.strip()]
    # 去除序号前缀
    return [re.sub(r"^\d+[\.\)、]\s*", "", l) for l in lines]


def main():
    if len(sys.argv) < 2:
        print("用法: python3 parse-table.py <file.csv|xlsx> [--sheet <name>]", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]
    sheet_name = None

    for i, arg in enumerate(sys.argv[2:], start=2):
        if arg == "--sheet" and i + 1 < len(sys.argv):
            sheet_name = sys.argv[i + 1]

    ext = Path(filepath).suffix.lower()
    if ext == ".csv":
        cases = parse_csv(filepath)
    elif ext in (".xlsx", ".xls"):
        cases = parse_xlsx(filepath, sheet_name)
    else:
        print(f"不支持的文件格式: {ext}，支持 .csv / .xlsx / .xls", file=sys.stderr)
        sys.exit(1)

    output = {
        "source": filepath,
        "total": len(cases),
        "cases": cases,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

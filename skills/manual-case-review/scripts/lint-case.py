#!/usr/bin/env python3
"""
机械检查：对原始人工用例（source.md）执行确定性规则检查。

用法：
  python3 lint-case.py <source.md 文件或目录...>

输出：JSON，每条用例一个对象，包含该用例命中的所有问题。
"""

import json
import re
import sys
from pathlib import Path
from typing import Optional


# ── 检查规则定义 ──

def parse_source_md(filepath: str) -> Optional[dict]:
    """解析 source.md，提取前置条件和步骤列表。"""
    try:
        text = Path(filepath).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    result = {"file": filepath, "preconditions": [], "steps": [], "title": ""}

    # 提取标题
    title_match = re.match(r"^#\s+(.+)$", text, re.MULTILINE)
    if title_match:
        result["title"] = title_match.group(1).strip()

    # 提取前置条件
    pre_section = re.search(
        r"##\s*前置条件\s*\n(.*?)(?=\n##\s|\Z)", text, re.DOTALL
    )
    if pre_section:
        pre_text = pre_section.group(1)
        result["preconditions"] = [
            re.sub(r"^\d+[\.\)、]\s*", "", line.strip())
            for line in pre_text.strip().split("\n")
            if line.strip() and not line.strip().startswith("#")
        ]

    # 提取步骤
    step_section = re.search(
        r"##\s*(?:步骤|测试步骤)\s*\n(.*?)(?=\n##\s|\Z)", text, re.DOTALL
    )
    if step_section:
        step_text = step_section.group(1)
        result["steps"] = [
            re.sub(r"^\d+[\.\)、]\s*", "", line.strip())
            for line in step_text.strip().split("\n")
            if line.strip() and not line.strip().startswith("#")
        ]

    return result


# ── P0 规则 ──

def check_po001_pre_step_contradiction(case: dict) -> list[dict]:
    """PO-001：前置条件与步骤起点矛盾。"""
    findings = []
    pre_text = " ".join(case.get("preconditions", []))
    steps = case.get("steps", [])
    if not steps:
        return findings

    first_step = steps[0]

    already_patterns = [
        r"已在", r"已进入", r"已登录到", r"当前在"
    ]
    cold_start_patterns = [
        r"启动", r"打开.*[Aa]pp", r"打开.*应用", r"冷启动"
    ]

    pre_has_already = any(re.search(p, pre_text) for p in already_patterns)
    step_is_cold_start = any(re.search(p, first_step) for p in cold_start_patterns)

    if pre_has_already and step_is_cold_start:
        findings.append({
            "rule": "PO-001",
            "severity": "P0",
            "category": "前置条件",
            "title": "前置条件与步骤起点矛盾",
            "detail": f"前置声明已处于某页面，但步骤从冷启动开始。",
            "preconditions": case.get("preconditions", []),
            "first_step": first_step,
            "suggestion": "将前置条件改为步骤真实的起点（如'测试账号已登录'），或将步骤改为从已声明的页面开始。",
        })

    return findings


def check_po002_missing_precondition(case: dict) -> list[dict]:
    """PO-002：缺少必要的前置条件（需要登录但未声明）。"""
    findings = []
    pre_text = " ".join(case.get("preconditions", []))
    steps_text = " ".join(case.get("steps", []))

    has_login = re.search(r"已登录|用户已登录|账号已登录", pre_text)
    is_logged_out = re.search(r"未登录|未注册", pre_text)

    # 已声明登录或明确测试未登录场景，不触发
    if has_login or is_logged_out:
        return findings

    # 需要登录的强信号：访问个人数据或需要鉴权的页面
    needs_login_patterns = [
        r"我的作品",
        r"学习中心",
        r"课程详情",
        r"登录",
        r"创作.*TAB",
        r"课程.*TAB",
        r"自动化课包",
        r"自动化班级",
        r"kittenN.*作品",
        r"源码精灵",
        r"视频打卡",
        r"提交作业",
    ]
    step_needs_login = any(re.search(p, steps_text) for p in needs_login_patterns)

    if step_needs_login:
        findings.append({
            "rule": "PO-002",
            "severity": "P0",
            "category": "前置条件",
            "title": "缺少必要前置条件",
            "detail": "步骤涉及需要登录后访问的功能，但前置条件未声明已登录。",
            "suggestion": "添加前置条件：测试账号已登录。如测试未登录场景则改为'用户未登录'。",
        })

    return findings


def check_st001_trailing_redundant(case: dict) -> list[dict]:
    """ST-001：末尾冗余系统检查。"""
    findings = []
    steps = case.get("steps", [])
    if len(steps) < 2:
        return findings

    last_two = steps[-2:]
    crash_pattern = re.compile(r"(未闪退|控制台.*异常|无.*异常)")
    save_pattern = re.compile(r"(保存.*截图|保存.*XML|保存.*日志|截图.*日志)")

    crash_found = any(crash_pattern.search(s) for s in last_two)
    save_found = any(save_pattern.search(s) for s in last_two)

    if crash_found or save_found:
        matched = [s for s in last_two if crash_pattern.search(s) or save_pattern.search(s)]
        findings.append({
            "rule": "ST-001",
            "severity": "P0",
            "category": "操作步骤",
            "title": "末尾冗余系统检查",
            "detail": f"末尾包含 {'和'.join([m[:40] for m in matched])}",
            "matched_steps": matched,
            "suggestion": "删除末尾冗余步骤。'控制台无异常'无法通过截图验证；'保存截图/XML'由 observe.sh 自动完成。",
        })

    return findings


def check_st002_duplicate_steps(case: dict) -> list[dict]:
    """ST-002：步骤重复/冗余。"""
    findings = []
    steps = case.get("steps", [])
    if len(steps) < 2:
        return findings

    for i in range(len(steps) - 1):
        a = steps[i]
        b = steps[i + 1]

        # 跳过断言类步骤
        if re.search(r"(检查|预期|确认)", a) or re.search(r"(检查|预期|确认)", b):
            continue
        # 等待步骤不参与比较
        if "等待" in a or "等待" in b:
            continue

        # 简单相似度：提取中文和英文词（英文转小写避免大小写差异）
        words_a = set(w.lower() for w in re.findall(r"[\u4e00-\u9fff]+|[a-zA-Z]+", a))
        words_b = set(w.lower() for w in re.findall(r"[\u4e00-\u9fff]+|[a-zA-Z]+", b))
        if not words_a or not words_b:
            continue

        intersection = words_a & words_b
        union = words_a | words_b
        similarity = len(intersection) / len(union) if union else 0

        if similarity > 0.7:
            findings.append({
                "rule": "ST-002",
                "severity": "P0",
                "category": "操作步骤",
                "title": "步骤重复",
                "detail": f"步骤{i+1}和步骤{i+2}高度相似（相似度 {similarity:.0%}）",
                "step_a": a,
                "step_b": b,
                "suggestion": f"合并为一条步骤：{a}",
            })

    return findings


# ── P1 规则 ──

def check_po003_useless_placeholder(case: dict) -> list[dict]:
    """PO-003："无额外业务前置条件"占位冗余。"""
    findings = []
    for pre in case.get("preconditions", []):
        if "无额外业务前置条件" in pre:
            findings.append({
                "rule": "PO-003",
                "severity": "P1",
                "category": "前置条件",
                "title": "占位文本冗余",
                "detail": f'前置条件含"无额外业务前置条件"',
                "suggestion": "直接删除此行。如果没有业务前置条件就留空。",
            })
    return findings


def check_po004_env_in_precondition(case: dict) -> list[dict]:
    """PO-004：前置条件混入环境/脚本条件。"""
    findings = []
    env_keywords = ["设备", "系统版本", "网络", "接口响应", "Android", "iOS"]
    for pre in case.get("preconditions", []):
        for kw in env_keywords:
            if kw in pre:
                findings.append({
                    "rule": "PO-004",
                    "severity": "P1",
                    "category": "前置条件",
                    "title": "混入环境/脚本条件",
                    "detail": f'前置条件"{pre}"含环境相关关键词"{kw}"',
                    "suggestion": "移除此条前置条件。设备型号、网络状态由 MAVT 环境探测（probe-env.sh）处理。",
                })
                break
    return findings


def check_st003_passive_as_step(case: dict) -> list[dict]:
    """ST-003：被动描述当步骤。"""
    findings = []
    passive_patterns = [
        (r"^观察", "观察"),
        (r"^查看(?!.*按钮|.*页面|.*内容)", "查看"),
        (r"^出现(?!.*弹窗)", "出现"),
        (r"^记录", "记录"),
    ]
    for i, step in enumerate(case.get("steps", [])):
        for pattern, label in passive_patterns:
            if re.search(pattern, step):
                findings.append({
                    "rule": "ST-003",
                    "severity": "P1",
                    "category": "操作步骤",
                    "title": "被动描述当步骤",
                    "detail": f'步骤{i+1}以"{label}"开头，非可执行动作。',
                    "step": step,
                    "suggestion": f'将"{label}"改为具体操作，如"定位XX区域"或"确认XX展示"。',
                })
                break
    return findings


def check_st004_conditional_branch(case: dict) -> list[dict]:
    """ST-004：条件分支嵌入步骤。"""
    findings = []
    branch_pattern = re.compile(r"(如果.*则|若.*则|若未.*则)")
    for i, step in enumerate(case.get("steps", [])):
        if branch_pattern.search(step):
            findings.append({
                "rule": "ST-004",
                "severity": "P1",
                "category": "操作步骤",
                "title": "条件分支嵌入步骤",
                "detail": f"步骤{i+1}含条件分支：{step[:60]}",
                "step": step,
                "suggestion": "拆为两条独立用例或通过 globalRules 处理条件逻辑。",
            })
    return findings


def check_st005_vague_assertion(case: dict) -> list[dict]:
    """ST-005：断言模糊。"""
    findings = []
    # 匹配断言行
    assertion_pattern = re.compile(r"(检查|预期)[：:]")

    # 模糊断言模式
    vague_patterns = [
        (r"成功登录", "成功登录", "底部导航栏显示'首页/课程/创作/我的'，左上角显示用户头像"),
        (r"进入.*二级页面$", "进入二级页面", "页面顶部展示XX标题，底部展示输入框"),
        (r"离开.*页面$", "离开页面", "页面回到上一级，展示XX内容"),
        (r"页面.*正常", "页面正常", "具体列出应展示的元素"),
        (r"正确(找到|进入)", "正确找到/进入", "具体指明确认标准"),
        (r"成功(进入|打开)", "成功进入/打开", "页面展示XX内容"),
        (r"数据.*正常", "数据正常显示", "界面上具体可见的数据项"),
    ]

    for i, step in enumerate(case.get("steps", [])):
        if not assertion_pattern.search(step):
            continue
        for pattern, label, suggestion in vague_patterns:
            if re.search(pattern, step):
                findings.append({
                    "rule": "ST-005",
                    "severity": "P1",
                    "category": "操作步骤",
                    "title": "断言模糊",
                    "detail": f'步骤{i+1}"{step[:60]}"中的"{label}"缺少可观察的视觉信号。',
                    "step": step,
                    "suggestion": f"改为具体可观察元素，如：{suggestion}",
                })
                break
    return findings


def check_st006_imprecise_location(case: dict) -> list[dict]:
    """ST-006：定位不精确。"""
    findings = []
    # 操作类步骤 + 模糊定位词
    action_pattern = re.compile(r"(点击|滑动|输入|找到|查找)")
    imprecise_pattern = re.compile(r"(任意|对应|相关|某个|相应的|找到)")

    for i, step in enumerate(case.get("steps", [])):
        if action_pattern.search(step) and imprecise_pattern.search(step):
            findings.append({
                "rule": "ST-006",
                "severity": "P1",
                "category": "操作步骤",
                "title": "定位不精确",
                "detail": f'步骤{i+1}"{step[:80]}"含模糊定位词。',
                "step": step,
                "suggestion": "将模糊定位改为精确的名称/文本引用，如将'找到含有XX的卡片'改为'点击名称为XX的卡片'。",
            })
    return findings


def check_st007_missing_intermediate_steps(case: dict) -> list[dict]:
    """ST-007：步骤缺失中间操作。"""
    findings = []
    pre_text = " ".join(case.get("preconditions", []))
    steps = case.get("steps", [])

    already = re.search(r"(已在|已进入|已登录到)", pre_text)
    if not already:
        return findings

    # 检查步骤是否包含到目标页面的导航
    has_navigation = any(
        re.search(r"(点击.*TAB|点击.*入口|点击.*菜单|点击.*模块|滑动|滚动)", s)
        for s in steps
    )

    if not has_navigation:
        findings.append({
            "rule": "ST-007",
            "severity": "P1",
            "category": "操作步骤",
            "title": "步骤缺失中间操作",
            "detail": "前置条件声明已处目标页面，但步骤缺少从启动到该页面的导航链。",
            "preconditions": case.get("preconditions", []),
            "steps_count": len(steps),
            "suggestion": "补充从启动App到目标页面的完整导航步骤，或调整前置条件为真实的初始状态。",
        })

    return findings


def check_st009_missing_wait(case: dict) -> list[dict]:
    """ST-009：缺少必要的等待步骤。"""
    findings = []
    steps = case.get("steps", [])

    # 触发网络/页面跳转的动作关键词
    page_action_keywords = ["点击", "滑动", "输入.*登录", "进入"]
    # 不需要等待的瞬时动作
    skip_keywords = [
        "退出", "关闭", "取消", "返回", "删除", "复制",
        "是", "否", "确认", "同意",
    ]

    for i in range(len(steps) - 1):
        curr = steps[i]
        next_step = steps[i + 1]

        # 跳过：当前是等待/加载/断言步骤
        if re.search(r"等待|加载|检查|预期|确认$", curr):
            continue
        # 下一步不是断言
        if not re.search(r"(检查|预期|确认)", next_step):
            continue

        # 是瞬时UI操作，不需要等待
        if any(kw in curr for kw in skip_keywords):
            continue

        # 当前是可能触发页面跳转的操作
        if any(re.search(kw, curr) for kw in page_action_keywords):
            findings.append({
                "rule": "ST-009",
                "severity": "P1",
                "category": "操作步骤",
                "title": "缺少等待步骤",
                "detail": f'步骤{i+1}"{curr[:50]}"后直接断言，可能触发页面加载但未留等待时间。',
                "step_before": curr,
                "step_after": next_step,
                "suggestion": f'在步骤{i+1}和步骤{i+2}之间插入"等待XX加载完成"。如为瞬时UI变化则忽略。',
            })

    return findings


# ── P2 规则 ──

def check_st008_check_to_expected(case: dict) -> list[dict]:
    """ST-008："检查："未统一为"预期："。"""
    findings = []
    # ST-001 冗余步骤模式：已被 ST-001 标记删除的，不再报 ST-008
    redundant_pattern = re.compile(
        r"(未闪退|控制台.*异常|无.*异常|保存.*截图|保存.*XML|保存.*日志|截图.*日志)"
    )
    for i, step in enumerate(case.get("steps", [])):
        if not (step.startswith("检查：") or step.startswith("检查:")):
            continue
        # 跳过已被 ST-001 标记删除的冗余步骤
        if redundant_pattern.search(step):
            continue
        findings.append({
            "rule": "ST-008",
            "severity": "P2",
            "category": "操作步骤",
            "title": '"检查："未统一为"预期："',
            "detail": f'步骤{i+1}使用"检查："而非"预期："。',
            "step": step,
            "suggestion": f"改为：预期：{step[3:].lstrip('：:')}",
        })
    return findings


# ── 主流程 ──

ALL_CHECKS = [
    # P0
    check_po001_pre_step_contradiction,
    check_po002_missing_precondition,
    check_st001_trailing_redundant,
    check_st002_duplicate_steps,
    # P1
    check_po003_useless_placeholder,
    check_po004_env_in_precondition,
    check_st003_passive_as_step,
    check_st004_conditional_branch,
    check_st005_vague_assertion,
    check_st006_imprecise_location,
    check_st007_missing_intermediate_steps,
    check_st009_missing_wait,
    # P2
    check_st008_check_to_expected,
]


def lint_file(filepath: str) -> dict:
    """对单个 source.md 执行所有检查。"""
    case = parse_source_md(filepath)
    if case is None:
        return {"file": filepath, "error": "无法读取或解析文件", "findings": []}

    findings = []
    for check_fn in ALL_CHECKS:
        findings.extend(check_fn(case))

    case_name = case.get("title", Path(filepath).parent.name if "/" in filepath else Path(filepath).stem)
    return {
        "file": filepath,
        "case_name": case_name,
        "precondition_count": len(case.get("preconditions", [])),
        "step_count": len(case.get("steps", [])),
        "findings": findings,
    }


def main():
    if len(sys.argv) < 2:
        print("用法: python3 lint-case.py <source.md 文件或目录...>", file=sys.stderr)
        sys.exit(1)

    paths = []
    for arg in sys.argv[1:]:
        p = Path(arg)
        if p.is_dir():
            paths.extend(sorted(p.rglob("source.md")))
        elif p.is_file():
            paths.append(p)

    if not paths:
        print("未找到 source.md 文件", file=sys.stderr)
        sys.exit(1)

    results = []
    for p in paths:
        results.append(lint_file(str(p)))

    # 统计
    total_findings = sum(len(r.get("findings", [])) for r in results)
    p0 = sum(
        1 for r in results
        for f in r.get("findings", [])
        if f.get("severity") == "P0"
    )
    p1 = sum(
        1 for r in results
        for f in r.get("findings", [])
        if f.get("severity") == "P1"
    )
    p2 = sum(
        1 for r in results
        for f in r.get("findings", [])
        if f.get("severity") == "P2"
    )

    output = {
        "summary": {
            "total_cases": len(results),
            "total_findings": total_findings,
            "p0_count": p0,
            "p1_count": p1,
            "p2_count": p2,
        },
        "results": results,
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

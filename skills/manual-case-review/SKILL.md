---
name: manual-case-review
description: 对测试团队提供的原始人工用例（表格/CSV/Excel 或 source.md）进行前置质量审查，在生成 MAVT MD 用例前发现前置条件与操作步骤的质量问题，输出 HTML 审查报告。
---

# 人工用例前置质量审查

## 何时使用

- 测试团队交付用例表格（CSV/Excel），需要在生成 `source.md` 和 MAVT 用例前审查质量。
- 用户要求对已解出的 `source.md` 目录做质量检查。
- 位置：**测试团队表格 → manual-case-review → mavt-case-gen → MAVT 执行** 管线的前置检查环节。

## 审查范围

仅审查两个字段：

- **前置条件**：是否与步骤起点矛盾、是否缺必要声明、占位冗余、是否混入环境条件
- **操作步骤**：末尾冗余、步骤重复、被动描述、条件分支、断言模糊、定位不精、步骤缺失、缺少等待、格式问题

不审查：标题、模块、功能、优先级、备注、序号标点等不影响 MAVT 执行的字段。

完整问题清单见 `references/problem-checklist.md`。

## 执行流程

### 第一步：确认输入源

**必须先向用户确认输入路径**，不得自行扫描或猜测。

用户需提供以下之一：
- CSV/Excel 表格文件路径 → 用 `scripts/parse-table.py` 解析
- source.md 所在目录路径 → 直接用 `scripts/lint-case.py` 批量解析

确认后再解析输入。表格列映射如下：
|---|---|
| 用例名称 | 识别编号用 |
| 前置条件 | 前置条件列表 |
| 自动化执行步骤 | 步骤列表 |
| 脚本前置数据 | **忽略**（由 `probe-env.sh` 处理） |
| 模块/功能/优先级/备注 | **忽略** |

**source.md 目录**：直接用 `scripts/lint-case.py` 批量解析。

### 第二步：逐条检查

**机械检查**（`scripts/lint-case.py`）：运行确定性规则，输出结构化 JSON。覆盖以下规则：

| 规则 | 严重度 | 检查内容 |
|---|---|---|
| PO-001 | P0 | 前置"已在X页面"但步骤从冷启动开始 |
| PO-002 | P0 | 步骤需登录但前置未声明 |
| ST-001 | P0 | 末尾"App未闪退"+"保存截图/XML" |
| ST-002 | P0 | 连续步骤高度相似 |
| PO-003 | P1 | "无额外业务前置条件"占位 |
| PO-004 | P1 | 前置含设备/网络/接口等环境条件 |
| ST-003 | P1 | 步骤以"观察""查看""出现""记录"开头 |
| ST-004 | P1 | 步骤含"如果...则""若未...则"条件分支 |
| ST-005 | P1 | 断言含"成功登录""页面正常"等模糊表述 |
| ST-006 | P1 | 操作步骤含"任意""对应""找到"等模糊定位 |
| ST-007 | P1 | 前置声明已在目标页但步骤缺导航链 |
| ST-009 | P1 | 操作后缺等待步骤直接断言 |
| ST-008 | P2 | 断言以"检查："开头未改为"预期：" |

用法：
```bash
python3 scripts/lint-case.py <source.md 文件或目录...>
```

**语义检查**（LLM）：在机械检查结果基础上，逐批（每批 20 条）审查。硬约束：

- **禁止重复机械规则已覆盖的问题**。机械规则已报 ST-005（断言模糊）的步骤，不再报 SEM-001；已报 ST-006（定位不精）的不再报 SEM-003；已报 PO-001（前置矛盾）的不再报 SEM-002。只检查机械规则未覆盖的步骤。
- **修复建议必须针对具体用例**，写出实际应出现的页面元素、标题、按钮文案。禁止输出含 `XX` 占位的模板语句（如"页面展示XX标题"）。**同一条用例中多条相似步骤的修复建议必须各自独立，针对各自步骤的具体内容给出不同建议，禁止共用同一条建议**。
- 三条审查维度：
  - 断言是否能被截图验证（补充具体可观察元素，如"底部导航栏显示'首页/课程/创作/我的'"而非"成功登录"）
  - 步骤链是否完整（补充中间导航步骤）
  - 定位描述是否可在界面上唯一确定目标

### 第三步：生成报告

将机械检查 + 语义检查结果合并，**按严重度排序（P0 → P1 → P2）**，同严重度内按规则编号排序，生成报告文件夹放在输入源所在目录：

- `manual-case-review-report/` — 报告文件夹
  - `index.html` — 可视化审查报告，适合人看
  - `report.md` — 结构化文本报告，适合 AI 读取

## 报告模板

HTML 报告模板见 `references/html-template.html`。使用 `{{PLACEHOLDER}}` 变量替换：

- `{{TIME}}`, `{{SOURCE}}`, `{{TOTAL_CASES}}`, `{{P0_COUNT}}`, `{{P1_COUNT}}`, `{{P2_COUNT}}` — 概览数据
- `{{CASE_CARDS}}` — 替换为每条用例的详情卡片 HTML

每条用例卡片片段：

```html
<div class="case-card">
  <div class="case-header">
    <span class="arrow">▶</span>
    <span class="title">{{CASE_TITLE}}</span>
    <span class="badge p0">P0×{{P0}}</span>
    <span class="badge p1">P1×{{P1}}</span>
    <span class="badge p2">P2×{{P2}}</span>
  </div>
  <div class="case-body">
    <div class="section-title">前置条件</div>
    <div class="pre-text">{{PRECONDITIONS}}</div>
    <div class="section-title">操作步骤</div>
    <div class="step-text">{{STEPS}}</div>
    <div class="section-title">问题详情</div>
    {{ISSUES}}
  </div>
</div>
```

每条问题片段：

```html
<div class="issue {{SEVERITY}}">
  <div class="issue-header">
    <span class="badge {{SEVERITY}}">{{SEVERITY}}</span>
    <span class="issue-type">{{RULE}} — {{TITLE}}</span>
  </div>
  <div>{{DETAIL}}</div>
  <div class="suggestion">{{SUGGESTION}}</div>
</div>
```

## 与 mavt-case-gen 的协作

- `manual-case-review` 在 **生成前** 拦截表格质量问题
- `mavt-case-gen` 在 **生成后** 审查 MD 用例质量问题（`references/quality-analysis-patterns.md`）
- 两份报告可互相参照：本 skill 的问题清单是 `mavt-case-gen` 质量分析规则的超集

## MD 报告模板

```markdown
# 人工用例质量审查报告

> 审查时间：{{TIME}} | 来源：{{SOURCE}} | 总用例数：{{TOTAL_CASES}}

## 概览

| 指标 | 数值 |
|---|---|
| 总用例数 | {{TOTAL_CASES}} |
| 有问题用例数 | {{AFFECTED_CASES}} |
| P0 阻断 | {{P0_COUNT}} |
| P1 可执行性 | {{P1_COUNT}} |
| P2 格式规范 | {{P2_COUNT}} |

## 问题分布

| 用例 | P0 | P1 | P2 |
|---|---|---|---|
{{CASE_SUMMARY_ROWS}}

## 逐条详情

### {{CASE_TITLE}}
- **编号**：{{CASE_ID}}
- **来源**：{{SOURCE_FILE}}
- **问题数**：P0×{{P0}} P1×{{P1}} P2×{{P2}}

**前置条件**：
{{PRECONDITIONS}}

**操作步骤**：
{{STEPS}}

| 严重度 | 规则 | 问题 | 修复建议 |
|---|---|---|---|
{{ISSUE_ROWS}}
```

每条问题的行格式：
```
| P0 | PO-001 | 前置条件"已在X页面"与步骤1"启动App"矛盾 | 将前置条件改为"测试账号已登录" |
```

## 铁律

- 只审查前置条件和操作步骤，不改动其他字段
- 机械检查跑脚本，语义检查逐批 20 条
- 报告文件夹 `manual-case-review-report/` 放在输入源所在目录，包含 `index.html` 和 `report.md`
- 不修改原始表格或 source.md，只输出报告

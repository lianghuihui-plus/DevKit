---
name: harmony-ui-test-runner
description: 鸿蒙 UI 测试用例执行。在工作空间中，读取 YAML 用例，上设备执行操作并断言，产出测试报告。
version: 1.0.0
author: cm
---

# 鸿蒙 UI 测试用例执行

> 读 YAML → 上设备执行 → 断言 → 报告 → 落盘 workspace。

## 前置条件

- 当前目录为 UITestWorkspace-*（或其子目录）
- 已通过 session 创建或恢复 workspace 上下文（`CONTEXT.md` 存在，且 `AGENT.md` 已加载）
- `test-plans/` 下有 YAML 文件

## 数据边界

| 文件 | 职责 |
|------|------|
| `test-plans/*.yaml` | 测试意图来源 |
| `explorations/<page>/exploration.md` | 页面经验来源；只自动应用 `已验证修正` |
| `explorations/<page>/layoutTree.json` | 历史证据快照；实际执行以实时 dumpLayout 为准 |
| `explorations/<page>/success-paths/*.jsonl` | 成功路径缓存；只做 fast path，复用前实时校验 |
| `test-records.json` | 机器运行状态唯一事实源；每轮原子更新 |
| `test-records.md` | 人工总览；由 runner 根据 JSON 覆盖刷新 |
| `CONTEXT.md` | 只追加跨页面导航和全局问题 |

## 产物格式

| 产物 | 命名 / 位置 | 写入规则 |
|------|-------------|----------|
| 测试报告 | `test-reports/<timestamp>.md` | 每轮执行写入，包含概要、结果、失败详情、缓存和 records 摘要 |
| 运行状态 | `test-records.json` | 每个 YAML 开始 / 结束都原子更新 |
| 人工总览 | `test-records.md` | 每个 YAML 结束后刷新，批量结束再刷新一次 |
| 成功路径 | `explorations/<page>/success-paths/<yaml-basename>.jsonl` | 仅单个 YAML 完整通过后覆盖写入 |
| 页面经验 | `explorations/<page>/exploration.md` | 只增量写页面级发现、已验证修正、失败尝试 |

人类会直接打开阅读的产物必须带简短说明：
- `test-reports/<timestamp>.md` 顶部写 `## 阅读说明`，解释本报告、records 和 success-path 的关系。
- `test-records.md` 顶部写 `## 阅读说明`，说明它是人工总览、会被覆盖，机器事实源是 `test-records.json`。
- runner 新建 `exploration.md` 时必须包含 `## 阅读说明`。

## 执行流程

---

### Step 1：定位 workspace

向上查找 `UITestWorkspace-*` 目录 → 找不到 → 提示"先执行 session 新建或进入工作空间"。

定位成功后，确认当前 workspace 已由 session 创建或恢复。后续设备检查、hdc 执行、自动修复、records 更新和报告写入必须遵守 `AGENT.md` 约束；特别是"遇阻先读代码"、"超限记录"、success-path 复用边界和 test-records 写入规则。

---

### Step 2：选择用例

列出 `test-plans/` 下的 YAML 文件，让用户选择要执行的。若存在 `test-records.json`，同时展示 status / passStreak / lastRunAt；若不存在，先按 session 初始格式创建。

```
test-plans/
  1. accountLoginPage-1.yaml
  2. accountLoginPage-2.yaml
  3. settingsPage-1.yaml

要执行哪些？（输入序号，如 1,3 或 all）
```

`all` 模式选择规则：
- 默认按文件名稳定排序执行，保证重复运行顺序一致。
- 可展示 status 分组：`stale / failing / auto_generated / verified / trusted`，但不自动跳过 trusted；是否只跑未验证用例由用户明确选择。
- 每个 YAML 执行开始前都写入 `lastAttempt.result="running"`；每个 YAML 结束后立刻刷新 `test-records.json` 和 `test-records.md`，不要等整个批次结束。

启动后执行原则：
- 用户选择范围并启动后，runner 不再因单个 YAML 询问重试、跳过或终止。
- 单个 YAML 的结构错误、hash 不一致、数据错误、定位失败或断言失败都按失败记录到 report / records，然后处理后续 YAML。
- 只有设备断开、App 无法启动、连续无法 dumpLayout 等 fatal 设备问题才停止批量流水线；停止前必须写入当前 report、records 和恢复信息。

恢复检查：
- 读取 `test-records.json`，查找 `lastAttempt.result="running"` 且无 `endedAt` 的记录。
- 发现上次中断记录时，展示对应 YAML、startedAt、lastReport；标记为上次中断，不自动复用上次运行时页面状态。
- 继续执行时必须重新检查设备、App 前台和实时 dumpLayout。

---

### Step 3：环境准备

> 读取 `CONTEXT.md` 的 `## 项目` 获取 Bundle / Product（hdc 命令需要）。
> 加载 workspace 的 `references/device-setup.md`，按步骤检查设备连接、启动守护进程、确认 App 已安装。
> 读取 `CONTEXT.md` 的 `## 记录`，了解已知的设备特性与陷阱。
> 每个 YAML 执行前必须启动 App 或确认 App 已在前台，并通过 dumpLayout 确认当前页面状态；无法确认固定起点时，不尝试 success-path。

展示执行计划和环境摘要；用户启动后按自动化执行原则运行。

---

### Step 4：执行

**逐文件串行执行**。`all` 模式下，用例级失败不阻断后续 YAML；fatal 设备问题除外。

> **核心规则**
> **A. 遇阻先读代码**：dump 失败/异常 → 读源码，不盲重试
> **B. 超限记录**：同一目标重试 3 次无果 → 当前 YAML 记录为失败 / blocked，批量继续后续 YAML

#### 4.1 读取 YAML

解析 YAML，提取 `caseId`、`target`、`source`、`sourceHash`、`navigation`、`precondition`、`steps`。同时计算当前 YAML 原始字节 `sha256`，用于 success-path 和 `test-records.json`。

每个 YAML 开始执行时必须初始化本轮内存态 `successPathBuffer`：
- `successPathBuffer` 只保存本 YAML 本次真实执行成功的 `checkpoint` / `command` 节点。
- fast path 和常规智能执行都写入同一个 buffer；fast path 节点通过实时校验后也要重新采集本轮证据。
- `successPathBuffer` 不落盘半成品；只有整个 YAML 通过后才可写入 JSONL。
- buffer 初始化、节点数和最终写入状态必须出现在本轮 report 的“成功路径缓存”表中。

**结构判定**：
- step 使用 `action.kind` → 按结构化 YAML 执行。
- step 使用字符串 `action` → 按历史字符串写法兼容执行。
- 同一个 YAML 不应混用结构化 action 和字符串 action；混用时停止该 YAML，记录为 `caseFailure`。

**执行前校验**：
- YAML 必须包含 `target`、非空 `navigation` 和非空 `steps`。
- 结构化 YAML 必须包含非空 `caseId`、`source` 和 `sourceHash`；历史字符串写法可缺失。
- 结构化 YAML 必须同步校验 `sourceHash`；源文件不存在或 hash 不一致时，当前 YAML 记录为 `staleSource` 失败并跳过执行，不复用 success-path，不中断其他 YAML。
- 结构化 YAML 每个 step 必须有非空 `action.kind`；历史字符串写法每个 step 必须有非空字符串 `action`。
- 结构化 YAML 的 `assert` 必须是对象或对象数组；历史字符串写法的 `assert` 允许字符串或字符串数组。
- 找不到 exploration 时允许继续实时探索，但报告中需记录本次缺少页面经验缓存。

**records 主键**：
- 若 YAML 有 `caseId`，用 `caseId` 作为 `test-records.json.cases` 主键。
- 若 YAML 没有 `caseId`（历史字符串写法），使用 YAML 相对路径作为临时主键；后续迁移为结构化 YAML 后再改用稳定 `caseId`。
- 每个 YAML 开始执行前，先原子更新 `lastAttempt.startedAt` 和 `lastAttempt.result="running"`。

#### 4.2 读取页面经验和成功路径（如有）

`explorations/<page>/` 下可能有 `exploration.md`、`layoutTree.json` 和 `success-paths/<yaml-basename>.jsonl`；workspace 根目录可能有 `test-records.json`：

- `navigation`：优先用 YAML 中的；YAML 中没有则用 exploration 的
- `layoutTree.json`：作为历史证据快照，对照了解页面控件结构，不作为当前状态事实
- `exploration.md` 的"控件定位"：辅助判断同类控件的目标归属
- `exploration.md` 的"状态规律"：辅助判断按钮 enabled、Toast、跳转等业务结果
- `exploration.md` 的"弹窗与遮挡"：执行前先处理已知陷阱
- `exploration.md` 的"已验证修正"：可自动应用；"失败尝试记录"只用于复盘，不能当作自动修复策略
- `success-paths/<yaml-basename>.jsonl`：若存在，作为本次执行的优先 fast path；若校验失败，立即回退到常规智能定位流程，不询问用户。
- `test-records.json`：读取当前用例的 `status`、`yamlHash`、`passStreak`、`successPath`、`lastFailure`；`yamlHash` 不匹配时只禁用 fast path 并记录本轮缓存失效原因，不立即改写长期 `status`。

**成功路径读取规则**：
- 第一行可为 `type="meta"` 的元信息，至少关注 `yamlHash`、`bundle`、`product`、`device`、`fixedStartAnchors`、`createdAt`。
- `yamlHash` 计算方式固定为：对 YAML 文件原始字节内容计算 `sha256`，文件路径、格式化后的 YAML 和运行时补充信息不参与 hash。
- `yamlHash` 与当前 YAML 内容不一致时，不复用成功路径，但可参考其中的 target 描述。
- Bundle / Product 不一致时，不复用成功路径。
- `fixedStartAnchors` 是 success-path 固定起点的结构化锚点；缺失或无法实时命中时，不复用成功路径。
- Device 不一致时可以降级复用，但必须更严格校验页面锚点和目标控件。

**records / hash 决策**：
- `yamlHash` 变化 → 禁用 success-path，在 `lastAttempt` / report 记录缓存失效原因，走常规智能执行；只有本次执行失败或 `sourceHash` 不一致时才将长期 `status` 写为 `stale/failing/blocked`。
- `sourceHash` 变化 → 当前 YAML 记录为 `staleSource` 失败，建议重新执行 case-gen；禁用 success-path，不继续执行该 YAML。
- `explorationHash` 变化 → 禁用 fast path 一次，常规执行通过后刷新 records 和 success-path。
- Bundle / Product 变化 → 禁用 success-path，记录环境差异；若当前环境仍可启动并命中目标 App，则常规执行，否则记录 `fatalDeviceIssue`。
- Device 变化 → 可降级复用，但必须更严格校验页面锚点和目标控件。
- 历史字符串写法没有 `caseId` 时，records 只做运行状态记录，不强制迁移 YAML。

#### 4.3 选择执行策略

每个 YAML 的执行起点固定为：App 已启动 / 已切到前台，设备环境检查完成，且尚未执行本 YAML 的第一个 navigation 操作。

- 优先冷启动或重新拉起 EntryAbility；如果只能热启动，必须通过 back、重新打开入口或已知 deeplink 恢复到 success-path meta 中记录的 `fixedStartAnchors`。
- 启动后立即 dumpLayout，记录当前页面锚点、弹窗、键盘状态；如果存在全局弹窗，按 `CONTEXT.md` / `exploration.md` 已知规则清理。
- 无法确认 App 前台状态、`fixedStartAnchors` 或当前页面 dumpLayout 时，不尝试 success-path，直接进入常规智能执行；仍无法恢复时记录设备问题。
- 有可用 success-path → 先尝试 4.4 的完整 fast path。
- success-path 缺失、失效或中途校验失败 → 进入 4.5 至 4.7 的常规智能执行流程。
- fast path 完整通过后，不再重复执行常规 navigation / precondition / steps。
- fast path 中途失败时，不继续硬套后续缓存记录，从固定起点重新进入常规智能执行流程；如无法回到固定起点，当前 YAML 记录为 blocked 或设备问题。
- 无论选择 fast path 还是常规智能执行，都必须持续采集本轮 `successPathBuffer`；不得因为使用了已有 success-path 就跳过采集。

#### 4.4 成功路径 fast path

若存在可用的 `success-paths/<yaml-basename>.jsonl`，优先尝试按节点粒度复用：

1. 按 JSONL 顺序读取 `checkpoint` / `command` 记录，允许 `phase` 为 `navigation`、`precondition`、`step`、`assert`、`cleanup`。
2. 处理每条记录前先 dumpLayout。
3. 校验当前状态是否匹配该记录的 `before`：
   - 页面锚点仍存在
   - 目标控件的 text / type / id / description / hint 至少有可靠命中
   - 弹窗、键盘、遮挡状态与记录一致，或可按 exploration 已知规则清理
   - bounds 可变化，但目标控件中心必须来自本次实时 dumpLayout
4. `type="checkpoint"`：只做状态校验和记录，不执行物理命令。
5. `type="command"`：根据 `operation` 结构和实时 dumpLayout 重新生成并执行本次 hdc 命令。
6. command 执行后必须再次 dumpLayout，校验该记录的结构化 `after.observedAnchors` 是否满足；`after.expected` 只作说明，不作为 fast path 放行依据。
7. `before` 或 `after` 任一校验失败 → 停止 fast path，回退到 4.5 的常规智能执行流程；报告中记录"成功路径失效原因"。
8. 每条 checkpoint / command 实时校验通过后，都必须基于本次 dumpLayout 重新生成对应节点并写入 `successPathBuffer`；不得直接复制历史 JSONL 节点。

**禁止盲回放**：
- 不允许只因为成功路径里有坐标就直接点击。
- 不允许直接执行 success-path 中记录的历史 `command`；该字段只用于复盘和策略参考。
- 不允许把历史坐标写入 YAML。
- 不允许跨 YAML 复用另一个用例的成功路径。
- 不允许跳过 command 后的 `after` 校验。
- 不允许在 fast path 部分失败后继续硬套后续缓存命令。

#### 4.5 导航到目标页面

常规智能执行时，每个 YAML 都必须先进入明确目标页面，再执行 precondition 和 steps：

- 优先执行 YAML 的 `navigation`；YAML 缺失时才参考 `exploration.md` 的"导航"。
- 导航命令可进入成功路径，`phase` 记为 `navigation`。
- 若当前页面已经是目标页面，仍需 dumpLayout 校验目标页面锚点；校验通过后记录一条 `type="checkpoint"`、`phase="navigation"` 的页面锚点确认记录。
- 每个成功的 navigation 命令或页面确认都必须写入 `successPathBuffer`；命令写 `command`，纯状态确认写 `checkpoint`。
- 导航失败 → 按规则 A 读代码换策略，最多 3 次；仍失败记录当前 YAML 为 `caseFailure` 或 `blocked`。

#### 4.6 precondition 检查

执行前 dumpLayout 检查是否满足：

- 满足 → 继续；可记录一条 `type="checkpoint"`、`phase="precondition"` 的状态确认。
- 不满足 → 尝试 UI 操作修正，结合代码逻辑确定修正方式；修正命令可记录为 `phase="precondition"`。
- precondition 满足、被修正成功或跳过为已由 navigation 保证时，都必须写入 `successPathBuffer` 的 `checkpoint` 或 `command` 节点。
- 修正代价大 → 记录当前 YAML 为 `blocked`，在 report 写明需要人工处理的前置条件
- 修正最多 3 次 → 仍失败按规则 B 记录

#### 4.7 逐 step 执行

**action 定义**：action 是**逻辑操作**。执行时拆为物理操作。结构化 YAML 使用结构化 action；历史字符串写法使用自然语言 action，并按当前 NLP 规则解析。

**结构化 action 执行规则**：

| `action.kind` | 必填字段 | 物理执行 |
|---------------|----------|----------|
| `click` | `targetRole` | dumpLayout → 按 targetRole + exploration + 源码语义定位控件 → 取实时 bounds 中心点击 |
| `inputText` | `targetRole`, `text` | 定位输入框 → click → clearText（如可行）→ inputText → 收键盘 → 等页面稳定 |
| `clearText` | `targetRole` | 定位输入框 → clearText；无法直接清空时结合源码 / UI 能力保守处理 |
| `swipe` | `targetRole`, `direction` | 定位滚动区域或页面主体 → 按方向 swipe |
| `wait` | `durationMs` | 等待指定毫秒后 dumpLayout 确认页面稳定 |
| `closePopup` | `targetRole` | 定位弹窗关闭控件 → click → dumpLayout 确认弹窗消失 |

**历史字符串 action 兼容规则**：

| 逻辑操作 | 物理实现 |
|---------|---------|
| `点击xxx` | dumpLayout → 结合 exploration 控件定位 / 源码语义找目标控件 → uiInput click |
| `输入xxx` | dumpLayout → 结合 exploration 控件定位 / placeholder / TextInput 顺序找输入框 → uiInput click → uiInput inputText → 点空白收键盘 → delayMs(500) |
| `勾选xxx` | dumpLayout → 结合 exploration 控件定位找 Toggle / Checkbox / Switch / 自定义勾选控件 → uiInput click |
| `滑动` | dumpLayout → 结合 exploration 和当前布局找可滚动容器 → swipe |

**控件定位优先级**：
1. 读取 `exploration.md` 的"控件定位"和"已验证修正"。
2. 用实时 dumpLayout 验证控件仍存在且状态可操作。
3. 结合源码事件绑定和页面结构确认同类控件归属。
4. 兜底使用 text / type / description / hint / 坐标中心等信息；不得只因 text 缺失就判失败。

**坐标兜底边界**：坐标只能来自本次实时 dumpLayout 的控件 bounds 中心，不写入 YAML，不写入长期记录，也不跨次复用固定坐标。

**successPathBuffer 采集**：无论 fast path 还是常规执行，只要本次 checkpoint 或物理命令最终成功，且能生成可校验的 `before` 和 `after` 证据，就必须写入内存中的 `successPathBuffer`；只有整个 YAML 通过后，才落盘覆盖对应 `success-paths/<yaml-basename>.jsonl`。无法生成有效状态指纹的节点只写入测试报告，不进入 success-path，并说明原因。

每个逻辑操作执行完后，UI 必须回到干净状态（无键盘、无弹窗）。

每次操作的标准流程：
```
解析 action → dumpLayout before → 记录 before.pageAnchors / 键盘 / 弹窗
→ 结合 exploration 页面经验和历史 layoutTree 证据 → 找目标控件
→ uiInput click/inputText → 等页面稳定
→ dumpLayout after → 记录 after.observedAnchors / 键盘 / 弹窗
→ 有 assert？→ 匹配断言规则 → 通过/失败
→ 通过？→ 生成 checkpoint/command 节点写入 successPathBuffer
→ 失败？→ 读代码分析原因 → 换策略重试（最多 3 次）→ 仍失败按规则 B 记录
```

assert 采集规则：
- 有物理 action 的 assert 成功后，优先把 assert 成功证据写入同一 `command.after.observedAnchors`。
- 无物理命令的 assert 或页面锚点确认，写入 `type="checkpoint"`、`phase="assert"`。
- cleanup（关闭弹窗、收键盘、等待页面稳定）成功时，写入 `phase="cleanup"` 的 `command` 或 `checkpoint`。

**自动修复决策树**：

1. 记录失败现场：stepIndex、action、assert、当前 dumpLayout 摘要、弹窗 / 键盘 / 前台状态、最近 hdc 命令结果。
2. 匹配 `exploration.md ## 已验证修正`：
   - `symptom` 与当前失败现象匹配，且 `appliesTo` 命中当前 page / targetRole / phase。
   - 修正动作能映射为结构化 operation，如 `closePopup`、`wait`、`click`、`swipe`、`clearText`。
   - 执行前仍必须实时 dumpLayout 校验目标控件或弹窗锚点，不得盲用历史坐标。
3. 无已验证修正时，读源码 + 实时 dumpLayout 推断一次候选修复：
   - 弹窗 / 键盘遮挡 → `closePopup` 或收键盘。
   - 控件未出现 → `wait`、滚动或重新导航到固定起点。
   - 控件 disabled → 检查 precondition 或补前置 UI 操作。
   - 断言不满足 → 追踪业务分支，判断是预期错误、数据错误还是等待不足。
4. 候选修复执行后必须重新执行失败 step 或断言，并用实时 dumpLayout / Toast / 页面锚点证明修复有效。
5. 同一 step + 同一 symptom 最多尝试 3 次；重复失败时不继续换同类策略。

**修复记录写入规则**：

| 结果 | 写入位置 | 规则 |
|------|----------|------|
| 已验证修正命中且执行成功 | 不重复写入；可刷新 `verifiedAt` | 仅当修正规则内容有变化时追加新行 |
| 新候选修复执行成功，且后续 step/assert 通过 | `## 已验证修正` | 写 `symptom`、结构化 `fix`、`appliesTo`、`verifiedAt` |
| 候选修复执行失败 | `## 失败尝试记录` | 写 `symptom`、`attemptedFix`、`result`、`recordedAt` |
| 失败原因是用例数据或断言错误 | `test-records.json.lastFailure` + report | 不写 `已验证修正` |
| 失败原因是设备问题 | report + records failureType | 只在跨页面稳定复现时写 `CONTEXT.md ## 记录` |

`fix` 必须尽量使用结构化文本，便于后续读取，例如：

```text
closePopup targetRole=弹窗关闭按钮 anchor=青少年守护
wait durationMs=1000 until=textPresent:登录
swipe targetRole=页面滚动区 direction=up until=targetRole:登录按钮
```

禁止把“重试一次”“多点几下”“点击历史坐标”写入 `## 已验证修正`。

**结构化 assert 执行规则**：

| `assert.type` | 判定方式 |
|---------------|----------|
| `textPresent` | 实时 dumpLayout 中存在 `text` / `description` / `hint` 命中 `value` 的节点 |
| `textAbsent` | 页面稳定后实时 dumpLayout 中不存在命中 `value` 的节点 |
| `pageChanged` | 当前页面锚点与 action 前锚点发生符合预期的变化；有 `to` 时优先验证目标锚点 |
| `pageAnchorsPresent` | `values` 中的稳定锚点均可在实时 dumpLayout 中命中 |
| `componentEnabled` | 按 `targetRole` 定位控件，并确认 enabled / clickable 或源码状态允许点击 |
| `toastPresent` | action 后短时间轮询 dumpLayout / Toast 节点 / 页面提示文本，命中 `value` |
| `naturalLanguage` | 读源码 + 实时 UI 证据综合判断，并在报告里写明判断依据 |

历史字符串断言按原自然语言规则解析；能转成上述结构化断言时按结构化方式执行，不能转时按 `naturalLanguage` 处理。

**弹窗**：每次 dumpLayout 后检查是否有弹窗，存在则先关闭再继续。弹窗处理参考 exploration 的"弹窗与遮挡"和"hdc 探索记录"。

**异常**：hdc 命令失败时先按 `recoverableDeviceIssue` 尝试恢复一次；恢复失败或设备断开、App 无法启动、连续无法 dumpLayout 时记录为 `fatalDeviceIssue`，写入 report / records 后停止批量流水线。

**失败分类**：

| failureType | 含义 | 批量执行策略 |
|-------------|------|--------------|
| `staleSource` | `sourceHash` 不一致或源文件缺失 | 当前 YAML 记失败 / stale，跳过执行，继续下一个 YAML |
| `caseFailure` | 用例自身失败，如断言不满足、控件找不到 | 记录 failing，`all` 模式继续下一个 YAML |
| `recoverableDeviceIssue` | 可恢复设备问题，如临时 dump 失败、App 短暂未响应 | 尝试恢复一次；恢复成功继续，失败升级 |
| `fatalDeviceIssue` | 设备断开、App 无法启动、连续无法 dumpLayout | 停止批量流水线，记录当前位置和恢复建议，等待人工处理 |

#### 4.8 文件完成

- **通过** → 先执行 success-path 通过门禁，再更新 `test-records.json` 为 `verified` 或 `trusted`，建议结果：`✅ xxx.yaml 通过`
- **失败** → 展示失败信息并更新 `test-records.json` 为 `failing` / `stale` / `blocked`：`❌ xxx.yaml 失败 — step N: 未找到 xxx`

**success-path 通过门禁**：
- YAML 判定通过前必须检查 `successPathBuffer`。
- `successPathBuffer` 非空时，必须写入 / 刷新 success-path JSONL，并在 report 记录 buffer 节点数、写入路径和写入状态。
- `successPathBuffer` 为空时，不允许静默通过；可以保留 YAML 通过，但必须在 report 的“成功路径缓存”表中写明未写入原因。
- 通过用例如果未写入 success-path，`test-records.json.successPath` 不得指向新的缓存文件；已有缓存也不得被覆盖。
- 每个通过用例都必须在 report 的“成功路径缓存”表中有一行；失败 / 跳过 / 中断用例也必须记录“未覆盖已有缓存”。

`all` 模式规则：
- `caseFailure`：记录后继续下一个 YAML。
- `staleSource`：记录后继续下一个 YAML。
- `recoverableDeviceIssue`：恢复成功继续；恢复失败升级为 `fatalDeviceIssue`。
- `fatalDeviceIssue`：停止批量流水线，不继续污染后续用例记录。
- 每个 YAML 完成后立即写入本用例 report 片段、records 和 `test-records.md`；批次总报告最后再汇总。
- 用户终止批量时，当前 running 用例写 `lastAttempt.result="blocked"` 或 `skipped`（按实际情况），后续未开始用例不改状态。

#### 4.9 成功路径写入格式

成功路径只在整个 YAML 通过且通过门禁检查后写入：

```
explorations/<page>/success-paths/<yaml-basename>.jsonl
```

采用覆盖写入：先写临时文件，确认完整后再替换旧文件，避免半成功记录污染缓存。

文件落盘仍是 JSONL：一行一个 JSON 对象。下面示例为便于阅读使用格式化展示，实际写入时每个对象压缩成单行。

第一行为元信息：

```json
{
  "type": "meta",
  "yaml": "test-plans/accountLoginPage-1.yaml",
  "caseId": "account-login-error-password",
  "yamlHash": "sha256:...",
  "source": "test-sources/account-login-error-password.md",
  "sourceHash": "sha256:...",
  "explorationHash": "sha256:...",
  "target": "accountLoginPage",
  "bundle": "com.xxx",
  "product": "default",
  "device": "xxx",
  "fixedStartAnchors": ["首页", "我的"],
  "createdAt": "YYYY-MM-DD HH:MM:SS"
}
```

后续每一行记录一个可复用节点，`type` 可为 `checkpoint` 或 `command`：

```json
{
  "type": "checkpoint",
  "seq": 1,
  "phase": "navigation",
  "logicalAction": "确认已在 accountLoginPage",
  "before": {
    "pageAnchors": ["账号", "密码", "登录"],
    "keyboardVisible": false,
    "popupVisible": false
  },
  "after": {
    "expected": "目标页面锚点存在",
    "observedAnchors": ["账号", "密码", "登录"]
  },
  "source": {
    "strategy": "page-anchor",
    "fromExploration": true
  }
}
```

```json
{
  "type": "command",
  "seq": 3,
  "phase": "step",
  "stepIndex": 2,
  "logicalAction": "点击登录",
  "commandType": "uiInput.click",
  "command": "hdc shell uitest uiInput click 540 1620",
  "operation": {
    "kind": "click",
    "targetRole": "登录按钮"
  },
  "target": {
    "role": "登录按钮",
    "text": "登录",
    "type": "Button",
    "id": "",
    "description": "",
    "hint": "",
    "bounds": [120, 1500, 960, 1700]
  },
  "before": {
    "pageAnchors": ["账号", "密码", "登录"],
    "keyboardVisible": false,
    "popupVisible": false
  },
  "after": {
    "expected": "出现账号或密码错误 Toast",
    "observedAnchors": ["账号或密码错误"]
  },
  "source": {
    "strategy": "text+type+onClick",
    "fromExploration": true
  }
}
```

字段要求：
- 第一行 `type="meta"` 必须记录 `yaml`、`yamlHash`、`target`、`bundle`、`product`、`device`、`fixedStartAnchors`、`createdAt`；结构化 YAML 还必须记录 `caseId`、`source`、`sourceHash`、`explorationHash`。
- meta 必须记录本轮 `bufferNodeCount` 和 `writeReason`，便于报告和恢复核对。
- `fixedStartAnchors` 必须来自本 YAML 第一个 navigation 操作执行前的固定起点实时 dumpLayout；少于 1 个稳定锚点时不得写入 success-path，只在测试报告说明。
- 第一行 meta 之后的节点 `type` 只能取 `checkpoint` 或 `command`；`checkpoint` 只做状态确认，不执行物理命令。
- `phase` 只能取 `navigation`、`precondition`、`step`、`assert`、`cleanup`；同一文件中按真实执行顺序递增记录。
- `operation` 是复用时重建动作的主要依据，`command` 只是历史记录。
- `operation.kind` 至少支持 `click`、`inputText`、`swipe`、`wait`、`closePopup`、`clearText`。
- `operation.kind="inputText"` 时必须记录 `text` 和 `targetRole`；`swipe` 必须记录 `direction` 和可滚动区域角色；`wait` 必须记录 `durationMs`；`closePopup` 必须记录弹窗锚点和关闭控件角色。
- `command` 记录真实执行命令，便于复盘；实际复用时禁止直接执行历史命令，必须根据实时 dumpLayout 重新确认目标并生成本次命令。
- `target.bounds` 记录当次成功证据，不作为跨次固定坐标。
- `before.pageAnchors` 至少记录 1 个页面稳定锚点；没有锚点时不得写入 fast path，只写测试报告说明。
- `checkpoint` 以 `before.pageAnchors` 作为复用校验依据；可记录 `after.observedAnchors` 用于复盘，但 fast path 不依赖 checkpoint 的 `after` 放行。
- `after.observedAnchors` 记录命令后能证明成功的结构化 UI 结果；无断言 step 也要记录页面稳定信号。没有 `observedAnchors` 的 command 不得写入 success-path。
- fast path 复用时，每条 `command` 执行后必须用实时 dumpLayout 校验 `after.observedAnchors`；校验失败不得继续执行后续节点。
- 如果本次成功依赖关闭弹窗、收键盘或等待，相关命令也按 command 行记录。

---

### Step 5：写入产物

写入 `test-reports/<timestamp>.md`（项目信息从 `CONTEXT.md` 的 `## 项目` 读取），并刷新 `test-records.json` / `test-records.md`：

```markdown
# UI 测试报告

## 阅读说明
- 本报告只描述本轮 runner 执行结果；长期状态以 `test-records.json` 为准。
- `status` 是用例长期状态，`lastAttempt` 是最近一次执行结果。
- `failureType` 用于区分用例失败、来源变更和设备问题。
- success-path 是加速缓存；使用成功不代表盲回放，runner 每次仍会实时校验。

## 概要
| 项 | 值 |
|------|------|
| 工作空间 | /path/to/workspace |
| 代码仓库 | /path/to/repo |
| Bundle | com.xxx.xxx |
| 设备 | xxx |
| 执行时间 | YYYY-MM-DD HH:MM |
| 总耗时 | Ns |

## 结果
| 用例文件 | target | 状态 | 耗时 |
|----------|--------|------|------|
| accountLoginPage-1.yaml | accountLoginPage | ✅ | Ns |
| accountLoginPage-2.yaml | accountLoginPage | ❌ | Ns |

**通过 X/Y**

## 失败详情
| 用例 | step | 错误 |
|------|------|------|
| accountLoginPage-2.yaml | 3 点登录 | 未找到 "首页" |

## 成功路径缓存
| 用例 | buffer 节点 | 写入状态 | 文件 | 说明 |
|------|-------------|----------|------|------|
| accountLoginPage-1.yaml | 6 | 已刷新 | explorations/accountLoginPage/success-paths/accountLoginPage-1.jsonl | navigation 1, step 4, assert 1 |
| accountLoginPage-2.yaml | 0 | 未覆盖 | explorations/accountLoginPage/success-paths/accountLoginPage-2.jsonl | 用例失败，保留已有缓存 |
| smoke-accountLoginPage.yaml | 1 | 未写入 | — | 稳定锚点不足，报告已说明原因 |

## 运行记录
| 用例 | records key | status | passStreak | failureType | lastAttempt |
|------|-------------|--------|------------|-------------|-------------|
| accountLoginPage-1.yaml | account-login-error-password | trusted | 3 | — | passed |
| accountLoginPage-2.yaml | account-login-empty-account | failing | 0 | caseFailure | failed |
```

**更新 CONTEXT.md**：执行中发现的新的导航路径 → 写入 `CONTEXT.md` 的 `## 页面导航`。新发现的全局性问题 → 写入 `CONTEXT.md` 的 `## 记录`。

**更新 exploration.md**：执行中发现的页面级控件定位、状态规律、弹窗遮挡、已验证修正或失败尝试记录 → 写入对应页面的 `exploration.md`，不要写入 YAML。

**更新 success-paths**：仅当单个 YAML 完整通过时覆盖写入对应成功路径。失败、跳过、用户终止、设备异常时不得覆盖已有成功路径；报告中记录已有缓存是否被使用、是否失效、失效原因。

如果对应页面的 `exploration.md` 不存在，按 case-gen 的标准章节创建，至少包含：`## 阅读说明`、`## 导航`、`## 控件定位`、`## 状态规律`、`## 弹窗与遮挡`、`## 代码分析`、`## hdc 探索记录`、`## 已验证修正`、`## 失败尝试记录`。其中 `## 控件定位`、`## 已验证修正`、`## 失败尝试记录` 必须创建结构化表头：

```markdown
## 阅读说明
- 这是页面经验库，不是测试用例。
- runner / script-gen 会读取这里的页面级经验辅助定位和修复。
- `已验证修正` 可被 runner 自动应用；`失败尝试记录` 只用于复盘和避坑，不会自动复用。

## 控件定位
| targetRole | preferred | fallback | anchors | source | confidence | lastVerifiedAt |
|------------|-----------|----------|---------|--------|------------|----------------|

## 已验证修正
| symptom | fix | appliesTo | verifiedAt |
|---------|-----|-----------|------------|

## 失败尝试记录
| symptom | attemptedFix | result | recordedAt |
|---------|--------------|--------|------------|
```

**更新 test-records.json**：
- 使用 `caseId` 作为 records 主键；历史字符串写法无 `caseId` 时临时使用 YAML 相对路径。
- 成功：写入 `yaml`、`target`、`yamlHash`、`source`、`sourceHash`、`explorationHash`、`layoutTreeHash`、`pageFingerprint`，`runCount + 1`、`passStreak + 1`；普通用例 `passStreak >= 3` 时 status 为 `trusted`，否则为 `verified`。
- 成功且 success-path JSONL 实际写入 / 刷新成功：更新 `successPath` 为本次缓存路径，并在 `lastAttempt.successPath` 记录 `status="written"`、`bufferNodeCount`、`path` 和 `writeReason`。
- 成功但 success-path 未写入：不得让 `successPath` 指向新的缓存文件；已有可用缓存可保留但必须在 `lastAttempt.successPath` 记录 `status="notWritten"`、`bufferNodeCount` 和 `reason`，report 同步说明。
- smoke 用例（`caseId` 以 `smoke-` 开头，或文件名为 `smoke-<page>.yaml`）通过后 status 最高只写 `verified`，不升级 `trusted`；它只证明页面可达和核心锚点存在，不代表业务用例可信。
- 失败：`runCount + 1`、`passStreak = 0`；按失败分类写 `status`、`lastFailure` 和 `lastAttempt.result`。`staleSource` 写 `status="stale"`，`caseFailure` 写 `status="failing"`，需要人工补前置或页面不可恢复时写 `status="blocked"`。
- 跳过：写 `lastAttempt.result="skipped"`，不修改 passStreak。
- 中断 / fatal 设备问题：写 `lastAttempt.result="blocked"`，保留原 status 或标记 `blocked`，报告中说明。
- 写入必须原子化：先写临时文件，确认 JSON 格式完整后替换旧文件。

**刷新 test-records.md**：

runner 每处理完一个 YAML 都刷新一次 `test-records.md`；批量模式结束后再按最终 `test-records.json` 刷新一次，确保中途停止后人工总览也可用。

```markdown
# 用例执行记录

## 阅读说明
- 这是给人工看的执行总览，会被 runner 根据 `test-records.json` 覆盖刷新。
- `status` 表示用例长期状态；`lastAttempt` / report 里的结果表示最近一次执行。
- 机器决策以 `test-records.json` 为准，人工长期备注写入 `manualNote` 或具体 report。

| 用例 | 页面 | 状态 | 连续通过 | 上次执行 | 失败原因 |
|------|------|------|----------|----------|----------|
| accountLoginPage-1.yaml | accountLoginPage | trusted | 3 | 2026-06-03 20:20 | — |
| accountLoginPage-2.yaml | accountLoginPage | failing | 0 | 2026-06-03 20:25 | Step 3: 未找到登录按钮 |

## 失败详情

### accountLoginPage-2.yaml
- failureType: caseFailure
- lastReport: test-reports/2026-06-03-202500.md
- 建议：查看 exploration 的失败尝试记录或重新执行 runner。
```

`test-records.md` 是生成视图，可以被 runner 覆盖；人工长期备注写入 `test-records.json.manualNote` 或 report。

---

## 关键原则

- **遇阻先读代码**：dump 失败/异常 → 读源码，不盲重试
- **超限记录**：同一目标重试 3 次无果 → 当前 YAML 记录为失败 / blocked，批量继续后续 YAML
- **优先用 exploration 缓存**：读 `explorations/<page>/`，没有才实时探索
- **成功路径只做加速**：有 success-path 先校验再复用，校验失败自动回退到智能定位
- **启动后少打断**：执行开始后不询问重试 / 跳过 / 终止，异常落 report / records 等待人工处理

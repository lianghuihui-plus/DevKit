---
name: harmony-ui-test-case-gen
description: 鸿蒙 UI 测试用例生成。在工作空间中，用户用自然语言描述测试意图，Agent 读代码 + 上设备探索页面，生成 YAML 用例和页面探索数据。
version: 1.0.0
author: cm
---

# 鸿蒙 UI 测试用例生成

> NL → 读代码 → 上设备 → YAML + exploration 数据 → 落盘 workspace。

## 前置条件

- 当前目录为 UITestWorkspace-*（或其子目录）
- 已通过 session 创建或恢复 workspace 上下文（`CONTEXT.md` 存在，且 `AGENT.md` 已加载）

## 数据边界

| 文件 | 职责 |
|------|------|
| `test-sources/*.md` | 人类原始输入；临时自然语言先规范化写入这里 |
| `test-plans/*.yaml` | 结构化测试意图；新生成 YAML 使用 `schemaVersion: 2` |
| `explorations/<page>/exploration.md` | 页面经验：控件定位、状态规律、弹窗、已验证修正、失败尝试 |
| `explorations/<page>/layoutTree.json` | 最近一次真实 dumpLayout 证据快照 |
| `test-records.json` | 只初始化 / 更新 `auto_generated`，不写执行结果 |

## 产物格式

| 产物 | 命名 / 位置 | 写入规则 |
|------|-------------|----------|
| 源用例 | `test-sources/<slug>.md` | 临时自然语言先落源文件；批量模式读取已有源文件 |
| 结构化 YAML | `test-plans/<page>-<n>.yaml` | 一个 YAML 一个用例；普通用例按序号写入 |
| smoke YAML | `test-plans/smoke-<page>.yaml` | 批量探索固定命名，重复探索更新同一文件 |
| 页面经验 | `explorations/<page>/exploration.md` | 增量写入章节；结构化表头保持稳定 |
| 页面快照 | `explorations/<page>/layoutTree.json` | 每次真实 dumpLayout 后覆盖最近快照 |
| 运行记录 | `test-records.json` | 只初始化 / 更新 `auto_generated`，不写执行结果 |

## 执行流程

支持三种模式：

- **单个模式**：一次只问一个问题。一个用例从 Step 1 走到 Step 5，完成后再开下一个。
- **批量模式**：用户说“全部生成 / 批量编译 / 编译 test-sources”时，扫描 `test-sources/*.md`，先展示编译计划，再逐文件处理；只有 target 无法唯一确认、测试数据缺失或关键导航依据缺失时才暂停询问。
- **批量探索模式**：用户说“探索全部页面 / 全部未验证页面 / 生成冒烟用例”时，读取 `CONTEXT.md ## 路由表` 和 `test-records.json`，为缺少 exploration 或长期未验证的页面补探索数据并生成 smoke YAML。

---

### Step 1：定位 workspace

向上查找 `UITestWorkspace-*` 目录 → 找不到 → 提示"先执行 session 新建或进入工作空间"。

定位成功后，确认当前 workspace 已由 session 创建或恢复。后续读代码、hdc 探索、写 YAML 和写 exploration 时必须遵守 `AGENT.md` 约束；特别是"遇阻先读代码"、"超限即停"和工作空间写入边界。

---

### Step 2：获取目标页面和测试意图

优先扫描 `test-sources/*.md`：

- 若存在源文件且用户没有指定具体用例，列出源文件让用户选择要编译的文件；用户选择 `all` 时进入批量模式。
- 若用户直接用自然语言提出用例，先生成 slug，写入 `test-sources/<slug>.md`，再按同一流程编译。
- 若没有 `test-sources/`，创建目录后继续。

**批量编译计划**：

进入批量模式后，先生成计划并展示：

```markdown
## 批量编译计划
| 源文件 | 推断 target | 场景数 | 状态 |
|--------|-------------|--------|------|
| test-sources/account-login.md | accountLoginPage | 2 | 可编译 |
| test-sources/settings.md | settingsPage | 1 | 需确认 target |
```

- 一个源文件包含多个场景时，拆成多个候选 YAML；写入前展示拆分结果。
- 已有同 `caseId` 的 YAML 时，默认更新同一 YAML 文件；无法确认对应关系时生成新序号文件，并在汇总中说明。
- `sourceHash` 与已生成 YAML 相同且 YAML 通过基础校验时，标记为“未变化”，默认跳过；用户明确要求重生成时才覆盖。
- 缺 target、测试数据或导航依据的源文件标记为“需确认”，批量中只对这些文件逐个提问。
- 某个源文件编译失败不阻塞后续文件；失败原因写入批量汇总，不写通过 / 失败运行状态。

从 `CONTEXT.md` 的 `## 路由表` 展示页面名列表。

**批量探索计划**：

进入批量探索模式后，先生成计划并展示：

```markdown
## 批量探索计划
| 页面 | exploration | records 状态 | 计划 |
|------|-------------|--------------|------|
| accountLoginPage | 缺失 | auto_generated | 探索 + 生成 smoke YAML |
| settingsPage | 已存在 | stale | 重新 dumpLayout + 刷新 smoke YAML |
```

- 选择范围默认是缺少 `exploration.md` 或 records 状态为 `stale/failing/auto_generated` 且长期未验证的页面。
- 每个页面按 `CONTEXT.md ## 路由表` 和 `## 页面导航` 推断导航；无法确认导航时标记“需确认”，不编造 deeplink。
- 探索成功后写入 `explorations/<page>/exploration.md` 和 `layoutTree.json`。
- 每个探索成功页面先写入 `test-sources/smoke-<page>.md`，再生成一个 v2 smoke YAML，用 `caseId: smoke-<page>`，`source` 指向该源文件，`sourceHash` 使用该源文件原始字节 sha256。
- smoke YAML 固定写入 `test-plans/smoke-<page>.yaml`；重复批量探索时更新同一文件，不使用普通序号规则。
- smoke YAML 只验证页面核心锚点存在，不写业务断言，不把页面标记为 trusted。
- smoke YAML 写入后只可初始化 / 更新 `auto_generated` 记录；执行可信度由 runner 后续运行决定。

单个模式下询问用户：`要测哪个页面？想测什么？`

如果用户 NL 中已同时包含 target 和测试意图（如"测登录页的密码错误提示"）→ 全部跳过。

否则逐项询问（一次一个问题）：

```
比如：
· 输错密码看有没有错误提示
· 勾选协议才能点登录
· 不填账号直接点登录看提示
```

用户输入后，Agent 解析产出**意图草案**（控件的具体 text 用占位符）。草案最终会编译为 v2 YAML：

**action 拆分**

action 是**逻辑操作**。Agent 执行时自动拆为物理操作。

| 逻辑操作 | 物理实现 |
|---------|---------|
| `点击xxx` | 找控件 → 点击 |
| `输入xxx` | 点击输入框 → 键入 → 收键盘 |
| `勾选xxx` | 找 Toggle → 点击 |
| `滑动` | 找可滚动容器 → swipe |

- 每个逻辑操作执行完后，UI 必须回到干净状态（无键盘、无弹窗）
- "并"/"和"/"然后"/"再" → 拆分逻辑操作
- 不拆到物理层

**隐式 action 补全**
- "输错密码看有没有提示" → 补 `点击登录`
- 补全依据：初步推断，读代码后做最终确认

**断言推断**
- "看有没有 xxx" → `text: "xxx"`（占位符，上设备后用真实值替换）
- "能不能点"/"能否跳转" → 自然语言断言
- 用户未提断言的 action → 不加 assert

**v2 action 编译**

| 用户意图 | v2 action |
|---------|-----------|
| 点击登录 | `kind: click`, `targetRole: 登录按钮` |
| 输入账号 test@example.com | `kind: inputText`, `targetRole: 账号输入框`, `text: test@example.com` |
| 清空账号 | `kind: clearText`, `targetRole: 账号输入框` |
| 勾选协议 | `kind: click`, `targetRole: 协议勾选框` |
| 向上滑动 | `kind: swipe`, `targetRole: 页面滚动区`, `direction: up` |
| 等待 1 秒 | `kind: wait`, `durationMs: 1000` |
| 关闭弹窗 | `kind: closePopup`, `targetRole: 弹窗关闭按钮` |

**v2 assert 编译**

| 用户预期 | v2 assert |
|---------|-----------|
| 出现"账号或密码错误" | `type: textPresent`, `value: 账号或密码错误` |
| 不出现"首页" | `type: textAbsent`, `value: 首页` |
| 页面跳转 | `type: pageChanged` |
| 页面仍有账号、密码、登录 | `type: pageAnchorsPresent`, `values: [账号, 密码, 登录]` |
| 登录按钮可点击 | `type: componentEnabled`, `targetRole: 登录按钮` |
| 出现 Toast | `type: toastPresent`, `value: xxx` |
| 难以结构化判断 | `type: naturalLanguage`, `text: 原始预期` |

解析完毕后展示确认，然后收集测试数据：

draft 中包含输入类 step 时，询问测试数据。一次只问一个。

```
需要输入什么账号？
```

用户回答后，展示最终草案确认。

---

### Step 3：读代码

**目标**：输出 navigation 序列 + 每个 step 的业务逻辑分析。

**导航分析**

1. 从 `CONTEXT.md` 的 `## 项目` 获取代码仓库路径（后续读源码用）
2. 检查 `CONTEXT.md` 的 `## 页面导航`：目标页面已有导航路径 → 复用，跳过分析
3. 无已有路径 → 从 `CONTEXT.md` 的 `## 路由表` 找到 `pageSourceFile`
4. 优先搜索 `UriRouterConstants` / route constants / deep link helper，确认 deep link scheme + host
5. 如果项目不用固定常量名，回退搜索 `router.pushUrl`、`Navigation`、`module.json5`、已有 `CONTEXT.md` 导航、页面入口 onClick 绑定和 hdc 点击链路
6. 优先 deep link，无法直达则追加点击步骤；仍无法确认时展示候选路径让用户确认，不直接编造

```
navigation:
  - deeplink: codemao://lunar/accountLogin
```

**业务逻辑分析**

针对 draft 中每个 step，读源码追踪交互逻辑。

**点击类 step**：
1. 找该控件的 `onClick` 绑定 → 跟踪函数体
2. 成功/失败分支各自的 UI 结果（跳转页面标志 text / Toast 文本）
3. 前置条件（非空校验 / 勾选校验 / 权限校验）

**输入类 step**：
1. 找 TextInput 的 `onChange` 绑定
2. 输入后联动哪些状态

**断言推断**（基于代码）：

| 代码模式 | 断言 |
|---------|------|
| `router.pushUrl({ url: 'pages/Home' })` | `text: "首页"` |
| `promptAction.showToast({ message: 'xxx' })` | `text: "xxx"` |
| `if (!this.agreed)` | 提示：代码要求先勾选协议 → 补 step？ |

**隐式前置条件**：代码要求但 draft 中没有（如 `if (!this.agreed)` → 勾选协议）→ 提示用户是否需要补 step。用户确认补 → 更新草案后重新走 Step 3 分析新增 step；用户拒绝 → 继续。

确认后进入 Step 4。

---

### Step 4：上设备

> **核心规则**
> **A. 遇阻先读代码**：dump 失败/异常 → 读源码，不盲重试
> **B. 超限即停**：同一目标重试 3 次无果 → 汇报卡点

**环境检查（仅首个用例执行）**

> 加载 workspace 的 `references/device-setup.md`，按步骤检查设备连接、启动守护进程、确认 App 已安装。
> 读取 `CONTEXT.md` 的 `## 记录`，了解已知的设备特性与陷阱。

后续用例跳过此步，直接导航。

**导航到目标页面**

按 Step 3 的导航分析结果逐项执行。
任一导航步骤失败 → 按规则 A 读代码换策略 → 按规则 B 限次。

**dumpLayout 取真实 text**

1. `hdc shell uitest dumpLayout -p /data/local/tmp/layout.json`
2. `hdc file recv /data/local/tmp/layout.json /tmp/`
3. **立即保存**为 `explorations/<page>/layoutTree.json`（覆盖，目录不存在则先创建；它只代表最近一次真实快照）
4. 解析 JSON，按类型分组展示。

**TextInput text 为空时**：`text=""` 可能只是输入框当前值为空，也可能是 placeholder 使用了 `$r()` 资源引用。先查 dumpLayout 中的 `hint` / `originalText` / `description` 字段，有值则直接用。都没有 → 读源码查 `placeholder: $r('app.string.xxx')` → 解析对应 `string.json`。

产出：控件真实 text（供 Step 5 使用）。

---

### Step 5：生成

**写入 exploration**

在 `explorations/<page>/` 下创建或增量更新 `exploration.md`（目录不存在则先创建）：

```
explorations/
  accountLoginPage/
    exploration.md       ← 页面经验库
    layoutTree.json      ← Step 4 最近一次 dumpLayout 证据快照
```

同页面已有 `exploration.md` → 增量更新，不覆盖：

| 章节 | 策略 |
|------|------|
| `## 导航` | 有变化才更新 |
| `## 控件定位` | 追加新发现，不删除已有 |
| `## 状态规律` | 追加新发现，不删除已有 |
| `## 弹窗与遮挡` | 追加新发现，不删除已有 |
| `## 代码分析` | 追加新发现，不删除已有 |
| `## hdc 探索记录` | 追加新发现 |
| `## 已验证修正` | 只追加已经由设备执行验证过的修正 |
| `## 失败尝试记录` | 追加失败现象和未验证 / 无效尝试 |

`layoutTree.json` 在 Step 4 dumpLayout 时已覆盖保存。

**exploration.md 格式**：

```markdown
# accountLoginPage

## 导航
- deeplink: codemao://lunar/accountLogin

## 控件定位
| targetRole | preferred | fallback | anchors | source | confidence | lastVerifiedAt |
|------------|-----------|----------|---------|--------|------------|----------------|
| 账号输入框 | type=TextInput,order=first | placeholder=编程猫账号 | 编程猫账号 | dumpLayout+source | medium | 2026-06-03T10:00:00+08:00 |
| 密码输入框 | type=TextInput,order=second | placeholder=密码 | 密码 | dumpLayout+source | medium | 2026-06-03T10:00:00+08:00 |
| 登录按钮 | text=登录,type=Button | onClick=performLogin | 账号,密码 | dumpLayout+source | high | 2026-06-03T10:00:00+08:00 |

## 状态规律
- 两个输入框均非空后登录按钮 enabled
- 未勾选协议时点击登录会被协议校验阻止

## 弹窗与遮挡
- 导航到页面后出现"青少年守护"弹窗，需先关闭
- 输入文字后键盘遮挡底部 Toggle，输入完成后点击页面标题区域收键盘

## 代码分析
- 登录按钮 onClick → performLogin()
  - onSuccess → navigateBack
  - onError → Toast("账号或密码错误")
- 两个输入框均非空 → 按钮 enabled
- this.agreed === true → 不勾选弹窗阻止

## hdc 探索记录
- TextInput placeholder 为 $r() 引用，text 为空

## 已验证修正
| symptom | fix | appliesTo | verifiedAt |
|---------|-----|-----------|------------|
| 弹窗遮挡登录按钮导致点击失败 | dump 后先关闭弹窗再继续 | 登录前操作 | 2026-06-03T10:00:00+08:00 |

## 失败尝试记录
| symptom | attemptedFix | result | recordedAt |
|---------|--------------|--------|------------|
| 登录按钮文本在部分状态下不可见 | 直接按 text="登录" 查找 | 未验证，不自动复用 | 2026-06-03T10:00:00+08:00 |
```

| 章节 | 来源 | 内容 |
|------|------|------|
| `## 导航` | Step 3 导航分析 | deep link / 点击链路 |
| `## 控件定位` | Step 3 + Step 4 | 页面关键控件的稳定识别方式，不要求固化为 YAML selector |
| `## 状态规律` | Step 3 业务逻辑 | enabled 条件、校验分支、跳转 / Toast 规律 |
| `## 弹窗与遮挡` | Step 4 设备操作 | 弹窗、键盘、遮挡等执行前需处理的问题 |
| `## 代码分析` | Step 3 业务逻辑 | onClick 链条、成功/失败分支、前置条件 |
| `## hdc 探索记录` | Step 4 设备操作 | 实际操作中发现的意外情况（弹窗、遮挡、placeholder 问题等） |
| `## 已验证修正` | Step 4 / runner | 已经由设备验证过、runner 可自动应用的修正方式 |
| `## 失败尝试记录` | Step 4 / runner | 失败原因、无效尝试和待验证修正；runner 不自动应用 |

`## 控件定位` 表格字段必须保持稳定，便于 runner / script-gen 读取：

- `targetRole` 对应 YAML 中的 `targetRole`。
- `preferred` 是首选定位策略，不是强 selector。
- `fallback` 是首选失败后的替代策略。
- `anchors` 是页面或局部区域锚点，用逗号分隔。
- `source` 可取 `dumpLayout`、`source`、`success-path` 或组合。
- `confidence` 取 `high`、`medium`、`low`。
- `lastVerifiedAt` 是最近一次设备探索或 runner 执行验证时间。

**生成 YAML**

按 templates/input-template.md 格式组装：

| 字段 | 来源 |
|------|------|
| `schemaVersion` | 固定为 `2` |
| `caseId` | 由 target + 源文件 slug + 用例目标生成，同一 workspace 内稳定唯一 |
| `description` | Agent 自动生成 |
| `target` | Step 2 |
| `source` | 对应 `test-sources/*.md`；临时 NL 也先落源文件 |
| `sourceHash` | `sha256:` + 源文件原始字节 sha256 |
| `navigation` | Step 3 |
| `precondition` | Step 2 推断 + Step 3 代码分析发现的前置条件（仅保留 UI 可验证的） |
| `steps[].action` | 结构化逻辑操作，不写 selector / index / 坐标 |
| `steps[].assert` | 结构化断言数组；自然语言只作为兜底类型 |
| `steps[].assert[].type` | 断言类型，取 `textPresent`、`textAbsent`、`pageChanged`、`pageAnchorsPresent`、`componentEnabled`、`toastPresent`、`naturalLanguage` |

**断言位置校验**：确保指定 assert 的 step 在代码逻辑中确实满足触发条件。

**写入前校验**：
- 新生成 YAML 必须包含 `schemaVersion: 2`、`caseId`、`source`、`sourceHash`。
- `description` / `target` / `navigation` / `steps` 必须完整。
- `caseId` 只能包含字母、数字、下划线和连字符；同一 workspace 内不得与其他 v2 YAML 重复。
- 每个 step 必须有非空 `action.kind`。
- `action.kind` 只能取 `click`、`inputText`、`clearText`、`swipe`、`wait`、`closePopup`。
- `inputText` 必须有 `targetRole` 和 `text`；`click` / `clearText` / `closePopup` 必须有 `targetRole`；`swipe` 必须有 `direction`；`wait` 必须有 `durationMs`。
- `assert` 必须是对象或对象数组；旧 YAML 兼容才允许字符串或字符串数组。
- YAML 不写强执行 selector；页面定位经验写入 `exploration.md`。
- `navigation` 每项必须为 `deeplink` 或 `click`；`click.target` 仅作可见文本提示，缺失时不阻塞写入，但必须能从 context / 代码分析 / hdc 探索三者之一找到点击依据。
- 导航必须能从 context / 代码分析 / hdc 探索三者之一得到依据。

生成后展示完整 YAML。单个模式下用户确认后写入；批量模式下先汇总所有候选 YAML，用户确认后按文件逐个写入。

写入 YAML 后，可以在 `test-records.json.cases[caseId]` 初始化一条记录：

```json
{
  "caseId": "account-login-error",
  "yaml": "test-plans/accountLoginPage-1.yaml",
  "target": "accountLoginPage",
  "status": "auto_generated",
  "source": "test-sources/account-login.md",
  "sourceHash": "sha256:...",
  "runCount": 0,
  "passStreak": 0
}
```

只初始化缺失记录；已有同 `caseId` 记录不得覆盖运行状态。批量模式下每写入一个 YAML 就立刻原子更新一次 `test-records.json`，避免中途停止导致已生成用例丢失记录。

**smoke YAML 生成规则**：

先写入 smoke 源文件：

```markdown
# accountLoginPage 冒烟用例

页面：accountLoginPage

操作：
1. 打开 accountLoginPage
2. 等待页面稳定

预期：
- 页面核心锚点存在：编程猫账号、登录
```

```yaml
schemaVersion: 2
caseId: smoke-accountLoginPage
description: 冒烟验证 accountLoginPage 可打开且核心控件存在
target: accountLoginPage
source: test-sources/smoke-accountLoginPage.md
sourceHash: sha256:...
navigation:
  - deeplink: codemao://lunar/accountLogin
steps:
  - action:
      kind: wait
      durationMs: 500
    assert:
      - type: pageAnchorsPresent
        values:
          - 编程猫账号
          - 登录
```

smoke YAML 的 anchors 必须来自本次 dumpLayout 或源码确认的稳定页面锚点；少于 1 个稳定锚点时不生成 smoke YAML，只在批量探索汇总中标记“需人工确认”。

smoke YAML 固定写入 `test-plans/smoke-<page>.yaml`，并用 `caseId: smoke-<page>` 更新对应 `test-records.json.cases` 记录；不得覆盖普通业务用例 YAML。

**序号规则**：扫描 `test-plans/<page>-*.yaml` 中已有文件名的数字后缀，取最大序号 + 1；没有已有文件时从 1 开始，避免依赖 `ls` 在无匹配文件时的行为。

**更新 CONTEXT.md**：Step 3 新发现的导航路径 → 写入 `CONTEXT.md` 的 `## 页面导航`（该页面下无此路径时追加）。Step 4 新发现的全局性问题 → 写入 `CONTEXT.md` 的 `## 记录`。

**输出格式：批量编译结果**

```markdown
## 批量编译结果
| 源文件 | caseId | YAML | 状态 | 说明 |
|--------|--------|------|------|------|
| test-sources/account-login.md | account-login-error | test-plans/accountLoginPage-1.yaml | 已写入 | sourceHash 已刷新 |
| test-sources/settings.md | — | — | 需确认 | target 无法唯一匹配 |
```

**输出格式：批量探索结果**

```markdown
## 批量探索结果
| 页面 | exploration | layoutTree | smoke YAML | 状态 | 说明 |
|------|-------------|------------|------------|------|------|
| accountLoginPage | 已刷新 | 已覆盖 | test-plans/smoke-accountLoginPage.yaml | 成功 | 2 个稳定锚点 |
| settingsPage | 未写入 | 未写入 | — | 需确认 | 导航无法唯一确认 |
```

**多用例循环**：单个模式完成当前用例后询问`继续生成下一个用例？` → 回到 Step 2。批量模式完成后不再逐个询问继续。复用 Step 1 的 workspace 和 Step 4 的环境检查。

---

## 关键原则

- **一个 YAML 一个用例**：一个 `test-sources/*.md` 可包含多个场景，但必须拆成多个 YAML
- **批量先计划后写入**：先展示源文件、target、场景数和风险，再落盘 YAML
- **批量不写执行状态**：只可初始化 `auto_generated`，不得写 passed / failed / trusted
- **遇阻先读代码**：dump 失败 → 读源码，不盲重试
- **超限即停**：同一目标重试 3 次无果 → 汇报卡点，询问用户
- **用 dumpLayout 的真实 text**，不凭空编造
- **一次只问一个问题**

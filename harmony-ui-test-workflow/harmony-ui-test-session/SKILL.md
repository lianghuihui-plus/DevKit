---
name: harmony-ui-test-session
description: 鸿蒙 UI 测试会话管理。新建或继续 UITestWorkspace，提取项目元数据，管理测试工作空间生命周期。
version: 1.0.0
author: cm
---

# 鸿蒙 UI 测试会话管理

> 新建 / 继续 UITestWorkspace → 确认元数据 → 读取 AGENT.md → 进入工作空间。

## 数据边界

| 文件 | 职责 |
|------|------|
| `CONTEXT.md` | 工作空间全局信息：项目元数据、路由索引、已解析页面路由、跨页面导航、全局设备特性和已知问题 |
| `explorations/<page>/exploration.md` | 页面级经验：导航、控件定位、状态规律、弹窗遮挡、代码分析、hdc 探索、已验证修正、失败尝试记录 |
| `explorations/<page>/layoutTree.json` | 最近一次真实 dumpLayout 证据快照，不作为完整 UI 状态库 |
| `explorations/<page>/success-paths/*.jsonl` | runner 成功路径缓存：某个 YAML 最近一次完整通过时的 checkpoint / command 节点记录；复用前必须实时校验 |
| `test-sources/*.md` | 人类原始用例输入，格式宽松；后续 case-gen 可从这里批量编译 YAML |
| `test-plans/*.yaml` | 测试意图：目标页面、导航、前置条件、逻辑步骤、断言，不写强执行 selector |
| `test-records.json` | 机器读写的运行状态：status、runCount、passStreak、lastAttempt、failure、success-path 引用 |
| `test-records.md` | 人工查阅的执行总览，由 runner 根据 `test-records.json` 刷新，不作为机器状态来源 |
| `test-reports/*.md` | 执行结果、失败详情和本次运行观察 |

## 产物格式

| 产物 | 命名 / 位置 | 写入规则 |
|------|-------------|----------|
| 工作空间 | `UITestWorkspace-<工作名>/` | 新建时一次性创建基础目录 |
| 全局上下文 | `CONTEXT.md` | session 创建，后续 skill 只增量追加对应章节 |
| 行为约束 | `AGENT.md` | 从模板复制，后续 skill 必须遵守 |
| 源用例模板 | `test-sources/example.md` | 从模板复制，方便用户改写；case-gen 可忽略或按用户选择编译 |
| 运行状态 | `test-records.json` | 初始 `{ "version": 1, "updatedAt": null, "cases": {} }` |
| 人工总览 | `test-records.md` | 初始“暂无执行记录”，runner 后续覆盖刷新 |

## 执行流程

### Step 1：选择模式

```
新建工作空间还是继续已有？

1. 新建
2. 继续已有
```

---

## 模式 A：新建

### Step A1：收集信息

一次只问一个问题。

**工作名**

```
请输入工作名（用于命名 UITestWorkspace-xxx）：
如：login-test、setting-test
```

**代码仓库路径**

```
请输入鸿蒙项目代码仓库路径：
```

校验 `build-profile.json5` + `AppScope/app.json5` 存在。不通过 → 提示重新输入。

### Step A2：提取元数据

读取代码仓库：

| 字段 | 来源 |
|------|------|
| Bundle | `AppScope/app.json5` → `app.bundleName` |
| Product | 扫描 `product/` 目录；多 product → 列出让用户选 |
| 入口 Ability | `*/src/main/module.json5` 中 `type: "entry"` 的 `mainElement` |
| 路由索引 | 优先记录标准 `route_map.json` 路径；找不到时用 `rg --files -g 'route_map.json'` 记录候选文件，不全量解析页面路由 |

> session 阶段只做轻量元数据和路由索引，不读取全部页面源码，不分析所有导航链路。具体 `target -> pageSourceFile` 由 case-gen / script-gen 按目标页面懒加载；批量探索模式才允许全量读取 route_map。
>
> 路由索引规则：标准路径存在时写入 `routeMap`；标准路径不存在但只有一个候选时，自动把该候选写入 `routeMap`，同时写入 `routeMapCandidates`；存在多个候选时，必须在 session 阶段让用户选择主 `routeMap`，再写入候选列表。不要把多个候选留给 case-gen / script-gen 再判断。
>
> 如果标准路径无法提取 Bundle / Product / 入口 Ability，回退搜索必要配置文件；仍无法确认时，展示候选项让用户确认，不直接编造。

### Step A3：确认元数据

```
📋 工作空间信息确认：

   工作名：login-test
   代码仓库：/Users/cm/GitProj/LunarHarmony/lunarharmony
   Bundle：com.codemao.hos.lunar
   Product：lunar
   入口 Ability：EntryAbility
   路由索引：已找到 route_map

   确认创建？
```

### Step A4：创建 workspace

在当前目录创建 `UITestWorkspace-<工作名>/`：

```
UITestWorkspace-<工作名>/
├── CONTEXT.md
├── AGENT.md                        ← Agent 行为规则
├── references/
│   ├── device-setup.md
│   ├── UiTest-API.md
│   └── UiTest-指南.md
├── explorations/
├── test-sources/
│   └── example.md
├── test-plans/
├── test-records.json
├── test-records.md
└── test-reports/
```

`explorations/<page>/`、`layoutTree.json` 和 `success-paths/` 由 case-gen / runner 在对应页面首次探索或执行成功后创建，不在新建 workspace 时创建占位页面目录。

1. 创建目录结构
2. 从当前 skill 目录下复制 `templates/device-setup.md` 到 `references/device-setup.md`
3. 从当前 skill 目录下复制 `templates/AGENT.md` 到工作空间根目录
4. 从当前 skill 目录下的 `templates/` 拷贝官方文档 Markdown 到 `references/`（重命名为简短名）：
   - `@ohos.UiTest-ArkTS API-*.md` → `references/UiTest-API.md`
   - `UI测试框架使用指导-*.md` → `references/UiTest-指南.md`
5. 从当前 skill 目录下复制 `templates/test-source-template.md` 到 `test-sources/example.md`
6. 写入 `CONTEXT.md`（Markdown 格式，供下游 skill 读写）：

```markdown
# <工作名>

## 项目
- **代码仓库**：<repo-path>
- **Bundle**：<bundleName>
- **Product**：<product>
- **入口 Ability**：<entryAbility>

## 路由索引
- **routeMap**：product/<product>/src/main/resources/base/profile/route_map.json
- **routeMapCandidates**：
  - product/<product>/src/main/resources/base/profile/route_map.json
- **status**：lazy
- **说明**：session 只记录路由文件位置；case-gen / script-gen 按目标页面读取并补充下方路由表。

## 路由表
| 页面名 | 源文件 | 来源 | 更新时间 |
|--------|--------|------|----------|

> 初始为空；普通用例按需追加，批量探索才全量填充。

## 页面导航
> case-gen / runner 在 hdc 探索中发现新的导航路径后，增量追加到此处。

### <页面名>
- deeplink: `scheme://host/path`
- click: 首页 → Tab "xxx" → "xxx"

## 记录
> 全局重要信息。设备特性、已知行为、跨页面通用注意事项。各 skill 按需读写。

> 页面级信息不要写在这里，应写入 `explorations/<page>/exploration.md`。
```
7. 写入初始 `test-records.json`：

```json
{
  "version": 1,
  "updatedAt": null,
  "cases": {}
}
```

8. 写入初始 `test-records.md`：

```markdown
# 用例执行记录

## 阅读说明
- 这是给人工看的执行总览，会被 runner 根据 `test-records.json` 覆盖刷新。
- `status` 表示用例长期状态；最近一次执行详情看 `lastAttempt` 或对应 `test-reports/*.md`。
- 机器决策以 `test-records.json` 为准，人工长期备注写入 `test-records.json.manualNote` 或具体 report。

暂无执行记录。
```

9. **读取 `AGENT.md`**：读取工作空间根目录下的 `AGENT.md`，并在后续 case-gen / runner / script-gen 执行中显式遵守其中约束。

### Step A5：完成

```
✅ 工作空间已创建：UITestWorkspace-login-test/

   下一步：
   - 生成用例：在 workspace 目录下执行 case-gen
   - 执行用例：在 workspace 目录下执行 runner
   - 生成脚本：在 workspace 目录下执行 script-gen
```

---

## 模式 B：继续已有

### Step B1：列出工作空间

在当前目录下搜索 `UITestWorkspace-*`（当前目录 + 上级目录）：

```
已有工作空间：

1. UITestWorkspace-login-test/    (3 个用例, 最后修改 2026-06-03)
2. UITestWorkspace-settings-test/ (1 个用例, 最后修改 2026-06-01)

选择：
```

### Step B2：加载并恢复

继续模式的目标不是只进入目录，而是恢复 Agent 后续工作的必要上下文。加载选中 workspace 后，先读取必需文件并补齐基础结构，再汇总恢复摘要：

| 阶段 | 数据 | 恢复内容 | 规则 |
|------|------|----------|------|
| 必需加载 | `AGENT.md` | 行为约束、写入边界、ArkTS 约束 | 必须读取；不存在则提示 workspace 不完整 |
| 必需加载 | `CONTEXT.md` | 项目元数据、路由索引、已解析页面路由、页面导航、全局记录 | 必须读取；不存在则提示重新执行 session 新建；继续模式默认不刷新项目路由 |
| 基础补齐 | `test-sources/`、`test-plans/`、`explorations/`、`test-reports/` | 基础目录 | 缺失则创建空目录；不要自动创建页面级 exploration 目录 |
| 基础补齐 | `test-sources/example.md` | 源用例模板 | `test-sources/` 为空时复制模板；已有源文件时不覆盖 |
| 基础补齐 | `test-records.json` | 用例运行状态、连续通过、失败、中断信息 | 缺失则按新建 workspace 的初始内容创建 |
| 基础补齐 | `test-records.md` | 人工总览 | 缺失则按新建 workspace 的初始内容创建 |
| 摘要汇总 | `test-records.json` | 用例状态统计、中断信息 | 机器状态唯一事实源 |
| 摘要汇总 | `test-records.md` | 人工总览 | 只展示摘要，不作为状态来源 |
| 摘要汇总 | `test-plans/*.yaml` | 用例数量、caseId、target、sourceHash | 只读索引和关键字段 |
| 摘要汇总 | `test-sources/*.md` | 源用例数量 | 只读文件列表，不解析全文 |
| 摘要汇总 | `explorations/<page>/` | 页面经验、layoutTree、success-path 是否存在 | 只读页面级索引，不全量加载 JSON / JSONL |
| 摘要汇总 | `test-reports/*.md` | 最近报告 | 只取最近 3 份路径和时间 |

加载完成后展示恢复摘要：

```
📋 工作空间：UITestWorkspace-login-test/

   代码仓库：/Users/cm/GitProj/LunarHarmony/lunarharmony
   Bundle：com.codemao.hos.lunar
   Product：lunar
   已解析页面路由：3 个
   导航路径：5 条
   源用例：2 个
   YAML 用例：3 个（结构化: 3，历史字符串: 0）
   页面探索：2/3 个页面已有 exploration
   成功路径：1 个
   最近报告：test-reports/2026-06-03-202500.md
   运行记录：trusted 1 / verified 1 / failing 0 / stale 0 / auto_generated 1
   中断记录：无

   确认进入？
```

确认后，后续操作（case-gen / runner / script-gen）直接基于已恢复的 workspace 上下文执行，并显式遵守 `AGENT.md` 约束。

### Step B3：识别恢复重点

从 `test-records.json` 和文件索引中识别下一步建议：

| 状态 | 建议 |
|------|------|
| 存在 `lastAttempt.result="running"` 且无 `endedAt` | 提示上次可能中断，建议先执行 runner 重新处理该 YAML；不得继承上次设备页面状态 |
| 有 `failing` / `blocked` 用例 | 建议先执行 runner 复查失败用例；blocked 可能需要先补人工信息、测试数据或环境 |
| 有 `stale` 用例 | 建议先执行 case-gen 重新编译或同步 source/YAML，再执行 runner |
| 有 `auto_generated` 用例 | 建议执行 runner 验证新生成 YAML |
| 页面缺少 exploration | 建议执行 case-gen 批量探索或生成 smoke YAML |
| 用例已 `verified` / `trusted` | 可建议 script-gen 生成 ArkTS 脚本；未验证 / 失败 / 过期用例默认不建议生成脚本 |

展示格式：

```markdown
## 恢复建议
1. runner：重新处理 `test-plans/accountLoginPage-1.yaml`（上次可能中断）
2. case-gen：补探索 `settingsPage`（缺少 exploration）
3. script-gen：`account-login-error-password` 已 trusted，可生成脚本
```

不要替用户自动执行下一步；等待用户选择 case-gen / runner / script-gen。

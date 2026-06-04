# Agent 角色

以下规则是强制性约束，你必须严格遵循。违反任意一条即为错误。

## 你的身份

你是一名 HarmonyOS 高级开发工程师，精通 ArkTS / ArkUI / @kit.TestKit UI 测试框架。

## 工作空间

- **重要信息写入正确位置**：新发现的跨页面导航路径写入 `CONTEXT.md` 的 `## 页面导航`，设备级 / 跨页面陷阱写入 `CONTEXT.md` 的 `## 记录`
- **记录职责清晰**：`CONTEXT.md` 只记录全局项目、路由、跨页面导航和全局问题；页面级控件定位、状态规律、弹窗处理、页面内陷阱、已验证修正和失败尝试记录写入 `explorations/<page>/exploration.md`
- **test-sources 是原始输入**：`test-sources/*.md` 只保存人类粗糙用例输入，runner / script-gen 不把它作为步骤来源；只允许为 `sourceHash` 校验读取
- **YAML 保持意图层**：`test-plans/*.yaml` 只表达目标页面、导航、前置条件、逻辑步骤和断言，不强制写入 id/index/selector 等执行细节
- **新 YAML 使用 v2**：case-gen 新生成 YAML 必须包含 `schemaVersion: 2`、稳定唯一 `caseId`、`source` 和 `sourceHash`；缺少 `schemaVersion` 的旧 YAML 仅作为兼容执行
- **smoke 只做冒烟验证**：smoke 用例固定使用 `caseId: smoke-<page>` 和 `test-plans/smoke-<page>.yaml`，通过后最高只标记 `verified`，不得直接升级 `trusted`
- **layoutTree 是证据快照**：`layoutTree.json` 保存最近一次真实 dumpLayout，用于辅助判断，不要求覆盖页面所有 UI 状态
- **success-path 是成功路径缓存**：runner 只有在单个 YAML 完整通过后，才可写入 `explorations/<page>/success-paths/<yaml-basename>.jsonl` 的 checkpoint / command 节点记录；复用前必须实时 dumpLayout 校验页面锚点和目标控件，禁止盲目回放历史坐标
- **test-records 是运行状态**：`test-records.json` 是机器运行状态唯一事实源，记录 status、passStreak、lastAttempt 和 failure；`test-records.md` 只是人工总览，可由 runner 覆盖刷新
- **恢复工作读 records**：停止后继续时，先读 `test-records.json` 识别 `lastAttempt.result="running"` 且无 `endedAt` 的中断用例；不要继承上次前台页面、键盘或弹窗状态
- **查文档**：API 问题查阅 `references/UiTest-API.md`，用法场景查阅 `references/UiTest-指南.md`
- **遇阻先读代码**：dump 失败 / 点击无反应 / 页面不对 → 立即用当前平台可用的源码搜索和文件读取能力读源码（如 `rg`、文件搜索工具、文件读取工具），不盲重试
- **超限即停**：同一目标重试 3 次无果 → 汇报卡点，询问用户

## ArkTS 语法限制

违反以下任意一条将导致编译失败。

- 禁止 `any` / `Object` / 匿名对象字面量 / 属性简写
- 禁止动态索引访问（`obj[key]`、`delete obj[key]`）
- 禁止 `Partial<>` 等工具类型
- 类型窄化不穿透 `forEach` 闭包

## 编码约定

- 常量放已有类的 `static readonly`，不新增独立常量文件
- `!== undefined` 优于 truthy；`findComponent` 判 `null`，`findComponents` 判 `length > 0`
- 所有 Component/Driver 方法必须 `await`，禁止并发调用
- 复用逻辑提 `private` 方法，埋点剥离到独立 tracker 类
- 输入完成后点页面标题收键盘，不用硬编码坐标
- 匹配优先级：`ON.id()` > `ON.type()` > `ON.text()`

## 测试脚本

- 框架 `@ohos/hypium`，`it()` 用 `0` 替代 `Level`，用 `async (): Promise<void>` 替代 `done` 回调
- 同页面多用例合并一个 `.ets`，`List.test.ets` 增量追加不覆盖

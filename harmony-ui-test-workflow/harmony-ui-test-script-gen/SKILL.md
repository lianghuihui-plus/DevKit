---
name: harmony-ui-test-script-gen
description: 鸿蒙 UI 测试脚本生成。在工作空间中，基于 YAML 用例和 exploration 数据，生成 ArkTS 测试脚本并写入目标项目的 ohosTest 目录。
version: 1.0.0
author: cm
---

# 鸿蒙 UI 测试脚本生成

> YAML + exploration → ArkTS .ets → 写入目标项目。

## 前置条件

- 当前目录为 UITestWorkspace-*（或其子目录）
- 已通过 session 创建或恢复 workspace 上下文（`CONTEXT.md` 存在，且 `AGENT.md` 已加载）
- `test-plans/` 下有 YAML 文件
- 默认只为 `test-records.json` 中状态为 `verified` 或 `trusted` 的 YAML 生成脚本；其他状态必须显式展示风险并等待用户确认
- 推荐对应页面有 `explorations/<page>/exploration.md`；缺失时进入降级生成流程，不直接停止

## 数据边界

| 文件 | 职责 |
|------|------|
| `test-plans/*.yaml` | 测试意图和步骤；使用结构化 action / assert |
| `explorations/<page>/exploration.md` | 页面定位经验、状态规律、弹窗、修正记录 |
| `explorations/<page>/layoutTree.json` | 历史证据快照；不能替代等待和判空 |
| `explorations/<page>/success-paths/*.jsonl` | hash 匹配时提供 runner 验证过的语义证据 |
| 目标项目 `ohosTest/` | 写入 ArkTS 测试脚本；不把 selector 回写 YAML |

## 产物格式

| 产物 | 命名 / 位置 | 写入规则 |
|------|-------------|----------|
| 业务测试脚本 | `<module>/src/ohosTest/ets/test/<Page>.test.ets` | 同页面业务用例合并为多个 `it()` |
| smoke 测试脚本 | `<Page>.smoke.test.ets` 或 `Smoke.test.ets` | 仅用户明确选择 smoke YAML 时生成 |
| 测试入口 | `List.test.ets` | 只追加 import / suite 调用，不覆盖已有内容 |
| 测试模块配置 | `<module>/src/ohosTest/module.json5` | 缺失时创建；不受 ArkTS 匿名对象限制 |
| 页面经验推断 | `explorations/<page>/exploration.md` | 缺依据时可写待验证推断，不写已验证修正 |

## 执行流程

---

### Step 1：定位 workspace

向上查找 `UITestWorkspace-*` 目录 → 找不到 → 提示"先执行 session 新建或进入工作空间"。

定位成功后，确认当前 workspace 已由 session 创建或恢复。后续 YAML 解析、页面经验读取、ArkTS 代码生成和 `ohosTest` 写入必须遵守 `AGENT.md` 约束；特别是 ArkTS 语法限制、List.test.ets 追加规则和工作空间写入边界。

---

### Step 2：选择用例

列出 `test-plans/` 下的 YAML，用户选择要生成脚本的。读取 `test-records.json` 并同时展示每个 YAML 的 `status`、`passStreak`、`lastAttempt` 和最近 report。

默认候选范围：
- `verified` / `trusted`：可直接生成脚本。
- `auto_generated`：尚未 runner 验证，默认不生成；用户明确选择时必须展示风险。
- `failing` / `stale` / `blocked`：默认不生成；用户明确选择时必须展示失败 / 过期 / 阻塞原因，并建议先执行 runner 或 case-gen。
- records 缺失或找不到对应 case：视为未验证，默认不生成。

同页面的用例合并到一个 `.ets` 文件（多个 `it()`）。

smoke 用例边界：
- `caseId` 以 `smoke-` 开头，或文件名为 `smoke-<page>.yaml` 的用例视为冒烟用例。
- 用户选择业务用例时，不默认混入 smoke YAML。
- 用户明确选择 smoke YAML 时，可以生成脚本；同页面 smoke 用例建议写入 `<Page>.smoke.test.ets` 或追加到独立 `Smoke.test.ets`，不要和业务断言用例混在同一个 describe 中。
- smoke 脚本只验证页面核心锚点和导航可达性，不生成业务流程断言。

---

### Step 3：读取数据

对每个选中的 YAML：

1. 解析 YAML → `caseId`, `target`, `source`, `sourceHash`, `navigation`, `precondition`, `steps`, `assert`
2. 读取 `explorations/<page>/exploration.md`，重点使用 `控件定位`、`状态规律`、`弹窗与遮挡`、`已验证修正`；`失败尝试记录` 只用于避坑和风险提示
3. 读取 `explorations/<page>/layoutTree.json` 作为历史证据快照
4. 如存在 `explorations/<page>/success-paths/<yaml-basename>.jsonl`，先读取第一行 meta 并计算当前 YAML 原始字节 `sha256`；hash 一致才读取 `operation`、`target`、`source`、`before/after` 作为 runner 已验证证据

按 target 分组。

**生成前校验**：
- YAML 必须包含 `target`、非空 `navigation` 和非空 `steps`。
- 结构化 YAML 必须包含 `caseId`、`source` 和 `sourceHash`，并且每个 step 必须有 `action.kind`。
- 结构化 YAML 必须同步校验 `sourceHash`；源文件不存在或 hash 不一致时，将该 YAML 视为 `stale` 风险，提示"源用例已变化，建议先重新执行 case-gen / runner"。用户确认继续时仍可生成脚本，但不得读取过期 success-path 作为证据源，且生成结果必须标注“基于过期 YAML”。
- 历史字符串写法允许字符串 action / assert；生成时先转换为等价的内部结构，再翻译 ArkTS。
- 同页面用例优先读取对应 `exploration.md`。
- success-path 的 `yamlHash` 与当前 YAML 不一致时，标记为"缓存过期"，不得作为控件证据源。
- success-path 存在时只能增强控件语义和页面锚点判断；不得把其中的 `command`、历史坐标或 hdc 命令直接写成 ArkTS。
- 找不到 `exploration.md` 时不直接停止：先读取页面源码、路由信息和可用的 `layoutTree.json` 做保守分析；仍缺少关键定位依据时，生成脚本前展示风险说明，并把本次推断写入新的 `exploration.md` 的 `## 代码分析` / `## 控件定位` / `## 失败尝试记录` 中标注"待设备验证"，不得写入 `## 已验证修正`。
- 每个生成的 Component / Driver 异步方法必须使用 `await`。
- `findComponent` 必须判 `null`，`findComponents` 必须判 `length > 0`。
- 生成代码不得包含 `any`、`Object`、匿名对象字面量、动态属性索引（如 `obj[key]` / `delete obj[key]`）、`Level` 或 `done` 回调。

---

### Step 4：定位目标模块

读取 `CONTEXT.md` 的 `## 项目` 获取代码仓库路径。先从 `## 路由表` 查找当前 YAML `target` 的 `pageSourceFile`；如果缺失，则按 `## 路由索引` 读取 `routeMap` 中该 target 的记录，追加到 `## 路由表` 后再反推模块路径。

路由索引异常处理：
- `routeMap` 存在 → 直接按 target 查询。
- `routeMap` 为空且 `routeMapCandidates` 只有 1 个 → 使用该候选，并把它补写为 `routeMap`。
- `routeMap` 为空且 `routeMapCandidates` 多于 1 个 → 仅作为旧 workspace 或 `CONTEXT.md` 被手工修改后的恢复兜底；不写入脚本，展示风险并建议先执行 session 选择主 routeMap 或执行 case-gen 补齐目标页面路由。正常新建 workspace 应由 session 阶段选择主 `routeMap`。
- `routeMap` 和候选都缺失 → 不写入脚本，提示先执行 session 刷新路由索引。

```
pageSourceFile: featuresLunar/LunarLogin/src/main/ets/pages/AccountLogin.ets
→ module: featuresLunar/LunarLogin
→ ohosTest: featuresLunar/LunarLogin/src/ohosTest/ets/test/
```

检查 `ohosTest/` 是否存在。不存在 → 创建：

```
<module>/src/ohosTest/
├── module.json5         ← { "module": { "name": "<module>Test", "type": "feature", "srcEntrance": "./ets/test/List.test.ets" } }
└── ets/test/
```

JSON5 配置文件按 JSON5 格式写；AGENT.md 中"禁止匿名对象字面量"只约束生成的 `.ets` ArkTS 测试代码，不适用于 `module.json5`。

### Step 5：生成脚本

> ⚠️ 遵守 AGENT.md 中的 ArkTS 约束。

#### 5.1 生成 <Page>.test.ets

```typescript
import { describe, beforeAll, afterAll, it } from '@ohos/hypium';
import { Driver, ON } from '@kit.TestKit';
// 按实际导航代码按需导入 abilityDelegatorRegistry / Want / 项目 helper；不要固定生成未使用 import 或未使用变量。

export default function <page>TestSuite() {
  describe('<Page>Test', () => {
    let driver: Driver = Driver.create();

    beforeAll(async () => {
      // 导航到目标页面（见下方导航翻译规则）
      // precondition 处理（见下方）
    });

    afterAll(async () => {
      await driver.delayMs(500);
    });

    it('case_description', 0, async (): Promise<void> => {
      // ...
    });
  });
}
```

**导航翻译规则**：

| YAML navigation | ArkTS |
|----------------|-------|
| `deeplink: codemao://lunar/xxx` | 优先复用目标项目已有的 Want / startAbility 写法；没有项目惯例时，只输出待确认方案，不直接写入未经验证的代码 |
| `click: 点击 "xxx"` | 优先根据 exploration / success-path / 源码选择 `ON.id()` / `ON.type()` / `ON.text()`；`navigation[].target` 只作为可见文本提示，`ON.text('xxx')` 只作为兜底示例 |

导航序列按顺序写入 `beforeAll`。

**deeplink 写法规则**：
- 先在目标项目中搜索 `startAbility` / `Want` / `viewData`，复用已有可编译写法。
- 只有实际需要 `startAbility` / `Want` 时，才生成 `abilityDelegatorRegistry.getAbilityDelegator()`、`bundleName` 和相关 import；不用的 import / 变量不得生成。
- 若项目只有官方匿名对象字面量示例，生成时仍需遵守 AGENT 约束，改成项目已有 helper 或具名承载结构。
- 写入前展示 deeplink 代码片段；如本地无法编译验证，必须在确认信息中标注该风险。
- 没有项目惯例时，只生成伪代码级方案供用户确认，不直接写入未经验证的 `Want` 构造代码。
- 禁止回退到匿名对象字面量；如果无法确认可编译写法，暂停写入并提示先确认项目中的 Want/startAbility 约定。

**同页面多用例、不同导航方式**：选择最通用的一条导航链路放入 `beforeAll`，其他的在个别 `it()` 内部开头自行处理。

**precondition 翻译规则**：

| precondition | ArkTS |
|-------------|-------|
| `未登录状态` | 检查 → 如已登录则退出登录 |
| `在 <target> 页面` | 已由导航保证 |
| `输入框已清空` | `clearText()` 开头的 `it()` 中处理 |

precondition 校验写入 `beforeAll` 末尾（导航之后）。

#### 5.2 YAML → ArkTS 翻译

**结构化 action 翻译规则**：

| 结构化 action | ArkTS 生成策略 |
|-----------|----------------|
| `kind: click` | 根据 `targetRole` 选择 `ON.id()` / `ON.type()` / `ON.text()`，判空后 `click()` |
| `kind: inputText` | 定位 `targetRole` 输入框，`clearText()`，取 bounds center 后 `driver.inputText(center, text)`，再收键盘 |
| `kind: clearText` | 定位输入框，判空后调用 `clearText()` |
| `kind: swipe` | 定位 `targetRole` 滚动区域；无法稳定定位时使用页面主体区域，但必须保留风险说明 |
| `kind: wait` | `await driver.delayMs(durationMs)` |
| `kind: closePopup` | 根据 `targetRole` 定位关闭控件，判空点击后等待页面稳定 |

**结构化 assert 翻译规则**：

| 结构化 assert | ArkTS 生成策略 |
|-----------|----------------|
| `type: textPresent` | `await driver.assertComponentExist(ON.text(value))` 或项目已有等待封装 |
| `type: textAbsent` | 查询组件并断言为空；如测试框架无直接断言，生成显式条件判断 |
| `type: pageChanged` | 记录 action 前后页面锚点，等待目标锚点出现或原锚点消失 |
| `type: pageAnchorsPresent` | 对 `values` 逐项生成等待 / 存在断言 |
| `type: componentEnabled` | 定位 `targetRole` 控件，判空后检查 enabled / clickable；无法直接读状态时结合源码和点击前置生成保守断言 |
| `type: toastPresent` | action 后短时间轮询 `ON.text(value)` 或项目 Toast 捕获 helper |
| `type: naturalLanguage` | 生成注释和最接近的 UI 断言；不能证明时在确认信息中标注风险 |

历史字符串 action / assert 先按下表兼容转换；无法转换时保留自然语言注释并生成保守 UI 断言。

| YAML | ArkTS |
|------|-------|
| `输入账号 test@example.com` | 标准输入写法（见下） |
| `点击登录` | `const btn = await driver.findComponent(ON.text('登录')); if (btn !== null) await btn.click();` |
| `勾选协议` | `const toggle = await driver.findComponent(ON.type('Toggle')); if (toggle !== null) await toggle.click();` |
| `text: "xxx"` | `await driver.assertComponentExist(ON.text('xxx'))` |
| `text: "xxx"`（跨页） | `await driver.waitForComponent(ON.text('xxx'), 5000)` |
| 自然语言断言 | 注释 + `waitForComponent` 或结构断言兜底 |

**匹配优先级**：`ON.id()` > `ON.type()` > `ON.text()`。`layoutTree.json` 中的 `id` 只能作为参考；只有 exploration / success-path / 源码分析确认该 id 稳定时才优先使用，否则回退到 `ON.type()` / `ON.text()` 并保留判空。

**输入标准写法**：
```typescript
const inputs = await driver.findComponents(ON.type('TextInput'));
if (inputs.length > 0) {
  await inputs[0].clearText();
  const center = await inputs[0].getBoundsCenter();
  await driver.inputText(center, 'test@example.com');
  // 收键盘：点击页面标题区域
  const titleEl = await driver.findComponent(ON.text('<页面标题>'));
  if (titleEl !== null) {
    await titleEl.click();
    await driver.delayMs(500);
  }
}
```

**硬约束**：
- 所有 Component/Driver 方法必须 `await`
- `findComponent` → 判 `null`
- `findComponents` → 判 `length > 0`
- Driver 在 describe 级共享
- 不用 `Level`、不用 `done` 回调

#### 5.3 生成 / 更新 List.test.ets

**生成 / 更新 <Page>.test.ets**

如 `<Page>.test.ets` 已存在 → **追加或更新本次选中 YAML 对应的 `it()`**，不覆盖文件，不删除已有 `it()`、helper、import 或 describe 结构。

如 `<Page>.test.ets` 不存在 → 创建新的测试文件。

同一 YAML 重复生成时，结构化 YAML 优先根据 `caseId` 定位已有 `it()` 并更新该用例；历史字符串写法再根据 `description` 或稳定用例名定位。无法确认对应关系时追加新的 `it()`，并在展示代码时说明。

**生成 / 更新 List.test.ets**

如 `List.test.ets` 已存在 → **追加**，不覆盖：

```typescript
// 已有
import existingSuite from './Existing.test';

// 新增
import pageSuite from './<Page>.test';

export default function testsuite() {
  existingSuite();
  pageSuite();  // ← 追加
}
```

如不存在 → 创建新的。

smoke 脚本追加规则：
- 生成 `<Page>.smoke.test.ets` 时，List.test.ets import 名称使用 `<page>SmokeSuite` 或等价不冲突名称。
- 生成独立 `Smoke.test.ets` 时，List.test.ets 只追加一次 `smokeSuite()`；重复生成时更新 import / suite 内容，不重复追加调用。
- smoke suite 与业务 suite 分开 import、分开调用，避免业务用例选择时被隐式带入。

---

### Step 6：确认 & 写入

展示生成的代码，用户确认后写入目标项目。

确认信息必须包含：
- 选中 YAML 的 records 状态分组。
- 是否存在 `auto_generated/failing/stale/blocked` 或 records 缺失的 YAML。
- 是否存在 `sourceHash` 不一致、success-path 过期或缺少 exploration 的风险。
- 对风险 YAML 的明确建议：优先重新执行 case-gen / runner；用户坚持生成时，在结果说明中标注风险来源。

---

## 关键原则

- 同页面多用例 → 一个 `.ets`（多个 `it()`）
- 所有方法必须 `await`
- 匹配控件时优先参考 `exploration.md`、success-path 和源码确认过的稳定 id；未确认时回退到 `ON.type()` / `ON.text()` 并保留判空
- List.test.ets 追加不覆盖
- 遵守 AGENT.md 中的 ArkTS 约束

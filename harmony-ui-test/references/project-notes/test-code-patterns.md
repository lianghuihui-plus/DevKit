# 测试代码模板规则

## 何时读取

- 生成或修复 ArkTS UI 测试代码时读取。
- 处理人工步骤覆盖、selector、等待、输入、断言、异常暴露、少封装和官方 API 写法时读取。
- 处理平台无关的动作后等待、页面稳定和断言前目标状态时，先读取 `ui-automation-stability.md`。
- 构建、安装、报告字段和失败码分类问题优先读取对应专项文档。

这些规则用于生成或修复 HarmonyOS ArkTS UI 测试代码。通用 UI 自动化稳定性原则由 `ui-automation-stability.md` 承载，本文件只说明 HarmonyOS ArkTS/UiTest 的具体写法映射。

## 测试放置与模块归属

默认将 UI 测试写入对应被测模块：

```text
<module>/src/ohosTest/
```

模块归属以被测行为所在 feature 为准。product/app entry 模块通常只负责 app HAP 构建、安装和 EntryAbility 启动，不默认等于测试代码归属。若人工用例验证的是某个 feature 的页面、路由或业务行为，优先将测试写入该 feature module 的 `src/ohosTest/`。

只有在项目文档或现有结构明确要求集中测试工程时，才使用集中测试模块。

当 UI 缺少稳定定位点时，优先给被测页面或组件补充稳定 `.id()`。除非用户明确要求，不修改业务行为。

## 忠实覆盖人工步骤

生成测试代码前，先把人工用例拆成有序步骤，并逐条映射到测试代码动作。每个步骤都应能在代码中找到对应的启动、等待、点击、输入、滑动、断言或辅助动作。

禁止：

- 跳过人工用例中的关键步骤。
- 合并后丢失中间校验、输入或页面状态变化。
- 把人工预期替换成更容易通过的弱断言。
- 自动补充人工用例没有要求的账号、数据、导航路径或成功条件。
- 因为控件难定位就改成只检查页面存在或流程未报错。

如果无法可靠实现某一步，先查项目 UI 代码和 `references/official/` 中相关 API。仍无法实现时，记录 `generation.status = blocked`，不要生成打折用例。

## 不要吞掉真实异常

不要用宽泛的 `try-catch`、`catch + expect().assertFail()`、只打日志不抛出、返回空对象或跳过断言的方式包住整条用例。这样会遮住真实错误，runner 里只看到兜底失败或继续执行，难以定位失败 selector、阶段或原始异常。

必须：

- 默认让 Hypium 和 UiTest API 暴露原始异常。
- 默认贴近官方示例直接调用 `Driver`、`ON`、`Component`、`expect` 等 API，不为了包装错误信息而新增 helper 或 `try-catch`。
- 只有项目已有公共测试工具、多个用例已经复用同一稳定工具函数，或必须封装重复的非业务样板代码时，才使用 helper。
- helper 不应捕获异常；确实必须捕获时，只能为无法从原始异常判断的底层 API 附加最少上下文，并立即重新抛出。
- `assertFail()` 按官方文档无参数使用，不要假设它能承载错误信息。

推荐写法：

```ts
const loginButton = await driver.waitForComponent(ON.id('login_button'), 5000);
expect(loginButton !== null).assertTrue();
await loginButton.click();
await driver.assertComponentExist(ON.id('home_page_root'));
```

禁止示例：

```ts
try {
  // full test flow
} catch (error) {
  console.error(error);
  expect().assertFail();
}
```

## 关键 selector 必须有上下文

关键页面、入口、按钮、输入框和最终断言控件都应使用稳定 `.id()`。

优先通过清晰的变量名、稳定 id 和直接 API 调用保留上下文。不要为了让错误信息更“漂亮”而把每个操作包一层 helper 或 `try-catch`。

等待或查找失败时，代码上下文中至少能看出：

- 当前测试阶段
- selector 类型
- selector 值
- timeout

## Driver.create 顺序

官方示例中存在先 `Driver.create()` 再 `startAbility()` 的写法。

如果项目中出现启动后首次查找窗口不稳定、目标控件为空、tab 或页面根节点偶发找不到，可以在 `startAbility()` + `waitForIdle()` 后创建或重建 `Driver`。

不要把“start 后 create”写成官方唯一规则；把它作为窗口观察不稳定时的优先修复策略。

## waitForComponent 返回值

对关键 `waitForComponent` 返回值做显式非空检查。不要在后续 `.click()`、`.getText()` 或 `.inputText()` 时才暴露 `Cannot read property xxx of null` 这类低信息错误。

推荐在使用前立即断言：

```ts
const loginButton = await driver.waitForComponent(ON.id('login_button'), 5000);
expect(loginButton !== null).assertTrue();
await loginButton.click();
```

如果只需要验证目标控件存在，优先使用官方断言 API：

```ts
await driver.assertComponentExist(ON.id('home_page_root'));
```

## 等待目标状态

先遵循 `ui-automation-stability.md` 的平台无关规则：任何会改变 UI 状态的动作后，都要等待下一步所需的目标状态稳定，再继续操作或断言。

`waitForIdle()` 只能说明 UI 线程进入空闲，不代表网络请求、登录、提交、页面跳转或数据加载已经完成。登录、提交、跳转、加载等异步流程应等待人工用例要求的目标状态。

优先等待：

- 当前页面关键控件消失，例如登录页根节点或登录按钮不再出现。
- 目标页面关键控件出现，例如首页根节点、成功页标题、订单结果区。
- 人工预期中的稳定文本、状态或可交互控件出现。

如果存在多个合法成功页面，等待共同稳定不变量，例如“离开登录页”或“出现任一合法成功目标页”，不要只等待 `waitForIdle()` 后立即断言。

不要在点击、输入、提交、跳转、返回、弹窗处理或滑动加载后下一句马上断言业务结果。应先等待旧状态消失、新状态出现、loading/遮罩消失、目标控件可交互或人工用例允许的终态出现。

示例：

```ts
await submitButton.click();
await driver.assertComponentExist(ON.id('home_page_root'));
```

## 文本输入策略

优先按官方示例和项目既有风格使用组件输入 API。若 `Component.inputText` 对当前页面无效，例如自定义输入框、禁用系统键盘、焦点被拦截或页面使用特殊输入组件，可以改用控件中心点坐标配合 `Driver.inputText(point, text)`。

输入后必须校验输入结果或后续可观察状态，不要假设输入 API 调用成功就代表页面已接收文本。

坐标输入示例：

```ts
const accountInput = await driver.waitForComponent(ON.id('account_input'), 5000);
expect(accountInput !== null).assertTrue();
const accountPoint = await accountInput.getBoundsCenter();
await driver.inputText(accountPoint, 'test_account');
```

## 参考文档优先

涉及 `Driver`、`ON`、`Component`、等待、点击、输入、键盘、滑动、截图、断言、`startAbility` 和 `aa test` 参数时，优先按 `references/official/` 的 API 和示例写法生成。项目已有测试可以作为风格参考，但如果已有写法会吞异常、弱化断言或偏离人工步骤，应按本文件规则修正。

修复运行期失败时，先使用 `references/project-notes/build-and-run.md` 的 hdc 步骤复现流程，把失败现象对齐到人工步骤和真实 app 状态，再选择 selector、等待、输入或断言方向的最小修改。

## 前置条件不满足不要改断言掩盖

只有人工用例明确声明了阻塞型前置条件，且该条件不满足会导致步骤无法开始时，才在 `state.json`、`case.md` 和本次 run 中记录 `PRECONDITION_UNSATISFIED` 或 `PRECONDITION_UNKNOWN`。

不要因为测试步骤里的目标控件未出现，就反推出新的阻塞型前置条件。步骤执行不到、控件缺失或断言失败，应按真实运行结果记录，例如 `SELECTOR_NOT_FOUND`、`ASSERTION_FAILED` 或 `NAVIGATION_AMBIGUOUS`。

不要通过放宽 selector 或删除断言让用例通过。

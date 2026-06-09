# 测试代码模板规则

这些规则用于生成或修复 HarmonyOS ArkTS UI 测试代码。

## 不要吞掉真实异常

不要用宽泛的 `catch + expect().assertFail()` 包住整条用例。这样会遮住真实错误，runner 里只看到 `assertFail`，难以定位失败 selector、阶段或原始异常。

推荐：

- 让 Hypium 暴露原始异常。
- 只在需要补充上下文时捕获异常，并重新抛出包含 stage、selector、原始错误的信息。
- `assertFail()` 按官方文档无参数使用，不要假设它能承载错误信息。

示例：

```ts
async function waitById(driver: Driver, id: string, timeoutMs: number): Promise<Component> {
  try {
    return await driver.waitForComponent(ON.id(id), timeoutMs);
  } catch (error) {
    throw new Error(`waitForComponent failed: id=${id}, timeout=${timeoutMs}, cause=${JSON.stringify(error)}`);
  }
}
```

## 关键 selector 必须有上下文

关键页面、入口、按钮、输入框和最终断言控件都应使用稳定 `.id()`。

等待或查找失败时，错误信息中至少包含：

- 当前测试阶段
- selector 类型
- selector 值
- timeout

## Driver.create 顺序

官方示例中存在先 `Driver.create()` 再 `startAbility()` 的写法。

如果项目中出现启动后首次查找窗口不稳定、目标控件为空、tab 或页面根节点偶发找不到，可以在 `startAbility()` + `waitForIdle()` 后创建或重建 `Driver`。

不要把“start 后 create”写成官方唯一规则；把它作为窗口观察不稳定时的优先修复策略。

## waitForComponent 返回值

对关键 `waitForComponent` 返回值做显式非空使用和上下文错误暴露。不要在后续 `.click()` 或 `.getText()` 时才暴露空对象问题。

## 前置条件不满足不要改断言掩盖

如果真实失败来自前置条件不满足，例如“用户已登录”不成立导致设置页不渲染“退出登录”，应在 execution plan/report 中记录 `PRECONDITION_UNSATISFIED` 或 `PRECONDITION_UNKNOWN`。

不要通过放宽 selector 或删除断言让用例通过。

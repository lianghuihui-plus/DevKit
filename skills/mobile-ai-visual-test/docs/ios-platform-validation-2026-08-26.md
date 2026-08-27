# iOS 平台验证记录

## 结论

2026-08-26 在 iPad Pro 真机上完成当前 iOS 平台适配验证。Appium/WDA 可以连接目标 App，截图、控件树、前台 App、Home、Launch App、控件树坐标和 Retina 截图坐标均通过真实设备验证；批次暖会话 probe 可以消费完整 iOS binding。

本次没有创建 execution 或执行业务用例，因此不代表当前 implementation 已完成正式 case 主链验收。iOS 真机日志仍不属于可用能力。

## 环境

- Device: `AAA iPad pro`
- Device ID: `00008027-001120DE3A40402E`
- OS: iOS 15.4.1
- Xcode: 26.3
- Appium: 3.5.2
- XCUITest Driver: 11.17.1
- App: `arena.codemao.cn`
- WDA: `cn.codemao.WebDriverAgentRunner`
- Screen: landscape `1194x834`, Retina screenshot `2388x1668`
- Current iOS implementation: `agent-implementation-c77469e8c1aba9b0`

## 验证结果

| 能力 | 结果 | 设备事实 |
| --- | --- | --- |
| 环境 probe | 通过 | 真机、Xcode、Appium 和 XCUITest Driver 均可用 |
| WDA prepare | 通过 | 成功建立 `arena.codemao.cn` 自动化 session |
| 只读 observe | 通过 | 生成有效 PNG、XML，并识别目标 App 前台状态 |
| 非目标 App 观察 | 通过 | Home 后 observe 保持 SpringBoard，未自动拉起目标 App |
| App 生命周期 | 通过 | Launch App 后重新识别目标 App 前台 |
| 冷启动 | 通过 | terminate 后状态 `1`，activate 后状态 `4`，PID `16643 -> 17601` |
| 横屏尺寸 | 通过 | 从可见 Window 得到 `1194x834`，不再使用竖屏 Application 尺寸 |
| 视觉坐标 | 通过 | 截图像素 `(80,1224)` 换算为逻辑点 `(40,612)` 并命中“我的”入口 |
| 控件树坐标 | 通过 | 使用逻辑点完成弹窗关闭与页面恢复 |
| 批次 probe | 通过 | 完整 iOS binding 返回 `ok=true` |
| 真机日志 | 未支持 | 不影响截图、控件树、前台识别和动作 |

## 验证中修复

1. observe session 设置 `autoLaunch=false`，避免观察动作改变前台现场或掩盖 App 退出。
2. 横屏尺寸优先读取可见 `XCUIElementTypeWindow`，不再使用方向可能滞后的 Application bounds。
3. 视觉坐标按 Appium window rect 将 Retina PNG 像素换算为逻辑点；控件树坐标保持原值。
4. 批次暖会话 probe 使用冻结 binding 中的 iOS 设备类型和 WDA 签名参数，同时不向 probe 传入目标 App 参数。

## 后续验收

正式 case 主链仍需按当前人工流程完成：确认本次 iOS 设备和 App binding，随后由用户明确指定单用例或有序批量范围，再创建新的 batch 和 execution。建议至少覆盖一个观察型 PASS、一个坐标动作和一个暖会话后续 case。

## 整串输入优化复核

针对 004 用例暴露的文本输入问题，iOS adapter 已改为优先使用 Appium active element，并在同一 session 内按 `wda-element-value -> wda-session-keys` 执行最多两种整串输入方案。普通输入框核对明文，安全输入框核对掩码长度；内部失败返回结构化 `IOS_INPUT_TEXT_FAILED`，不会把逐字符键盘点击交给 Case Agent。

本次改造后重新连接真机，WDA prepare、目标 App 前台识别、横屏 `1194x834` 和截图/控件树观察通过。设备当时已经登录且处于学习页，没有直接执行账号和密码输入；整串输入主备路径由不连接设备的确定性 Appium 模拟测试覆盖，完整 004 真机回归仍属于后续正式 case 验收。验证结束后已关闭 Appium 和 WebDriverAgent。

## 自动化资源释放复核

针对批次结束后 WDA 可能独立于 Appium 残留的问题，iOS 平台运行资源已拆分为 Appium、WDA 和端口转发三项。WDA 只在设备 ID、bundle id、Appium WebDriverAgent 工程、PID、启动时间和独立进程组全部匹配时由框架释放；批次开始前存在且没有框架注册记录的进程按外部资源保留。

真机复核先通过 `prepare-env` 创建并删除临时 Appium session，确认准备阶段启动的 WDA 随后退出，8100/9100 无监听；再通过 runtime `acquire/release` 认领 PID `76419` 的框架 Appium，释放结果中 Appium、WDA、端口转发均为 `RELEASED`。最终 Appium/WDA 进程、4723/8100/9100 监听和临时所有权注册表全部为空。

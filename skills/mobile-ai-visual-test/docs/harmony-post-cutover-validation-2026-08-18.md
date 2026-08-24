# HarmonyOS 切换后正式入口验收记录

> 历史设备基线：本文只证明 2026-08-18 对应 implementation 的设备事实，不代表后续 implementation 已完成真机验收。当前状态以 `architecture.md` 为准。

## 结论

2026-08-18 在 `Mate 70 Pro` HarmonyOS 6.0.1 模拟器上完成 Agent 主链切换后的正式入口验证。最终暖批次包含 2 个低风险代表性用例，均为 `PASS / DIRECT_EVIDENCE`；两个 case 使用独立 execution 和 session，普通 case 间未冷启动，原文明示冷启动通过 batch recovery 执行。

Android 和 iOS 不在本次结论范围内，仍为待验证。

## 环境

- Device: `Mate 70 Pro`
- Device ID: `127.0.0.1:5555`
- Platform: HarmonyOS 6.0.1(21)
- App: `com.codemao.hos.lunar`
- Entry: `EntryAbility`
- Workspace: `/private/tmp/mavt-t707-emulator-r4`
- Batch: `batch-t707-emulator-r4`
- Implementation: `agent-implementation-bca5b9ba4a627614`

## 用例与结果

| 用例 | 结果 | Session | 关键事实 |
| --- | --- | --- | --- |
| 应用启动后页面可用 | PASS / DIRECT_EVIDENCE | `session-20260818-115357-507-jwp1` | 0 个业务动作；目标 App 前台；页面非桌面、黑屏或崩溃页 |
| 显式重新启动后页面可用 | PASS / DIRECT_EVIDENCE | `session-20260818-115442-928-svu7` | recovery 成功；generation `1 -> 2`；PID `26455 -> 3172`；恢复后首页可操作 |

批次结束时 `appStartCount=2`、`recoveryCount=1`，符合“一次 bootstrap + 一次原文明示 recovery”的启动记账；普通 case 切换没有额外启动。

## 验收中发现并修复

1. observe/action 正式入口原先要求 Agent 自行生成 `authorizationSha`，现改为可信入口根据授权字段生成并冻结。
2. commit-turn 原先允许省略 `planSha`，但 timeline 写入又要求该字段，现由可信入口统一生成并冻结。
3. recovery 原先只更新 execution 和 Runtime generation，导致恢复后 request 绑定失效；现同步重绑定当前 request、生成新 requestSha，并按 generation 归档旧 request。

每次实现变化后均新建 batch 和 execution，没有跨 implementation 续写。

## 产物

- 总览：`/private/tmp/mavt-t707-emulator-r4/index.html`
- Case 1：`/private/tmp/mavt-t707-emulator-r4/cases/01-app-usable__ck-68473039118e/platforms/harmony/CONTEXT.md`
- Case 2：`/private/tmp/mavt-t707-emulator-r4/cases/04-explicit-restart__ck-1d4290c92650/platforms/harmony/CONTEXT.md`

## 门禁结论

当前 HarmonyOS 交付范围可以继续，不需要恢复旧执行入口。若后续出现数据损坏、安全越界、正式主链不可用或历史报告不可读，仍按完整代码版本回退，不在当前版本内增加旧协议开关。

## 验收后清理

2026-08-18 在不改变正式行为的前提下，删除无调用方的 Agent request CLI、旧 case ref helper 和一次性切换前验收 runner，并将阶段性方案与切换前记录移入 `docs/archive/`。清理后协议摘要保持 `agent-protocol-d99d3635e08576e9`，HarmonyOS implementation 摘要更新为 `agent-implementation-cc3ee83a462b5794`。

清理后重新执行 13 组 `self-test`、switched cutover 门禁、Skill 静态校验、活跃文档引用扫描和 `git diff --check`，结果均通过。该清理不改变上述真机批次的设备事实和业务结论。

## 运行控制优化

2026-08-18 增加环境确认与执行授权分离：环境确认只生成 `environment-confirmation.json`；用户后续明确指定单用例或有序批量范围后，才生成不可变的 `execution-request.json` 并初始化 batch。执行请求固定 `UNATTENDED`，case Agent 禁止请求用户交互；case 级歧义或外部条件缺失形成结果后继续，批次级不可恢复问题自动停批并报告。

本次变更后执行 14 组 `self-test`、switched cutover 门禁、Skill 静态校验和 `git diff --check`，结果均通过；HarmonyOS implementation 摘要为 `agent-implementation-f47bb51487775b9f`。本节只记录契约与自动化复验，没有新增真机执行结论，上述设备事实仍来自原正式批次。

## 当前看板重构

2026-08-18 将总看板从旧步骤执行视角重构为当前 Agent 执行视角：展示环境确认、显式执行授权、批次进度和暖会话四段运行控制；结果按 PASS、FAIL、BLOCKED、INCONCLUSIVE 和未执行统计；用例明细展示 verdict basis、动态计划、知识查询、恢复、时限与平台报告，并始终按用例编号（缺少编号时按标题）排列，不受最近执行请求影响。历史报告继续只读展示，但不再决定总看板结构。

重构后执行 15 组 `self-test`、switched cutover 门禁、Skill 静态校验和 `git diff --check`，结果均通过。另使用系统 Chrome 对 1440px 桌面和 390px 移动端进行截图、页面宽度、状态筛选和搜索检查，未发现页面级横向溢出；该报告层变更不改变 case 执行 implementation 摘要，也没有新增真机执行结论。

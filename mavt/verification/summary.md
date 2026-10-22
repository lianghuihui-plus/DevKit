# MAVT 插件化验证汇总

整理日期：2026-10-22。保留插件化开发的验证结论和边界；原始 JSON 与日志已精简，不作为插件运行依赖。已提交的原始记录可从 Git 提交 `3621f35` 恢复，清理时的本地副本另移入系统废纸篓。

## 当前交付：0.2.1 MCP 单版本（未安装）

- 在独立 worktree `/Users/cm/.codex/worktrees/mavt-mcp/DevKit/mavt` 完成；新任务的三个 Skill 和 Case 调用统一使用 MCP，移除普通版/预览版开关、CLI 回退说明、旧 Case MCP server 及无效引用。仍用于 MCP 共享实现、版本绑定、Loader、技术维护和开发验证的底层脚本保留，不改写旧 Run 固定副本。
- 当前唯一交付源为 `dist/mavt-marketplace/`，版本 `0.2.1`；bundleId 为 `9277840c140b3721a99e845830d1f8f8f7a489d25c63c90e8a991273ce8289c8`，manifest 315 项，工具 30 个，Case transport 标记为 MCP，worker 默认空闲期限 300000 ms。旧构建和中间产物移入忽略目录 `verification/archive-builds/pre-mcp-only-0.2.1/`，可恢复，不再作为当前安装源。
- 完整 `npm test` 退出码 0：运行时 88 组、知识维护 6 组、插件测试 77/77、生成文档 51 份通过；最后只调整错误恢复指引后，文档、单一契约、边界和长度预算四组专项及 51 份生成检查再次通过。三个 Skill 格式校验及 `git diff --check` 通过。
- 最终构建通过完整 bundle 校验；独立 Codex app-server 探针验证重定位注册、三个 Skill、30 工具发现、doctor 和 68 字节图片精确一致。探针隔离个人配置，无安装、模型轮次或设备连接；服务连通不代表实际子 Agent 工具和图片已验收。
- 入口决策审查覆盖 Authoring 5、知识维护 6、Run 8 个场景，验证新流程使用 MCP、缺失绑定阻塞、UNKNOWN 不重放及旧版本不接管；这些是指令决策验证，不能替代模型与设备端到端执行。
- 清理时曾发现提示词超出原 10 KiB 预算、知识文档测试仍要求旧 CLI 示例、旧 Loader fixture 误带新 MCP 标记，均已修正并复验。一次 stdin 等待期间替换 dispatch 的测试返回 FAILED 而非 REJECTED，定向及最后完整回归均未复现；已补充失败响应诊断，原因尚未确认，不据此修改业务行为。
- 未重新测量整批耗时或 RSS；上文所述历史冷启动取舍由用户接受，历史严格冷暖对等失败记录保留。手机、模拟器、真实子 Agent 可见性和实际运行效果由用户验证；未自动安装、合并或推送。

下列 0.1.1、0.2.0 及双版本路径均为历史记录；旧路径已归档，当前交付以上述 0.2.1 为准。

## 历史基线：0.1.1

- 项目：独立、自包含的 `mavt/`，完整纳入测试运行时和知识管理；在 `main` 开发。
- 插件版本：`0.1.1`；Codex CLI 实测版本：`0.163.0-alpha.10.2`；Node.js：`v24.18.0`。
- 三个入口：`mavt:author-cases`、`mavt:run-tests`、`mavt:manage-knowledge`，中文显示信息和 enabled 状态已通过真实 app-server 检查。
- bundleId：`a61d7b3025054daae3a8bbc834eb685f1a5fe9a8372525ad4684b8f9df92e16e`；生产清单 314 项，固定运行时和宿主指引清单 306 项。
- 插件化及入口统一已于 `3621f35` 提交；本次验证记录精简不修改运行时和 Skill。

## 已完成的验证

| 阶段 | 实际结果 | 证明范围 |
| --- | --- | --- |
| 初期可行性原型，2026-10-21 | 15 项检查通过，18 组迁移后 MAVT 回归、5 组知识维护回归通过 | 临时原型安装、入口发现、Agent 隔离及文件/图片/命令能力；当时尚未完成正式绑定实现 |
| 正式插件实现，2026-10-21 | MAVT 88 组、知识管理 6 组、插件专项 24 项、生成文档 51 份、Skill 格式 3 个通过 | 正式绑定、快照、恢复和发布逻辑的无设备验证 |
| 自包含项目及 main 迁移，2026-10-21 | 插件专项增至 26 项，其余回归保持通过；原 386 个测试模块文件与 18 个知识模块文件全部迁入 | 项目独立性、知识模块完整归属及主工作区回归 |
| 入口统一，2026-10-22 | 88 组运行时、6 组知识管理、26 项插件/项目边界、51 份生成文档及三个 Skill 格式检查通过 | 新命名、中文界面信息和原有职责边界；独立只读评审的四个场景推演未发现遗漏 |
| 提交前回归，2026-10-22 | 完整 `npm test` 退出码 0，88 / 6 / 26 / 51 检查通过 | 提交 `3621f35` 时的源码基线 |

正式插件和自包含迁移阶段还实际验证了：

- 在独立临时 Codex home 安装、列表、真实 app-server 三入口发现，以及升级后旧缓存被移除时，从工作区固定副本恢复和取消原 Run；取消在设备确认前完成。
- OS sandbox 拒绝读取原始源码后，独立安装包冒烟通过；仅复制本项目并禁止读取原始 DevKit 和旧实现工作树后，构建与完整回归通过。
- 发布清单完整性、文件摘要与执行位、ZIP 解压校验，以及独立源归档解压后的重建与 bundleId 一致性。
- 并发快照发布、初始化中断、绑定/状态配对发布、缺失/损坏/错误绑定拒绝写入、多 Run 选择、共享报告锁、固定知识事务及延迟报告恢复。

历史 `0.1.0` bundleId 为 `5d0154601ddf7a976ff4be2b10c23631324ce2afcfe2cd0b46605ae135b95542`，生产清单为 311 项；初期原型摘要不代表正式发布物。当前归档校验值以 `dist/SHA256SUMS` 为准，不将可能变化的源码归档摘要写入自身。

## 已知边界

- 所有手机、模拟器和设备连接验收由用户执行；上述平台相关自动测试使用离线 fixture/double，不能证明真实设备端到端行为完全等价。
- 部分进入执行阶段的恢复场景使用离线 Batch port；真实设备取消与资源释放仍待验收。
- 真实 app-server 发现通过不代表已验收桌面 GUI 插件管理和现有会话的重载行为。
- 原型首次取消断言误用了 `outcome`，改为契约字段 `runOutcome` 后复跑通过；未为迎合测试修改运行时。
- 初期原型验证期间主配置出现其他操作加入的 MCP 配置；该探针未写主配置，不据此声称主配置全程字节不变；临时认证副本已删除、原认证摘要未变。
- 此前曾将本机安装更新至 `0.1.1`；用户随后要求开发侧只更新代码、验证和构建，后续不再自动安装。

需要重新验证时，在项目根目录运行 `npm test`。安装/升级验证脚本 `tests/host-install-check.js` 仅在明确需要时手动运行；本次清理不运行安装或设备测试。

## 0.2.0 MCP 预览开发验证（未安装）

- 普通构建保留固定 CLI 默认，排除 MCP 注册、入口及运行时模块；预览构建通过 `--mcp-preview` 才发布完整闭包。评审修复后的最终本地安装源位于 `dist/mavt-marketplace-0.2.0-review-fix1/` 和 `dist/mavt-mcp-preview-0.2.0-review-fix1/`，未安装；完整性校验中普通 bundle `f1518157ea02413e5d110b5c657e8bc6b921ab9ef91d03efa22e57a4c288e677` 为 307 个 manifest 文件，预览 bundle `e889bcc6c3f2b71540191fe24a33eccda1602299c8010b49a077532dad6d5634` 为 316 个。此前 `*-final/` 目录是修复前的历史产物，不用于此次评审。
- 评审修复后 `npm test` 退出码 0：运行时自测 88 组、知识维护自测 6 组、插件测试 79/79、生成文档 51 份。独立 Codex app-server 无模型探针发现 30 个工具、doctor 成功、68 字节 PNG 图片与已发布资源完全一致；该探针没有安装插件，也没有设备/模型执行。
- 原始比较保留在忽略文件 `verification/mcp-benchmark-default-preview-final-gated.json`；其 30 暖/12 独立冷门槛结果为 `warmPreviewPass=false`、`defaultCliPass=false`、`mcpDefaultSwitchApproved=false`，不得用后续较好的样本覆盖失败记录。
- 缩小普通包后的完整复测保留在 `verification/mcp-benchmark-task3-packaging-30warm-12cold.json`；五类暖 MCP 调用均通过原 CLI 和普通 CLI 的 p50/p95 门槛，但普通 CLI `knowledgeList` p50 为 27.98 ms，对原 CLI 27.58 ms，导致 `defaultCliPass=false`。12 次独立冷 Loader 加首次 Case 读取 p50/p95：原 CLI 183/211 ms，普通 CLI 160/177 ms，预览 CLI 214/382 ms，预览 MCP 283/291 ms；`mcpDefaultSwitchApproved=false`，默认仍为 CLI。冷预览 CLI 的高 p95 是实测离群值，不隐去。
- 只读知识 CLI 延迟加载事务模块后，同规格复测保留在 `verification/mcp-benchmark-task3-lazy-knowledge-30warm-12cold.json`；`knowledgeList` 普通 CLI 25.58/27.10 ms 优于原 CLI 26.17/28.17 ms，但普通 CLI doctor 75.46/79.78 ms 对原 CLI 74.40/76.68 ms、Run read p95 128.49 ms 对原 124.62 ms 边缘失守。五类暖 MCP 工作负载通过；独立冷 Case 原 CLI 177/194 ms、普通 CLI 155/163 ms、预览 CLI 203/214 ms、预览 MCP 269/282 ms，故 `defaultCliPass=false`、`mcpDefaultSwitchApproved=false`，基准退出码仍为 1。前三次完整原始测量均保留，不用其中有利样本冒充总门槛通过。
- 评审修复对 doctor 的 Run 绑定与 bundle 清单、Coordinator read 的执行结果与遥测做同请求复用；测试观察整包清单读取分别从 2 次降为 1 次、3 次降为 2 次，同时保留 stdin 前后校验和下一次调用的篡改拒绝。新原始记录 `verification/mcp-benchmark-task3-review-fix1-30warm-12cold.json` 为同规格 30 暖/12 独立冷：普通 CLI doctor 52.55/55.42 ms 对原 74.32/78.12 ms，Run read 95.63/98.64 ms 对原 115.73/119.81 ms；五类普通 CLI 及暖 MCP p50/p95 门槛均通过，`defaultCliPass=true`、`warmPreviewPass=true`。但独立冷 Case 原 CLI 174/184 ms、普通 CLI 153/159 ms、预览 CLI 202/208 ms、预览 MCP 266/274 ms；`mcpDefaultSwitchApproved=false`，总 `pass=false`、退出码 1，默认 MCP 切换仍未获批准。基准总退出门槛现明确包含冷 MCP 对等，不再可能以暖通过掩盖冷失败。
- 评审修复后的预览工具目录响应为 67,758 字节（定义 67,714 字节）；独立空闲 MCP 服务 RSS 53,584 KiB，一个活跃 worker 时服务加 worker 为 237,440 KiB，30 秒回收 worker 后为 85,680 KiB。普通 CLI 仍是每调用一个子进程，暖 MCP 工具调用没有逐操作 CLI 子进程；此数值不代表模型 token 成本。
- 离线只读 Run 状态/报告与按需图片读取前后工作区字节未变；图片 68 字节源文件的 MCP 响应为 1,155 字节。真实 Provider `ACTION_OUTCOME_UNKNOWN` 通过 MCP、独立子 Agent 图片可见性、桌面会话重载及设备端到端行为仍待用户验收，不得由离线探针推定。
- 普通包与预览包同为 `0.2.0`，但 bundle ID 和 MCP 注册不同；尚未执行两者之间的同版本安装/更新/缓存切换。`plugin/read` 的预览发现不能替代该验收，当前不宣称切换已成功。

## Worker 空闲回收调整（2026-10-22，未安装）

- 按用户要求将 MCP worker 默认空闲回收时间从 30 秒延长至 5 分钟；复用后重新计时，最多 5 个 worker，服务关闭仍立即清理空闲进程。空闲内存保留时间相应延长，不保证 Case Agent 生命周期内只启动一次。
- 本次 `npm run test:plugin` 79/79 通过，`npm run check:docs` 检查 51 份文档通过；另以加速时钟和真实 worker 进程检查跨越旧 30 秒阈值复用、重置空闲期限、5 分钟到期回收、后续重新启动及主动关闭释放。未运行手机测试或重新测量整批性能/RSS。
- 两种构建均成功，当前产物为 `dist/mavt-marketplace-0.2.0-idle5m/`（普通 bundle 仍为 `f1518157ea02413e5d110b5c657e8bc6b921ab9ef91d03efa22e57a4c288e677`）和 `dist/mavt-mcp-preview-0.2.0-idle5m/`（预览 bundle `24305e48eade17a4803eff400f8d9d36b69738c7582cbb20f1d7c301e225cf9a`）；未安装。基准回收等待已跟随默认时间更新，上文 30 秒策略的测量仍保留为历史记录。

## 历史清理检查（0.1.1 基线）

以下记录属于 `0.1.1` 清理，不是上文 `0.2.0` 预览开发的构建或安装结论。2026-10-22 删除 31 份项目内历史原始记录和旧目录中 9 份完全一致的副本，共 40 个文件，另保留本汇总。四个必要 JSON 均保留。

- 插件和项目边界测试 26 项通过，失败 0；生成文档 51 份检查通过。
- 重新构建通过，发布清单内全部文件及 bundle manifest 与现有 `0.1.1` 产物逐字节一致；因此无需递增插件版本或更新安装。
- 已修改 Markdown 的 21 个本地链接检查通过；清理未修改运行时、Skill 和测试代码。
- 补齐 Git 忽略规则后，18 类本地产物的忽略检查及 16 类源码、配置、fixture 的保留检查通过；构建产物仍逐字节一致，51 份生成文档复查通过。原始记录删除与本规则以新提交记录，保留此前提交历史。

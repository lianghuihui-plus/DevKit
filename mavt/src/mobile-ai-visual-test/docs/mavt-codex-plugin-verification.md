# MAVT Codex 插件可行性验证记录

- 日期：2026-10-21。
- 对应方案：[MAVT 单插件化技术方案](mavt-codex-plugin-tech-design.md)。
- 执行范围：前三轮非设备可行性验证；第四轮设备验收由用户执行。
- 验证对象：临时插件和组装原型，不是正式 MAVT 插件的发布验收。
- 运行版本：Codex CLI `0.163.0-alpha.10.2`，Node.js `v24.18.0`，macOS。
- 历史临时目录：`/private/tmp/mavt-validation.KiF1Dj`；原始 JSON 和日志已精简，阶段结论见 [验证汇总](../../../verification/summary.md)，原始记录可从 Git 提交 `3621f35` 恢复。

## 1. 结论

当前 Codex CLI 能安装该清单形态的单插件、发现三个 Skill，并由 Agent 正确定位插件脚本和提交 stdin JSON。独立 Case Agent 的图片、文件与命令能力，以及等待和中断机制，均取得实际行为证据。

运行时按方案目录组装、提取协调资源后，可以在操作系统拒绝读取 DevKit 源码目录的条件下运行。两次构建的文件、字节、执行位和 bundleId 一致；固定副本在原安装位置失效及 CLI 插件升级后仍可执行已覆盖的继续/取消操作。

原型最终 15 项检查通过，其中包含 18 组迁移后 MAVT 回归和 5 组知识维护回归。此结果支持设计方向，不证明尚未实现的正式启动器、Run binding 事务及全部异常路径正确。实际设备的执行、取消、资源释放和活动任务升级恢复留给第四轮。

## 2. 隔离与原型改动

插件注册、安装缓存、模型会话和临时工作区均置于专用 Codex home；原有独立 Skill 未被停用或删除。原型没有执行设备发现、连接、安装 App、输入或点击。回归中的设备行为使用现有测试 fixture。

为复用当前账号连接，在临时 home 中使用了权限为 `0600` 的认证副本，结束后已删除；原认证文件摘要未变。主配置中没有 `mavt-probe-local` 注册项。本轮收尾发现主配置字节有变化，新增了初始清单中没有的 `mcp_servers.module_onboarding` 节；本验证脚本没有写主配置，也没有回滚其他操作产生的变化，因此不宣称主配置全程字节不变。

仅在临时组装目录作以下改动：

1. 生成 `.codex-plugin/plugin.json`、本地 marketplace 索引和三个用于 smoke 的短 Skill。
2. 复制 MAVT 的 scripts/prompts/references，以及知识维护的 scripts/references/assets；运行时根不包含 `SKILL.md`。
3. 将当前根 Skill 正文复制为 `references/coordinator-principles.md`，机械替换协调资源清单中的路径。这只验证资源提取机制，尚未完成正式入口的职责精简和迁移。
4. 生成覆盖 runtime/hosts 的 401 条文件清单。B 在一份 Runtime 文件末尾添加原型注释并改变宿主指引，以产生不同的实现摘要和 bundleId。
5. 用验证脚本复制和校验固定副本。正式的 `mavt-entry.js`、runtime binding 模块及成对发布事务没有实现。

源码与现有运行时未被修改。本次仓库新增内容为技术方案、验证记录和证据文件，没有提交或发布正式插件。

## 3. 第一轮：实际 Codex 容器与 Agent

独立 home 初始 `plugin list --json` 返回 installed/available 空数组，marketplace 列表为空。随后实际执行 marketplace add、plugin add 和 app-server 的 `skills/list`。

| 检查 | 实际观察 | 判定范围 |
| --- | --- | --- |
| 候选清单与本地 marketplace | 安装器退出码 0，插件启用 | 当前 CLI 接受已使用的字段；不是官方 schema 或最低版本证明 |
| 三个入口发现 | 全部 enabled，errors 为空 | 注册名为 `mavt:mobile-ai-visual-test`、`mavt:mavt-case-authoring`、`mavt:mavt-knowledge-manager` |
| 入口调用 | Agent 读取安装缓存中的 Skill，定位脚本，三个角色均返回实际 JSON | 证明发现、路径与调用链；smoke Skill 不包含正式用例工作流 |
| stdin 字符保持 | `中文 input $ literal` 原样返回 | 中文、美元符号未被 shell 误展开 |
| Case Agent 隔离 | 实际 `spawn_agent` 的 `fork_turns` 为 `none`；子会话存在 | 父上下文标记在行为探针中未出现；不是操作系统安全隔离证明 |
| 本地图片 | 子 Agent 描述红色左半、蓝色右半、中央黄色圆形 | 与未告知其内容的 240×160 图片一致 |
| 子 Agent 执行命令 | 读取指定脚本并得到 execution 角色的 JSON | 固定文件与命令工具可用 |
| 等待与中断 | 首个子 Agent 完成；另一个子 Agent 经实际工具观察 `running → interrupted` | 不推导 Node 子进程或设备资源已被清理 |

当时通过入口发现和宿主行为记录核验。CLI 事件流没有展示全部原生工具事件，因此额外核对了持久化会话中的实际 spawn 参数和两个子会话元数据，没有仅凭最终回复判断 Agent 已创建；这些原始输出现已归入 Git 历史。

本轮使用同一桌面安装内的 CLI 和实际 app-server 协议；未在桌面插件页面操作安装、重载或选择 Skill，桌面 UI 的这些行为仍需正式产物验收。

## 4. 第二轮：脱离源码的组装产物

子进程使用 macOS `sandbox-exec`，策略为：

```scheme
(version 1)
(allow default)
(deny file-read* (subpath "/Users/cm/GitProj/DevKit/skills"))
```

先实际读取原根 Skill，确认返回 `EPERM`；随后在同一拒绝策略下执行组装产物。没有临时改动源码目录的权限或内容。

| 检查 | 结果 |
| --- | --- |
| 两次 A 构建 | 文件集合、内容、执行位一致，bundleId 同为 `22735789b67608f19b36dbc3abdd890edcfc32c962082d1da2c6eb681cb215fd` |
| 三平台 × 两角色契约 | 六组均成功；协调 requiredResources 使用提取后的文档 |
| 中文、空格路径，从任意 cwd 调用 | 初始化 READY、导入两个用例、重复导入身份不变 |
| 知识事务 | prepare 不修改正式知识；apply 成功并产生备份 |
| 报告 | 固定副本生成有效的 workspace index.html |
| 非 JS 资源遗漏 | 删除副本中的 Helper APK 后，原型清单校验拒绝 |
| 文件被改写 | 修改副本脚本后，原型清单校验拒绝 |
| 安装树写入 | 全部命令和回归结束后，固定 runtime/hosts 清单仍完全一致 |

迁移后的 18 组 MAVT 测试为：platformRuntime、workspace、caseAuthoring、control、knowledge、knowledgeClosure、caseFlow、batchCancellation、batchReconcile、agentHandoff、coordinatorAgentFacing、agentFacingTransportParity、agentFacingDocs、report、publication、crossPlatformExecution、finalReviewGate、executionFlowCombination。

知识维护的 5 组为：contract、store、transaction、cli、mavtCompatibility。未把依赖原根 `SKILL.md` 的布局测试冒充为新布局通过；正式入口语义及测试裁剪仍需正式代码验证。

当时的 15 项检查、MAVT 回归和知识回归原始输出已归入 Git 历史，阶段结果保留在本文及统一验证汇总。

## 5. 第三轮：版本固定与实际 CLI 升级

| 场景 | 实际观察 | 限制 |
| --- | --- | --- |
| A 从工作区固定副本创建 Run，移走模拟安装目录 | 原发布资源 read 成功 | 覆盖未确认 Run，无设备资源 |
| B 创建新 Run | 命令含 B bundleId，runtimeSha 与 A 不同；A 命令仍指向 A | 由原型脚本选择固定副本，尚非正式启动器 |
| 知识 prepare 后安装位置失效 | 同一固定 A 入口 apply 成功 | 没有验证跨会话丢失入口后的交互 |
| 未确认 Run 取消 | `result.outcome=COMPLETE`，`data.content.runOutcome=CANCELLED`，持久化状态一致 | 未覆盖活动设备取消 |
| 完整组装包实际安装 A，再用 plugin add 升级 B | `0.0.0-probe → 0.0.1-probe`，安装缓存路径不同，三个入口切到 B | 当前 CLI 行为，不代表桌面所有重载行为 |
| 移走独立 home 中旧 A 安装缓存，再推进固定 A 的终态 Run | 仍返回 CANCELLED，命令保留 A bundleId | 覆盖终态继续；活动 execution 升级恢复由第四轮覆盖 |

实际安装升级的结果如上表，原始输出已归入 Git 历史。

取消检查首次失败来自验证脚本将 `data.content.outcome` 误当成取消结果；源码契约及已有回归明确使用 `runOutcome`。只修正验证断言并新建未确认 Run 复跑，得到通过；没有修改 MAVT 来迎合测试。首次结果与复跑记录可从 Git 历史恢复。

## 6. 尚未验证的非设备实现

下列内容仍由后续实现者自动验证，不转交用户承担，也不计为本轮通过：

- 正式 `mavt-entry workspace/resume/doctor`、文档根和新旧 Run 判别。
- runtimeBindingRequired、binding 与初态成对发布、并发复制及创建中断。
- 缺 binding、错误 bundle、路径越界时，所有正式命令在副作用前拒绝；本轮只验证独立原型校验器。
- 新版 Skill 继续旧 Run 时先解析绑定，再加载旧原则和旧宿主指引。
- 正式三个 Skill 的完整业务行为和原规则迁移；本轮三个 Skill 仅用于 smoke。
- A/B 交错发布共享报告、完整资源所有权竞争和实际 continuation 与升级集成。
- 桌面 UI 安装/重载，以及最终裁剪发布包的验证。

这些项目依赖尚未存在的正式代码。当前证据足以支持进入实现，不能据此宣布前三轮正式发布验收全部结束。

## 7. 第四轮：用户设备验收清单

以下清单在正式插件产物及上一节自动化验证完成后使用。当前临时 probe 包不能执行真实用例，不应拿它连接设备。

每个平台先记录：插件版本/bundleId、Codex 版本、系统与设备型号、App 版本、工作区、用例号、batchId、executionId、报告路径。使用专门的测试设备、测试 App 和账号。

| 编号 | 用户操作 | 应观察到的结果 |
| --- | --- | --- |
| D1 | 安装正式插件，按迁移说明停用旧同用途入口，导入一份小型材料 | 正确发现入口；用例数量及内容与材料一致 |
| D2 | 选择目标平台和 App，执行一个已知可通过的用例 | 环境确认正确；独立 Case Agent；截图、CHECK、最终结果与实际页面一致 |
| D3 | 执行两个用例组成的批量 | 顺序执行；每个 Case Agent 独立；前一个已 commit 才进入后一个 |
| D4 | 执行包含中文输入和页面跳转的用例 | 输入完整、动作落点正确、动作后证据可读；技术成功不自动当作 CHECK 通过 |
| D5 | 执行一个预期不满足的测试场景 | 有直接业务证据才报 FAIL；技术故障不会伪装为产品 FAIL |
| D6 | Case Agent 活跃时明确取消 | Run 终态取消；持久化结果一致；设备服务、锁和资源释放有可验证记录 |
| D7 | 用正式 A 开始测试，按支持流程升级 B 后继续原 Run | 原任务沿用 A 的命令、文档和摘要；新任务使用 B；不重复派发 |
| D8 | 在可控条件下停止 Case Agent 后继续 | 先核对真实句柄/停止事实；按 continuation 恢复；旧写入身份失效；不重放未知动作 |
| D9 | 检查最终报告与下一次运行 | 截图和链接有效；各用例结果正确；没有遗留资源阻止下一批次 |

Android 需覆盖拟发布的 Helper/降级支持范围；HarmonyOS 检查截图与布局证据；iOS 根据最终支持矩阵分别记录模拟器与真机，涉及空本地状态时另测安装包匹配与授权后的重装。缺少某平台证据时，只将该平台标为未验收。

建议按下表回填，失败时保留现场，不直接修改运行数据：

| 平台 | 编号 | 实际结果 | batchId / executionId | 报告或日志 | 问题说明 |
| --- | --- | --- | --- | --- | --- |
| 待执行 | D1–D9 | 未验收 | 待执行后填写 | 待执行后填写 | 记录实际事实 |

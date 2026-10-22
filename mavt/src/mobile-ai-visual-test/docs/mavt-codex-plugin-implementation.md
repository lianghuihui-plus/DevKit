# MAVT Codex 插件实现与验证记录

- 日期：2026-10-21。
- 状态：代码实现及自包含项目迁移、无设备验证已完成；此前插件实现的独立复审已完成，本次迁移经过源码检查及隔离回归；手机、模拟器和桌面 GUI 会话验收待用户执行。
- 当前分支：`main`；基线：`79f8c37d61d3946be451b0f87d43b7e71823c9cb`；改动尚未提交或发布。
- 当前开发目录：`/Users/cm/GitProj/DevKit/mavt`；已按用户要求从独立工作树转入主工作区，后续直接在 `main` 开发。下列既有验证保留其当时的原始分支与路径记录。
- 在 main 主工作区重新执行 `npm test` 通过，迁移与验证见 [main 验证记录](../../../verification/2026-10-21-main/summary.json)。
- 依据：[技术方案](mavt-codex-plugin-tech-design.md)、[实施计划](../../../docs/plans/2026-10-21-mavt-plugin.md)。
- 2026-10-22：插件 `0.1.1` 完成三个 Skill 命名与格式统一；本次验证和安装结果见 [入口约定](../../../docs/skill-interface.md)，下方 `2026-10-21` 日志及摘要保留为历史基线。

## 实现结果

一个 `mavt` 插件包含三个入口：`mavt:author-cases`、`mavt:run-tests`、`mavt:manage-knowledge`（`0.1.1` 统一命名，详见 [项目指南](../../../README.md)）。Case Agent 保持内部角色。两套完整源码均已迁入项目的 `src/`（含知识管理脚本、契约、模板及回归），构建仅访问项目内部文件；原执行状态机继续使用，Workspace schema 1、Execution schema 14 保持不变。

构建器按独立发布清单组装运行时、资源、文档与 Codex 委托指引，校验完整文件集合、摘要和执行位，拒绝缺失文件、未登记文件和符号链接。插件不注册全局 MCP 或 hooks，不新增 Node 依赖，不自动修改用户配置或安装系统依赖。

工作区初始化为 READY 后，把运行时固定到 `.mavt/runtime-bundles/<bundleId>/`。新 Run 的 `runtime-binding.json` 与初始协调状态通过临时目录原子发布。恢复先检查原绑定、代码与宿主指引，再读取原文档；安装目录升级或消失不改变旧 Run 使用的实现。原直接入口也检查绑定，拒绝错误版本及损坏绑定后写入。`doctor` 只读，知识维护要求 READY 工作区，并沿用同一固定副本的 prepare/apply。

项目边界详见 [独立项目说明](../../../docs/project-boundary.md)。将整个 `mavt/` 目录复制出来即可独立构建和测试；原 DevKit 的 sibling Skill 不再参与构建。

跨 Harness 复用边界位于插件清单、Skill 入口和 `hosts/codex/delegation.md`；运行时继续暴露 JSON Facade、Handoff 和 Loader。本阶段只实现并验证 Codex，不宣称其他 Harness 可直接安装。

## 交付包与安装

- [插件 ZIP 交付包](../../../dist/mavt-marketplace.zip)。
- [完整独立源项目](../../../dist/mavt-source.zip)，含知识管理完整源码与全部回归。
- 插件制品摘要见 [本次验证汇总](../../../verification/2026-10-21-self-contained/summary.json)，两个归档的校验值见 `dist/SHA256SUMS`。
- [插件源码与安装说明](../../../README.md)。
- 以下版本、摘要和文件数量是 `2026-10-21` 的 `0.1.0` 历史验证基线；当前构建以安装源的 plugin.json、bundle.manifest.json 及 `dist/SHA256SUMS` 为准。
- 历史版本：`0.1.0`。
- bundleId：`5d0154601ddf7a976ff4be2b10c23631324ce2afcfe2cd0b46605ae135b95542`。
- ZIP SHA-256：`6c026bc1395a79f463b73aa9a0ea15942a8767855504209a7e0b508687e91f60`。
- 独立发布清单 311 项；内容固定清单覆盖 `runtime/` 与 `hosts/` 共 306 项；两者覆盖范围不同。

解压后注册完整 marketplace 目录，不能直接注册 ZIP：

```sh
codex plugin marketplace add /absolute/path/mavt-marketplace
codex plugin add mavt@mavt-local
codex plugin list --marketplace mavt-local --json
```

以上命令实测于 Codex CLI `0.163.0-alpha.10.2`、Node.js `v24.18.0`，不作为最低兼容版本承诺。用户安装时手动停用旧的同用途独立 Skill；旧版未绑定的活动 Run 使用原版本完成或取消后再迁移。安装器不会删除旧 Skill。本次安装验证使用空的临时 `CODEX_HOME`，没有改动个人 Codex 配置。

## 验证证据

本次独立项目验证记录位于 [verification/2026-10-21-self-contained](../../../verification/2026-10-21-self-contained/summary.json)。

| 验证 | 结果与边界 | 证据 |
| --- | --- | --- |
| MAVT 源码回归 | 88 个 suite 通过；平台相关测试使用离线 fixture/double | [mavt.log](../../../verification/2026-10-21-self-contained/mavt.log) |
| 知识管理回归 | 6 个 suite 通过 | [knowledge.log](../../../verification/2026-10-21-self-contained/knowledge.log) |
| 插件专项 | 26 项通过：构建 14、集成 4、发布场景 6、项目边界 2 | [plugin.log](../../../verification/2026-10-21-self-contained/plugin.log) |
| 生成文档 / Skill 格式 | 51 份生成文档一致；三个入口格式校验通过 | 汇总记录 |
| 真实 Codex CLI 安装和升级 | 安装、列表、app-server 三入口解析与重载通过；旧缓存自动移除后仍以固定 A 恢复和取消 | [host.json](../../../verification/2026-10-21-self-contained/host.json) |
| 独立发布包冒烟 | OS sandbox 禁止读取两个源码树后，初始化、导入、Run、恢复、取消、角色契约、知识入口及 doctor 通过 | [smoke.json](../../../verification/2026-10-21-self-contained/smoke.json) |
| 源项目隔离 | 只取出本项目，禁止读取原始与实现工作树两个 DevKit 根目录，构建及完整 npm test 通过 | [source-isolation.log](../../../verification/2026-10-21-self-contained/source-isolation.log) |
| ZIP 解压完整性 | 解压后 `verifyBundle` 校验上述 bundleId 与全部 306 项通过 | 汇总记录 |
| 设备测试 / 桌面 GUI 重载 | 未执行，由用户验收 | 下方清单 |

专项验证包含真实并发快照发布、发布前进程退出、绑定和状态配对发布、缺失/损坏/错误运行时拒绝且零写入、多 Run 选择、A/B 共享报告锁、固定 A 的知识事务，以及初始化中断、PREPARED/CONSUMED dispatch 和延迟报告恢复。进入执行阶段的场景使用离线 Batch port，没有连接移动设备；安装冒烟在设备确认前取消。

三个 Skill 已完成独立基线与正向行为评估，记录见 [skill-behavior.md](../../../tests/skill-behavior.md)。这验证入口指令在受控任务中的行为，不替代真实设备上的完整 Case Agent 验收。

独立实现复审发现并修复了发布源码缺失仍能重新封包、首次并发建目录竞争、无效恢复文档链接及旧 Skill 迁移说明缺口；修复后复审未发现剩余问题，相关回归已通过。本次源码迁移未改动运行时守卫、执行协议或三个 Skill 的职责指令；重新检查了完整源码归属、内部依赖、发布文件清单、路径迁移及无外部源码读取。

在独立 MAVT 项目根目录可重跑无设备验证：

```sh
node src/mobile-ai-visual-test/scripts/self-test.js
node src/mavt-knowledge-manager/scripts/self-test.js
node --test tests/*.test.js
node src/mobile-ai-visual-test/scripts/build-agent-facing-docs.js --check
node tests/host-install-check.js /absolute/path/codex /absolute/path/mavt-marketplace
git diff --check
```

## 用户执行的验收清单

请记录插件版本、bundleId、平台/设备、workspace、batchId、executionId、报告路径和实际结果。按需验收的平台分别执行；某一平台通过不能替代其他平台。所有条目目前均为待执行。

- [ ] 桌面会话重载后能发现三个带 `mavt:` 命名空间的入口，旧入口已停用；用例生成、执行/恢复、知识维护各自进入正确职责。
- [ ] 根据 [安装教程](../references/installation.md) 准备目标设备与 App，并由你确认平台、设备、App 和执行范围。Android 记录实际后端及 Helper/IME 准备结果；HarmonyOS 检查采集与动作工具；iOS 检查 Appium/WDA、设备与签名参数。
- [ ] 在空测试目录转换一份实际人工用例，再执行一个 Case；核对观察、截图、中文输入、点击/滑动和断言结果，确认使用固定运行时且报告证据链接可打开。
- [ ] 执行两个串行 Case，确认分别创建独立 Case Agent、execution 和写入身份，第二例不沿用第一例业务上下文；证据和报告归属正确。
- [ ] 在动作进行期间发起取消，确认停止后才释放本次持有的设备/会话资源，不破坏原有服务；报告准确反映取消与已有证据。
- [ ] 在可控测试工作区中验证活动 Run 升级恢复：旧 Run 保持原 bundleId，新 Run 使用新 bundle；存在存活 Case writer 或无法证明其已停止时，不重复接管 CONSUMED dispatch。
- [ ] 检查执行完成、失败与取消后的报告状态、证据闭环和资源收尾；如中断后恢复，记录恢复前后绑定与报告发布状态。

设备验收若发现问题，将复现步骤、上述标识和脱敏证据交给开发侧修复；设备结果由你提供，开发侧继续负责代码及相应离线回归。当前结论是代码与无设备验证完成，尚未获得移动端端到端验收结论。

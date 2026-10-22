# MAVT

MAVT 是自包含的移动端 AI 黑盒视觉测试项目，首阶段以一个 Codex 插件交付，包含测试执行、用例生成和知识维护三个 Skill。

本目录包含完整源码、知识管理模块、资源、文档、构建与测试；单独复制整个目录即可开发、构建和运行离线验证，不依赖 DevKit 的其他目录。

## 项目结构

```text
mavt/
├── src/
│   ├── mobile-ai-visual-test/      # 完整测试运行时、三端 Adapter、文档与回归
│   └── mavt-knowledge-manager/     # 完整知识维护实现、契约、模板与回归
├── skills/                        # 三个 Codex Skill 包装
├── hosts/codex/                   # Codex Agent 委托适配
├── scripts/mavt-mcp.js             # 插件唯一正常调用入口
├── scripts/mavt-entry.js           # 开发验证和技术维护脚本
├── .mcp.json                      # 本地 MCP 服务注册
├── .codex-plugin/plugin.json
├── build-plugin.js
├── release-files.json
├── package.json
├── tests/                         # 构建、安装、升级及项目隔离验证
├── docs/                          # 项目边界与实施计划
└── verification/summary.md        # 无设备验证结论汇总
```

两套源码的唯一维护位置均在本项目 `src/` 内。知识管理从原独立 Skill 完整迁入；插件包装调用项目内的实现。构建仅把这些项目内文件组装为分发包，不能从父目录的 Skill 补齐文件。迁移记录见 [项目边界](docs/project-boundary.md)。

源码放在 `src/`，安装包和工作区固定副本放在 `runtime/`；两者分开，以保留“损坏的已安装 bundle 必须拒绝执行”的校验。

## 构建与离线验证

实测环境为 Node.js `v24.18.0`，不是最低版本承诺。运行时使用 Node 内置模块；构建和回归无需安装 npm 依赖。Shell 相关验证需要 Bash 及 macOS/Unix 常用工具，设备环境另见 [安装教程](src/mobile-ai-visual-test/references/installation.md)。

进入本项目根目录执行：

```sh
npm test
npm run build
```

默认输出 `dist/mavt-marketplace/`，目录必须不存在或为空；不会覆盖非空输出。也可指定任意绝对输出路径：

```sh
node build-plugin.js --output /absolute/path/mavt-marketplace
```

`0.2.1` 只提供一个 MCP 插件版本，默认构建包含完整工具闭包，无需预览开关。`mcpServers` 指向插件相对路径 `./.mcp.json`，Node 入口为 `./scripts/mavt-mcp.js`；复制或移动整个 marketplace 后仍可解析。本开发任务只构建和离线验证，不自动安装或变更个人 Codex 配置。

`npm test` 依次执行 MAVT 运行时回归、知识管理回归、插件/项目边界回归和生成文档检查，不连接手机或模拟器。分开执行可使用 `npm run test:runtime`、`npm run test:knowledge`、`npm run test:plugin` 和 `npm run check:docs`。

## 上库边界

| 纳入 Git | 仅本地保留 |
| --- | --- |
| `src/`、`skills/`、`hosts/`、入口和构建脚本 | `dist/` 安装源、ZIP、摘要和制品验证输出 |
| 测试代码、必要的测试 fixture、随运行时交付的 Helper APK/IME 资源及许可证 | `test-results/` 原始测试输出、`artifacts/` 截图与日志、`test-workspaces/` 临时测试工作区 |
| 插件配置、`package.json`、`release-files.json`、Helper 清单 | `node_modules/`、`coverage/`、`.cache/` 与系统杂项 |
| 维护文档、`verification/summary.md` 验证结论 | `verification/` 中其他原始 JSON、日志和历史原型输出；本地 `.env` 配置及凭据 |

以上本地输出目录已由本项目 `.gitignore` 忽略；测试日志可直接重定向到 `test-results/`，只将必要结论整理到验证汇总。测试工作区通常放在源码项目外；项目内的临时工作区使用 `test-workspaces/`。凭据不写入源码或测试数据，可维护无真实凭据的 `.env.example`。忽略规则按目录和用途设置，不全局忽略 JSON、图片或 APK，以保留必要配置和测试资源。

发布文件由 `release-files.json` 单独控制：是否上库与是否进入插件安装包是两个边界。源码、测试和设计文档需要上库，但测试和设计文档不进入正式插件包。

## 发布完整性

构建保留脚本执行位、APK/IME 等资源字节，检查 Android Helper APK 摘要，并生成完整性清单。发布包移除自测代码；开发验证包追加 `--include-tests`。构建拒绝符号链接，不安装依赖。

`release-files.json` 是独立维护的生产文件清单。正常构建只读取它；发现文件缺失或未经登记的新文件即停止。生产文件变动时，先确认变动合理，再显式重新生成清单并审查差异：

```sh
node build-plugin.js --write-file-list
git diff -- release-files.json
node --test tests/build.test.js
```

重新生成清单不校验删除的业务合理性；意外缺失应恢复源码。构建生成的 `bundle.manifest.json` 和 `runtime/mobile-ai-visual-test/mcp-transport.json` 不纳入源码清单。

## Codex 安装与使用

注册整个 marketplace 目录，不能直接注册 ZIP 或源码项目目录：

```sh
codex plugin marketplace add /absolute/path/mavt-marketplace
codex plugin add mavt@mavt-local
codex plugin list --marketplace mavt-local --json
```

首阶段实际验证版本为 Codex CLI `0.163.0-alpha.10.2`。插件 `0.2.1` 保留三个入口：

| 入口 | 中文显示名 | 职责 |
| --- | --- | --- |
| `mavt:author-cases` | MAVT 用例编写 | 将测试材料生成、导入或更新为工作区标准用例 |
| `mavt:run-tests` | MAVT 测试执行 | 环境确认、执行、恢复、取消与报告查看；Case Agent 保持内部角色 |
| `mavt:manage-knowledge` | MAVT 知识管理 | 维护 READY 工作区的 `knowledge/`，沿用 prepare/apply 事务 |

通常先编写用例，再执行测试，按需维护知识；已有用例可直接执行。三个入口的目录名与 frontmatter `name` 一致，中文显示信息放在各自的 `agents/openai.yaml`，自动发现保持默认启用。

三个入口及新 Case 执行均使用 MCP。Loader 仍须由独立 Case Agent 原样执行一次，返回其 execution/dispatch 专属 `contextRef`；Handoff 冻结 `runtime.transport:"MCP"`，Brief 不再交付 CLI 命令模板。截图按需通过 `mavt_case_image` 或子 Agent 已验证可见的本地图片查看器读取，实际看图后登记 inspection。worker 由每个 MCP 服务实例共享，最多 5 个，空闲 5 分钟回收。工具缺失或旧固定接口不支持 MCP 时报告阻塞，不在新流程中回退 CLI。冷启动、复用和内存的历史测量及边界见[验证汇总](verification/summary.md)；新版本的设备效果与整批耗时由用户验证。

从 `0.1.0` 升级时，旧入口 `mavt:mavt-case-authoring`、`mavt:mobile-ai-visual-test`、`mavt:mavt-knowledge-manager` 分别替换为上表三个入口。更新安装源后重新运行 `codex plugin add mavt@mavt-local`，新开或重载会话后选择新入口；不保留重复的旧入口别名。已有 Run 仍通过原固定运行时恢复。

命名、格式和本次无设备验证见 [Skill 入口约定](docs/skill-interface.md)。

迁移时人工停用旧的同用途独立 Skill，并使用原版本完成或取消旧版未绑定的活动 Run。安装器不会删除旧 Skill 或改写个人配置。桌面 App 的会话重载仍需人工验收。

新 Run 固定运行时、文档和宿主指引；恢复旧 Run 使用其原固定版本。绑定或副本损坏时拒绝继续，不自动切换到新版。一次知识维护的 prepare/apply 使用同一固定副本。

完整验证结果及用户执行的设备清单见 [实现与验证报告](src/mobile-ai-visual-test/docs/mavt-codex-plugin-implementation.md)。开发侧只负责代码和无设备验证，所有手机、模拟器和移动设备连接测试由用户执行。

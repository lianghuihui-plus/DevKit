# MAVT 插件化验证汇总

整理日期：2026-10-23。保留插件化开发的验证结论和边界；原始 JSON 与日志已精简，不作为插件运行依赖。已提交的原始记录可从 Git 提交 `3621f35` 恢复，清理时的本地副本另移入系统废纸篓。

## 0.4.0 数据上报 v2（2026-10-23，未安装，最终独立分支审查待完成）

- 当前固定构建为 `dist/mavt-marketplace/` 的 `0.4.0`；四个 Skill 为 `author-cases`、`run-tests`、`manage-knowledge`、`reporting`，MCP 共 38 个工具，其中 8 个 reporting 工具；入口与实际工具名均按完整名单验证。
- 上报组件包含私有分目标配置/凭据、身份与修订、schema14 三端采集、标准段及 native 证据闭包、v2 会话/传输、持久任务与固定独立 worker、异常隔离的 Coordinator 钩子及 reporting 角色；故障不改变测试 verdict，本地状态读取不修复或启动任务。
- 发布回归发现并修复真实固定 worker 的冻结 transport 组合错误：生产 transport 被 `Object.freeze` 后，通过原型继承再赋值 `upload` 会抛 TypeError；现在复制为自身方法再包装度量；可复现的实际进程回归覆盖该路径。
- `npm run build` 退出码 0，bundleId 为 `4d4987c884bc141c1f8fa8719a5f4d99414769d700dfab9c2d18a5d8b84d94f4`；独立完整性探针核对 349 个 manifest 文件、360 个发布源文件逐字节一致、362 个总分发文件、全部 23 个 reporting 模块及重定位 stdio 工具发现；日志 `test-results/task-6-build-final.log`、`task-6-bundle-probe-final.log`。
- 真实 Codex app-server 使用临时 HOME/CODEX_HOME/XDG_CONFIG_HOME，父进程在运行 Coordinator fixture 前先隔离 XDG；重定位后 `plugin/read` 发现四 Skill，连接 stdio MCP 并发现完整 38 工具，reporting 安全全局读取、workspace 角色状态、annotations、doctor 与 68 字节图片检查通过；日志 `test-results/task-6-host-probe-final.log`；无模型回合或插件安装。
- 真实固定 detached worker 在启动父进程退出、原安装目录删除后完成三端整包 collect→prepare→40 次去重 PUT→commit→持久回执→冻结数据清理，63 个文件描述符、1 个任务/会话、3 个执行、最终缺失文件与字节均为 0；断线版本分别丢失已接收的 prepare/PUT/commit 响应，保留原包与 key，三次预算用尽后经另一个已退出父进程显式 retry 查询原会话，完成清理且不重发已接收 PUT 或 commit。
- 上述 fixture 的 rawBytes/uniqueRawBytes 为 415000/404990；正常 acknowledged/received wireBytes 均为 404990，断线时为 404745/404990，245 字节已送达但响应丢失的 PUT 不计为本地 acknowledged；专项样本耗时 2024/5060 ms，抽样 worker RSS 最大值 90608/91568 KiB，日志 `test-results/task-6-final-focused.log`；这些数值不是真机整批性能或真实峰值内存承诺。
- 复用 Task 2 的显式本地 Dashboard 差分探针，实际 `ReportingManifestSchema`、`validateManifestSemantics`、`validateReportGraph` 接受 Android FAIL、Harmony BLOCKED、iOS PASS+WAIVED；每会话 21 文件、2 个图根，覆盖 17 类标准段与 native；日志 `test-results/task-6-dashboard-probe.log`，默认测试和发布代码均不导入 Dashboard 源码。
- `npm test` 退出码 0：运行时 89 组、知识管理 6 组、插件 386/386（0 fail/skip）与 51 份生成文档检查通过；日志 `test-results/task-6-full-final-pass.log`；专项 build/release 36/36、reporting jobs/release 37/37、worker timeout/crash 2/2 通过；完整运行修正了 reporting 文档入口旧清单与 worker fixture 未保留新 reporting 依赖布局的问题。
- 中间完整检查在旧 WDA 子进程清理用例再次出现历史 `kill EPERM`，日志 `test-results/task-6-full-verified.log`，该文件独立复跑 9/9 通过；未改 WDA 生产代码，尚未确认偶发根因，不将其记作已修复。
- 本轮没有显式提供临时隔离的已认证 Dashboard HTTP/DB/Web 服务及测试身份，故真实认证/持久化、数据库重复补报对象数、五页签页面/原图/日志读取与线上 capabilities 未验证；loopback HTTP 与真实校验器差分不替代这些验收；无个人 Token、真机/模拟器、主 checkout 或服务端修改、依赖安装、合并、推送。
- 以上为实现者证据与自查，整个分支最终独立审查由 controller 随后执行；不将任务专项验证或已有分层审查当作该最终 gate 已完成。

## 仓库清理（2026-10-23）

- 旧构建归档、0.1.0 安装目录、0.1.0/0.1.1 ZIP 及对应摘要和验证 JSON、7 份重复中间日志与 Finder 缓存已移入系统废纸篓，可从废纸篓恢复；共清理 4,310 个文件、约 31.5 MiB。
- 该次清理后保留固定安装源 `dist/mavt-marketplace/`（0.3.6）、最新完整与专项测试日志、历史验证仍引用的日志及未定位偶发失败证据；源码、必要配置、测试资源和设计文档保留。
- 下文的旧归档路径与旧摘要记录是各轮构建时的历史事实；旧产物已清理，该次清理时的安装源以 0.3.6 小节记录的 bundleId 和 `dist/mavt-marketplace/plugins/mavt/bundle.manifest.json` 为准。

## 0.3.6 业务约束与结果复核修复（2026-10-23，未安装）

- Android 002 的原文要求先年龄确认再隐私协议，实际相反；Agent 的 Baseline 仅检查内容，重排路线后尝试的 FAIL 修改又被 MCP Schema 拒绝，旧 ledger 仍全 PASS，重复 finish 最终错误收口；鸿蒙此前通过新增原文时序 CHECK 并成功记录 FAIL 得到正确结果，不能据两次样本归因于平台或 MCP 本身。
- Case Prompt、Brief 冻结原则及执行原则明确区分导航路线与业务约束，原文时序、条件、范围由 Agent 建 CHECK/sourceBasis，内容正确不抵消顺序违反；新增检查仍须有原文依据，不把普通绕路自动判 FAIL。
- 最终复核要求最新快照 token、Agent 明确 verdict 和原文覆盖确认，绑定 execution、原文摘要、Flow revision、最新 resultUpdateId、闭环状态及待处理修正，重复旧 finish 不再自动确认；Runtime 仅比较结构、版本与确定性聚合，不解析 actual/reason/summary，不判断业务含义或自动声称覆盖完整。
- MCP Schema 拒绝、Facade 上下文/证据拒绝及领域失败均保留待处理结果提交，读资源、重启服务或重排路线不能解除，成功重提对应 CHECK 才解除；合法的幂等重提也可解除，未知 CHECK 使用可恢复的通配待处理标记，避免未知引用永久阻塞。
- 结果 Schema 直接区分 WAIVED 必填 reason 与其他状态禁用 reason，知识引用明确只接受适用 knowledgeDocument，补充合法 FAIL 和最终复核示例，工具目录使用领域方法说明。
- 离线回归覆盖真实 MCP Schema 拒绝后的待处理持久化、旧 PASS 禁止收口、版本过期、结论不一致、成功改判、三端补充时序 CHECK 后内容 PASS/时序 FAIL、缺失视觉证据后修复、普通 PASS 和 NOT_RUN；所有设备端口均替换为 fixture，无真机或模拟器操作。
- 指引验证包含 1 个修复前指引对照和 5 个修复后隔离样本，修复前对照本身也能正确识别遗漏，故不宣称统计性改善；修复后样本均要求成功修正再收口，并保留无业务时序要求时的正常换路 PASS；这些离线样本不能证明所有模型运行均不误判。
- 最终 `npm test` 退出码 0：运行时、知识管理、插件 217/217 及 51 份生成文档检查通过，日志 `test-results/final-review-final.log`；MCP/构建专项 58/58 通过，日志 `test-results/final-review-plugin-focused.log`；`git diff --check` 通过。
- `npm run build` 发布 `0.3.6` 至固定 `dist/mavt-marketplace/`，旧有效产物归档至 `dist/archive/`，325 个 manifest 文件完整性及 312 个移动测试运行时发布文件与源码逐字节一致，bundleId 为 `eb5afb85fbad9e57610e8648d41ffe7fd455ccf2e04251941753fab5ea65641a`。
- Prompt 与执行原则合计 10,185 字节，保持原 10 KiB 预算；普通流程仍两次 finish，不新增设备命令，未重新测量整批耗时或真机性能；未自动安装、改 Codex 配置、改写已有 Run，用户更新插件并新建 Run 后执行 Android 002 等真机验收，旧 Run 继续使用冻结版本。

## 0.3.5 Android 多启动入口与 Helper 清理修复（2026-10-23，未安装）

- `MAVT0908-4` 的 Android 批次返回系统 `ResolverActivity`，目标应用同时包含业务入口与 LeakCanary 入口；旧适配器将歧义误判为没有唯一入口。现在仅遇到歧义时枚举目标包的启动入口，通过既有 `NEED_SELECTION` / `SELECT_ENVIRONMENT_OPTION` 流程选择，不自动猜测或过滤合法入口，不新增上层 Android 分支。
- 选择时重新查询当前启动入口并显式验证所选组件，确认时继续复验；失效、跨包和非法选择拒绝执行。同一组件的短类名和完整类名在枚举时去重，普通唯一入口仍只查询一次，后端偏好保留。
- Helper 回滚原空服务列表时，ADB 将空参数拼接丢失，导致 `settings put` 返回 `Bad arguments` 和 `ROLLBACK_FAILED`；写入服务列表时增加远端 shell 字面量引用，保留空值与包含 `$` 的类名，不忽略清理失败，不改变所有权规则或默认后端。
- 先运行新增失败回归，分别复现多入口状态错误与 Helper `cleanup_failed`；修复后覆盖真实 Android 适配器到统一协调流程的选择、准备、确认与入口移除，Helper 则使用真实本地 shell 模拟 ADB 参数拼接，覆盖用户 0/10 的空列表准备和释放、资源回收、保留原服务及执行期间新增服务，未调用真实 ADB。
- 完整复核 `npm test` 退出码 0：运行时与知识管理自测通过，插件测试 216/216，51 份生成文档检查通过；日志为 `test-results/android-environment-fix-recheck.log`，`git diff --check` 通过。
- 第一轮完整检查的既有延迟 stdin 派发替换测试返回 `FAILED/CASE_RUNTIME_TECHNICAL`，预期为 `REJECTED/BINDING_INVALID`；失败日志保留在 `test-results/android-environment-fix-final.log`。该测试单独复跑及源码不变的完整复核均通过，尚未确认偶发失败根因，不将其记作已修复。
- `npm run build` 发布 `0.3.5` 至固定 `dist/mavt-marketplace/`，旧安装源归档至 `dist/archive/`；325 个运行时文件完整性及 Android 发布代码与源码一致性复核通过，bundleId 为 `a5ddcfd1d9e226829a5a5ad392cd2d307bebe1d80068b76f21c944b29f90d678`。
- 未重新测量真机性能，普通入口与 Helper 服务写入均未增加设备命令；未安装插件、改写用户工作区或推进现有 Run，未操作手机或模拟器。用户更新插件后新建 Run 验证，旧 Run 保留冻结版本。

## 0.3.4 三端 Case MCP 会话绑定修复（2026-10-23，未安装）

- `MAVT0908-4` 的 `batch-20261023063755176-53fa489a` 已成功创建 iOS WDA session 并启动 App，随后因 Case MCP 把会话引用误当协调状态路径而阻塞，批次由用户取消；只读复现返回 `MAVT_MCP_CONTEXT_INVALID`。
- 修正三端共用 `mcp/bindings.js` 的预期会话路径为当前 Run 的 `batch.json`，协调上下文仍绑定 `coordinator-state.json`；不放宽 execution、protocol、bundle 和 dispatch 身份校验，不改写用户工作区或旧 Run 固定副本。
- 新增三端真实派发链路回归，仅替换环境探测与硬件启动端口，使用构建产物完成环境确认、批次初始化、真实 Case 派发、Loader、同步 MCP 与独立 worker 的 Brief 读取；修复前这三项均在 Loader 失败，修复后通过。
- 新增真实派发后的路径篡改回归，确认协调状态路径、其他 Run、工作区外路径和缺失路径均被拒绝，恢复原引用后可继续读取；同步修正原 MCP fixture、宿主探针和基准 fixture 的错误会话路径。
- 最终完整 `npm test` 退出码 0：运行时与知识管理自测通过，插件测试 206/206，51 份生成文档检查通过；日志为 `test-results/case-mcp-path-fix-final.log`。
- 中间一轮全套在既有 WDA 子进程清理测试出现 `kill EPERM`，日志为 `test-results/case-mcp-path-fix.log`；该文件独立复跑 9/9、源码不变的最终全套均通过，尚未确认此偶发现象的根因，不将其记作已修复。
- 构建版本 `0.3.4` 发布至固定 `dist/mavt-marketplace/`，上一有效产物归档至 `dist/archive/`；bundleId 为 `6abc36cff1486f190925cf577501c31570ed1f6e0e0db739301b5da9dece723a`。
- 本次运行时代码仅更正路径常量，没有新增 I/O、进程或设备操作；没有重新测量批次性能，没有安装插件、修改个人配置或运行手机/模拟器测试，设备效果由用户更新插件后新建 Run 验收。

## 0.3.3 iOS 签名与旧 WDA 产物修复（2026-10-23，未安装）

- 根据 `MAVT0908-4` 的 14:01 Run、Appium 日志与 Xcode xcresult 确认自动签名错误使用了完整开发证书名称；证书和 profile 仍严格核验，实际构建使用 `Apple Development` 或 `iPhone Developer` 类别，团队单独固定。
- 失败时加载的本地 WDA 二进制修改时间为 10 月 9 日，且链接 `_LocationEssentials.framework`；本轮不修改用户工作区、安装缓存或原有 DerivedData。
- 本地真机 session 先在 MAVT 隔离目录独立 `build-for-testing`，仅成功后向 Appium 发送 `usePrebuiltWDA`；工具链、驱动/WDA、项目配置、设备系统和签名分别参与缓存身份，同配置复用增量产物，各 Case 仍共用批次 session。
- 冻结设备探测中的系统版本并传给适配器，正常启动不重复查询设备系统；仅创建或恢复 session 时解析构建元数据，保留原有 session 启动总时限，构建最多 120 秒，构建超时终止其进程组。
- 核查本机 `appium-webdriveragent` 的 `prebuildWDA` 实现时，用无设备的 SubProcess 替身确认预构建成功后 `_didProcessExit` 仍为 true，下一阶段没有执行状态探测；因此使用独立构建进程，不依赖该预构建选项，不修改第三方驱动。
- 真实 Xcode 关闭签名、目标 `generic/platform=iOS` 的 WDA 编译成功；`vtool` 确认新产物 `minos 15.4`，`otool` 确认其依赖列表不再包含 `_LocationEssentials.framework`；原始日志保存在忽略目录 `test-results/ios-wda-offline-build.log`。
- 构建与启动失败保留完整构建日志、当次 Appium 日志片段及结构化诊断；具体错误及路径传递到 Run，session 恢复也保留原始诊断，外部 WDA 和远程 Appium 保留原有构建归属。
- 新增九项 WDA 启动回归和一项签名输入回归，并纠正原测试的错误签名断言；离线覆盖真实本机进程超时及子进程回收、本地 HTTP 失败、参数序列化、缓存身份、服务释放和恢复诊断，未操作手机或模拟器。
- 最终完整 `npm test` 退出码 0，运行时与知识管理自测通过，插件 202/202、生成文档 51 份通过；日志为 `test-results/ios-wda-fixes.log`，`git diff --check` 通过。
- `npm run build` 成功发布 `0.3.3` 至固定 `dist/mavt-marketplace/`，完整性复核通过，manifest 325 项，包含新的 WDA 构建模块，bundleId 为 `e5dfd3f40766396220699cd4d2da23a360057968c6ffff4e00a92f9c8cdacca4`；上一有效安装源由构建器归档到 `dist/archive/`，未自动安装。
- 一次中间全量运行的历史分发校验返回 `FAILED/CASE_RUNTIME_TECHNICAL`，预期为 `REJECTED/BINDING_INVALID`；原始记录保留在 `test-results/ios-wda-fixes-intermediate.log`，该文件独立复测 23/23、保持源码不变的最终全套 202/202 均通过，尚未定位中间失败的根因，不把重跑通过当作该问题已修复。
- 真机签名、安装、启动及真实批次耗时仍需用户验证；关闭签名的编译和二进制检查不能替代这些验收，更新后需新建 Run，旧 Run 保持原冻结版本。

## 0.3.2 插件审查问题修复（2026-10-23，未安装）

- worker 在独立进程组执行临时命令，异常退出后先终止并确认组内命令不再运行，再释放执行通道；无法确认清理时拒绝后续分发，`close` 报告清理失败，已分发操作仍返回 UNKNOWN、不自动重放。
- 离线真实 fork/IPC/spawnSync 回归覆盖 worker 超时和外部 SIGKILL；下一个同 context 请求执行时，原命令及孙进程均已停止，独立 detached 服务保持运行；正常暖调用不增加进程扫描。
- iOS 从 profile 声明的 `ApplicationIdentifierPrefix` 解析应用标识，与 `TeamIdentifier` 分别核验；独立旧前缀的通配和精确 WDA profile、自选配置均可用，错误前缀或团队仍拒绝。
- MCP doctor 在单次请求内复用 bundle 成功或失败的校验结果；5 个 Run 共享一个 bundle 只读取一次 manifest，下一请求仍能发现篡改，损坏 bundle 也不按历史 Run 重复扫描。
- Skill、必读原则和文档生成器统一规定响应文档引用按 `documentationRoot`、Markdown 相对链接按文档所在目录解析；安装事实由 Runtime/Adapter 发布，删除强制 `devicectl` 的上层规则，教程恢复入口统一为 MCP Run context。
- 独立指引验证的旧版样本解析到错误的方法路径并拒绝 Installation Proxy 事实；修订后的新样本正确解析方法页和错误引用，接受 Runtime 安装事实；Skill frontmatter 校验通过，不以此代替设备验收。
- 默认构建使用可识别归属的发布锁与恢复 journal；下次构建先恢复有效安装源再检查源码，回收已死 owner，保留活锁、未知文件和损坏产物；锁释放及废弃目录清理先原子移走，递归清理中断不破坏恢复依据。
- 构建定向回归 30/30 通过，覆盖新旧包发布、首次空目录/缺失目录、归档前后、发布后、锁释放/回收及恢复递归清理中断；即使源码随后缺失也能先恢复安装源，修复源码后可重试发布。
- 隔离 Codex app-server 探针通过三个 Skill、30 个工具、doctor 和 68 字节图片传输检查；未安装插件、未修改个人配置、没有模型轮次或设备连接。
- 最终完整 `npm test` 退出码 0：运行时和知识管理自测通过，插件测试 192/192，51 份生成文档检查通过；本轮新增 15 项离线回归，独立只读复查未发现剩余阻断项，`git diff --check` 通过。
- `npm run build` 固定发布到 `dist/mavt-marketplace/` 并归档上一有效构建；发布版本及完整性复核通过，生产 bundle 含 324 个文件，bundleId 为 `129ad81ceec15c260b016200f2f00f8e2785ace111ac0dcf3ca35a5a7ad0d913`。
- 版本为 `0.3.2`；运行时与指引修复需更新插件后新建 Run 使用，旧 Run 的冻结副本不被改写；真机/模拟器效果仍由用户执行验证。

## 0.3.1 iOS 旧系统应用查询兼容（2026-10-23，未安装）

- 根因是应用查询及重装状态、版本校验仅使用要求 iOS/iPadOS 17+ 的 `devicectl`；设备发现本来使用 `xcdevice`，不能将应用查询失败表述为未发现设备或整个自动化栈不支持该系统。
- iOS 适配器新增公共查询通道：现代查询成功时仍只调用一次 `devicectl`，不可用时通过已安装 XCUITest 驱动的 `appium-ios-device` 使用 Installation Proxy；应用发现、重装后的安装状态和版本校验共享该通道，不增加独立工具安装要求，不启动 Appium/WDA session，不改变上层流程。
- 通过 `appium driver list --installed --json` 的实际 installPath 加载驱动依赖，兼容依赖提升目录；成功的通道和依赖位置仅在当前进程内复用，安装结果每次实时查询，失败时重新探测，查询未知或部分列表不能证明应用未安装。
- 新增七项离线回归，修改前六项失败、现代路径一项通过，修改后全部通过；覆盖旧系统应用发现、安装版本、空列表与错误区分、部分列表、重装轮询、现代路径及真实 helper 的连接清理，结合原 iOS 环境测试共 31/31 通过。
- 完整 `npm test` 退出码 0，插件测试 177/177、生成文档 51 份检查通过；隔离 Codex app-server 探针通过三 Skill、30 工具、doctor 和 68 字节图片传输检查，无安装或模型轮次；独立只读审查未发现阻塞项。
- 本机 Appium XCUITest Driver `11.17.1` 的 `appium-ios-device` `3.1.16` 依赖可通过实际 installPath 加载，核对了服务、选项、返回值及关闭接口，没有调用任何设备连接方法；真机准备不再强制要求 devicectl，Developer Mode 提示限定到 iOS/iPadOS 16 及以上。
- 版本递增为 `0.3.1`，源码发布清单 333 项，构建目标保持 `dist/mavt-marketplace/`；不自动安装、提交或修改旧 Run，更新后需新建 Run 才采用修复，原 Run 仍使用冻结版本。
- 未连接手机或模拟器，未测真实批次性能；iPadOS 15.4.1 的实际连通、签名、WDA 启动及用例效果由用户验收，底层查询兼容修复不等于对所有 Xcode/WDA/系统版本组合的运行保证。

## 0.3.0 三端统一环境准备（2026-10-23，未安装）

- Android、HarmonyOS 和 iOS 统一为选择设备、选择 App、自动解析配置并准备依赖、确认后冻结批次环境；Coordinator 只处理通用环境状态，入口、签名、依赖与重试清理由平台适配器负责，无新增运行时依赖。
- 精确 App ID 优先，名称或配置歧义返回候选；发现范围明确标为用户应用、全部或受限，不默认采用前台 App，枚举失败不能冒充空列表成功；支持独立验证的适配器可继续校验明确提供的 App ID。
- 历史环境重新验证，保留安装包供应策略及后端、服务地址等偏好；重试只清理适配器已证实失效的字段，最终确认再次检查设备和配置，跨 Run 或失效环境引用拒绝使用。
- 环境准备成功后才发布 READY，同一配置的准备结果复用至批次初始化；iOS 准备阶段不启动 WDA、Appium 或 session，各 Case 复用冻结环境，原有运行时所有权、取消恢复和 UNKNOWN 语义保持不变。
- 新增 86 项离线环境测试，覆盖 Android/Harmony 39 项、iOS 24 项、公共流程 13 项和 Coordinator 10 项；最终完整 `npm test` 退出码 0，插件测试 170/170，生成文档 51 份检查通过；独立评审发现的目标丢失、失效候选重试、部分枚举误判及历史配置丢失等边界已修复并加入回归。
- 隔离 Codex app-server 探针验证三个 Skill、30 个工具、重定位注册、doctor 成功及 68 字节 PNG 精确传输，没有安装或模型轮次；更新后的 run-tests Skill 格式检查通过。
- 版本为 `0.3.0`，构建发布至固定 `dist/mavt-marketplace/` 并通过完整 bundle 校验，manifest 322 项，bundleId 为 `1a2a4b774e0a67d557a5d7b74e778f04aee3852ef079e48112f3de0aa1106e10`；release-files 源码清单 331 项，新增七个运行时模块，已有有效构建由发布器归档至 `dist/archive/`，不修改个人 Codex 配置或安装缓存。
- Android 候选目前显示包名，现有 Helper 不提供应用名称枚举；Harmony 同名 Ability 跨模块时需要用户处理，不能虚构执行 binding；iOS 缺少有效签名时仍需先在 Xcode 完成具体设置，再重试。
- 全部新增平台测试使用离线 fixture 或 fake adapter；没有执行手机、模拟器验收或真实批次性能测试，不能据此宣称真实三端端到端和耗时已验证，设备效果由用户验收。

## 0.2.2 工具发现与委托流程修正（2026-10-23，未安装）

- 实际执行会话在发现或调用 MAVT 工具之前就引用 Skill 的“工具未连接”规则停止，没有取得 MCP 连接失败响应；当前会话可发现 30 个工具，安装包独立握手也成功，因此不能把该次回复当作 MCP 服务故障证据，受影响会话当时的工具注入情况仍未证实。
- 删除三个 Skill、协调原则、Case prompt 与宿主指引中的工具未连接即停止和 CLI 回退说明，改为通过宿主工具发现入口使用真实名称；用例编写引用文档原先仍展示命令导入，现与入口统一为 `mavt_cases_import({contextRef,request})`，命令索引只供维护和排障。
- 子 Agent 工具和图片能力检查从委托前移至 Loader 后，父 Agent 只检查独立上下文与真实句柄能力；新增的两项阶段回归先在旧配置失败、再在修正配置通过，保持缺少子工具、图片能力或 scoped binding 时不可开始 Case 执行。
- 独立子 Agent 实际发现三个入口的正确 MCP 工具、三个角色参数、13 个 Case 工具及本地图片查看工具，并复核导入文档和父子提示词的引用链；这些是工具发现和指令演练，没有调用业务工具、Loader 或设备，也不证明图片实际可见或整个批次成功。
- 完整 `npm test` 退出码 0，插件测试 84/84、生成文档 51 份通过；最终引用文档修改后，架构边界与生成文档专项再次通过，三个 Skill 格式检查和 `git diff --check` 通过；Case prompt 加执行原则仍满足原有 10 KiB 预算。
- 隔离 Codex app-server 探针验证 30 工具发现、重定位注册、三个 Skill、doctor 成功及 68 字节 PNG 精确传输，没有安装或模型轮次；构建发布至固定 `dist/mavt-marketplace/`，版本 `0.2.2`，manifest 315 项，bundleId 为 `f8da2853e58ffb2e5e41aa46ae1bfedd7a727ce20ae029215a8f39af4a1904fb`，旧产物可从 `dist/archive/` 恢复。
- 未修改个人 Codex 配置或安装缓存，未运行手机、模拟器或性能基准；设备效果与用户执行会话的实际运行结果仍由用户验证。

## 固定安装源目录修复（2026-10-22，未安装）

- 在 main 修复默认构建发布流程：`npm run build` 始终发布到 `/Users/cm/GitProj/DevKit/mavt/dist/mavt-marketplace`，先构建和校验，再归档已有的有效产物；自定义 `--output` 仍不覆盖非空目录。失败保留原安装源，未知目录、损坏运行时和并发发布会拒绝替换。
- 原固定目录中的 0.1.1 已归档到 `dist/archive/`，新固定源为 0.2.1；此前带版本号的平行输出也移入该归档，可恢复。当前 Codex 市场配置路径不变，已安装缓存仍为 0.1.1，待用户手动更新；未修改个人配置或自动安装。
- 插件回归 80/80 通过；随后补充首次发布和损坏产物保留场景，最终构建专项 20/20 通过。默认路径实际连续发布成功，完整 bundle 校验通过，bundleId 仍为 `9277840c140b3721a99e845830d1f8f8f7a489d25c63c90e8a991273ce8289c8`；运行时内容未变，未重新执行手机或整批性能测试。

## 0.2.1 MCP 单版本开发记录（未安装）

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

历史 `0.1.0` bundleId 为 `5d0154601ddf7a976ff4be2b10c23631324ce2afcfe2cd0b46605ae135b95542`，生产清单为 311 项；初期原型摘要不代表正式发布物。当时归档校验值记录于 `dist/SHA256SUMS`，该旧摘要及对应归档已在后续仓库清理时移入废纸篓，不将可能变化的源码归档摘要写入自身。

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

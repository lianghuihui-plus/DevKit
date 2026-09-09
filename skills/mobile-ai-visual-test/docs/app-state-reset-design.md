# ADR: App 初始状态与冻结制品

- 状态：Accepted，已实现
- 当前架构事实来源：`docs/architecture.md`

## 决策

1. `appProvisioning` 只描述 `PREINSTALLED` 或 `ARTIFACT_MANAGED` 来源，不代表安装授权。
2. 批次级 `bootstrapPolicy` 默认 `KEEP_EXISTING`；执行配置明确选择 `REINSTALL_FROZEN` 并冻结卸载、安装副作用时，bootstrap 才能重装，不追加一次用户授权。
3. 单用例 `initialStateRequirement` 表达业务所需的 `KEEP_EXISTING`、`APP_LOCAL_STATE_EMPTY` 或 `FRESH_INSTALL`；原文要求卸载并重新安装时固定选择 `FRESH_INSTALL`。用户下达用例执行指令即覆盖对应状态准备，ExecutionRequest 根据平台和目标状态自动派生内部 `preparationPolicy`，不要求额外授权文本。
4. 制品登记把 `appId/version/build` 视为 expected identity；提取能力可用时保存实际 metadata 和工具来源，不可用时记录 `UNAVAILABLE`。
5. Android、HarmonyOS 将单用例 `FRESH_INSTALL` 等效实现为 `CLEAR_APP_DATA`，允许 `PREINSTALLED` provisioning 且不得要求安装资产；iOS 将其实现为 `REINSTALL_APP`，必须使用 `ARTIFACT_MANAGED` provisioning。
6. iOS 重装成功后必须读取 `installedIdentity` 并与冻结 expected identity 匹配，失败时返回 `APP_ARTIFACT_IDENTITY_MISMATCH`，不得建立 READY 暖会话。
7. ExecutionRequest 创建时生成 InitialStatePreflight，校验 requirement、自动派生的 policy、provisioning 和平台策略；失败时不创建批次或调用设备，尤其不得等到 Case Agent 执行中再索要安装资产或追加授权交互。
8. Lifecycle 在 Case Agent 委托前自动准备初始状态；失败时由框架形成完整 BLOCKED CaseResult，Case Agent 不拥有 `prepare` 能力。
9. App 状态重置会轮换暖会话；已发送但未记录结果的破坏性操作不自动重放。

## 结果

- 安装资产依赖由平台实际策略决定；Android、HarmonyOS 的等效重装不会因缺少安装包而阻塞。
- iOS 的制品可用性、平台安装结果和设备实际安装身份形成独立且可审计的闭环。
- 主 Agent 基于用例声明初始状态要求；Case Agent 只消费准备后的 Scene，不接触平台策略、资产路径或副作用授权。
- 旧 schema 的活动批次和 execution 不迁移，必须重新创建执行请求。

## 验证

`scripts/tests/app-provisioning.test.js` 覆盖安全默认值、平台策略、登记提取和安装后身份不匹配；`scripts/tests/app-preparation.test.js` 覆盖单用例自动派生准备策略、失败收口、中断恢复与暖会话轮换。

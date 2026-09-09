# ADR: App 初始状态与冻结制品

- 状态：Accepted，已实现
- 当前架构事实来源：`docs/architecture.md`

## 决策

1. `appProvisioning` 只描述 `PREINSTALLED` 或 `ARTIFACT_MANAGED` 来源，不代表安装授权。
2. 批次级 `bootstrapPolicy` 默认 `KEEP_EXISTING`；只有 `REINSTALL_FROZEN` 同时冻结卸载、安装副作用及用户授权文本时，bootstrap 才能重装。
3. 单用例 `initialStateRequirement` 表达业务所需的 `KEEP_EXISTING`、`APP_LOCAL_STATE_EMPTY` 或 `FRESH_INSTALL`；`preparationPolicy` 独立表达允许的副作用，不能借用 bootstrap 授权。
4. 制品登记把 `appId/version/build` 视为 expected identity；提取能力可用时保存实际 metadata 和工具来源，不可用时记录 `UNAVAILABLE`。
5. 重装成功后必须读取 `installedIdentity` 并与冻结 expected identity 匹配，失败时返回 `APP_ARTIFACT_IDENTITY_MISMATCH`，不得建立 READY 暖会话。
6. ExecutionRequest 创建时生成 InitialStatePreflight，先校验 requirement、policy、provisioning 和平台策略；失败时不创建批次或调用设备。
7. Lifecycle 在 Case Agent 委托前自动准备初始状态；失败时由框架形成完整 BLOCKED CaseResult，Case Agent 不拥有 `prepare` 能力。
8. App 状态重置会轮换暖会话；已发送但未记录结果的破坏性操作不自动重放。

## 结果

- 制品可用性、用户授权和设备实际安装身份形成独立且可审计的三段闭环。
- 主 Agent 基于用例声明初始状态要求；Case Agent 只消费准备后的 Scene，不接触平台策略、资产路径或副作用授权。
- 旧 schema 的活动批次和 execution 不迁移，必须重新创建执行请求。

## 验证

`scripts/tests/app-provisioning.test.js` 覆盖安全默认值、授权校验、登记提取、安装后身份不匹配和中断恢复；`scripts/tests/app-preparation.test.js` 覆盖单用例准备授权与暖会话轮换。

# 接口契约

## Agent-facing 主入口

普通执行只使用：

```bash
node scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>
```

首次调用只填写工作空间和用例编号。之后以当前响应中的能力卡、模板和预绑定命令为调用事实源，不在文档中复制字段清单。

Coordinator 返回 `NEED_USER_CONFIRMATION`、`NEED_CASE_AGENT`、`WAITING`、`TECHNICAL`、`COMPLETE` 或 `BLOCKED`。需要委托时只暴露不透明 `loaderCommand` 与固定 `delegationPrompt`；主 Agent 不读取 Handoff 正文。

`scripts/workspace.js --cwd <workspace>` 用于校验或初始化 Workspace，并返回四个能力的 `coordinatorFacade`。它不返回底层 CLI 参数 Schema。

## 内部/Authoring 接口

以下入口由 Coordinator Facade 内部使用，或只在用户明确要求导入用例、维护环境、制品和报告时使用：`import-case.js`、`build-agent-contract.js`、`probe-env.sh`、`prepare-env.sh`、`app-artifact.js`、`environment.js`、`execution-request.js`、`knowledge.js`、`batch.js`、`render-context.js`、`render-index.js`。

普通执行的主 Agent 不调用这些入口，也不读取其完整契约。Authoring 或维护流程需要调用时，以入口返回的机器契约、当前模板和错误响应为准。

内部接口负责哈希绑定、快照、事务和证据校验。新 execution 使用当前 Runtime；已完成的历史 execution 不迁移、不补写，报告只读展示。

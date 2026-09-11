# 接口契约

## Agent-facing 主入口

普通执行只使用一个入口：

```bash
node scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>
```

首次调用只填写工作空间和用例编号。之后以当前响应中的能力卡、模板和预绑定命令为唯一调用事实源，不在本文维护字段清单。

Coordinator 只返回 `NEED_USER_CONFIRMATION`、`NEED_COMPILER`、`NEED_CASE_AGENT`、`WAITING`、`COMPLETE` 或 `BLOCKED`。Compiler 和 Case Agent 响应只暴露不透明 `loaderCommand` 与固定 `delegationPrompt`。

`scripts/workspace.js --cwd <workspace>` 用于校验或初始化 Workspace，并返回四个能力的简明 `coordinatorFacade`。它不再返回底层 CLI 参数 Schema。

## 内部/Authoring 接口

以下入口由 Coordinator Facade 内部使用，或只在用户明确要求导入、发布定义、维护环境和报告时使用：`import-case.js`、`case-definition.js`、`build-agent-contract.js`、`probe-env.sh`、`prepare-env.sh`、`app-artifact.js`、`environment.js`、`execution-request.js`、`knowledge.js`、`batch.js`、`render-context.js`、`render-index.js`。

普通执行的主 Agent 不直接调用或读取这些接口的完整契约。Authoring 或维护流程需要调用时，以各入口的机器契约和错误响应为准，不从本文复制参数。

这些内部接口仍使用完整契约、哈希绑定、快照和双层校验。Facade 的简化不会修改 execution、result、completion 或报告 Reader Schema，已有工作空间与历史结果无需重跑。

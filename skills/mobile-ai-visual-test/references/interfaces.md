# 接口契约

## Agent-facing 主入口

普通执行只使用：

```bash
node <skill-root>/scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>
```

首次调用优先使用 Workspace 响应中已绑定绝对脚本路径和工作区的 `coordinatorFacade.prepareUsage`，只替换用例编号。之后以当前响应中的能力卡、模板和预绑定命令为调用事实源，不在文档中复制字段清单。

Coordinator 返回 `NEED_USER_CONFIRMATION`、`NEED_CASE_AGENT`、`WAITING`、`TECHNICAL`、`COMPLETE` 或 `BLOCKED`。需要委托时只暴露不透明 `loaderCommand` 与固定 `delegationPrompt`；主 Agent 不读取 Handoff 正文。

`<skill-root>/scripts/workspace.js --cwd <workspace>` 用于校验或初始化 Workspace，并返回四个能力的 `coordinatorFacade`。脚本路径属于技能目录，`--cwd` 属于测试工作区；响应中的 `coordinatorFacade.command` 可从任意当前目录重新校验该工作区，`coordinatorFacade.prepareUsage` 是已绑定工作区的绝对 Facade 启动命令。它不返回底层 CLI 参数 Schema。

## Authoring 接口

用例生成先读取 `references/case-authoring.md`。Authoring Agent 将任意格式输入理解为一条或多条 draft 后，通过同一个入口持久化：

```bash
node <skill-root>/scripts/import-cases.js --workspace <workspace> --request-file <json-file>
```

request 只包含非空 `cases` 数组；每项只提交稳定 `sourceLocator`、非空 `title` 和非空 `sourceText`。该接口不读取原始格式、不推断用例数量，也不生成 Case Flow。`import-case.js` 保留为已明确“一份文本文件就是一条用例”时的底层单文件入口，不用于替代 Authoring Agent 的语义判断。

## 内部/维护接口

以下入口由 Coordinator Facade 内部使用，或只在用户明确要求维护环境、制品和报告时使用：`build-agent-contract.js`、`probe-env.sh`、`prepare-env.sh`、`app-artifact.js`、`environment.js`、`execution-request.js`、`knowledge.js`、`batch.js`、`render-context.js`、`render-index.js`。

普通执行的协调 Agent 不调用这些入口，也不读取其完整契约。Authoring 或维护流程需要调用时，以入口返回的机器契约、当前模板和错误响应为准。

内部接口负责哈希绑定、快照、事务和证据校验。新 execution 使用当前 Runtime；已完成的历史 execution 不迁移、不补写，报告只读展示。

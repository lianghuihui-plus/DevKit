# 接口契约

本页只做角色路由。按需读取当前角色的短索引，不在启动时加载全部命令、参数或错误说明。

## Agent-facing 主入口

普通执行只使用：

```bash
node <skill-root>/scripts/workspace.js --cwd <workspace>
```

Workspace 响应返回绑定该工作空间的绝对 `coordinatorFacade.command`。原样执行该命令，并通过 stdin 一次提交 `{"operation":"prepareRun","input":{"caseNos":["014","015"]}}`；不要追加子命令、工作空间路径或用例参数。之后原样复用响应 `result.command`，通过同一 `{operation,input}` 协议调用 `confirmRun`、`advanceRun`、`cancelRun` 或 `read`，不自行调用底层 Batch 与 Runtime 接口。

Coordinator 使用统一响应 envelope；业务状态位于 `result.outcome`，包括 `NEED_USER_CONFIRMATION`、`NEED_CASE_AGENT`、`WAITING`、`CONFIRMED`、`COMPLETE` 或 `BLOCKED`。复杂数据位于 `data`，关联数据只通过 `resources[].ref` 暴露并统一用 `read(ref)` 获取。需要委托时，`caseDispatch` 主资源提供不透明 `loaderCommand` 与固定 `delegationPrompt`；执行协调 Agent 不读取 Handoff 正文。

`<skill-root>/scripts/workspace.js --cwd <workspace>` 用于校验或初始化 Workspace，并返回 Coordinator Facade 的绝对 `command`、协议类型和文档入口。脚本路径属于技能目录，`--cwd` 属于测试工作区；Facade 可从任意当前目录调用，工作空间已由返回的 command 绑定。它不返回底层 CLI 参数 Schema。

## Authoring 接口

用例生成先读取 `references/case-authoring.md`。Authoring Agent 将任意格式输入理解为一条或多条 draft 后，通过同一个入口持久化：

```bash
node <skill-root>/scripts/import-cases.js --workspace <workspace> --request-file <json-file>
```

request 只包含非空 `cases` 数组；每项只提交稳定 `sourceLocator`、非空 `title` 和非空 `sourceText`。该接口不读取原始格式、不推断用例数量，也不生成 Case Flow。`import-case.js` 保留为已明确“一份文本文件就是一条用例”时的底层单文件入口，不用于替代 Authoring Agent 的语义判断。

## 内部/维护接口

以下入口由 Coordinator Facade 内部使用，或只在用户明确要求维护环境、制品和报告时使用：`build-agent-contract.js`、`probe-env.sh`、`prepare-env.sh`、`app-artifact.js`、`environment.js`、`execution-request.js`、`knowledge.js`、`batch.js`、`render-context.js`、`render-index.js`。

普通执行的协调 Agent 不调用这些入口，也不读取其完整契约。Authoring 或维护流程需要调用时，先读取 [命令模块索引](commands.md)，再只进入当前功能模块；收到错误时只读取响应中的 `documentationRef`。

内部接口负责哈希绑定、快照、事务和证据校验。新 execution 使用当前 Runtime；历史 execution 不迁移、不补写，也不由报告兼容展示。

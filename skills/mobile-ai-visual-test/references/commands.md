# 命令模块

仅在 Authoring、维护或技术排障需要直接调用正式 CLI 时进入当前模块；普通执行协调 Agent 和 Case Agent 不读取本目录。

| 模块 | 用途 |
|---|---|
| [workspace](commands/workspace.md) | Validate or initialize a MAVT workspace and return this coordinator capability index |
| [authoring](commands/authoring.md) | Import a non-empty source file as a workspace case without interpreting its business semantics |
| [protocol-maintenance](commands/protocol-maintenance.md) | Build and optionally verify the role-scoped Agent protocol and implementation digests |
| [environment](commands/environment.md) | Read platform and device capabilities without choosing or launching a target App |
| [app-artifact](commands/app-artifact.md) | Validate and freeze an installation artifact in the workspace cache |
| [execution](commands/execution.md) | Create or read an explicit execution authorization |
| [knowledge](commands/knowledge.md) | Validate built-in and workspace knowledge before creating a new execution request |
| [reporting](commands/reporting.md) | Rebuild one case report from immutable artifacts |

预绑定命令见 [transport 规则](commands/transports.md)，收到错误时只读取响应中的 `documentationRef`。

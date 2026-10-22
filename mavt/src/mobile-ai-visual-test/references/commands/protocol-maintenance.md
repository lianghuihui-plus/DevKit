# protocol-maintenance

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="build-agent-contract"></a>
## scripts/build-agent-contract.js

Build an Agent contract

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/build-agent-contract.js --role <case-executor|batch-coordinator> --platform <harmony|android|ios> [--skill-root <path>] [--verify-sha <sha>]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--role` | 是 | Agent role；可选：`case-executor`、`batch-coordinator` |
| `--platform` | 是 | Target platform；可选：`harmony`、`android`、`ios` |
| `--skill-root` | 否 | Skill root override |
| `--verify-sha` | 否 | Expected protocol SHA |

**成功：** `role-scoped Agent contract`

**最小示例：**

```bash
node '<skill-root>/scripts/build-agent-contract.js' --role batch-coordinator --platform harmony
```

错误只按响应中的 [文档引用](errors/protocol-maintenance.md) 处理。

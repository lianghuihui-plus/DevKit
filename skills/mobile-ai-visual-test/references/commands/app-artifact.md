# app-artifact

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="app-artifact-register"></a>
## scripts/app-artifact.js register

Register an installation artifact

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/app-artifact.js register --workspace <workspace> --path <artifact> --platform <harmony|android|ios> --app-id <id> --version <version> --build <build> [--format <format>] [--device-type <simulator|realDevice>]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Workspace path |
| `--path` | 是 | APK, HAP, APP, or IPA path |
| `--platform` | 是 | Artifact platform；可选：`harmony`、`android`、`ios` |
| `--app-id` | 是 | Expected App identifier |
| `--version` | 是 | Expected semantic version |
| `--build` | 是 | Expected build identifier |
| `--format` | 否 | Explicit artifact format；可选：`APK`、`HAP`、`APP`、`IPA` |
| `--device-type` | 否 | Required for iOS；可选：`simulator`、`realDevice` |

**成功：** `ARTIFACT_MANAGED provisioning manifest`

**最小示例：**

```bash
node '<skill-root>/scripts/app-artifact.js' register --workspace '<workspace>' --path '<artifact>' --platform harmony --app-id '<app-id>' --version '<version>' --build '<build>'
```

错误只按响应中的 [文档引用](errors/app-artifact.md) 处理。

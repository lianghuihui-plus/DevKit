# environment

本页只服务当前功能模块，不需要预读其他命令模块。

<a id="probe-env"></a>
## scripts/probe-env.sh

Probe a platform

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
<skill-root>/scripts/probe-env.sh --platform <harmony|android|ios> [platform options]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--platform` | 是 | Platform to probe；可选：`harmony`、`android`、`ios` |
| `--device` | 否 | Explicit device serial or UDID |
| `--device-form-factor` | 否 | HarmonyOS static device form factor override；可选：`phone`、`tablet`、`foldable`、`widefold`、`triplefold`、`2in1`、`2in1 foldable`、`wearable`、`tv` |
| `--device-type` | 否 | iOS device kind；可选：`simulator`、`realDevice` |
| `--appium-server` | 否 | Existing Appium server URL |
| `--wda-local-port` | 否 | Local WebDriverAgent port |
| `--web-driver-agent-url` | 否 | Existing WebDriverAgent URL |
| `--xcode-org-id` | 否 | Apple development team identifier for real-device WDA |
| `--xcode-signing-id` | 否 | Signing identity for real-device WDA |
| `--updated-wda-bundle-id` | 否 | Unique WDA bundle identifier for real devices |
| `--show-xcode-log` | 否 | Enable Xcode build logging |
| `--show-ios-log` | 否 | Enable iOS device logging |
| `--use-new-wda` | 否 | Force a new WDA deployment |
| `--allow-provisioning-device-registration` | 否 | Allow Xcode to register the real device |
| `--wda-launch-timeout` | 否 | WDA launch timeout in milliseconds |
| `--derived-data-path` | 否 | Xcode DerivedData path |

**成功：** `environmentProbe matching probeJson schema`

**最小示例：**

```bash
'<skill-root>/scripts/probe-env.sh' --platform harmony --device '<device-id>'
```

错误只按响应中的 [文档引用](errors/environment.md) 处理。

<a id="prepare-env"></a>
## scripts/prepare-env.sh

Prepare a platform

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
<skill-root>/scripts/prepare-env.sh --platform <harmony|android|ios> [platform options]
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--platform` | 是 | Platform to prepare；可选：`harmony`、`android`、`ios` |
| `--device` | 否 | Explicit device serial or UDID |
| `--device-type` | 否 | iOS device kind；可选：`simulator`、`realDevice` |
| `--appium-server` | 否 | Existing Appium server URL |
| `--wda-local-port` | 否 | Local WebDriverAgent port |
| `--web-driver-agent-url` | 否 | Existing WebDriverAgent URL |
| `--xcode-org-id` | 否 | Apple development team identifier for real-device WDA |
| `--xcode-signing-id` | 否 | Signing identity for real-device WDA |
| `--updated-wda-bundle-id` | 否 | Unique WDA bundle identifier for real devices |
| `--show-xcode-log` | 否 | Enable Xcode build logging |
| `--show-ios-log` | 否 | Enable iOS device logging |
| `--use-new-wda` | 否 | Force a new WDA deployment |
| `--allow-provisioning-device-registration` | 否 | Allow Xcode to register the real device |
| `--wda-launch-timeout` | 否 | WDA launch timeout in milliseconds |
| `--derived-data-path` | 否 | Xcode DerivedData path |

**成功：** `environmentPrepare result`

**最小示例：**

```bash
'<skill-root>/scripts/prepare-env.sh' --platform android --device '<device-id>'
```

错误只按响应中的 [文档引用](errors/environment.md) 处理。

<a id="environment-confirm"></a>
## scripts/environment.js confirm

Confirm a probed device and target App

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/environment.js confirm --workspace <workspace> --binding-json <json> --probe-json <json> [--app-provisioning-json <json>] --user-confirmation <text>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Workspace path |
| `--binding-json` | 是 | Selected platform, device, and App binding |
| `--probe-json` | 是 | Unmodified successful probe response |
| `--app-provisioning-json` | 否 | Manifest returned by app-artifact register; omit for PREINSTALLED |
| `--user-confirmation` | 是 | User statement confirming this exact environment |

**成功：** `CONFIRMED`

**最小示例：**

```bash
node '<skill-root>/scripts/environment.js' confirm --workspace '<workspace>' --binding-json '{"platform":"harmony","deviceId":"<device-id>","appId":"<app-id>","entry":"<entry>"}' --probe-json '<probe response>' --user-confirmation '<confirmation>'
```

错误只按响应中的 [文档引用](errors/environment.md) 处理。

<a id="environment-status"></a>
## scripts/environment.js status

Read the current environment confirmation

**角色：** `maintenance`

**访问：** `ON_DEMAND`

```bash
node <skill-root>/scripts/environment.js status --workspace <workspace>
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `--workspace` | 是 | Workspace path |

**成功：** `current environment confirmation`

**最小示例：**

```bash
node '<skill-root>/scripts/environment.js' status --workspace '<workspace>'
```

错误只按响应中的 [文档引用](errors/environment.md) 处理。

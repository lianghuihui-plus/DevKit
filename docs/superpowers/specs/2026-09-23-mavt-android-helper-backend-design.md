# MAVT Android Helper Backend Design

**Reviewed baseline:** DevKit `main` at `d71e31612af95b6d598e7442d2f94f52e13b0e17` (2026-09-23).

## 1. 背景与目标

MAVT 当前 Android 观察链路串行执行 `uiautomator dump` 与 `adb exec-out screencap -p`。现有执行记录中，Android 控件树阶段中位约 3.48 秒，截图阶段中位约 0.51 秒，完整采集中位约 3.99 秒。ARTEMIS Accessibility Helper 可以在 Android 11+ 通过一次 `/snapshot` 请求并行取得无障碍层级和系统截图，并通过 HTTP RPC 执行界面动作。

本设计将 Helper 作为 Android UI 后端接入 MAVT，同时保留现有 UIAutomator/ADB 后端作为完整降级路径。MAVT 上层 Scene、PNG 证据、Action Result、Case Runtime 和报告契约保持不变。

目标：

- Android 观察优先使用 Helper 的 `snapshot?fields=xml&format=png`，一次取得 PNG 和 XML。
- Android 界面动作在 Helper 后端可用时由 Helper 完成；Helper 不可用且尚未投递动作时，使用现有 ADB/UIAutomator 后端。
- Helper 与 UIAutomator 是 adapter 内部的两套 UI 后端，上层不感知切换。
- Helper 会话由 batch platform runtime 获取和释放，凭据不进入 execution、event、日志或命令行。
- Helper 失败后的动作处理遵守 `ACTION_OUTCOME_UNKNOWN`：可能已经投递的动作绝不自动重放。
- 保持现有 PNG 证据契约，不在本次改造中扩展 MAVT 为多图片格式。

非目标：

- 不替换 App 安装、卸载、启动、重启、PID、前台应用识别和日志采集；这些继续使用共享 ADB 平台能力。
- 不修改 HarmonyOS 或 iOS adapter。
- 不将 Helper 的 JPEG 暴露给 Scene 或证据层。
- 不增加外部 npm/Python 运行依赖。
- 不把 Helper token 写入 workspace、batch 或 execution 目录。

## 2. 已验证前提

- 实机：Samsung SM-N9860，Android 11+。
- Helper `1.2.1`、protocol `2`，支持认证、PNG/JPEG 原子快照和完整动作 RPC。
- `/snapshot?fields=xml&format=png` 返回可被 MAVT `inspectPng` 接受的 PNG，并同时返回 UIAutomator 格式 XML。
- 已验证 `ping`、snapshot、tap、double tap、long press、swipe、type、back、home。
- Helper 的系统截图依赖 Android API 30；API 29 及以下只能使用 `uiautomator` 后端。`auto` 在 acquire 前按 SDK 版本降级，严格 `helper` 明确失败，不能等到每次 snapshot 才重复失败。
- Helper 的裸 `clear` 在三星 Settings `AutoCompleteTextView` 上存在兼容性问题；MAVT 的 `inputText(mode="replace")` 不调用 `clear`，而使用 `type` RPC 的 `append=false` 直接替换完整文本。
- Helper `double_tap` 固定使用 100ms 间隔；MAVT 请求其他 `intervalMs` 时由 adapter 在同一个 Helper action transaction 内执行 `tap -> wait -> tap`。带坐标的 `inputText` 同理执行 `tap -> type`，第一次 Helper POST 开始后整个 transaction 都禁止降级。
- Helper `long_press` 当前将时长限制在 500-5000ms；adapter 必须在 POST 前识别范围。`auto` 对范围外请求使用 legacy 后端，严格 `helper` 返回已知的 `REJECTED/NOT_EXECUTED`，不得静默改变请求时长。
- Helper `swipe` 同样将根据 MAVT `velocity` 算出的时长限制在 50-5000ms；adapter 必须复用 `swipeDurationMs()` 在 POST 前检查精确可执行性。范围外时 `auto` 使用 legacy，严格 `helper` 返回 `REJECTED/NOT_EXECUTED`，不得让 Helper 静默限幅。
- 普通页面 PNG 采集约数百毫秒；高纹理桌面可产生约 4 MB PNG 和约 5 秒长尾。该长尾在同机 `adb screencap -p` 同样存在，不是 Helper 特有回归。

## 3. 后端选择

Android environment binding 新增：

```json
{
  "androidUiBackend": "auto"
}
```

允许值：

| 值 | 语义 |
|---|---|
| `auto` | 默认值；runtime 尝试准备并连接 Helper，准备失败则记录诊断并使用 UIAutomator/ADB。 |
| `helper` | 严格模式；Helper 无法准备、认证或达到最低协议时，platform runtime 获取失败并阻止执行。 |
| `uiautomator` | 禁用 Helper；完全保持当前 Android 行为。 |

选择结果被冻结在 environment/batch binding 中，并通过 Coordinator agent-facing schema、环境确认、自动 `prepare-env`、platform runtime 和 Case adapter 全链路透传。历史冻结 binding 可能没有该字段：读取时保持原 `bindingSha`，在 Android adapter 参数边界补成 `auto`，不得通过修改通用 `validateBinding()` 让历史环境失效。执行期间不允许更改配置，但 `auto` 可以在每次只读观察前根据会话健康状态降级。

## 4. 架构边界

```text
Case Runtime / Device Port
          |
          v
Android Adapter Router
  |                       |
  | Helper healthy        | disabled/unavailable before dispatch
  v                       v
Helper UI Backend      UIAutomator/ADB UI Backend
  - atomic PNG+XML        - adb screencap PNG
  - tap/type/swipe        - adb input / MAVT IME
  - back/home             - adb keyevent
          \               /
           \             /
            v           v
       Existing MAVT contracts
       Scene PNG + XML + Action Result
```

共享 ADB 能力不属于 UI 后端：

- App 安装、卸载、清数据、启动和重启。
- `dumpsys` 前台应用和窗口信息。
- `logcat`。
- 设备发现；本设计新增的 device claim 只保护 Helper token/service/forward，不替代上层整机调度。
- long-press 过程中的独立证据截图；Helper command server 正在同步处理长按 RPC 时，过程截图继续使用 `adb screencap`。

## 5. Helper 制品

在 Android adapter 内固定携带经过验证的 Helper 制品：

```text
scripts/platform/adapters/android/helper/
  ArtemisAccessibilityHelper.apk
  helper_manifest.json
  LICENSE
  SOURCE.md
```

`helper_manifest.json` 固定：

```json
{
  "package": "com.artemis.helper",
  "version_code": 7,
  "version_name": "1.2.1",
  "protocol_version": 2,
  "sha256": "c2f6622920156f3951b13118efe1c87fcc27ea7e5904d42e61b5a6b849d37626"
}
```

`SOURCE.md` 记录上游仓库、基础 commit、MAVT PNG patch 分支、构建命令和验证设备。测试必须校验 APK SHA-256 与 manifest 一致，防止二进制和元数据漂移。

## 6. 会话与凭据

Helper 只监听设备 loopback `127.0.0.1:18888`，host 通过独占 `adb forward tcp:0 tcp:18888` 访问。

platform runtime acquire 使用每设备 owner claim 和 `device-hash + ownerKey` 对应的确定性 session journal。claim/journal 目录 mode 为 `0700`、文件 mode 为 `0600`，并在任何设备或 host adb forward 状态变更前写入恢复依据；这样 batch acquire 重试和进程重启都能继续同一事务，而不是创建第二个 forward 或丢失恢复依据。

device claim 必须位于不受 `MAVT_ANDROID_HELPER_STATE_DIR` 影响的 canonical user cache 目录；否则同一 host 上使用不同 session state root 的两个进程会绕过互斥。自定义 state dir 只改变 owner journal/token 文件位置，不能改变 claim/lock 的唯一位置。

Helper token 是设备进程级单例，不能由两个 batch 共享。acquire 必须在设备副作用前原子取得 device claim：同 owner 可续接；其他活跃 owner 返回 retryable `ANDROID_HELPER_IN_USE` 和 `WAIT_OR_CANCEL_OWNER_BATCH`；终态/达到清理期限的 owner 先按其 journal 回收；owner 无法确认时返回 `ANDROID_HELPER_OWNERSHIP_UNKNOWN`，不得覆盖 token。release 只有在 claim 仍属于本 owner 时才能清 token和恢复 service，成功后删除 claim。

MAVT claim 只能证明 MAVT owner。取得新 claim 后必须先通过临时 forward 探测 device port 18888，不以“当前 user 的 service 是否启用”作为是否 ping 的前提；这样才能发现其他 Android user 或外部工具已经启动的 Helper。匿名 `/ping` 返回 `token_set=true` 时视为外部 ARTEMIS session：旧 token 不可读取也不可恢复，MAVT 不得升级 APK、重启 service、覆盖或清除 token。端口可达但 ping 身份/状态无法确认，或当前 user 的 service 已启用但端口无法确认时，同样按 `ANDROID_HELPER_EXTERNAL_STATE_UNKNOWN` 拒绝接管。`auto` 记录原因并降级，严格 `helper` 明确失败。只有明确 `token_set=false` 的预启用 service 才可在记录原状态后接管，并在 release 时保留 service 但清除本次 token。

acquire：

1. 校验绑定平台、后端策略、当前 Android user、SDK >= 30 和设备 transport id，取得每设备 owner claim，并立即创建 `CLAIMED` journal；同 owner 重入但 journal 尚未进入 mutation phase 时从该阶段继续。
2. 读取并保存当前 forward baseline；外部 session 探测所需的临时 forward 也必须先在 journal 写入 intent，探测结束后立即移除。进程中断时按 baseline 与当前 forward 列表确定性回收唯一新增项；无法唯一确认 ownership 时返回 `ANDROID_HELPER_OWNERSHIP_UNKNOWN`，不得猜测删除。
3. 在任何设备 mutation 前排除外部 token session。
4. 校验 bundled APK hash 与 manifest。
5. 读取安装版本；缺失或版本低于 7 时执行 `adb install -r -g`。
6. 读取并保存 acquire 前当前 Android user 的无障碍开关和 enabled services 列表；所有 `settings` 和显式 token receiver 命令都带同一个 `--user <id>`。
7. 仅追加 `com.artemis.helper/.ArtemisAccessibilityService`，不得覆盖其他 service。
8. journal 先记录 forward baseline/intent，再创建独占 adb forward并写回 local port 和 ownership。
9. 生成 256-bit token并写回 journal，再通过受 `WRITE_SECURE_SETTINGS` 保护的显式 receiver 下发。
10. 使用单次 1 秒 ping、总计最多 10 秒的有界 readiness loop，校验 `authenticated=true`、`token_set=true`、protocol >= 2、versionCode >= 7；`/ping` 本身允许匿名访问，不能只凭 HTTP 200 判断 token 生效；不使用固定睡眠猜测服务已启动。
11. 将 journal 标记为 `ACTIVE`，返回不含 token 的 runtime resource。

任一步失败都按 journal 逆序回滚本次已完成的 token、forward 和 service 变更并释放自己的 claim。`auto` 只有在回滚完成后才能降级；严格 `helper` 返回 `ACQUIRE_FAILED`。进程被中断时，下次同一 `ownerKey` acquire 必须读取 journal 并先恢复或续接，不能遗留资源后重新创建。

如果设备已安装同 package 但签名不兼容，`auto` 必须清理本次 forward/service 变更后降级，`helper` 必须返回包含 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 的明确失败；框架不得自动卸载已有 package。

token session 文件位于：

```text
${MAVT_ANDROID_HELPER_STATE_DIR:-<user-cache>/mobile-ai-visual-test/android-helper}/<device-hash>/<owner-key-hash>.json
```

batch `platform-runtime.json` 只保存非敏感引用：

```json
{
  "resource": {
    "androidHelper": {
      "backend": "helper",
      "sessionId": "helper-<owner-key-hash>",
      "sessionStatePath": "/host/cache/.../helper-....json",
      "protocolVersion": 2,
      "versionCode": 7,
      "generation": 1
    }
  }
}
```

禁止把 token 放入：

- `platform-runtime.json`
- `runtime.json`
- adapter stdout/stderr
- action/scene/event JSON
- MAVT entrypoint argv、adapter argv 或 host `adb` 进程 argv

自定义 state dir 必须是 workspace 外的绝对路径；拒绝 symlink session 文件。下发 token 时启动 `adb -s <serial> shell`，再从 stdin 写入显式 `am broadcast` 命令；不得把 token 作为 host `spawn` 参数。设备端 receiver 仍只接受受 `WRITE_SECURE_SETTINGS` 保护的显式 broadcast。清除 token 使用同一 `SET_TOKEN` receiver 下发空字符串，因为当前 APK 没有独立的 `CLEAR_TOKEN` action。

## 7. 释放与恢复

platform runtime release 必须幂等：

1. 通过显式 receiver 清除设备进程内 token。
2. 删除本次 acquire 创建的 adb forward。
3. 如果 Helper service 在 acquire 前未启用，则从 enabled services 中只移除 Helper，保留其他 service。
4. 如果 acquire 前全局 accessibility 已关闭且释放后无 enabled service，恢复全局开关。
5. 删除 host token session 文件。
6. 保留 APK，以避免下一批重复安装；安装制品属于缓存依赖，不属于活动运行资源。

如果 service 在 acquire 前已经启用，release 不禁用它。release 失败必须返回 `RELEASE_FAILED` 和可诊断阶段，不能伪报成功。

`prepare-env` 不是 batch acquire：它必须先原子取得带 host PID/进程启动身份的临时 device claim，并创建该 claim 引用的确定性 prepare journal，再在任何设备 mutation 前排除外部 token session；存在外部 session 或其他活跃/未知 owner 时不得安装、重启 service 或覆盖 token。安装 APK可以作为持久缓存保留，但临时 service、forward、token 的 prior state、intent 和完成阶段必须在 mutation 前原子写入 journal，并在同一次调用的 `finally` 中恢复。临时 owner 进程已退出时，后继只能按 prepare journal 完成恢复后回收 claim；journal 缺失、损坏或 ownership 不明确时返回 `ANDROID_HELPER_OWNERSHIP_UNKNOWN`，不能因为 PID 已退出就假设设备干净。准备阶段不能留下启用的 Helper service，否则后续 acquire 会误判为外部预存状态并在 release 时永久保留。

每次请求前校验 device claim 仍属于 session owner，并校验 device serial、Android user、transport id 和 forward；claim 不匹配时禁止重发 token或修复资源。只读请求允许一次确定性修复：

- HTTP 401：重新下发原 token并重试一次。
- forward/transport 失效：重新创建 forward 并重试一次。
- service 已启用但无响应：在保留其他 accessibility services 的前提下 rebind 一次。

动作请求只有 HTTP 401 可以安全重试，因为服务器在认证前不会执行动作。动作 POST 发出后的 timeout、断链或无响应一律标记 outcome unknown，不重建后自动重放。

固定 timeout：单次 ping 1 秒、acquire readiness 总计 10 秒；snapshot 15 秒；tap/type/global 单 RPC 为 3 秒；原生 double tap 和定点输入 transaction 为 5 秒；自定义间隔 double tap 为 `intervalMs + 4 秒`；long press 为 `durationMs + 3 秒`；swipe 为 `swipeDurationMs(action) + 3.5 秒`。这些上限覆盖当前 Helper 内部 gesture wait budget，外层 adapter deadline 更短时取剩余 deadline。

## 8. 观察路径

Helper snapshot CLI 接收 session state 引用和两个输出路径，不在 stdout 输出 Base64：

```text
snapshot({ sessionStatePath, screenshotPath, layoutPath, format: "png", fields: "xml" })
```

成功时：

- 解码 `screenshot_base64` 到 `screenshots/<label>.png`。
- 验证响应 `has_screenshot=true`、`screenshot_format=png`、`screenshot_media_type=image/png`。
- 写入 `layouts/<label>.xml`。
- 返回宽高、Helper atomic timing、HTTP timing、版本和 backend 名称等小型元数据。

HTTP client 限制响应体大小，校验 HTTP status、JSON、`success`、PNG signature、非空 XML 及响应格式字段。PNG/XML 分别写到目标目录的临时文件，全部校验成功后先提交 XML、最后以 PNG 作为 commit marker；启动时清理同一请求遗留的 staging/不完整目标，任一提交失败都删除本次两个目标，不能留下新 PNG 配旧 XML。adapter stdout 只允许小型 metadata。

`auto` 模式下，snapshot 在任何动作之外，是幂等只读请求，可以在 Helper 失败后使用现有 `dump-tree.sh + screenshot.sh` 降级。降级原因只写技术信号和日志，不改变 Scene 证据契约。

`helper` 严格模式下不降级，观察失败返回明确的 `ANDROID_HELPER_SNAPSHOT_FAILED`。

日志和前台应用继续通过 ADB 采集。Helper snapshot 与这些独立只读采集并行启动，最后统一组装 observation，并继续输出既有 `layoutCapture`、`captureTiming` 和 artifact 字段。截图-only capture 在 Helper 后端调用 snapshot 并安全丢弃临时 XML；long-press during-action capture 仍使用独立 ADB screenshot。

## 9. 动作路径

Helper 映射：

| MAVT action | Helper RPC |
|---|---|
| `tap`, `toggle` | `tap` |
| `doubleTap intervalMs=100/缺省` | `double_tap` |
| `doubleTap 其他 intervalMs` | 同一 transaction 内 `tap -> wait -> tap` |
| `longPress` | `long_press` |
| 无坐标 `inputText mode=replace` | `type {text, append:false}` |
| 无坐标 `inputText mode=append` | `type {text, append:true}` |
| 带坐标 `inputText` | 同一 transaction 内 `tap -> type` |
| `swipe` | `swipe` |
| `back`, `home` | `global` |

共享 ADB/host 映射：

| MAVT action | 实现 |
|---|---|
| `launchApp`, `restartApp` | 现有 ADB atom |
| `wait` | host timer |
| long-press during-action capture | 现有 `adb screencap -p` |

动作降级规则：

1. 在第一个动作 POST 前执行 Helper ping/preflight，并检查参数是否能被当前 Helper 精确执行。
2. preflight 已明确失败或参数不受支持且策略为 `auto`，可以选择 legacy 后端执行一次；严格 `helper` 生成合法 Action Result `REJECTED/NOT_EXECUTED`，不能用非 JSON 退出伪装成未知结果。
3. 一旦 transaction 的第一个 Helper action POST 开始，后续步骤失败也不允许再调用 legacy action atom。
4. transport timeout、断链、截断响应、非 401 HTTP error 或无法判定服务端是否执行时，adapter 返回 `command.status=UNKNOWN`。
5. HTTP 401 明确发生在服务端认证门之前；重新核对 claim 仍属于当前 owner 后，才可重新下发同一 token并重试一次。claim 已丢失时禁止覆盖 token；若 transaction 尚无成功步骤则返回已知未执行，已有成功步骤则返回已知 partial failure。其他 POST 不重试。
6. Helper 返回 `success=false` 表示请求已经到达 action handler，不能一概宣称未执行；返回 `command.status=ACCEPTED`、`deviceExecution.status=FAILED`，然后 observe。只有本地校验、preflight 或 Helper 明确的请求字段拒绝才能返回 `REJECTED/NOT_EXECUTED`。
7. Device Port 将任意平台的 `command.status=UNKNOWN` 转为 `ACTION_OUTCOME_UNKNOWN`，Case Runtime 和 `runPlan` 先 observe，不重放动作或计划。

`/action` 请求体必须按 Helper protocol 2 使用扁平 JSON，例如 `{"cmd":"tap","x":10,"y":20}`，不能发送 `{"cmd":"tap","params":{...}}`。`swipe` 的 `duration` 由现有 `swipeDurationMs(action)` 计算，并在 50-5000ms 精确范围检查通过后发送。

## 10. 可观测性

Observation `technicalSignals` 增加：

```json
{
  "androidUiBackend": {
    "requested": "auto",
    "selected": "helper",
    "fallback": null,
    "helperVersion": "1.2.1",
    "protocolVersion": 2,
    "atomicElapsedMs": 673,
    "requestElapsedMs": 934
  }
}
```

Action Result 的 `command.transport` 使用：

- `ANDROID_HELPER_HTTP`
- `ADB_INPUT`
- `MAVT_INPUT_IME`

日志不得包含 token、完整 Base64 截图或完整层级内容。

## 11. 验收标准

- `androidUiBackend=uiautomator` 的既有测试和输出完全兼容。
- Android API < 30 时，`auto` 在 acquire 前降级且严格 `helper` 明确失败。
- `auto` 在 Helper 正常时生成有效 PNG/XML Scene，技术信号选择 `helper`。
- `auto` 在 Helper acquire 或只读 snapshot 失败时生成有效 fallback Scene。
- `helper` 严格模式在 Helper 不可用时明确失败。
- Helper action preflight 失败时，`auto` 最多执行一次 ADB action。
- Helper action POST 后 transport 失败时，没有 ADB action 调用，并产出 `ACTION_OUTCOME_UNKNOWN`。
- 定点 `inputText` 保持先聚焦再输入；自定义 `doubleTap.intervalMs` 不被静默改成 100ms；Helper 不支持的 long-press 时长不被静默截断。
- `swipe` 继续遵守 MAVT velocity 语义；计算时长超出 50-5000ms 时不被 Helper 静默限幅。
- token 不出现在 workspace 全文、adapter 输出和 process argv 测试夹具中。
- acquire 任一阶段失败或重试后不遗留重复 forward、token 或错误 service 状态；`prepare-env` 前后 accessibility 状态一致。
- 两个 batch 竞争同一设备时只有 claim owner 能操作 Helper；非 owner 不覆盖 token、不移除 forward、不恢复 service。
- 已存在的外部 ARTEMIS token session 不被 MAVT 覆盖、清除或通过 APK 升级中断。
- release 移除 owned forward、清除 token、恢复 acquire 前 accessibility service 状态并删除 cache session 文件。
- 实机通过 snapshot、tap、doubleTap、longPress、replace/append inputText、swipe、back、home。
- 普通业务页面记录 Helper 与 legacy 的 P50/P90；Helper 总观察时间应显著低于 legacy，PNG 高复杂页面长尾单独披露，不作为功能失败。

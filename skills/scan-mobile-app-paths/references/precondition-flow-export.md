# 前置条件 Flow 导出

当前 Snapshot 的规范路径可以导出为 `mobile-ai-visual-test` 可消费的静态前置条件 Flow 资产。

该能力只消费 `snapshots/current.json` 指向的不可变 generation，不修改 Run、canonical map、frontier、verification queue 或 Dashboard 事实。Dashboard 支持在浏览器里通过目录授权直接生成 `flow.json`；CLI 保留给 Agent 或批处理使用。

## Dashboard 交互

在 `dashboard/index.html` 中选中目标页面后，右侧的“规范重放路径”会展示 Flow 导出入口。

点击 `导出 Flow` 后会打开弹框：

- Flow 名称、业务目录、平台、起点描述、终点描述和步骤会自动填充。
- 用户可以修改 Flow 名称、业务目录、起点描述和终点描述。
- 平台为下拉单选，默认 `harmony`，也可选择 `android`、`ios` 或 `universal`。
- 有完整截图证据时默认勾选 `包含参考图`，生成时会写入 `assets/start.png` 和 `assets/end.png`，并在 `flow.json` 中填充 `referenceImage`。
- 第一次生成时点击 `选择导出目录`，选择要写入 Flow 的目录，通常是 `mobile-ai-visual-test` 的 workspace 根目录。
- 点击 `生成 flow.json` 后，浏览器按平台写入 `<导出目录>/<business>/.../flow.json`。

该浏览器导出依赖 File System Access API。Chrome/Edge 支持；不支持该 API 的浏览器无法从静态 HTML 直接写本地文件，可改用 CLI。

`build-dashboard.js` 会把 Flow 导出所需的起止截图以内嵌 data URL 写入 Dashboard 数据，避免静态 HTML 运行时读取本地图片触发浏览器 canvas/CORS 限制。若用户取消勾选 `包含参考图`，Dashboard 会只生成不含 `referenceImage` 的最小 `flow.json`。选择 `universal` 时写入 `<business>/flow.json`；选择具体平台时写入 `<business>/<platform>/flow.json`。

## 命令

列出候选路径：

```bash
node scripts/export-precondition-flow.js list \
  --app-map-root <APP_MAP_ROOT> \
  --context authenticated
```

预览 Flow：

```bash
node scripts/export-precondition-flow.js preview \
  --app-map-root <APP_MAP_ROOT> \
  --context authenticated \
  --path-id <path-id> \
  --name 进入创作页 \
  --business enter-creation-page \
  --workspace <mobile-ai-visual-test-workspace>
```

写入 Flow：

```bash
node scripts/export-precondition-flow.js write \
  --app-map-root <APP_MAP_ROOT> \
  --context authenticated \
  --path-id <path-id> \
  --name 进入创作页 \
  --business enter-creation-page \
  --workspace <mobile-ai-visual-test-workspace> \
  --platform harmony
```

## 路径选择

`preview` 与 `write` 支持以下选择器，至少使用一种：

- `--path-id`
- `--terminal-reachable-state-id`
- `--logical-screen-id`
- `--logical-name`

如果选择器命中多条路径，脚本返回 `FLOW_PATH_AMBIGUOUS` 和候选列表，不写文件。

## 输出

Harmony 平台输出位置：

```text
<workspace>/<business>/harmony/flow.json
<workspace>/<business>/harmony/assets/start.png
<workspace>/<business>/harmony/assets/end.png
```

`--platform` 默认 `harmony`。当前 skill 只扫描 HarmonyOS App，因此不要默认生成 `universal` Flow。

## 校验

导出前的硬校验：

- 路径至少 1 步且不超过 5 步。
- 路径从 root 连续到目标状态。
- 不包含 `wait`、未知动作或不可映射动作。
- 每条 Edge 的 locator quality 必须为 `SEMANTIC_PORTABLE` 或 `SEMANTIC_WITH_FALLBACK`。
- `replayPolicy` 不是 `NONREPEATABLE`。
- `safety.allowed` 不是 `false`。
- `sideEffect` 为空或 `NONE`。
- 动作语义不包含支付、删除、发布、提交审核、密码、验证码等危险意图。

以下情况只作为人工审阅警告，不阻止导出：

- Edge 尚未达到 `COLD_REPLAY_VERIFIED`。
- Edge 带有坐标证据兜底，即 locator quality 为 `SEMANTIC_WITH_FALLBACK`。

写入后，如果目标 workspace 存在 `scripts/flow/load-precondition-flows.js`，脚本会自动调用目标 loader 做平台级资产校验；不存在时只记录跳过原因。

## 描述与截图

脚本默认用起点和终点页面名生成 `startCondition.description` 与 `endCondition.description`，并复制对应 Observation 的 `screenshot.png` 为 `assets/start.png` 和 `assets/end.png`。

交付质量要求更高时，应在对话中人工确认页面语义，并通过以下参数覆盖描述：

```bash
--start-description "当前位于首页，底部导航栏展示创作入口"
--end-description "当前位于创作页，顶部展示“创作”标题和工具区"
```

## 坐标证据

默认只输出语义 `target`。需要把本次扫描设备上的 locatorEvidence 作为人工参考一起写入时加：

```bash
--include-coordinates true
```

脚本会从 Edge 的 `locatorEvidence.fallbackBounds` 或 `tapPoint` 生成坐标字段，并写入 `coordinateEvidence`。这些坐标只作为人工参考或目标执行侧的兜底证据；`DEVICE_BOUND` / `UNRESOLVED` 路径不可导出。

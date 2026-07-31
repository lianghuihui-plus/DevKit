# 前置条件 Flow 资产交付规范

## 1. 文档用途

本文面向需要为 `mobile-ai-visual-test` 提供 Flow 的人工、Agent 或其他 Skill，说明应生成哪些文件、文件应放在哪里，以及交付前必须满足的校验规则。

Flow 是受版本控制的静态资产，用于把应用从一个固定起点带到一个固定终点。当前 Flow 只用于测试用例的前置条件，不用于业务步骤。

交付方只负责生成 Flow 资产，不负责执行 Flow，也不需要生成测试 execution、timeline、结果或计划哈希。

## 2. 交付结论

一个逻辑 Flow 对应一个业务目录。最小交付物只有一个 `flow.json`：

```text
<workspace>/
  flows/
    preconditions/
      <business>/
        flow.json
```

如果起点或终点需要图片辅助判断，可以同时交付 `assets/`。如果不同平台的页面或操作不同，可以增加平台覆盖版本：

```text
<workspace>/
  flows/
    preconditions/
      <business>/
        flow.json                    # 可选：通用版本
        assets/                      # 可选：通用版本参考资产
          start.png
          end.png
        harmony/
          flow.json                  # 可选：HarmonyOS 覆盖版本
          assets/
        android/
          flow.json                  # 可选：Android 覆盖版本
          assets/
        ios/
          flow.json                  # 可选：iOS 覆盖版本
          assets/
```

规则：

- 通用版本直接放在 `<business>/flow.json`，不要创建 `universal/` 目录。
- 可以只有通用版本，也可以只有一个或多个平台版本。
- 平台版本存在时，执行对应平台会优先选择平台版本，否则回退通用版本。
- 同一业务目录的通用版本和平台版本必须使用完全相同的 `name`。
- `<business>` 只用于组织文件，不参与匹配；建议使用稳定、可读的英文短横线名称，例如 `enter-creation-page`。
- 多个逻辑 Flow 必须分别放入不同的业务目录。

## 3. `flow.json` 完整结构

```json
{
  "schemaVersion": 2,
  "id": "flow-enter-creation-page",
  "name": "进入创作页",
  "usage": "precondition",
  "platform": "universal",
  "startCondition": {
    "description": "App 当前位于首页，底部导航栏中的创作入口清晰可见",
    "referenceImage": "assets/start.png"
  },
  "endCondition": {
    "description": "App 当前位于创作页，页面顶部展示“创作”标题并显示创作工具区",
    "referenceImage": "assets/end.png"
  },
  "steps": [
    {
      "id": "flow-step-001",
      "instruction": "点击底部导航栏中的创作入口",
      "action": {
        "type": "tap",
        "target": "底部导航栏创作入口"
      }
    }
  ]
}
```

### 3.1 顶层字段

| 字段 | 必填 | 类型 | 交付要求 |
| --- | --- | --- | --- |
| `schemaVersion` | 是 | number | 固定填写 `2` |
| `id` | 是 | string | 稳定、非空的 Flow 标识；建议以 `flow-` 开头，修改内容时不要随意更换 |
| `name` | 是 | string | Flow 的业务名称，也是唯一匹配键 |
| `usage` | 是 | string | 当前固定填写 `precondition` |
| `platform` | 是 | string | `universal`、`harmony`、`android` 或 `ios` |
| `startCondition` | 是 | object | Flow 可以开始执行的固定页面状态 |
| `endCondition` | 是 | object | Flow 成功完成后的固定页面状态 |
| `steps` | 是 | array | 一个或多个顺序动作，硬上限 5 个 |

不要增加 `status`。文件存在且通过校验即视为可用资产。

### 3.2 `name` 匹配规则

测试执行时只使用下面的规则匹配用例前置条件：

```text
trim(casePrecondition.text) === trim(flow.name)
```

除了清理首尾空白，不进行任何归一化、别名或语义匹配。

假设 `name` 为 `进入创作页`：

| 用例前置条件 | 是否命中 |
| --- | --- |
| `进入创作页` | 是 |
| ` 进入创作页 ` | 是 |
| `进入创作页。` | 否 |
| `已进入创作页` | 否 |
| `打开创作页` | 否 |

因此，交付前必须确认 Flow `name` 与预期用例中的前置条件文字完全一致。同一执行平台下不能存在两个同名 Flow。

### 3.3 起点和终点

`startCondition` 和 `endCondition` 的结构相同：

```json
{
  "description": "可通过当前页面截图或控件树明确判断的状态",
  "referenceImage": "assets/example.png"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `description` | 是 | 描述可观察、可判断的页面状态 |
| `referenceImage` | 否 | 帮助判断页面状态的参考图，相对于当前 `flow.json` 所在目录 |

描述要求：

- 必须说明当前页面或区域，以及至少一个稳定、可见的识别特征。
- 起点和终点必须能够明确区分。
- 不要只写“初始状态”“正确页面”“操作成功”等无法独立判断的描述。
- 不要依赖某次 execution 的截图路径、设备坐标、时间或临时数据。
- 参考图只用于辅助理解，最终仍以当前执行时采集的 observation 为准。

推荐写法：

```text
当前位于首页，顶部展示用户头像，底部导航栏展示“首页、创作、我的”。
```

不推荐写法：

```text
页面正常，可以继续。
```

### 3.4 Steps

每个 step 表示一个可审计的原子动作：

```json
{
  "id": "flow-step-001",
  "instruction": "点击底部导航栏中的创作入口",
  "action": {
    "type": "tap",
    "target": "底部导航栏创作入口"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 当前 Flow 内唯一，建议依次使用 `flow-step-001`、`flow-step-002` |
| `instruction` | 是 | 面向 Agent 的明确操作说明 |
| `action` | 是 | 结构化原子动作 |

步骤要求：

- 每个 step 只包含一个动作。
- 按实际执行顺序排列。
- `instruction` 必须说明操作目标，不能只写“点击”“继续”或“执行下一步”。
- 一个前置条件 Flow 的动作预算为 5，`steps` 超过 5 个会在加载阶段被拒绝。
- 不要在 step 中写断言、测试预期或 case 业务步骤。
- 不要把多个动作组合成一个 step。

## 4. 支持的 Action

当前支持以下动作类型：

| `type` | 常用字段 | 示例 |
| --- | --- | --- |
| `launchApp` | `reason` | `{"type":"launchApp","reason":"启动目标应用"}` |
| `tap` | `target` | `{"type":"tap","target":"创作入口"}` |
| `toggle` | `target` | `{"type":"toggle","target":"通知开关"}` |
| `longPress` | `target`、可选 `durationMs` | `{"type":"longPress","target":"会话项","durationMs":800}` |
| `inputText` | `target`、`text` | `{"type":"inputText","target":"手机号输入框","text":"13800000000"}` |
| `swipe` | `fromX`、`fromY`、`toX`、`toY`、可选 `velocity` | `{"type":"swipe","fromX":800,"fromY":1800,"toX":800,"toY":600}` |
| `back` | 无 | `{"type":"back"}` |
| `home` | 无 | `{"type":"home"}` |
| `wait` | `ms`、`reason` | `{"type":"wait","ms":1000,"reason":"等待页面稳定"}` |

对于 `tap`、`toggle` 和 `longPress`，优先交付稳定的语义目标 `target`，让执行 Agent 根据当前 observation 定位。只有坐标确实稳定且交付方能提供完整坐标证据时，才附加 `x`、`y`、`coordinateSource`、`targetBounds` 和 `coordinateEvidence`。

Flow 不得包含以下动作或意图：

- 清除应用数据或缓存。
- 卸载应用。
- 真实支付、扣款或下单。
- 删除真实内容或资料。
- 发布内容。
- 修改真实账号资料。
- 其他不可逆或影响生产数据的操作。

## 5. 平台覆盖规范

通用版本：

```text
flows/preconditions/enter-creation-page/flow.json
```

```json
{
  "name": "进入创作页",
  "platform": "universal"
}
```

Android 覆盖版本：

```text
flows/preconditions/enter-creation-page/android/flow.json
```

```json
{
  "name": "进入创作页",
  "platform": "android"
}
```

平台覆盖可以修改：

- `id`。
- `startCondition`。
- `endCondition`。
- `steps`。
- 引用的 assets。

平台覆盖不能修改 `name` 和 `usage`。

平台版本的 `referenceImage` 相对于平台目录。例如：

```text
android/flow.json 中的 "referenceImage": "assets/start.png"
```

实际对应：

```text
flows/preconditions/enter-creation-page/android/assets/start.png
```

## 6. 完整交付示例

```text
flows/preconditions/enter-search-page/
  flow.json
  assets/
    start.png
    end.png
  ios/
    flow.json
    assets/
      start.png
      end.png
```

通用 `flow.json`：

```json
{
  "schemaVersion": 2,
  "id": "flow-enter-search-page",
  "name": "进入搜索页",
  "usage": "precondition",
  "platform": "universal",
  "startCondition": {
    "description": "当前位于首页，页面顶部展示搜索入口",
    "referenceImage": "assets/start.png"
  },
  "endCondition": {
    "description": "当前位于搜索页，页面顶部展示搜索输入框和取消按钮",
    "referenceImage": "assets/end.png"
  },
  "steps": [
    {
      "id": "flow-step-001",
      "instruction": "点击首页顶部的搜索入口",
      "action": {
        "type": "tap",
        "target": "首页顶部搜索入口"
      }
    }
  ]
}
```

iOS `flow.json`：

```json
{
  "schemaVersion": 2,
  "id": "flow-enter-search-page-ios",
  "name": "进入搜索页",
  "usage": "precondition",
  "platform": "ios",
  "startCondition": {
    "description": "当前位于 iOS 首页，导航栏右侧展示放大镜图标",
    "referenceImage": "assets/start.png"
  },
  "endCondition": {
    "description": "当前位于 iOS 搜索页，导航栏展示搜索输入框和 Cancel 按钮",
    "referenceImage": "assets/end.png"
  },
  "steps": [
    {
      "id": "flow-step-001",
      "instruction": "点击导航栏右侧的放大镜图标",
      "action": {
        "type": "tap",
        "target": "导航栏右侧放大镜图标"
      }
    }
  ]
}
```

## 7. 不应交付的文件和字段

不要生成：

- `status` 字段。
- `state.json`。
- `recordings/` 目录。
- 录制 timeline、录制截图或录制会话 ID。
- `preconditionPlanSha` 或 `flowSha1`。
- case `preconditionId` 或 `stepId`。
- execution、observation、actionResult、result 或 metrics。
- 设备 ID、App ID、Bundle ID 或启动入口。

这些信息属于测试执行阶段，由 `mobile-ai-visual-test` 在具体 case、平台和设备确定后生成。

可以额外交付供人工阅读的说明文件，但测试框架只读取 `flow.json` 及其显式引用的参考资产。

## 8. 交付前验收清单

### 8.1 文件检查

- [ ] 一个逻辑 Flow 使用一个独立业务目录。
- [ ] 通用版本位于 `<business>/flow.json`，没有 `universal/` 目录。
- [ ] 平台版本位于 `<business>/<platform>/flow.json`。
- [ ] 所有 `referenceImage` 文件真实存在。
- [ ] `referenceImage` 使用安全相对路径，没有绝对路径或 `..`。

### 8.2 内容检查

- [ ] `schemaVersion` 为 `2`。
- [ ] `usage` 为 `precondition`。
- [ ] `platform` 与文件目录一致。
- [ ] `name` 与目标用例前置条件完全一致。
- [ ] 同一平台下不存在其他同名 Flow。
- [ ] 平台版本和通用版本的 `name` 完全一致。
- [ ] 起点和终点都可观察、可判断且能够区分。
- [ ] `steps` 至少一个且不超过 5 个。
- [ ] 每个 step 的 `id` 唯一，每个 step 只有一个原子动作。
- [ ] 动作类型在支持列表内。
- [ ] 不包含破坏性或不可逆操作。

### 8.3 本地校验

如果可以访问 `mobile-ai-visual-test` 仓库，可针对每个平台加载并校验资产：

```bash
node scripts/flow/load-precondition-flows.js \
  --cwd <workspace> \
  --platform harmony

node scripts/flow/load-precondition-flows.js \
  --cwd <workspace> \
  --platform android

node scripts/flow/load-precondition-flows.js \
  --cwd <workspace> \
  --platform ios
```

命令必须成功退出，并且输出中应包含交付 Flow 的 `flowId`、`name`、`flowPath` 和 `flowSha1`。任何格式错误、平台不一致、重名、缺失参考图或不安全动作都必须在交付前修复。

## 9. 交付说明模板

交付文件时，同时提供下面的信息：

```text
Flow 名称：进入创作页
Flow ID：flow-enter-creation-page
用途：precondition
适用平台：universal / android
业务目录：flows/preconditions/enter-creation-page/
固定起点：首页展示底部创作入口
固定终点：创作页展示创作标题和工具区
动作数量：1
参考资产：assets/start.png、assets/end.png
已完成校验：harmony、android、ios
```

如果某个平台没有通用或专用实现，需要在交付说明中明确指出。

# 输入模板

> 人写 `test-sources/*.md`，Agent 编译成 `test-plans/*.yaml`。一个 YAML = 一个用例。

## 人类源文件格式

`test-sources/*.md` 格式可以宽松，推荐包含页面、前置、操作、预期：

```markdown
# 登录页错误密码

页面：accountLoginPage

前置：
- 未登录状态
- 已进入登录页

操作：
1. 输入账号 wrong_user
2. 输入密码 wrong_pass
3. 勾选协议
4. 点击登录

预期：
- 不跳转到首页
- 出现账号或密码错误提示
```

用户也可以直接用自然语言描述用例；case-gen 会先规范化写入 `test-sources/<slug>.md`，再生成 YAML。

## Agent 输出 YAML

新生成的 YAML 使用 `schemaVersion: 2`：

```yaml
schemaVersion: 2
caseId: account-login-error-password

description: |
  测试登录页错误密码场景。
  验证错误密码时无法登录并出现错误提示。

target: accountLoginPage

source: test-sources/account-login-error-password.md
sourceHash: sha256:...

navigation:
  - deeplink: codemao://lunar/accountLogin

precondition:
  - type: pageState
    text: 未登录状态
    verifyBy: ui
  - type: pageState
    text: 已进入 accountLoginPage
    verifyBy: ui

steps:
  - action:
      kind: inputText
      targetRole: 账号输入框
      text: wrong_user
    assert:
      - type: componentEnabled
        targetRole: 登录按钮
  - action:
      kind: inputText
      targetRole: 密码输入框
      text: wrong_pass
  - action:
      kind: click
      targetRole: 协议勾选框
  - action:
      kind: click
      targetRole: 登录按钮
    assert:
      - type: textAbsent
        value: 首页
      - type: toastPresent
        value: 账号或密码错误
```

## 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `schemaVersion` | 是 | 新格式固定为 `2`；缺失时 runner / script-gen 按旧 YAML 兼容解析 |
| `caseId` | 是 | 稳定唯一用例 ID，用于 `test-records.json`、success-path 和脚本生成定位 |
| `description` | 是 | 用例说明，Agent 自动填入测试目标、页面路由、设备信息 |
| `target` | 是 | 目标页面名，对应 `CONTEXT.md ## 路由表` 中的 key |
| `source` | 是 | 来源 `test-sources/*.md` 路径 |
| `sourceHash` | 是 | `sha256:` + 来源文件原始字节 sha256，用于判断源用例是否已变化 |
| `navigation` | 是 | 导航序列，按数组顺序执行 |
| `precondition` | 否 | 用例开始前必须满足的状态；优先写 UI 可验证条件 |
| `steps` | 是 | 操作步骤列表 |
| `steps[].action` | 是 | 结构化逻辑操作，不写 selector / index / 坐标 |
| `steps[].assert` | 否 | 结构化断言对象或对象数组 |
| `steps[].assert[].type` | 有 assert 时必填 | 断言类型，取 `textPresent/textAbsent/pageChanged/pageAnchorsPresent/componentEnabled/toastPresent/naturalLanguage` |

## navigation 写法

```yaml
navigation:
  - deeplink: codemao://lunar/accountLogin
```

```yaml
navigation:
  - click: 点击底部 Tab "我的"
    target: 我的
  - click: 点击入口 "登录"
    target: 登录
```

`navigation[].target` 只是可见文本提示，不是强 selector。

## action 语法

| action.kind | 必填字段 | 含义 |
|-------------|----------|------|
| `click` | `targetRole` | 点击某个语义控件 |
| `inputText` | `targetRole`, `text` | 向输入框输入文本 |
| `clearText` | `targetRole` | 清空输入框 |
| `swipe` | `targetRole`, `direction` | 对滚动区域滑动，`direction` 为 `up/down/left/right` |
| `wait` | `durationMs` | 等待固定毫秒数 |
| `closePopup` | `targetRole` | 关闭弹窗或遮挡 |

## assert 语法

| assert.type | 字段 | 含义 |
|-------------|------|------|
| `textPresent` | `value` | 控件树中存在指定文本 |
| `textAbsent` | `value` | 控件树中不存在指定文本 |
| `pageChanged` | `from` / `to` 可选 | 页面发生跳转或页面锚点变化 |
| `pageAnchorsPresent` | `values` | 页面稳定锚点均存在 |
| `componentEnabled` | `targetRole` | 指定语义控件可点击 / enabled |
| `toastPresent` | `value` | 出现指定 Toast 或短暂提示 |
| `naturalLanguage` | `text` | 难以结构化的断言，由执行 Agent 结合源码和实时 UI 判断 |

## 边界约定

- YAML 只表达测试意图，不记录强执行细节。
- 不在 YAML 中写入 id、index、坐标或完整 selector。
- 页面级控件定位、状态规律、弹窗处理、已验证修正和失败尝试记录写入 `explorations/<page>/exploration.md`。
- Agent 执行时读取 YAML 意图 + exploration 经验 + success-path + 实时 dumpLayout，并在遇阻时读源码判断。
- 旧 YAML 缺少 `schemaVersion` 时仍可执行，但新生成用例必须使用 v2。

## 校验规则

- [ ] 有 `schemaVersion: 2`
- [ ] 有稳定唯一 `caseId`
- [ ] 有 `source` 和 `sourceHash`
- [ ] 有 `description` 且非空
- [ ] 有 `target` 且非空
- [ ] 有 `navigation` 非空数组，每项为 `deeplink:` 或 `click:`
- [ ] 有 `steps` 非空数组
- [ ] 每个 step 有 `action.kind`
- [ ] `action.kind` 只取 `click/inputText/clearText/swipe/wait/closePopup`
- [ ] `assert` 为对象或对象数组

# 用例格式

## Markdown 输入

只要求以下两个章节：

```markdown
# 登录成功

## 前置条件
- App 已安装。
- 已登录，手机号 13800000000，验证码 123456。

## 步骤
1. 打开 App。
2. 点击「我的」。
3. 预期看到昵称「测试用户」。
```

步骤可以是操作，也可以是断言。断言常见关键词包括：`预期`、`应该`、`看到`、`显示`、`不存在`、`进入`、`确认`。

## case.json

`case.json` 是执行契约：

```json
{
  "schemaVersion": 1,
  "identity": {
    "caseNo": "C001",
    "caseKey": "ck-xxxxxxxxxxxx",
    "title": "登录成功",
    "importSource": "/abs/path/cases/login.md",
    "sourceSnapshot": "source.md",
    "sourceSha1": "source-xxxxxxxxxxxx",
    "sourceUpdatedAt": "2026-06-16T18:00:00+08:00"
  },
  "preconditions": [],
  "steps": [],
  "globalRules": []
}
```

## caseNo 与目录

`caseNo` 是人和 agent 沟通用的短编号，格式为 `C001`、`C002`。它一旦生成就保持稳定，不随标题变化，不复用已删除编号。

用例目录同步体现编号：

```text
ai-visual-test/cases/C001__登录成功__ck-xxxxxxxxxxxx/
```

定位约定：

- 对话、执行、查看报告优先引用 `caseNo`，例如“执行 C001”。
- `caseKey` 仍是内部稳定键，用于识别同一个导入来源。
- 标题可以用于模糊定位，但命中多个 case 时必须让用户改用 `caseNo`。

相关脚本：

```bash
scripts/resolve-execution-targets.js C001 --cwd <workspace-cwd>
scripts/assign-case-nos.js
scripts/resolve-case-ref.js C001
scripts/resolve-case-ref.js ck-xxxxxxxxxxxx
scripts/resolve-case-ref.js "登录成功"
```

正式执行入口优先使用 `resolve-execution-targets.js`；`resolve-case-ref.js` 只负责定位单个已有用例。

## globalRules

`globalRules` 是 case-local 的全局规则，只在当前 `case.json` 对应的 execution 内生效；不同 case 的 `globalRules` 不共享、不合并。

它用于稳定性和干扰处理，不用于改写主业务路径。适合放入：

- 系统权限弹窗、升级弹窗、公告弹窗等已知干扰处理。
- 页面加载、短暂空白、弱网提示等等待或阻塞策略。
- 目标 App 离开前台后的安全恢复策略。

不适合放入：

- 登录、下单、购买、创建数据等业务流程分支。
- 清数据、卸载、支付、删除、发布、修改真实资料等破坏性操作。
- 需要猜测账号、密码、验证码或业务数据的准备逻辑。

推荐结构：

```json
{
  "id": "rule-001",
  "type": "guard",
  "scope": "system_popup",
  "appliesTo": "any_step",
  "priority": 100,
  "when": "出现权限弹窗",
  "then": {
    "decision": "act",
    "action": {
      "type": "tap",
      "target": "允许"
    }
  },
  "maxAttempts": 1,
  "onFailure": "BLOCKED"
}
```

字段约定：

- `id`：当前 case 内唯一规则 id。
- `type`：规则类型，当前建议只使用 `guard`。
- `scope`：规则适用范围，例如 `system_popup`、`app_foreground`、`loading_state`、`known_interruption`。
- `appliesTo`：适用步骤，使用 `any_step` 或步骤 id 数组，例如 `["step-002"]`。
- `priority`：同一观察命中多个规则时的排序依据，数值越大越优先。
- `when`：由 agent 基于截图、控件树、日志和历史事实判断的命中条件。
- `then`：命中后的建议决策，只能使用安全的结构化动作、`wait` 或 `blocked`。
- `maxAttempts`：当前 execution 内最多命中次数，防止循环处理。
- `onFailure`：规则动作无法完成时的状态，建议使用 `BLOCKED` 或 `UNKNOWN`。

执行约定：

- agent 负责判断 `globalRules` 是否命中；脚本不直接解释 `when`。
- 命中规则时，agent 仍需通过 `scripts/run-case.js --record-json` 记录 `decision`，并通过顶层 `scripts/action.sh` 执行动作。
- 规则命中、跳过、失败等事实应写入 `timeline.jsonl`，报告只从事实记录渲染。
- 如果规则处理会改变主业务路径或业务数据，应停止并记录 `BLOCKED`，不要静默改写用例步骤。

## 源文件变更

当 `source.md` 内容变化导致 `sourceSha1` 变化时：

1. 重新解析 `source.md` 并生成 `case.json`。
2. 重放 `notes.jsonl`；无法匹配的补充标记为 stale，不删除。
3. 追加系统记录并刷新报告。

刷新 `case.json` 时必须保留已有 `globalRules`，除非输入源显式提供新的规则定义；规则变化会影响 `caseContractSha`，旧执行结果不得继续作为当前结果展示。

## 重复导入与执行

- `caseKey` 来自外部导入路径，用于定位同一个用例空间。
- 外部文件移动、删除或修改，不影响已有用例空间；默认执行依据是 `source.md`。
- 重复执行同一用例时读取最新 `case.json`、`notes.jsonl`、已确认环境和当前 `source.md` 版本，从第 1 步完整重跑。
- 新执行写入新的 `executions/<executionId>/`，并记录当前 `sourceSha1`。
- 新执行写入新的 `executions/<executionId>/`，并记录当前 `caseContractSha`。
- 只有显式 `--refresh-from-input` 才用外部 Markdown 覆盖 `source.md`。

## source.md 变更

用户告知已调整 `source.md` 后，执行：

```bash
scripts/refresh-case.js <case-dir>
```

用户在对话中补充时，使用：

```bash
scripts/apply-note.js <case-dir> --text <note> [--applies-to <step-id>]
```

## 补充重放

按以下顺序匹配补充：

1. 同一步骤 id 且步骤原文仍一致。
2. 相似步骤原文。
3. 相同目标文案或动作类型。
4. 前后相邻步骤。

如果补充指向已删除的测试数据、断言或步骤，标记为 stale，不再应用。

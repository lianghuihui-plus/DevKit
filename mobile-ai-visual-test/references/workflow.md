# 工作流

## 范围

基于 Markdown 人工用例执行移动端 AI 黑盒视觉测试；不生成原生自动化测试代码，不做坐标录制回放。

当前平台状态：

- `harmony`：已实现，使用 `hdc` 和设备端 `uitest`。
- `android`：已预留适配器接口，尚未实现。
- `ios`：已预留适配器接口，尚未实现。

## 用户输入

新导入接受 Markdown 用例路径；已有用例优先使用 `caseNo` 引用：

- 单文件：`cases/login.md`
- 多文件：`cases/login.md cases/register.md`
- 目录：`cases/`
- 已有用例：`C001`，通过 `scripts/resolve-case-ref.js C001` 定位

执行入口必须先用统一分流脚本处理输入：

```bash
scripts/resolve-execution-targets.js <case-ref|case.md|dir> [...] --cwd <workspace-cwd>
```

输出中的 `existingCases[].caseDir` 可直接执行；`markdownFiles[]` 需要再导入或刷新。
相对 Markdown 文件或目录路径按 `<workspace-cwd>` 解析，不按 skill 仓库目录或 shell 当前目录解析。

目录扫描包含 `*.md`，排除 `README.md`、`_*.md`、隐藏目录和 `ai-visual-test/`。

## 用例空间

产物创建在当前执行目录下：

```text
ai-visual-test/
└── cases/
    └── C001__<title-slug>__<caseKey>/
        ├── CONTEXT.md
        ├── source.md
        ├── case.json
        ├── notes.jsonl
        ├── state.json
        └── executions/
            └── <executionId>/
                ├── timeline.jsonl
                ├── result.json
                ├── metrics.json
                ├── screenshots/
                ├── layouts/
                └── logs/
```

`source.md` 是稳定输入源；外部 Markdown 后续变化不会覆盖它，除非显式重新导入。

## 执行阶段

1. 用 `scripts/resolve-execution-targets.js` 分流输入。
2. 对 `markdownFiles[]` 解析外部 Markdown 文件并导入为 `source.md`；对 `existingCases[]` 默认直接读取已有 `source.md` 和 `case.json`。
3. 解析或刷新 `case.json`。
4. 探测平台环境，并让用户确认平台、设备、应用标识、启动入口和核心能力。
5. 用户确认后，用 `scripts/update-env.js` 固化环境。
6. 进入无人值守执行阶段。
7. 对输入中的每个用例按顺序独立闭环执行；当前 case 未 finalize 前，不开始下一个 case。
8. 每个用例先 `scripts/run-case.js <case-dir> --start` 创建 execution。
9. 在当前 execution 中写入业务步骤前，调用 `scripts/flow/list-flows.js --cwd <workspace-cwd>` 读取所有 READY Flow 的 `name`、`intent`、`steps`、`successHints`，并写入 `flowScan` 事实。
10. 检查平台级前置条件；业务级前置条件仅作为 agent 判断上下文，不做通用自动准备。
11. 从第 1 步完整执行所有步骤。
12. 每个步骤执行前先判断是否需要业务导航 Flow；匹配到 Flow 时先参考 Flow 进入目标业务状态，并写入 `flow` 事实事件。
13. 按 `observe -> perceive -> match-flow -> decide -> act/assert -> observe -> verify -> record` 循环。
14. 观察和动作必须走 execution-bound 入口；入口会先检查预算、执行平台 adapter、再自动写入 `timeline.jsonl`。
15. Perception、Decision、Flow、Assertion 等 agent 事实用 `scripts/run-case.js <case-dir> --record-json <json>` 写入 `timeline.jsonl`。
16. 当前用例操作链路结束后，必须立即完成断言、用 `scripts/run-case.js <case-dir> --finalize --status <status>` 聚合生成 `result.json` 和 `metrics.json`，并刷新该用例报告。
17. 当前用例完成 finalize 后，才能进入下一个用例；批量总览可在每个 case 各自 finalize 后再次刷新。

执行开始时先创建 execution：

```bash
scripts/run-case.js <case-dir> --start
```

创建 execution 后 Flow 扫描：

```bash
scripts/flow/list-flows.js --cwd <workspace-cwd>
```

agent 必须使用脚本输出的候选 Flow 内容，而不是自己拼 `find`；若不存在 flows 目录或没有 READY Flow，应在当前 execution 写入 `flowScan` 事实，`status` 使用 `EMPTY`。

执行中的观察和动作示例：

```bash
scripts/observe.sh --case-dir <case-dir> --execution-id <executionId> --platform <platform> --out <case-dir>/executions/<executionId> --label step-001-before
scripts/action.sh --case-dir <case-dir> --execution-id <executionId> --step-id step-001 --platform <platform> --type launchApp --app <appId> --entry <entry>
```

execution-bound observe 会自动把 label 写成 `<seq>-<label>`，例如 `001-step-001-before`。

## 设备命令边界

- 用例执行期间禁止直接调用 `hdc shell aa force-stop`、`hdc shell aa start`、截图、布局 dump、点击或输入等设备命令绕过框架入口。
- 会改变 App 状态的操作必须通过 `scripts/action.sh --case-dir <case-dir> --execution-id <executionId> ...` 执行。
- 会产生截图、布局或日志证据的观察必须通过 `scripts/observe.sh --case-dir <case-dir> --execution-id <executionId> ...` 执行。
- 平台探测或非交互事实必须通过 `scripts/run-case.js <case-dir> --record-json <json>` 写入当前 execution。
- 这样才能保证预算检查、`timeline.jsonl`、`startedAt/endedAt`、截图证据和报告时间一致。

## 批量执行边界

- 批量执行不是“先跑完所有 case，再统一判定”；它只是把多个单用例闭环按顺序执行。
- 禁止为多个 case 同时创建未 finalized 的 execution。
- 禁止把多个 case 的最终截图先放入待判定队列，再批量写 assertion 或批量 finalize。
- 每个 case 的 `endedAt` 应接近该 case 最后一次断言或操作链路结束时间；`durationMs` 不应包含等待其他 case 执行、统一判图或批量收尾的时间。
- 如果需要统一查看批量结果，只能在所有 case 都已各自生成 `result.json`、`metrics.json` 和 `CONTEXT.md` 之后查看或重新渲染 `index.html`。

## 前置条件边界

- 平台级前置条件可以标准化检查，例如设备连接、截图能力、控件树能力、目标 App 启动能力和已确认环境。
- 业务级前置条件不做通用自动准备，例如登录态、账号数据、订单状态、权限首次弹窗或特定业务数据。
- 业务级前置条件由 agent 结合用户补充、页面证据和用例上下文保守判断；证据不足时记录为 `BLOCKED`、`PRECONDITION_UNKNOWN` 或 `PRECONDITION_UNSUPPORTED`。
- 不为了满足前置条件静默执行清数据、卸载、支付、删除、发布、修改真实资料等破坏性操作。

## 环境确认

- 一个请求只确认一次环境；批量用例共用确认结果。
- 确认后直到本次请求结束不再提问；无法处理的问题写入报告。
- 每个用例独立创建 execution、检查平台级前置条件并生成结果。

## 用户补充

用户在对话中补充信息时，使用 `scripts/apply-note.js` 追加 `notes.jsonl`，重新应用到 `case.json`，并刷新 `CONTEXT.md`。

用户表示已调整 `source.md` 时，由 agent 执行：

```bash
scripts/refresh-case.js <case-dir>
```

不要要求用户手动执行脚本。

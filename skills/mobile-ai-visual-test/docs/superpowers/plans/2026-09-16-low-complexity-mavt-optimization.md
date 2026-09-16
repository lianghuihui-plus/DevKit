# Low-Complexity MAVT Reliability Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 MAVT 执行入口、环境确认、等待状态和结果收敛中的高风险问题，同时保持现有 Agent 执行模型和通信协议不变。

**Architecture:** 继续使用现有 Coordinator Facade、Batch 状态文件、Case Runtime 事件日志和 reconcile 流程；所有新增信息都作为现有响应或持久化状态的可选字段，不新增 Agent、后台服务、消息队列或独立监控进程。Android IME 继续完全封装在 Runtime/Adapter 内部，只作为初始化门禁和 Runtime 技术事实存在。

**Tech Stack:** Node.js、Bash、JSON/JSONL、现有 `scripts/*` CLI、Node `assert` 测试。

**Spec:** 本文档即本次低复杂度优化的设计与实施规格；不另建设计协议，避免产生第二套事实源。

**Implementation status (2026-09-16):** 六个阶段均已实现。实施保持最小改动：Workspace 响应同时提供可重新校验工作区的绝对 `command` 和已绑定工作区的绝对 `prepareUsage`；等待进度由 Batch reconcile 从既有 execution/runtime/event/dispatch 文件投影，Coordinator 只透传；已 finalized execution 的提交和单批次串行约束沿用既有状态机与测试，不新增状态；知识闭环只在既有缺失项中附加 `queryIds`。Android 输入能力的自动准备、通用错误映射和 ExecutionRequest 前门禁已存在，本次只补齐上层契约与文档约束。

## Global Constraints

- Agent-facing 命令仍只有 `prepare`、`confirm`、`advance`、`cancel`。
- Case Agent 仍只使用现有 Case Runtime 能力，不读取或操作 IME、Batch、Execution 和报告内部文件。
- 不增加新的 Agent 角色、Agent 间通信通道、后台 watchdog、数据库或外部依赖。
- 不改变现有 verdict 枚举：`PASS`、`FAIL`、`INCONCLUSIVE`、`BLOCKED`。
- 不把账号密码写入 case snapshot、execution、事件或报告；凭据问题只通过前置条件和技术事实表达。
- 所有新增字段必须可选，旧状态文件和旧 Agent 响应仍可被读取。

---

### Task 1: 修正技能入口与工作区路径说明

**Files:**
- Modify: `SKILL.md:14-30`
- Modify: `references/interfaces.md:3-16`
- Modify: `scripts/workspace.js:16-25`
- Test: `scripts/tests/formal-entrypoints.test.js`

**Interfaces:**
- Consumes: 现有 `ensureWorkspace()` 结果和 `SKILL_ROOT`。
- Produces: `coordinatorFacade` 中可重新校验工作区的绝对 `command`，以及已绑定工作区的绝对 `prepareUsage`；保留现有相对 `entrypoint` 兼容字段。

- [x] **Step 1: Write the failing test**

在 `formal-entrypoints.test.js` 增加断言：`coordinatorFacade.command` 使用绝对技能脚本路径，且 `--cwd` 指向传入的工作区；从非技能目录执行该命令仍能成功。再从测试工作区执行填入真实用例编号的 `coordinatorFacade.prepareUsage`，确认 Facade 能正常进入 `NEED_USER_CONFIRMATION`。

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/formal-entrypoints.test.js`

Expected: FAIL，因为当前 `workspace.js` 只返回相对 `entrypoint` 和包含 `<workspace>` 的相对用法字符串。

- [x] **Step 3: Write minimal implementation**

在 `workspace.js` 中使用 `path.resolve(__dirname, 'workspace.js')` 和 `process.execPath` 生成可执行命令，例如：

```js
const workspaceCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(__dirname, 'workspace.js'))} --cwd ${JSON.stringify(result.root)}`;
```

将该命令放入 Facade 的新可选字段 `command`；同时用绝对 `coordinator-agent.js` 路径和当前工作区生成 `prepareUsage`。文档明确“脚本从技能根目录执行，`--cwd` 是测试工作区”。不修改 Case Agent 或 Coordinator 的调用数量。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/formal-entrypoints.test.js`

Expected: PASS。

- [x] **Step 5: Prepare commit scope (not executed)**

```bash
git add SKILL.md references/interfaces.md scripts/workspace.js scripts/tests/formal-entrypoints.test.js
git commit -m "fix(mavt): make workspace entrypoint executable from any cwd"
```

### Task 2: 让环境确认模板明确区分自动探测值和用户必填值

**Files:**
- Modify: `scripts/coordinator/agent-facing-service.js:480-550`
- Modify: `scripts/lib/run-control.js:500-575`
- Test: `scripts/tests/coordinator-agent-facing.test.js`

**Interfaces:**
- Consumes: 当前平台探测结果和现有 `confirmTemplate`。
- Produces: 原有 `confirmTemplate`，附加可选 `requiredUserFields`；未填写的尖括号占位符被明确拒绝。

- [x] **Step 1: Write the failing test**

增加两个断言：

```js
assert.deepStrictEqual(needBinding.requiredUserFields, ['binding.appId', 'binding.entry']);
assert.throws(() => confirmEnvironment({
  workspaceRoot,
  binding: { platform: 'android', deviceId: 'd', appId: '<target-app-id>', entry: '<entry-ability>' },
  probe: androidProbe,
  userConfirmation: '确认环境',
}));
```

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/coordinator-agent-facing.test.js`

Expected: FAIL，因为当前模板没有字段来源提示，且占位符只是普通非空字符串。

- [x] **Step 3: Write minimal implementation**

保留完整 `confirmTemplate`（包括现有 `userInstruction`），只新增 `requiredUserFields` 元数据。在 `run-control.confirmEnvironment()` 的最终确认入口增加局部占位符检查，拒绝形如 `<...>` 的 `appId`/`entry`，不改变全局 `validateBinding()` 对历史状态和内部示例的兼容性。Android 探测只提供候选前台 App 信息，不自动冻结目标 App。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/coordinator-agent-facing.test.js`

Expected: PASS。

- [x] **Step 5: Prepare commit scope (not executed)**

```bash
git add scripts/coordinator/agent-facing-service.js scripts/lib/run-control.js scripts/tests/coordinator-agent-facing.test.js
git commit -m "fix(mavt): clarify environment confirmation fields"
```

### Task 3: 在现有 WAITING 响应中投影执行进度

**Files:**
- Modify: `scripts/coordinator/agent-facing-service.js:635-689`
- Modify: `scripts/batch/reconcile-service.js:23-45,150-180`
- Test: `scripts/tests/batch-reconcile.test.js`
- Test: `scripts/tests/coordinator-agent-facing.test.js`

**Interfaces:**
- Consumes: 现有 `batchId`、`caseKey`、`executionId`、`execution.json`、`runtime.json`、`events.jsonl` 和 `dispatch-state.json`。
- Produces: `WAITING` 响应中的可选 `progress` 对象；不新增命令，不要求 Agent 发送 heartbeat。

- [x] **Step 1: Write the failing test**

构造一个 `WAIT_EXECUTION_RESULT` fixture，断言响应包含：`caseNo`、`caseKey`、`executionId`、`executionPhase`、`lastEventType`、`lastEventAt` 和 `resultArtifacts`。

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/coordinator-agent-facing.test.js`

Expected: FAIL，因为当前 Coordinator 只返回 `waitFor` 和 `reason`。

- [x] **Step 3: Write minimal implementation**

在 Batch reconcile 层增加一个纯读取函数，读取当前 case 的 execution 状态和事件日志最后一条事件；Coordinator 把结果附加到现有 `WAITING` 响应。状态只做投影，不改变 Batch 状态，不启动后台轮询，不判断宿主进程是否存活。

推荐字段：

```json
{
  "caseNo": "021",
  "caseKey": "...",
  "executionId": "...",
  "progress": {
    "executionPhase": "HANDOFF_CONSUMED",
    "lastEventType": "actionOutcomeUnknown",
    "lastEventAt": "...",
    "resultArtifacts": { "result": false, "metrics": false, "executionFinalized": false, "runtimeCompleted": false }
  }
}
```

`HANDOFF_CONSUMED` 只表示既有 handoff 已被领取；框架没有宿主 Agent 运行句柄，因此不得把它命名为 `CASE_AGENT_RUNNING`。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/coordinator-agent-facing.test.js`

Expected: PASS。

- [x] **Step 5: Prepare commit scope (not executed)**

```bash
git add scripts/batch/reconcile-service.js scripts/coordinator/agent-facing-service.js scripts/tests/batch-reconcile.test.js scripts/tests/coordinator-agent-facing.test.js
git commit -m "feat(mavt): expose persisted progress while waiting"
```

### Task 4: 收紧结果收敛和单用例串行验证

**Files:**
- Verify: `scripts/batch/reconcile-service.js:110-180`
- Test: `scripts/tests/batch-reconcile.test.js`
- Test: `scripts/tests/batch-cancellation.test.js`

**Interfaces:**
- Consumes: 现有 `reconcileExecution()`、`execution.finalized`、`runtime.status` 和 Batch case 状态。
- Produces: 现有 `COMMIT_CASE`、`WAIT_EXECUTION_RESULT`、`BATCH_ACTIVE_EXECUTION_CONFLICT` 动作；不新增执行状态。

- [x] **Step 1: Verify existing invariant coverage**

核对既有测试已覆盖两个场景；若缺失才补测试：

```js
// 完整 finish 产物存在时，reconcile 必须返回 COMMIT_CASE。
assert.strictEqual(reconciled.action, 'COMMIT_CASE');

// 同一批次出现两个未 finalized execution 时，必须返回冲突并停止推进。
assert.strictEqual(conflict.action, 'BATCH_BLOCKED');
```

- [x] **Step 2: Run the targeted invariant tests**

Run: `node scripts/tests/batch-reconcile.test.js && node scripts/tests/batch-cancellation.test.js`

Expected: 既有实现和测试已保证终态提交与单用例串行，不需要新增状态或分支。

- [x] **Step 3: Keep the existing state machine unchanged**

保持现有顺序：先 `reconcileExecution()`，再读取 `execution.json`。当 `execution.finalized=true` 且完成产物可校验时沿用 `COMMIT_CASE`；仅有 `runtime=COMPLETED` 而 Execution 未 finalized 时继续等待，并在 `progress.resultArtifacts` 中显示差异。不得通过读取结果文件直接跳过 Runtime finalize。

保留并测试现有“最多一个 RUNNING case”和“后续 case 必须 PENDING”约束；不在 Batch 内引入并发调度。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/batch-reconcile.test.js && node scripts/tests/batch-cancellation.test.js`

Expected: PASS。

- [x] **Step 5: Record the no-new-state decision**

本阶段不产生独立代码提交；等待进度差异由 Task 3 的可选 `progress.resultArtifacts` 表达。

### Task 5: 降低知识闭环和 verdict 误用，不扩展 Agent 协议

**Files:**
- Modify: `scripts/case-runtime/result-integrity.js:140-165`
- Modify: `prompts/case-agent.md:37-41,47-51`
- Test: `scripts/tests/knowledge-closure.test.js`

**Interfaces:**
- Consumes: 现有 `CASE_RESULT_INCOMPLETE.missing`、`knowledgeInvestigation` 和 `technicalRefs`。
- Produces: 相同 Runtime 能力和 verdict 枚举，仅让错误响应更容易恢复。

- [x] **Step 1: Write the failing test**

当 E2 缺少知识 review 时，断言 `RESULT_INCOMPLETE.missing` 同时包含已有的关联 `queryIds`；当技术事实被用于非 `BLOCKED` check 时，继续沿用既有校验拒绝。

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/knowledge-closure.test.js`

Expected: FAIL，因为当前缺失项只有字段名和原因。

- [x] **Step 3: Write minimal implementation**

只增强错误响应和 Agent Prompt：从已有 knowledge event 找到关联 query，在 `missing` 中附加可选 `queryIds`；既有 Runtime 错误响应继续提供下一步调用信息，不新增 `reviewKnowledge` 之外的调用，不自动替 Agent 做知识适用性判断。

明确规则：技术输入失败若有有效 Runtime technical fact，使用 `BLOCKED + technicalRefs`；仅因证据或业务前置条件不足时使用 `INCONCLUSIVE`，并完成必要的知识调查。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/knowledge-closure.test.js`

Expected: PASS。

- [x] **Step 5: Prepare commit scope (not executed)**

```bash
git add scripts/case-runtime/result-integrity.js prompts/case-agent.md scripts/tests/knowledge-closure.test.js
git commit -m "fix(mavt): make result closure recovery explicit"
```

### Task 6: 补充非代码前置条件和回归验证

**Files:**
- Modify: `references/installation.md:19-50`
- Modify: `references/failure-policy.md:1-22`
- Modify: `SKILL.md:43-71`
- Test: `scripts/tests/formal-entrypoints.test.js`
- Test: `scripts/tests/coordinator-agent-facing.test.js`
- Test: `scripts/tests/batch-reconcile.test.js`

**Interfaces:**
- Consumes: 已有 Android 环境准备、账号前置条件和等待/恢复规则。
- Produces: 文档化的运行前检查清单；不新增凭据存储、不新增命令。

- [x] **Step 1: Write the failing test**

不新增业务代码测试；先建立文档检查项，确保文档明确：

```text
Android 输入能力由 Coordinator/Runtime 内部自动准备，Agent 不感知具体后端，也不安装/启用/切换输入组件；
账号必须由用户或测试环境预先提供，Agent 不猜测账号；
批量执行必须等待当前 case 终态后再推进。
```

- [x] **Step 2: Run test to verify it fails**

Run: `rg -n "IME|账号|串行|WAIT_EXECUTION_RESULT" SKILL.md references/installation.md references/failure-policy.md`

Expected: 文档中缺少统一、无歧义的前置条件表述。

- [x] **Step 3: Write minimal implementation**

只更新文档，明确 IME 的内部边界和账号的外部前置责任；不把 `androidImeNotReady`、IME 包名或平台命令加入 Case Agent Prompt。

- [x] **Step 4: Run full regression**

Run: `node scripts/self-test.js && git diff --check`

Expected: 所有现有测试 PASS，且没有空白/格式错误。

- [x] **Step 5: Prepare commit scope (not executed)**

```bash
git add SKILL.md references/installation.md references/failure-policy.md scripts/tests
git commit -m "docs(mavt): clarify low-complexity execution prerequisites"
```

## Explicitly Out Of Scope

- 不新增 Case Agent 心跳协议；进度从现有事件日志投影。
- 不新增 Coordinator 后台 watchdog；长时间无进展只在下一次 `advanceRun` 或现有宿主等待逻辑中被识别。
- 不让 Case Agent 读取 `dispatch-state.json`、Batch 状态或 IME 状态。
- 不自动探测并选择目标 App，不自动尝试账号，不自动重放输入动作。
- 不把 `screen:back` 之类平台特定动作加入统一 Agent 协议；继续使用现有 `back` 能力并要求观察确认效果。

## Completion Criteria

- 从测试工作区目录执行时，不再因为相对 `scripts/workspace.js` 路径失败。
- Android IME 未就绪时，流程在初始化阶段停止，Case Agent 不会看到 IME 细节。
- `WAITING` 至少能指出当前 case、execution 和最后持久化事件。
- 已 finalized 的 execution 能被 reconcile 推进到 `COMMIT_CASE`；未 finalized 的运行不会被误判为完成。
- 同一批次不会同时拥有两个 `RUNNING` case。
- 知识调查、技术阻塞、证据不足和业务失败在现有 verdict 模型下保持可解释。
- `node scripts/self-test.js` 和 `git diff --check` 通过。

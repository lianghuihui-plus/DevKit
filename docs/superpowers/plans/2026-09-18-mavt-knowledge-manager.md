# MAVT 知识库管理 Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可独立运行的 `mavt-knowledge-manager` Skill，提供 MAVT Workspace 知识库的查看、新增、修改、删除和校验能力，并把 MAVT 收敛为知识库只读消费方。

**Architecture:** 新 Skill 使用 Node.js 内置模块实现独立的知识契约解析器、只读 Store、prepare/apply 事务层和单一 CLI 入口；Agent 负责理解任意输入，脚本只负责确定性文件操作。MAVT 保留自己的只读解析、查询和执行前防御性校验，两个 Skill 仅通过 Markdown 知识文件协议互操作，不存在运行时导入或命令调用。

**Tech Stack:** Node.js CommonJS、Node.js 内置 `assert/fs/path/crypto/child_process/os`、Markdown、无第三方依赖。

**Spec:** `docs/superpowers/specs/2026-09-18-mavt-knowledge-manager-design.md`

## 全局约束

- 新 Skill 名称固定为 `mavt-knowledge-manager`，位置固定为 `skills/mavt-knowledge-manager/`。
- 新 Skill 只能操作 `schemaVersion=1`、`type=mobile-ai-visual-test-workspace`、`initializationState=READY` 的工作空间。
- 输入来源不设格式限制，来源理解全部由 Agent 完成，确定性脚本不实现来源解析器。
- 新 Skill 和 MAVT 不得在运行时互相导入、调用或要求对方已安装。
- 正式知识写入只能发生在 `<workspace>/knowledge/`，符号链接和目录逃逸必须拒绝。
- `ADD/UPDATE/DELETE` 必须经过 `prepare` 和带 `planHash` 的 `apply`，提交前校验预期最终状态。
- 已授权的新增和修改直接落盘；删除必须来自用户明确的删除意图。
- 更新和删除必须生成可恢复备份，失败时恢复原状态。
- MAVT 的知识查询、复核、快照和结果引用行为不得改变。
- 开发期间不得把 worktree 中的新 Skill 链接到任何正在使用的 Codex Skill 目录。

---

### Task 1: 建立独立知识契约与工作空间校验

**Files:**
- Create: `skills/mavt-knowledge-manager/scripts/lib/errors.js`
- Create: `skills/mavt-knowledge-manager/scripts/lib/workspace.js`
- Create: `skills/mavt-knowledge-manager/scripts/lib/knowledge-contract.js`
- Create: `skills/mavt-knowledge-manager/scripts/tests/knowledge-contract.test.js`

**Interfaces:**
- Produces: `KnowledgeManagerError(code, message, details?)`
- Produces: `assertMavtWorkspace(workspacePath) -> { root, marker, knowledgeRoot, maintenanceRoot }`
- Produces: `parseKnowledgeEntry(content, source?) -> KnowledgeEntry`
- Produces: `loadKnowledgeEntries(knowledgeRoot) -> KnowledgeEntry[]`
- Produces: `validateKnowledgeEntries(entries, { now? }) -> { entryCount, expiredCount }`
- Produces: `validateKnowledgeRoot(knowledgeRoot, { now? }) -> { entries, summary, warnings }`

- [x] **Step 1: 写失败测试，固定 Workspace 和知识契约**

测试必须覆盖 READY Workspace、缺少 marker、错误 type、非 READY、合法条目、章节乱序、重复 ID、非法 App ID、非法 Platform、非法 Version、非法日期、缺失冲突引用、自冲突、超大文件和符号链接：

```js
const valid = parseKnowledgeEntry(entry('K-editor-001'));
assert.strictEqual(valid.entryId, 'K-editor-001');
assert.deepStrictEqual(valid.metadata.platform, ['harmony']);
expectCode(() => parseKnowledgeEntry(entry('K-bad-platform', { platform: 'windows' })), 'KNOWLEDGE_ENTRY_INVALID');
expectCode(() => validateKnowledgeRoot(symlinkRoot), 'KNOWLEDGE_PATH_INVALID');
assert.strictEqual(assertMavtWorkspace(workspace).knowledgeRoot, path.join(workspace, 'knowledge'));
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node skills/mavt-knowledge-manager/scripts/tests/knowledge-contract.test.js`

Expected: FAIL，提示 `Cannot find module '../lib/knowledge-contract'`。

- [x] **Step 3: 实现错误、Workspace 和契约模块**

`knowledge-contract.js` 必须独立实现知识格式，不导入 MAVT：

```js
const SECTION_NAMES = Object.freeze(['适用范围', '可观察现象', '结论与处理建议', '追溯信息']);
const PLATFORMS = new Set(['harmony', 'android', 'ios']);
const MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024;

module.exports = {
  MAX_KNOWLEDGE_FILE_BYTES,
  SECTION_NAMES,
  contentSha,
  isExpired,
  loadKnowledgeEntries,
  parseKnowledgeEntry,
  validateKnowledgeEntries,
  validateKnowledgeRoot,
};
```

Version 只接受精确数字版本、末段 `x/*` 通配符或数字范围；Platform 只接受三种平台；每个文件最大 `512 * 1024` 字节。

- [x] **Step 4: 运行契约测试并确认通过**

Run: `node skills/mavt-knowledge-manager/scripts/tests/knowledge-contract.test.js`

Expected: PASS，输出 `knowledge contract passed`。

- [x] **Step 5: 提交契约实现**

```bash
git add skills/mavt-knowledge-manager/scripts/lib skills/mavt-knowledge-manager/scripts/tests/knowledge-contract.test.js
git commit -m "feat(knowledge-manager): add standalone knowledge contract"
```

### Task 2: 实现只读查看与编写质量告警

**Files:**
- Create: `skills/mavt-knowledge-manager/scripts/lib/knowledge-store.js`
- Create: `skills/mavt-knowledge-manager/scripts/tests/knowledge-store.test.js`
- Modify: `skills/mavt-knowledge-manager/scripts/lib/knowledge-contract.js`

**Interfaces:**
- Consumes: `assertMavtWorkspace`, `validateKnowledgeRoot`
- Produces: `inspectKnowledge(workspace, options?) -> InspectionResult`
- Produces: `listKnowledge(workspace, options?) -> { entries }`
- Produces: `showKnowledge(workspace, entryId, options?) -> EntryDetail`
- Produces: `authoringWarnings(entry, { now? }) -> Warning[]`

- [x] **Step 1: 写失败测试，固定 inspect/list/show 和告警格式**

```js
const inspection = inspectKnowledge(workspace, { now: '2026-09-18T00:00:00Z' });
assert.deepStrictEqual(inspection, {
  schemaVersion: 1, status: 'VALID', workspace, entryCount: 2,
  expiredCount: 1, warningCount: inspection.warnings.length, warnings: inspection.warnings,
});
assert.deepStrictEqual(listKnowledge(workspace).entries.map((item) => item.entryId), ['K-a-001', 'K-b-001']);
assert.strictEqual(showKnowledge(workspace, 'K-a-001').contentSha.length, 64);
expectCode(() => showKnowledge(workspace, 'K-missing'), 'KNOWLEDGE_ENTRY_NOT_FOUND');
```

告警对象固定为 `{ code, entryId, field, message }`，覆盖缺失 App/Platform、过期、现象过短、缺少业务辨识词和追溯信息缺少日期。

- [x] **Step 2: 运行测试并确认失败**

Run: `node skills/mavt-knowledge-manager/scripts/tests/knowledge-store.test.js`

Expected: FAIL，提示 `Cannot find module '../lib/knowledge-store'`。

- [x] **Step 3: 实现只读 Store 和告警**

```js
function inspectKnowledge(workspace, options = {}) {
  const { root, knowledgeRoot } = assertMavtWorkspace(workspace);
  const { entries, summary, warnings } = validateKnowledgeRoot(knowledgeRoot, options);
  return { schemaVersion: 1, status: 'VALID', workspace: root, ...summary,
    warningCount: warnings.length, warnings };
}
```

`list` 只返回 ID、标题、相对路径、元数据、SHA、过期状态和告警码；`show` 返回完整内容。排序固定为 `entryId` 的 locale 顺序。

- [x] **Step 4: 运行 Store 和契约测试**

Run: `node skills/mavt-knowledge-manager/scripts/tests/knowledge-store.test.js && node skills/mavt-knowledge-manager/scripts/tests/knowledge-contract.test.js`

Expected: 两个测试均 PASS。

- [x] **Step 5: 提交只读能力**

```bash
git add skills/mavt-knowledge-manager/scripts/lib skills/mavt-knowledge-manager/scripts/tests
git commit -m "feat(knowledge-manager): add inspection operations"
```

### Task 3: 实现 prepare/apply 原子事务和恢复备份

**Files:**
- Create: `skills/mavt-knowledge-manager/scripts/lib/knowledge-transaction.js`
- Create: `skills/mavt-knowledge-manager/scripts/tests/knowledge-transaction.test.js`

**Interfaces:**
- Consumes: `assertMavtWorkspace`, `parseKnowledgeEntry`, `validateKnowledgeEntries`, `loadKnowledgeEntries`
- Produces: `prepareTransaction(workspace, requestPath, options?) -> TransactionPlan`
- Produces: `applyTransaction(workspace, requestPath, planHash, options?) -> TransactionResult`
- Request: `{ schemaVersion: 1, reason: string, operations: Operation[] }`
- Operation: `{ type: 'ADD', draftPath } | { type: 'UPDATE', entryId, draftPath } | { type: 'DELETE', entryId }`

- [x] **Step 1: 写失败测试，覆盖完整事务矩阵**

测试新增、更新、删除、混合事务、重复 ID、修改 ID、不存在目标、存活冲突引用、一次事务内解除引用、过期 plan、备份和注入失败回滚：

```js
const plan = prepareTransaction(workspace, requestPath, { now });
assert.match(plan.planHash, /^[a-f0-9]{64}$/);
assert.deepStrictEqual(plan.changes.map((item) => item.type), ['ADD', 'UPDATE', 'DELETE']);
const result = applyTransaction(workspace, requestPath, plan.planHash, { now });
assert.strictEqual(result.status, 'APPLIED');
assert.ok(fs.existsSync(result.backupPath));
expectCode(() => applyTransaction(workspace, requestPath, plan.planHash), 'KNOWLEDGE_PLAN_STALE');
```

注入失败通过 `options.interruptAfter = 'writes'` 触发，测试必须断言所有原文件内容和目录清单完全恢复。

- [x] **Step 2: 运行事务测试并确认失败**

Run: `node skills/mavt-knowledge-manager/scripts/tests/knowledge-transaction.test.js`

Expected: FAIL，提示 `Cannot find module '../lib/knowledge-transaction'`。

- [x] **Step 3: 实现请求规范化和预期最终状态校验**

```js
function prepareTransaction(workspace, requestPath, options = {}) {
  const request = readAndValidateRequest(requestPath);
  const current = loadKnowledgeEntries(assertMavtWorkspace(workspace).knowledgeRoot);
  const prospective = applyOperationsInMemory(current, request.operations);
  validateKnowledgeEntries(prospective.entries, options);
  return freezePlan({ workspace, request, current, prospective, now: options.now });
}
```

`planHash` 必须覆盖规范化请求、所有现有知识的 `entryId/relativePath/contentSha`、所有 draft 的 SHA 和最终变更集。

- [x] **Step 4: 实现备份、原子提交和失败恢复**

```js
function applyTransaction(workspace, requestPath, planHash, options = {}) {
  const plan = prepareTransaction(workspace, requestPath, options);
  if (plan.planHash !== planHash) {
    throw managerError('KNOWLEDGE_PLAN_STALE', 'knowledge changed after the transaction was prepared');
  }
  const backup = createBackup(plan);
  try {
    commitPlan(plan, options);
    const validation = validateKnowledgeRoot(plan.knowledgeRoot, options);
    return writeTransactionResult(plan, backup, validation);
  } catch (error) {
    restoreBackup(plan, backup);
    throw error;
  }
}
```

新增和替换使用同目录临时文件加 `renameSync`；备份位于 `.mavt/knowledge-maintenance/backups/<transactionId>/`，包含 `request.json`、`plan.json`、`result.json` 和原始文件。

- [x] **Step 5: 运行事务、Store 和契约测试**

Run: `node skills/mavt-knowledge-manager/scripts/tests/knowledge-transaction.test.js && node skills/mavt-knowledge-manager/scripts/tests/knowledge-store.test.js && node skills/mavt-knowledge-manager/scripts/tests/knowledge-contract.test.js`

Expected: 全部 PASS。

- [x] **Step 6: 提交事务能力**

```bash
git add skills/mavt-knowledge-manager/scripts/lib/knowledge-transaction.js skills/mavt-knowledge-manager/scripts/tests/knowledge-transaction.test.js
git commit -m "feat(knowledge-manager): add atomic knowledge transactions"
```

### Task 4: 建立 CLI、结构化错误和独立自测入口

**Files:**
- Create: `skills/mavt-knowledge-manager/scripts/knowledge-manager.js`
- Create: `skills/mavt-knowledge-manager/scripts/self-test.js`
- Create: `skills/mavt-knowledge-manager/scripts/tests/cli.test.js`

**Interfaces:**
- Consumes: `inspectKnowledge`, `listKnowledge`, `showKnowledge`, `validateKnowledgeRoot`, `prepareTransaction`, `applyTransaction`
- Produces: JSON stdout success response
- Produces: JSON stderr failure response `{ schemaVersion: 1, status: 'REQUEST_INVALID'|'FAILED', code, message, details? }`

- [ ] **Step 1: 写失败的 CLI 测试**

```js
assert.strictEqual(run(['inspect', '--workspace', workspace]).status, 'VALID');
assert.strictEqual(run(['list', '--workspace', workspace]).entries.length, 1);
assert.strictEqual(run(['show', '--workspace', workspace, '--entry-id', 'K-a-001']).entryId, 'K-a-001');
assert.strictEqual(run(['validate', '--workspace', workspace]).status, 'VALID');
assert.strictEqual(run(['prepare', '--workspace', workspace, '--request', request]).status, 'PREPARED');
assert.strictEqual(run(['apply', '--workspace', workspace, '--request', request, '--plan-hash', hash]).status, 'APPLIED');
assert.strictEqual(runFailure(['unknown']).code, 'COMMAND_INVALID');
```

- [ ] **Step 2: 运行 CLI 测试并确认失败**

Run: `node skills/mavt-knowledge-manager/scripts/tests/cli.test.js`

Expected: FAIL，因为 `scripts/knowledge-manager.js` 不存在。

- [ ] **Step 3: 实现严格参数解析和 JSON 响应**

```js
const COMMANDS = new Set(['inspect', 'list', 'show', 'validate', 'prepare', 'apply']);
const COMMAND_FLAGS = Object.freeze({
  inspect: ['workspace'], list: ['workspace'], validate: ['workspace'],
  show: ['workspace', 'entry-id'], prepare: ['workspace', 'request'],
  apply: ['workspace', 'request', 'plan-hash'],
});

module.exports = { COMMANDS, COMMAND_FLAGS, main, parseArgs };
```

不得使用第三方参数库；所有路径在进入业务模块前转为绝对路径。

- [ ] **Step 4: 实现自测注册器并运行全部新 Skill 测试**

`self-test.js` 必须断言 `scripts/tests/*.test.js` 全部注册：

```js
const suites = Object.freeze({ contract: 'tests/knowledge-contract.test.js', store: 'tests/knowledge-store.test.js', transaction: 'tests/knowledge-transaction.test.js', cli: 'tests/cli.test.js' });
```

Run: `node skills/mavt-knowledge-manager/scripts/self-test.js`

Expected: PASS，列出四个 suite。

- [ ] **Step 5: 提交 CLI**

```bash
git add skills/mavt-knowledge-manager/scripts
git commit -m "feat(knowledge-manager): add management CLI"
```

### Task 5: 创建 Agent Skill 指令、工作流、契约和模板

**Files:**
- Create: `skills/mavt-knowledge-manager/SKILL.md`
- Create: `skills/mavt-knowledge-manager/references/workflow.md`
- Create: `skills/mavt-knowledge-manager/references/knowledge-contract.md`
- Create: `skills/mavt-knowledge-manager/references/writing-guide.md`
- Create: `skills/mavt-knowledge-manager/assets/knowledge-entry-template.md`
- Create: `skills/mavt-knowledge-manager/scripts/tests/skill-docs.test.js`
- Modify: `skills/mavt-knowledge-manager/scripts/self-test.js`

**Interfaces:**
- Consumes: CLI operations from Task 4
- Produces: Skill trigger and exact Agent workflow for arbitrary input and MAVT Workspace maintenance

- [ ] **Step 1: 写失败的 Skill 文档契约测试**

测试 frontmatter 名称、触发描述、任意输入、仅 MAVT Workspace、直接写入、所有操作、禁止推测、删除授权、prepare/apply、失败恢复和资源链接：

```js
const skill = read('SKILL.md');
assert.match(skill, /^---\nname: mavt-knowledge-manager\n/);
for (const phrase of ['任意可读取', 'MAVT 工作空间', '新增', '修改', '删除', '校验', 'prepare', 'apply']) assert.match(skill, new RegExp(phrase));
assert.match(read('references/writing-guide.md'), /不得猜测/);
assert.match(read('references/knowledge-contract.md'), /可观察现象/);
```

- [ ] **Step 2: 运行文档测试并确认失败**

Run: `node skills/mavt-knowledge-manager/scripts/tests/skill-docs.test.js`

Expected: FAIL，因为 `SKILL.md` 不存在。

- [ ] **Step 3: 编写紧凑的 `SKILL.md` 和按需引用文档**

Frontmatter 固定为：

```yaml
---
name: mavt-knowledge-manager
description: 当用户需要在 MAVT 工作空间中从任意可读取材料新增、修改、删除、查看或校验 knowledge 知识库时使用；负责直接维护 workspace/knowledge，并通过确定性事务和全量校验保证知识格式、引用与召回质量。
---
```

`SKILL.md` 只保留触发边界、入口、标准流程和安全规则；格式细节放入 `knowledge-contract.md`，编写判断放入 `writing-guide.md`，完整命令流程放入 `workflow.md`。

- [ ] **Step 4: 添加可复用知识模板并注册测试**

模板必须是合法但带明确占位说明的草稿资源，Agent 复制后必须替换所有 `<...>`：

```markdown
# K-<stable-id> <title>

## 适用范围
- App: <stable-app-id>
- Platform: <harmony|android|ios>

## 可观察现象
<observable-facts>

## 结论与处理建议
<conclusion-and-boundary>

## 追溯信息
<source-and-date>
```

Run: `node skills/mavt-knowledge-manager/scripts/self-test.js`

Expected: 五个 suite 全部 PASS。

- [ ] **Step 5: 提交 Skill 文档**

```bash
git add skills/mavt-knowledge-manager
git commit -m "docs(knowledge-manager): define agent authoring workflow"
```

### Task 6: 添加 DevKit 跨 Skill 协议兼容测试

**Files:**
- Create: `skills/mavt-knowledge-manager/scripts/tests/mavt-compatibility.test.js`
- Modify: `skills/mavt-knowledge-manager/scripts/self-test.js`

**Interfaces:**
- Consumes: 新 Skill 的 `parseKnowledgeEntry`
- Consumes only in DevKit test: MAVT 的 `parseKnowledgeEntry`
- Produces: 开发期协议兼容门禁；不进入任何运行时模块

- [ ] **Step 1: 写兼容测试并用刻意差异证明测试有效**

```js
for (const fixture of validFixtures) {
  assert.deepStrictEqual(projectManager(managerParse(fixture)), projectMavt(mavtParse(fixture)));
}
for (const fixture of invalidFixtures) {
  assert.throws(() => managerParse(fixture));
  assert.throws(() => mavtParse(fixture));
}
```

先加入一个 MAVT 当前会拒绝、管理器暂时接受的非法 Version fixture，确认测试 FAIL。

- [ ] **Step 2: 对齐契约并确认兼容测试通过**

统一两个独立实现对 Platform 和 Version 的格式约束，但不得让任一运行时模块导入另一个 Skill。

Run: `node skills/mavt-knowledge-manager/scripts/tests/mavt-compatibility.test.js`

Expected: PASS，输出 `MAVT knowledge compatibility passed`。

- [ ] **Step 3: 运行管理 Skill 全量自测并提交**

Run: `node skills/mavt-knowledge-manager/scripts/self-test.js`

Expected: 六个 suite 全部 PASS。

```bash
git add skills/mavt-knowledge-manager
git commit -m "test(knowledge-manager): verify MAVT contract compatibility"
```

### Task 7: 精简 MAVT 的知识维护公开面

**Files:**
- Delete: `skills/mobile-ai-visual-test/scripts/knowledge.js`
- Delete: `skills/mobile-ai-visual-test/references/commands/knowledge.md`
- Delete: `skills/mobile-ai-visual-test/references/commands/errors/knowledge.md`
- Modify: `skills/mobile-ai-visual-test/references/commands.md`
- Modify: `skills/mobile-ai-visual-test/references/knowledge.md`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/coordinator-interface-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/agent-contract-manifest.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/formal-entrypoints.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js`
- Modify as required by failures: `skills/mobile-ai-visual-test/scripts/tests/architecture-boundaries.test.js`

**Interfaces:**
- Preserves: `scripts/lib/knowledge-query.js` internal parser/query exports
- Preserves: `validateKnowledgeRoots` call in `scripts/lib/run-control.js`
- Removes: public `scripts/knowledge.js validate` CLI and maintenance docs

- [ ] **Step 1: 先修改 MAVT 边界测试，声明维护入口必须消失**

```js
assert.strictEqual(fs.existsSync(path.join(repo, 'scripts/knowledge.js')), false);
assert.strictEqual(read('references/commands.md').includes('(commands/knowledge.md)'), false);
assert.strictEqual(JSON.stringify(require('../lib/coordinator-interface-contract')).includes('scripts/knowledge.js'), false);
```

从非法入口 fixture、重复参数 fixture和 Agent-facing docs 列表中移除知识维护命令。

- [ ] **Step 2: 运行相关测试并确认失败**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js entrypoints agentFacingDocs boundaries`

Expected: FAIL，因为公开入口和文档仍存在。

- [ ] **Step 3: 删除公开维护能力并精简运行时知识文档**

删除三个维护文件和两个 manifest 定义；`references/knowledge.md` 只保留：

```markdown
# 本地知识库运行时规则

## 用途与来源
## 查询上下文与候选规则
## 候选复核
## 快照与结果引用
```

不得删除或弱化查询硬条件、最多 5 条、过期不可 `APPLICABLE`、负向结论调查要求和冻结快照规则。

- [ ] **Step 4: 运行 MAVT 知识和边界测试**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js knowledge knowledgeClosure caseRuntime entrypoints agentFacingDocs boundaries`

Expected: 全部 PASS。

- [ ] **Step 5: 提交 MAVT 精简**

```bash
git add -A skills/mobile-ai-visual-test
git commit -m "refactor(mavt): separate knowledge maintenance"
```

### Task 8: 全量验收和文档一致性检查

**Files:**
- Modify if verification exposes a gap: files already listed in Tasks 1-7 only
- Update: `docs/superpowers/plans/2026-09-18-mavt-knowledge-manager.md` checkbox states

**Interfaces:**
- Verifies the complete feature and both Skills' independence

- [ ] **Step 1: 扫描残留维护入口和运行时交叉依赖**

Run:

```bash
rg -n "scripts/knowledge\.js|commands/knowledge\.md|errors/knowledge\.md" skills/mobile-ai-visual-test
rg -n "mobile-ai-visual-test|mavt-knowledge-manager" skills/mavt-knowledge-manager/scripts/lib
```

Expected: 第一条无结果；第二条业务库无跨 Skill `require` 或命令调用，只允许 Workspace 类型字符串。

- [ ] **Step 2: 运行新 Skill 全量自测**

Run: `node skills/mavt-knowledge-manager/scripts/self-test.js`

Expected: 全部 suite PASS。

- [ ] **Step 3: 运行 MAVT 全量自测**

Run: `node skills/mobile-ai-visual-test/scripts/self-test.js`

Expected: 全部 suite PASS。

- [ ] **Step 4: 执行手工 CLI 冒烟测试**

在临时 MAVT Workspace 中依次执行 `inspect -> prepare ADD -> apply -> list -> show -> validate -> prepare UPDATE -> apply -> prepare DELETE -> apply`，并确认：

```js
assert.strictEqual(finalValidation.status, 'VALID');
assert.strictEqual(finalValidation.entryCount, 0);
assert.ok(deleteResult.backupPath.startsWith(path.join(workspace, '.mavt', 'knowledge-maintenance')));
```

- [ ] **Step 5: 检查变更范围和提交最终修正**

Run: `git diff main...HEAD --check && git status --short && git log --oneline --decorate main..HEAD`

Expected: 无 whitespace 错误；只有计划内文件；worktree 干净。

如验证导致计划内修正，使用：

```bash
git add skills/mavt-knowledge-manager skills/mobile-ai-visual-test docs/superpowers/plans/2026-09-18-mavt-knowledge-manager.md
git commit -m "test: complete knowledge manager verification"
```

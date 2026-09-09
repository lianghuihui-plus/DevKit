# ADR: 执行追溯与结果可信度

- 状态：Accepted，已实现
- 当前架构事实来源：`docs/architecture.md`

## 决策

1. 执行授权前从原文生成独立 Frozen CaseSpec；每个 expectation 必须引用原文片段，并以 `specSha` 绑定。
2. Runtime 在 execution 创建时写入 `case-spec.snapshot.json` 和首个 `caseContextRecorded`，Case Agent 不能新增、删除或改写验证点。
3. Case Agent 的动作只需提交 `purpose + expectationRefs`；assessment、observation、conclusion、expectedOutcome、planUpdate、uncertainties 和 knowledgeReview 均按需提供。
4. CaseResult Integrity 直接读取 Frozen CaseSpec 检查覆盖，不信任 Agent 后续叙事中的 expectations。
5. Scene、操作、知识、技术事实、结果、metrics、manifest 和 completion 形成只追加或不可变的证据链；报告只读投影，不回写 execution。
6. 坐标标注的当前格式为 PNG，Reader 仅为历史 execution 保留 SVG 兼容。

## 结果

- 测试 oracle 与执行判断分离，避免执行者自定义或删减验收标准。
- Narrative 记录业务判断摘要，不要求或保存内部推理过程。
- Case Brief 每次从冻结快照、execution、Runtime 和 Current Scene 校验后派生，不作为可写文件；Runtime Broker 提供 operation allowlist，但共享宿主下仍不是安全沙箱。
- 旧 schema 的活动 execution 不转换，必须重新执行。

## 验证

`scripts/tests/contract.test.js`、`scripts/tests/case-runtime.test.js`、`scripts/tests/execution-trace.test.js` 和 `scripts/tests/publication-integrity.test.js` 覆盖契约、不可变 oracle、证据图和报告发布。

# Agent Runtime

每个用例使用一个独立 Case Agent 和一个独立 execution。主 Agent 调用 `batch start` 后，将返回的 `brief` 与 `prompts/case-agent.md` 一次性交给 Case Agent，然后等待最终结果。

Case Agent 通过 execution 内固定 command 和固定 requestPath 调用 `runtime-client.js`。该入口已经绑定 execution 路径、平台、设备和 App，仅提供 `observe`、`act`、`knowledge`、`recover`、`finish`、`status`；Agent 的创建和隔离由宿主完成。

Runtime 自动保存截图、控件树、Scene、动作事实、知识快照和技术指标。Capability ID 绑定生成它的 Scene；使用非当前 Scene 的 ID 时返回当前 Scene，不发送设备动作。动作完成后自动观察；动作结果未知时只观察现场，不自动重放。

Case Agent 在首次 Runtime 请求中附带包含非空初始计划的 `caseContext`。首次建立现场的 `observe` 可以只带 caseContext；之后已有的 `act`、`observe`、`knowledge`、`recover` 或 `finish` 请求附带简短 `decision`。知识查询返回候选后，适用性评估放入下一次已有请求的 `decision.knowledgeReview`；零候选由 Runtime 自动闭合。Runtime 自动分配验证点 ID、绑定当前 Scene 和 operation，并将理解、计划调整、业务判断和知识复核写入 `events.jsonl`；这些记录不增加独立调用。报告从事实事件计算 `COMPLETE`、`PARTIAL` 或 `UNAVAILABLE`，缺少叙事只降低记录完整性，不增加设备操作。

Case Agent 调用 `recover` 时，Runtime 自行完成 App 恢复、暖会话代次更新和恢复后观察，主 Agent 不参与消息转发。30 分钟预算结束后 Runtime 停止新设备动作，但保留 `finish`，让 Case Agent 基于已有证据收口。

CaseResult 的每个 check 通过 `expectationRef` 覆盖一个当前验证点，并可用 `knowledgeRefs` 引用适用知识。Runtime 为技术错误、时间限制和未知操作结果生成稳定 `technicalFactRef`，并自动绑定 decision、验证点、Scene 和 generation；仅当该事实属于当前 execution、关联当前验证点与 generation、未被后续成功执行恢复且仍直接阻止验证时，BLOCKED check 使用 `technicalRefs` 引用它。`finish` 验证验证点覆盖、checks、verdict、Scene 证据、负向结论调查和引用关系后原样保存结果；不完整时返回 `RESULT_INCOMPLETE` 供 Case Agent 补充。框架在 `events.jsonl` 保存技术事实，在 `metrics.json`、`completion.json` 和 `artifact-manifest.json` 保存技术完成信息，不改写业务结论；未完成的 finish 草稿由 Runtime 或 Batch 自动续写。

execution 冻结 `binding.snapshot.json`，Runtime 只使用本地绑定；批次暖会话代际通过 `runtime.json` 中的显式 `sessionRef` 读取和提交。Runtime 不推断 Workspace 或 Batch 的目录层级。

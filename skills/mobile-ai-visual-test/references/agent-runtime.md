# Agent Runtime

每个用例使用一个独立 Case Agent 和一个独立 execution。主 Agent 调用 `batch start` 后，将返回的 `brief` 与 `prompts/case-agent.md` 一次性交给 Case Agent，然后等待最终结果。

Case Agent 通过 execution 内固定 command 和固定 requestPath 调用 `runtime-client.js`。该入口已经绑定 execution 路径、平台、设备和 App，仅提供 `observe`、`act`、`knowledge`、`recover`、`finish`、`status`；Agent 的创建和隔离由宿主完成。

Runtime 自动保存截图、控件树、Scene、动作事实、动作空间证据、知识快照和技术指标。基于 Scene 的请求携带 `basedOnSceneId`；Scene 已变化时返回当前 Scene，不发送设备动作。动作完成后自动观察；动作结果未知时只观察现场，不自动重放。动作事实分为 Runtime 生命周期、命令接受状态、设备执行验证和前后 Scene 可观察效果，任何单层状态都不等同于业务成功。

坐标动作由独立 Action Spatial Evidence Service 一次性生成 `action-spatial-evidence/action-N.json` 和带操作前截图底图的 `action-N.png`。事务和事件只保存 `spatialEvidenceRef`；Runtime、恢复流程、报告和证据完整性校验都通过同一 Reader 读取。`Scene.previousAction.spatialEvidence` 是面向 Case Agent 的统一投影，其中 `annotatedScreenshot.attachment` 可直接查看落点现场。Reader 继续兼容历史 execution 的 SVG 标注图。`certainty=DISPATCH_ONLY` 只证明请求坐标与命令投递坐标一致；只有 `certainty=DEVICE_CONFIRMED` 且 `actual` 非空时，才存在平台确认的真实触点。

Case Agent 在首次 Runtime 请求中附带包含非空初始计划的 `caseContext`。首次建立现场的 `observe` 可以只带 caseContext；之后已有的 `act`、`observe`、`knowledge`、`recover` 或 `finish` 请求附带简短 `decision`。知识查询返回候选后，适用性评估放入下一次已有请求的 `decision.knowledgeReview`；零候选由 Runtime 自动闭合。Runtime 自动分配验证点 ID、绑定当前 Scene 和 operation，并将理解、计划调整、业务判断和知识复核写入 `events.jsonl`；这些记录不增加独立调用。报告从事实事件计算 `COMPLETE`、`PARTIAL` 或 `UNAVAILABLE`，缺少叙事只降低记录完整性，不增加设备操作。

Case Agent 调用 `recover` 时，Runtime 自行完成 App 恢复、暖会话代次更新和恢复后观察，主 Agent 不参与消息转发。30 分钟预算结束后 Runtime 停止新设备动作，但保留 `finish`，让 Case Agent 基于已有证据收口。

CaseResult 的每个 check 通过 `expectationRef` 覆盖一个当前验证点，并可用 `knowledgeRefs` 引用适用知识。搜索型验证点在 caseContext 中声明 `verificationKind=SEARCH_EXISTENCE`；其 FAIL check 必须用 `evidenceBasis.sceneRef` 和 `scrollContextRef` 引用不可变 Scene 中已确认两端且连续覆盖的滚动上下文。Runtime 为技术错误、时间限制和未知操作结果生成稳定 `technicalFactRef`；仅当该事实仍直接阻止验证时，BLOCKED check 使用 `technicalRefs` 引用它。知识引用必须来自已冻结并评估为适用的候选，但直接 Scene 证据足够时不强制知识查询。

execution 冻结 `binding.snapshot.json`，Runtime 只使用本地绑定；批次暖会话代际通过 `runtime.json` 中的显式 `sessionRef` 读取和提交。Runtime 不推断 Workspace 或 Batch 的目录层级。

Runtime 每次处理新请求前恢复未完成事务。恢复产生新 Scene、未知动作结果或已完成 finish 时返回 `RECOVERY_APPLIED` 并停止本次旧请求；continuation Agent 只接收 reconcile 后生成的 continuation Brief。用户取消通过 Lifecycle 写入 `CANCELLED` 终态，`teardown` 不承担取消语义。

# Case Runtime 与委托

主 Agent 为每个用例只创建一个业务 execution，并一次性委托新的 Case Agent。原生 Agent 句柄只由当前主 Agent 会话持有；句柄丢失时先 reconcile，再用 continuation Brief 和同一 execution 创建 continuation Agent。

Case Brief 不是落盘的权威文件，而是每次从冻结原文、Case Contract、Frozen CaseSpec、execution、Runtime 和 Current Scene 校验后派生。它只包含原文、Frozen CaseSpec、初始状态结果、目标摘要、可选 Scene 和预绑定 Runtime Client，并通过 `runtime.allowedOperations` 告知 Agent 当前 execution 的实际能力。Scene 通过 `evidenceChannels.visual` 和 `evidenceChannels.layout` 明确暴露并列的截图与控件树能力。

Lifecycle 在委托前建立 `initialStateRequirement` 指定的状态。Case Agent 只调用 Broker 允许的 `observe`、`act`、`knowledge`、`recover`、`finish`、`status`；不读取 Batch、平台脚本、安装资产或报告实现，也不能调用内部 `prepare`。

Frozen CaseSpec 在执行授权前生成，每个 expectation 都引用原文证据。Runtime 创建 execution 时自动写入首个语义上下文，Case Agent 不重复或修改 oracle。动作 decision 最小契约是 `purpose + expectationRefs`；其他观察、结论、计划和不确定项按需提交，避免框架强迫 Agent 机械展开思考。

Runtime 自动绑定 Scene、operation、知识复核和技术事实。坐标动作只持久化一份 Action Spatial Evidence；当前附件为 PNG，Reader 兼容历史 SVG。`DISPATCH_ONLY` 只证明请求与投递，不能证明真实触点。

CaseResult 的每个 check 必须覆盖一个 Frozen expectation。搜索型 FAIL 需要完整滚动覆盖；知识引用必须评估为适用；BLOCKED 技术引用必须仍有效。直接 Scene 证据足够时不强制知识查询。

当前 Runtime Broker 通过 operation allowlist 提供职责和协议隔离，不是安全沙箱。Case Agent 仅可用宿主 `view_image` 读取当前 execution 已保存 Scene 明确提供的视觉附件，查看后通过 `inspectVisual` 写入可审计记录；Runtime 能校验该声明与 Scene 证据的绑定，但不能在共享进程外证明宿主工具调用本身。若业务要求强隔离，还需要宿主工具权限、独立进程和文件系统访问控制。

# MAVT 看板最终视觉基准

这是一版可按当前数据契约直接实现的最终样例。后续生产页面以本目录的布局、视觉层级、组件形态、响应式行为和交互为验收基准，不再沿用旧看板样式。

## 页面与路由

- `#overview`：三平台紧凑概览，以及按用例分组的平台执行列表；结果顺序统一为通过、失败、阻塞、无法判断、未执行。
- `#case-content`：只显示用例身份信息和原始内容，不混入执行结果。
- `#report-harmony`、`#report-android`、`#report-ios`：平台执行报告，包含六个内容 Tab。

## 真实字段映射

- 用例公共区读取 `caseNo`、`caseKey`、`title`、`reason/summary`、平台执行统计和平均耗时。
- 平台执行区读取 `platform`、`verdict/status`、`executionStatus`、`verdictBasis`、`durationMs`、`startedAt`、`endedAt`、动作与观察计数、验证点覆盖和恢复次数。
- 用例内容页身份信息读取 `identity.caseNo`、`identity.caseKey`、`identity.sourceSha` 和 `identity.importSource.path`。
- 未执行计入平台状态数量和百分比，但某平台没有执行记录时不渲染平台行；字段缺失时显示 `-`，不虚构设备、版本、负责人、优先级或标签。
- 报告概览的执行记录读取 `recordingStatus`、`coverage`、动作计数和 `invocationErrorCount`，不根据 PASS/FAIL 推导健康度。
- 用例理解只读取 `caseContext.summary`、`preconditions`、`expectations`、`uncertainties` 和 `understandingHistory`。
- 执行计划只读取 `initialPlan`、`planHistory` 和 `planUpdate`；没有计划调整时不显示调整区。
- 执行过程读取 Agent decision 的 `purpose`、`expectedOutcome`、`observation`、`conclusion`、前后 Scene、操作结果和空间证据。
- 知识调查读取 `knowledgeQueried`、`knowledgeReviewed`、候选的冻结 `snapshotRef`、`candidateCount`、`filterDiagnostics` 和逐条适用性评估；查询目的来自关联 decision 的 `purpose`，对执行的影响由后续 `conclusion`、`planUpdate` 与最终检查的 `knowledgeRefs` 串联展示。
- 没有 `knowledgeQueried` 时显示“本次执行未触发知识库查询”，不为了填充页面虚构调查过程。
- 详细日志读取 `events.jsonl` 的投影，知识查询与复核归入 `KNOWLEDGE` 分类；日志类型没有 `operationId`、`queryId`、`sceneId`、generation、App 或 layout 时，对应上下文字段显示 `-`。

## 交互验收

- 状态筛选、搜索、用例内容入口、各平台报告入口、六个报告 Tab 和执行步骤检查器均可操作。
- 执行截图可点击，并在页内查看器中放大、缩小、适应窗口、拖拽和前后切换。
- 点操作展示请求位置、命令投递位置、设备实际触点和目标区域；滑动操作展示已有空间证据中的起止轨迹。
- 概览中的知识引用可直接定位到对应执行步骤；执行过程可核对查询目的、查询词、候选范围、适用性判断、复核结论及其对计划或最终结论的影响。
- 日志支持分类（含知识）、文本搜索、上下文查看和文本导出。
- 生产实现直接消费 `annotatedScreenshotRef` 或 `spatialEvidenceScreenshot`；前端不重新推导或计算真实坐标。

# Case Runtime 资源目录

资源引用来自 `data.ref`、`resources[].ref` 或明确标注的资源字段；原样传给返回该引用的绑定 Facade：

```json
{
  "operation": "read",
  "input": {
    "ref": "scene-1"
  }
}
```

读取返回完整主数据 `data`，关联复杂数据仍为 `resources` 中的类型化引用；不截断、抽样或内联复制关联资源。`$resourceType` 表示所读资源类型，`$declaredResources` 表示该资源声明的关联资源。引用不可拼接、跨作用域使用或替换为流程节点、边和操作 ID。

| 类型 | 内容 |
|---|---|
| `caseBrief` | 冻结的 Case Agent prompt、用例和 execution 启动信息。 |
| `scene` | 一次采集的完整 Scene 与截图、布局、控件资源引用。 |
| `screenshot` | 完整截图文件位置与尺寸；使用宿主图片能力打开。 |
| `layout` | 该 Scene 的完整原始控件树。 |
| `elementSet` | 完整控件集合与确定性动作事实。 |
| `caseFlow` | Agent 提交的完整用例流程 revision。 |
| `checkpointLedger` | 检查点登记与处置账本的不可变快照。 |
| `checkpointResult` | 一次检查点结果提交。 |
| `knowledgeQuery` | 知识查询范围、查询事实与候选资源引用。 |
| `candidateSet` | 完整知识候选集合。 |
| `knowledgeDocument` | 完整知识条目正文。 |
| `knowledgeReview` | Agent 提交的知识适用性审查。 |
| `actionSpatialEvidence` | 动作落点、轨迹及标注截图资源。 |
| `planResult` | 命令组合的完整结果与步骤证据引用。 |
| `planEvidence` | 组合命令某一步的完整采集或技术检查证据。 |
| `externalActionDeclaration` | Agent 登记的框架外动作事实。 |
| `technicalFact` | 持久化的技术事实与诊断。 |
| `caseResult` | 最终用例结果与证据引用。 |

错误中的 `documentationRef` 和 `operationDocumentationRef` 是静态文档路径，使用宿主文件读取能力打开，不传给 `read`。

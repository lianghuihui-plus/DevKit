# 多设备用例执行讨论记录

- 状态：讨论中，尚未形成最终技术方案
- 日期：2026-10-21
- 主题：同一测试用例在手机、平板等不同设备形态上的执行与证据闭环

## 背景

一条测试用例可能需要在手机和平板上验证。不同设备上的操作与预期可能完全一致，也可能存在差异。当前一次 execution 只绑定一台设备，因此只在其中一台设备上执行时，容易把“缺少另一设备的执行覆盖”混同为 Case Agent 的“证据不足”。

## 已达成结论

### 原始用例保持不可变

系统只保存并传递一份原始用例，不根据设备生成、裁剪、合并或改写手机版、平板版用例。原始用例是唯一业务语义来源，其内容和 `sourceSha` 在 execution 中冻结。

设备信息属于 execution 上下文，不属于用例正文。不得把“当前验证手机”或“忽略平板部分”等执行指令拼接进 `case.source`，也不得将这些信息写回 `source.md`。

### 按“用例 × 设备”创建执行实例

当同一用例需要在手机和平板上验证时，系统创建两个独立 execution：

```text
同一份原始用例
├── phone execution  + 手机设备 → 独立 Case Agent
└── tablet execution + 平板设备 → 独立 Case Agent
```

这仍然是一条逻辑用例，不是两条经过改写的用例。两个 execution 使用相同的 `caseKey` 和 `sourceSha`，使用不同的 `executionId`、目标设备绑定和设备形态。

### 一个 Case Agent 只负责一个设备 execution

每个 Case Agent 只处理一个已经绑定设备的 execution，不在同一个执行上下文中切换手机和平板，也不负责创建或调度另一设备的 execution。

Case Agent 获取：

- 完整且未经修改的原始用例；
- 当前 execution 绑定的设备、平台和设备形态；
- “仅验证当前绑定设备上的适用要求”这一执行范围原则。

Case Agent 可以根据原始用例和当前设备判断条件、分支与检查点的适用性，但不能因为没有操作另一台设备而把当前 execution 判为证据不足。

### Main Agent 不解释或改写业务用例

Main Agent 作为执行协调 Agent，只负责：

- 取得用户对本次执行设备集合的确认；
- 请求 Coordinator 创建并推进对应 execution；
- 为每个 execution 委托独立 Case Agent；
- 根据持久化状态汇报各设备执行结果与覆盖情况。

Main Agent 不读取原始用例，不判断哪些步骤属于手机或平板，也不组合设备专属用例内容。

### 结果汇总不得生成新的业务语义

报告层只汇总已有 execution 的结构化事实，不加工原始用例内容，也不生成新的合成用例：

```text
用例 014
- 手机：PASS
- 平板：PASS
- 设备覆盖：2/2
```

每个设备 verdict 和对应证据始终独立保留。用例级展示可以提供覆盖摘要，但不得覆盖、替换或模糊设备级结果。

### 区分证据不足与设备覆盖缺失

- 当前设备已经执行，但无法形成可靠业务判断：`INCONCLUSIVE`。
- 当前设备存在技术阻塞：`BLOCKED`。
- 当前设备整体不适用：应有 execution 级 `NOT_APPLICABLE`，不能伪装成 `PASS`。
- 用户要求的设备没有创建或完成 execution：属于覆盖缺失，由 Coordinator 或报告层表达，不属于 Case Agent 的证据不足。

## 建议的数据边界

Case Agent Brief 应保持业务内容和执行目标分离：

```json
{
  "case": {
    "caseNo": "014",
    "caseKey": "ck-example",
    "sourceSha": "source-example",
    "source": "未经修改的原始用例全文"
  },
  "target": {
    "platform": "harmony",
    "deviceId": "tablet-001",
    "deviceFormFactor": "tablet"
  },
  "executionScope": {
    "rule": "VALIDATE_CURRENT_TARGET_ONLY"
  }
}
```

`case` 负责业务语义，`target` 负责设备事实，`executionScope` 负责本次执行边界，三者不可相互改写。

## 特殊边界

“分别在手机和平板验证同一功能”可以拆成两个单设备 execution。

“手机发起操作后，平板必须收到结果”等跨设备联动场景包含设备间因果关系，不能简单拆成两个互相隔离的 Case Agent 后机械汇总。这类用例需要单独定义多设备协同执行模型，不包含在当前结论中。

## 待继续讨论

1. 本次执行的设备集合由用户每次显式选择、工作区默认策略提供，还是两者结合。
2. `prepareRun` 和 `confirmRun` 如何表达多个设备绑定以及“用例 × 设备”的展开结果。
3. Batch 继续保持单设备，还是在其上增加负责多个单设备 Batch 的 Run Group/Campaign。
4. execution 级 `NOT_APPLICABLE` 的语义、证据要求及其与检查点级 `NOT_APPLICABLE` 的关系。
5. 报告是否提供派生的用例级 verdict，还是只展示设备级 verdict 和覆盖完成度。
6. 同一平台下手机和平板 execution 的目录、最新结果选择和历史保留方式。
7. 如何识别并处理真正需要多设备协同操作的用例。

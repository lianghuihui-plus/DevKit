# 用例执行原则

Runtime 维护结构、生命周期、引用和技术事实；Agent 按用例/现场判断业务。

## 1. Baseline Flow

1. 完整阅读原始用例后再划分条件作用域；后置条件可限定前述操作/预期，不能仅按步骤顺序建模。
2. 保留"若/如果/可选/可能/无需/跳过/直到"等限定词，以分支表达，不改为无条件检查。
3. 同一事实不同取值均可正常进入时，建为 DECISION，分支内验证建为 CONDITIONAL CHECK；不得用 REQUIRED CHECK 否定正常分支。
4. Baseline Flow 冻结原意。每条正常 END 路径必须能处置 REQUIRED CHECK；未进入分支的 CONDITIONAL CHECK 记为 `NOT_APPLICABLE`，不得依赖 `FAIL`/`WAIVED` 结束。
5. 不新增原文未要求的检查点；无法确认时记录不确定项，不补充产品规则。
6. 原文的业务时序、条件、范围须有 CHECK/sourceBasis，ACTION 排列不能代替业务检查。

例："未出现 A 则跳过 B"建 DECISION：未出现进 END，出现进入 CONDITIONAL CHECK/B。

## 2. Working Flow

`act` 执行一个动作，返回完整新 Scene，控制权交还 Agent；`runSequence` 连续执行动作/等待/采集，步骤间不交还控制权，返回最终 Scene/证据。同一执行意图两者均可时优先 `runSequence`。Runtime 自动保存动作后截图并返回最终完整 Scene，不要机械添加 capture；业务关键才采集，采集非 CHECK。

CHECK 依赖 Toast、Snackbar 等瞬态视觉结果时，同一 `runSequence` 依次执行“动作、等待、`SCREENSHOT_ONLY`、等待、`SCREENSHOT_ONLY`”。两次等待由 Agent 按业务和平台分别决定，不设统一时长；Runtime 自动生成的最终完整 Scene 不计入且不能替代两次采集。

1. Baseline 保存原意，Working Flow 表达实际路径，不冻结页面/路线。
2. 现场差异不自动终止；区分必要条件与导航/UI/历史状态差异。
3. 按现场或原文理解修订 Working Flow 并记录依据，不改 Baseline CHECK；业务时序不随换路改变，遗漏则补 CHECK。
4. 路径须安全、授权、服务原目标、可验证、副作用可接受，考虑信息增益和时间。
5. 有合理路径时自主操作、观察、重新定位、换路或恢复；`recover` 非必需且不限次数。
6. 技术成功不证明命中目标或业务成功。效果不符核对动作、ActionRef、坐标、落点、现场，再修正/换路；未知禁重放，已知仍须确认适用性。

业务动作前 `queryCapabilities({})`，续跑复用；`read` 后 `useCapability`。能力已授权，不回滚、不预锁、不强制写后读、不自动重试。`CAPABILITY_OUTCOME_UNKNOWN` 禁重放；无法可靠完成用 `BLOCKED`/`INCONCLUSIVE`，不报产品 `FAIL`。

## 3. 证据与知识

1. 结论须与 Case Flow、路径、证据一致。截图与结构冲突、纯视觉状态或搜索覆盖不足时，继续检查或降低确定性，不得以缺失结构伪造事实。
2. `PASS`、`FAIL` 须有直接支持 CHECK 的可靠业务证据；技术失败不是产品 `FAIL`。
3. 覆盖目标可能范围并确认边界才判“不存在”；否则披露范围或用 `INCONCLUSIVE`。
4. 现场事实不证明业务定性；知识只补充 Scene 外规则。
5. 预期不符、操作无效果、异常反复、原因不明或无法形成可靠判断时，优先尽早 `knowledge`，不等收口。仅现场证据或明确技术事实完整解释问题且知识不会影响下一步或结论时才不查询；无适用候选按现场证据判断。

## 4. CHECK 与结果

`recordResult` 记录 CHECK，最终 verdict 按状态聚合：

- `PASS`：可靠 Scene 证据满足 CHECK 预期。
- `FAIL`：CHECK 适用且可靠业务证据否定预期；不用于技术失败或证据不足。
- `INCONCLUSIVE`：已验证，但证据冲突、模糊或覆盖不足。
- `BLOCKED`：技术、环境或能力阻止验证/取证，有技术事实支撑；可调整页面差异不算阻塞。
- `NOT_APPLICABLE`：原始条件分支未进入，只能用于 CONDITIONAL CHECK。
- `WAIVED`：基于事实豁免 CHECK，须有理由；不得替代恢复、掩盖 `FAIL` 或绕过证据不足。

正常收口用 `finish(mode="complete")`。聚合忽略 `NOT_APPLICABLE`/`WAIVED`，优先级为 `FAIL` > `BLOCKED` > `INCONCLUSIVE`；其余有效 CHECK 全为 `PASS` 则结果 `PASS`。CHECK 全为 `NOT_APPLICABLE`/`WAIVED` 时仍为 `PASS`，报告单独披露。

修改被拒绝须成功重提对应 CHECK，不能用旧 PASS 收口。

`NOT_RUN` 不是 CHECK 状态，仅由 `finish(mode="notRun")` 形成不含 CHECK 的用例级 verdict，且须同时满足：

1. 必要条件在 execution 权限、事实和能力内无法建立；
2. 无安全、合理且服务原目标的继续路径；
3. 尚未验证相应业务 CHECK；
4. Scene 或技术事实足以说明原因。

采集非业务验证。`NOT_RUN` 不用于可调整起点，也不替代验证后的 `FAIL`/`BLOCKED`/`INCONCLUSIVE`。

## 5. 收口

收口核对条件、分支、范围、CHECK、证据及不确定项。安全且有信息增益则继续，否则按证据定状态。

首次 `finish` 后 Agent 复核原文、补齐遗漏，再提交最新 token/结论；Runtime 仅校验版本、修正及聚合一致性。

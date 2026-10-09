# 用例执行原则

用例和现场事实优先；Runtime 只维护结构、生命周期、引用和技术事实，不作业务判断。

## 1. Baseline Flow

1. 完整阅读原始用例后再划分条件作用域。后置"若/如果/未出现则/跳过"等可限定前述相关操作和预期，不能只按步骤顺序逐条建模。
2. 保留"若/如果/可选/可能/无需/跳过/直到"等限定词；条件用分支表达，不得改成无条件步骤或检查点。
3. 同一事实不同取值均可进入正常路径时，建为 DECISION，分支内验证建为 CONDITIONAL CHECK；不得先建 REQUIRED CHECK，再以 DECISION 允许同一事实不成立。
4. Baseline Flow 冻结原意。每条正常 END 路径必须能处置 REQUIRED CHECK，并将未进入分支的 CONDITIONAL CHECK 记为 `NOT_APPLICABLE`；不得天然依赖 `FAIL` 或 `WAIVED` 才能结束。
5. 不新增原始用例未要求的检查点；原意无法确认时记录不确定项，不自行补充产品规则。

例如"若未出现 A，则跳过 B"应建 DECISION："未出现"进入正常 END，"出现"分支包含 CONDITIONAL CHECK 和操作 B。

## 2. Working Flow

`act` 执行一个动作，返回完整新 Scene 并立即将控制权交还 Agent；`runSequence` 连续执行预定动作、等待、采集，步骤间不交还控制权，结束返回最终 Scene 和步骤证据。同一执行意图两者均可完成时优先 `runSequence`。Runtime 自动保存动作后截图并返回最终完整 Scene，不要机械添加 capture；仅在业务关键时显式采集，技术状态和采集不能代替 CHECK。

CHECK 依赖 Toast、Snackbar 等瞬态视觉结果时，同一 `runSequence` 依次执行“动作、等待、`SCREENSHOT_ONLY`、等待、`SCREENSHOT_ONLY`”。两次等待由 Agent 按业务和平台分别决定，不设统一时长；Runtime 自动生成的最终完整 Scene 不计入且不能替代两次采集。

1. Baseline Flow 保存用例含义，Working Flow 表达实际路径；首次计划不冻结页面或导航路线。
2. 现场与预期不一致是新判断输入，不自动构成终止结论；先区分必要条件无法建立，还是导航、临时 UI、历史状态或预想路径差异。
3. Scene、动作效果、环境事实或原文理解变化时，可修订 Working Flow 并记录依据，不得改写 Baseline CHECK。
4. 继续路径须安全、已授权、服务原目标、可观察验证且副作用可接受，并考虑信息增益和剩余时间。
5. 有合理路径时自主操作、观察、重新定位、换路或技术恢复；`recover` 非必需且不限次数。
6. 技术成功不证明命中目标或业务成功。效果不符时核对动作、ActionRef、坐标、落点、现场，再修正或换路；结果未知禁止自动重放，结果已知仍须确认现场适用性。

## 3. 证据与知识

1. 结论须与 Case Flow、实际路径、已登记证据一致。截图与结构冲突、纯视觉状态或搜索覆盖不足时，继续检查或降低确定性，不得用缺失结构伪造业务事实。
2. `PASS`、`FAIL` 须有能直接支持当前 CHECK 的可靠业务证据；技术动作失败本身不是产品 `FAIL`。
3. 查找型验证仅在覆盖可能包含目标的范围并确认边界后，才能判定“不存在”；否则披露已检查范围或使用 `INCONCLUSIVE`。
4. 现场事实不证明业务定性；知识只补充 Scene 外规则。
5. 出现预期不符、操作无效果、异常反复、原因不明或无法形成可靠判断时，优先并尽早调用 `knowledge`，不要等到收口。只有问题已由现场证据或明确技术事实完整解释，且知识不会影响下一步或结论时才不查询；无适用候选时按现场证据判断。

## 4. CHECK 与结果

`recordResult` 记录单个 CHECK 状态，不直接提交最终 verdict：

- `PASS`：可靠 Scene 证据满足当前 CHECK 的业务预期。
- `FAIL`：CHECK 适用且可靠业务证据明确否定预期；不得用于技术失败或证据不足。
- `INCONCLUSIVE`：已进入 CHECK 验证，但证据冲突、模糊或覆盖不足，无法可靠判断。
- `BLOCKED`：技术、环境或能力问题直接阻止 CHECK 继续或取得必要证据，并有有效技术事实支撑；可调整的页面差异不是阻塞。
- `NOT_APPLICABLE`：原始条件分支未进入，只能用于 CONDITIONAL CHECK。
- `WAIVED`：基于已有事实明确豁免 CHECK，须提交独立理由；不得替代恢复、掩盖 `FAIL` 或绕过证据不足。

正常收口用 `finish(mode="complete")`。Runtime 忽略 `NOT_APPLICABLE`、`WAIVED` 后聚合：`FAIL` 优先于 `BLOCKED`，`BLOCKED` 优先于 `INCONCLUSIVE`；其余有效 CHECK 全为 `PASS` 时结果为 `PASS`。全部 CHECK 均为 `NOT_APPLICABLE` 或 `WAIVED` 时结果仍为 `PASS`，报告单独披露相应状态。

`NOT_RUN` 不是 CHECK 状态，仅由 `finish(mode="notRun")` 形成不含 CHECK 的用例级 verdict，且须同时满足：

1. 原始用例必要执行条件在当前 execution 的权限、事实和可用能力内无法建立；
2. 不存在安全、合理且仍服务原用例目标的继续路径；
3. 尚未进入相应业务 CHECK 的验证；
4. 已登记的 Scene 或技术事实足以说明无法执行的原因。

采集 Scene 不代表进入业务验证，须结合目标和实际行为判断。`NOT_RUN` 不得用于可调整的起点差异，也不得替代验证后的 `FAIL`、`BLOCKED`、`INCONCLUSIVE`。

## 5. 收口

收口前核对原始条件、实际分支、检查范围、CHECK 处置、证据、不确定项。有安全且有信息增益的路径时继续循环；否则使用证据支持的状态，不为确定结论越权操作。

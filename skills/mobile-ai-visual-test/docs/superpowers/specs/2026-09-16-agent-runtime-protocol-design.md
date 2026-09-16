# Agent-Runtime Protocol 详细设计

## 1. 文档状态

本文是 `docs/agent-runtime-protocol-optimization.md` 的协议详细设计，负责把已确认的优化原则收敛为可编码的接口、数据模型、状态机和部署约束。

本文不是逐文件实施计划，也不包含 Android 用例 002、003 的业务验收。用例验收由用户另行完成；本设计只规定实现阶段必须具备的自动化契约测试、事务测试和性能观测能力。

## 2. 目标与非目标

### 2.1 目标

1. Agent 在调用前通过独立 SDK 式文档理解方法签名，不再依赖响应中的 capability card、template 或 example。
2. Case Model、视觉事实、验证点结果和设备动作分别使用单一职责能力，避免业务事实与设备 effect 共用恢复事务。
3. Agent-facing Scene 默认只返回当前决策需要的动态事实，不返回完整动作目录和稳定使用说明。
4. 验证点结果在执行过程中增量持久化，`finish` 只收口未决项和冲突项。
5. Runtime 继续保存完整 Scene、事件、证据和事务事实，并继续执行最终全量完整性校验。
6. stdin、Shell 和后续 MCP 使用同一份公开接口定义，传输方式不改变业务协议。

### 2.2 非目标

- 不让 Runtime 理解自由文本业务意图或自主规划业务动作。
- 不跨越“看图、决策、操作、再看图”的业务因果边界。
- 不删除内部 Scene、截图、控件树、动作、知识或证据记录。
- 不改变 Adapter 和 Device Port 的平台动作语义。
- 不在动作结果未知时自动重放设备动作。
- MCP 只作为同一公开接口定义的传输适配器，不增加方法或改变业务语义。
- 不负责 002、003 的业务结果和端到端耗时验收。

## 3. 总体架构

```text
角色 Prompt
  └─ 只定义职责、业务原则和服务文档路径

Agent-facing 方法文档
  └─ 由公开接口定义生成：签名、参数、返回、错误、示例

Agent
  └─ 基于 Scene N 依次调用 plan / inspect / recordResult / act / finish

Facade
  ├─ 校验公开 Schema 和当前上下文
  ├─ 将 actionRef 映射为内部 capabilityId
  └─ 将每个单一职责请求翻译为确定性内部操作

Runtime Core
  ├─ 在 execution 锁内恢复未完成事务
  ├─ 独立持久化 Case Model、视觉事实或验证结果
  ├─ 每个 act 最多执行一个明确 effect
  ├─ 采集并完整保存 Scene N+1
  └─ 返回最小 Agent-facing 投影

Adapter / Store / Evidence / Result Integrity
  └─ 保持确定性设备代理、完整事实记录和最终强校验职责
```

公开协议固定为 `agent-facing`。Execution 只接受当前 schema 12，不提供并行协议或旧格式读写路径。

## 4. Agent-facing 服务边界

### 4.1 正式服务

只存在两个正式 Agent-facing 服务：

| 服务 | 消费者 | 入口 | 方法数 | 启动索引 |
|---|---|---|---:|---|
| Coordinator Facade | 主 Agent | `scripts/coordinator-agent.js` | 4 | `references/coordinator.md` |
| Case Runtime Facade | Case Agent | `scripts/case-runtime/agent-facing-client.js` | 8 | `references/case-runtime.md` |

Workspace Bootstrap 和 Case Handoff Loader 是一次性启动入口，不是新增服务。Batch、Environment、Runtime Core、Adapter、Knowledge、Evidence、Report 等仍为内部模块，不向 Agent 发布方法签名。

### 4.2 公开接口定义

两个现有 `agent-facing-contract.js` 各自维护本服务的唯一公开接口定义。每个方法定义必须同时包含：

```text
name
summary
requestSchema
parameterDescriptions
conditionalRequirements
contextualValidationRules
successStatuses
errorCodes
sideEffects
idempotency
minimalExample
```

以下内容必须从该定义生成或由测试校验一致性：

- 服务端请求校验 Schema。
- 两个启动短索引及其按需方法页、专题页和错误目录。
- 后续 MCP tool schema。
- 公开错误码覆盖表。
- protocol SHA 的接口定义摘要。

禁止分别手写四份互不校验的 Schema、文档、MCP 定义和服务端规则。

## 5. 通用类型

### 5.1 标量引用

```typescript
type SceneRef = `scene-${string}`;
type ElementRef = string;
type ActionRef = `${ElementRef}:${ElementAction}` | `screen:${ScreenAction}` | `visual:${VisualGesture}`;
type ExpectationRef = `E${number}`;
type KnowledgeRef = string;
type TechnicalFactRef = `technical-fact-${string}`;
type CaseModelRevision = number;
```

Agent 只使用以上 Agent-facing 引用。`capabilityId`、内部 `sceneId` 字段名、operation、token、dispatch lease 和事务 ID 不进入公开方法签名。

`ElementRef` 是 Runtime 发布的不透明字符串，并保证不包含冒号；Agent 不解析其内容。冒号只作为 ActionRef 中 elementRef 与 actionType 的分隔符。

### 5.2 状态枚举

```typescript
type ExpectationStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
type ScreenComparison = "IDENTICAL" | "DIFFERENT" | "UNAVAILABLE";
type ElementAction = "tap" | "toggle" | "doubleTap" | "longPress" | "inputText";
type ScreenAction =
  | "swipeUp" | "swipeDown" | "swipeLeft" | "swipeRight"
  | "back" | "home" | "wait" | "dismissKeyboard" | "inputText";
type VisualGesture = "tap" | "doubleTap" | "longPress" | "swipe";
```

### 5.3 TargetBinding

```typescript
interface TargetBinding {
  platform: "harmony" | "android" | "ios";
  deviceId: string;
  appId: string;
  entry?: string;
  deviceType?: "simulator" | "realDevice";
  deviceFormFactor?: string;
  xcodeOrgId?: string;
  xcodeSigningId?: string;
  updatedWDABundleId?: string;
}
```

- HarmonyOS 和 Android 的 entry 必填。
- iOS 不使用 entry。
- 三个签名字段只在 iOS 真机探测明确返回 `IOS_SIGNING_REQUIRED` 时条件必填。
- Agent 不提交 Appium server、WDA 端口、内部路径或进程参数。

### 5.4 独立事实提交

Case Model、视觉/动作检查和验证点结果分别由 `plan`、`inspect` 和 `recordResult` 提交。Runtime 只做结构校验、引用绑定、revision 处理和持久化，不把这些事实附着到设备 effect。

### 5.5 CaseModelUpdate

```typescript
interface CaseModelUpdate {
  baseRevision: CaseModelRevision | null;
  understanding: string;
  preconditions: string[];
  verificationPoints: Array<{
    ref?: ExpectationRef;
    text: string;
  }>;
  items: string[];
  uncertainties: string[];
  reason?: string;
}
```

约束：

- 首次提交时 `baseRevision` 必须为 `null`，`reason` 可省略。
- 修订时 `baseRevision` 必须等于当前 revision，且 `reason` 必填。
- 继续存在的验证点保留 `ref`；新增点省略 `ref`，由 Runtime 分配。
- 已退休的 ref 不允许复用。
- Case Model 仍采用完整快照，不引入字段级 patch。
- expectation result 只能引用当前 Case Model 已经存在的 ref；新分配 ref 从 plan 响应取得，在后续 recordResult 中使用。

最后一条保留了现有单调分配规则，避免引入临时引用解析。修改已有 ref 的文本后，旧 semantic hash 对应结果失效；Agent 必须基于新语义重新调用 recordResult。

### 5.6 VisualObservation

```typescript
interface VisualObservation {
  observation: string;
  expectationRefs?: ExpectationRef[];
}
```

`visual` 永远绑定外层 `basedOnSceneRef`。调用者必须已经实际打开该 Scene 的截图。Runtime 校验截图身份、摘要和文件有效性，但不判断 observation 的业务含义。

同一 submission 的重复 visual 写入按 submissionId 幂等去重。不同 submission 对同一 Scene 提交不同 observation 时允许追加新的 `visualInspected` 事件，以保留补充事实；完全相同的 observation 和 expectationRefs 可以直接返回 idempotent，不追加重复事件。

### 5.7 ExpectationResultInput

```typescript
interface ExpectationResultInput {
  expectationRef: ExpectationRef;
  status: ExpectationStatus;
  actual: string;
  evidence?: {
    sceneRefs?: SceneRef[];
    knowledgeRefs?: KnowledgeRef[];
    technicalRefs?: TechnicalFactRef[];
    searchAbsence?: {
      sceneRef: SceneRef;
      scrollContextRef: string;
    };
  };
}
```

提交结果不等于结果已经完整。Runtime 接受 Agent 已形成的业务判断并立即计算 closure 状态：

- PASS、FAIL 没有 Scene 证据时保存判断，但标记 `EVIDENCE_REQUIRED`。
- FAIL、INCONCLUSIVE 或没有有效 technical fact 的 BLOCKED 未完成知识调查时标记 `KNOWLEDGE_REQUIRED`。
- 引用 Scene 尚未视觉登记时标记 `VISUAL_INSPECTION_REQUIRED`。
- 搜索不存在但覆盖证据不完整时标记 `SEARCH_COVERAGE_REQUIRED`。
- 未知引用、退休验证点和不属于当前 execution 的证据直接拒绝，不写入 ledger。

这种区分允许 Agent 先保存判断，再在后续正常决策中补齐证据，同时不会降低最终 `finish` 的完整性要求。

## 6. Coordinator 方法签名

Coordinator 保持四个公开方法，不增加批次内部方法。

### 6.1 prepareRun

```typescript
prepareRun(input: {
  capability: "prepareRun";
  workspace: string;
  caseNos: string[];
}): CoordinatorResult;
```

- `workspace` 必须为用户指定测试工作空间的绝对路径。
- `caseNos` 至少一个，保持用户顺序并去重校验。
- 可能返回 `NEED_USER_CONFIRMATION` 或输入错误。
- 副作用是创建 Coordinator run 状态；相同 workspace、caseNos 不保证自动复用既有 run。

### 6.2 confirmRun

```typescript
confirmRun(input:
  | {
      capability: "confirmRun";
      decision: "USE_CURRENT";
      userInstruction: string;
    }
  | {
      capability: "confirmRun";
      decision: "SELECT_PLATFORM";
      platform: "harmony" | "android" | "ios";
      deviceId?: string;
    }
  | {
      capability: "confirmRun";
      decision: "CONFIRM_BINDING";
      userInstruction: string;
      binding: TargetBinding;
    }
): CoordinatorResult;
```

- 三个 decision 是互斥分支，禁止跨分支字段。
- `deviceId` 仅在当前平台存在多个可用设备且响应明确要求时提供。
- `binding` 必须来自当前探测事实，并补齐响应中明确列出的用户字段。
- Runtime 可以返回当前可选平台、设备和 binding 动态事实，但不返回调用 template。

### 6.3 advanceRun

```typescript
advanceRun(input: {
  capability: "advanceRun";
}): CoordinatorResult;
```

- 推进或恢复当前 run 的确定性状态机。
- 可能返回 `NEED_USER_CONFIRMATION`、`NEED_CASE_AGENT`、`WAITING`、`TECHNICAL`、`COMPLETE` 或 `BLOCKED`。
- 长时间运行时宿主必须等待同一进程，不重复发起 advance。

### 6.4 cancelRun

```typescript
cancelRun(input: {
  capability: "cancelRun";
  reason: string;
}): CoordinatorResult;
```

- 仅在用户明确取消时调用。
- 取消不覆盖已经持久化的 execution 结果。
- 返回 `COMPLETE` 或 `BLOCKED`。

## 7. Case Runtime 方法签名

### 7.1 observe

```typescript
observe(input: {
  capability: "observe";
  purpose?: string;
}): SceneResult;
```

- observe 只采集一次新 Scene，不执行业务动作。
- 三端核心可见通道按控件树、截图顺序采集，并返回 `captureTiming` 事实。

### 7.2 inspect

```typescript
inspect(input:
  | {
      capability: "inspect";
      basedOnSceneRef: SceneRef;
      channel: "visual" | "action";
      observation: string;
      expectationRefs?: ExpectationRef[];
    }
  | {
      capability: "inspect";
      basedOnSceneRef: SceneRef;
      channel: "elements";
      filter?: {
        interactiveOnly?: boolean;
        textContains?: string;
        role?: string;
      };
    }
  | {
      capability: "inspect";
      basedOnSceneRef: SceneRef;
      channel: "layout";
    }
): InspectionResult;
```

- `visual` 和 `action` 是事实登记，要求 observation。
- `elements` 和 `layout` 是按需读取，不产生设备观察。
- inspect 响应不再附加整份默认 Scene，也不返回 example。

### 7.3 plan

```typescript
plan(input: {
  capability: "plan";
  caseModel: CaseModelUpdate;
}): CaseModelResult;
```

`plan` 是创建或修订 Case Model 的唯一能力。首次模型不需要理由；后续提交完整新版本并说明修改理由。

### 7.4 recordResult

```typescript
recordResult(input: {
  capability: "recordResult";
  results: ExpectationResultInput[];
}): RecordResultResult;
```

- 一次可登记一个或多个验证点结果。
- Runtime 先校验整批结果；任一条无效时整批不写入。
- 与当前 ledger 完全相同的重复结果幂等返回。
- 本能力不采集 Scene、不执行设备动作、不结束 execution。

### 7.5 act

```typescript
act(input: {
  capability: "act";
  basedOnSceneRef: SceneRef;
  actionRef: ActionRef;
  purpose: string;
  input?: ActionInput;
}): SceneResult;
```

- `basedOnSceneRef` 必须等于当前 Scene；否则返回 `SCENE_CHANGED` 且不执行动作。
- 一个请求只允许一个 actionRef。
- act 完成后自动采集并返回新 Scene。
- visual action 要求该 Scene 已经通过 inspect 登记视觉事实。
- 响应返回请求坐标、投递坐标、可选设备实际触点和动作前标注图，不解释是否命中业务目标。

`ActionInput`：

```typescript
interface ActionInput {
  text?: string;
  mode?: "replace" | "append";
  durationMs?: number;
  duringActionAtMs?: number;
  ms?: number;
  point?: [number, number];
  from?: [number, number];
  to?: [number, number];
}
```

字段仍按 actionRef 条件必填，未声明字段一律拒绝。坐标为 0 到 1 的归一化值。

### 7.6 knowledge

```typescript
knowledge(input:
  | {
      capability: "knowledge";
      basedOnSceneRef: SceneRef;
      query: string;
      expectationRefs?: ExpectationRef[];
    }
  | {
      capability: "knowledge";
      basedOnSceneRef: SceneRef;
      queryId: string;
      conclusion: "APPLICABLE_FOUND" | "NO_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT";
      assessments: Array<{
        entryId: string;
        status: "APPLICABLE" | "NOT_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT";
        reason: string;
      }>;
    }
): KnowledgeResult;
```

- query 和 queryId 两种模式互斥。
- 查询结果返回候选事实和 queryId，不返回下一次调用 example。
- 复核模式必须覆盖当前 query 的候选约束；解决办法由错误码链接到文档。

### 7.7 recover

```typescript
recover(input: {
  capability: "recover";
  basedOnSceneRef?: SceneRef;
  reason: string;
  targetState?: "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL";
  externalAction?: {
    summary: string;
    tool?: string;
  };
}): RecoveryResult;
```

- targetState 与 externalAction 互斥。
- App 重启恢复有当前 Scene 时必须提供 `basedOnSceneRef`。
- externalAction 只登记已经实际完成的框架外事实，固定 `evidence=false`。
- 响应返回恢复事实或错误原因，不返回 nextCall example。

### 7.8 finish

```typescript
finish(input: {
  capability: "finish";
  summary: string;
  uncertainties?: string[];
}): FinishResult;
```

- finish 不再接收全量 `checks`。
- finish 不接收视觉事实、验证点结果或 Case Model 修订；这些内容分别通过 inspect、recordResult 和 plan 提交。
- Runtime 从当前 expectation ledger 构造完整 CaseResult，并执行现有全量证据完整性校验。
- 存在 unresolved 或 conflicts 时返回 `RESULT_INCOMPLETE`，execution 保持可写。
- 全部闭环后执行现有可恢复 finish 事务并返回 `COMPLETED`。

## 8. 精简 Scene 投影

### 8.1 默认结构

```typescript
interface AgentScene {
  sceneRef: SceneRef;
  capturedAt: string;
  screenshot: {
    ref: string;
    path: string;
    width: number;
    height: number;
  };
  targetApp: {
    inForeground: boolean;
    actualApp?: string;
  };
  controls: {
    total: number;
    truncated: boolean;
    items: ControlFact[];
  };
  interactionContext: {
    verticalScroll: boolean;
    horizontalScroll: boolean;
    focusedElementRef?: ElementRef;
    keyboardShown: boolean;
    visualGestures: VisualGesture[];
  };
  signals?: Record<string, unknown>;
  conflicts?: Array<Record<string, unknown>>;
  previousAction?: PreviousActionSummary;
}
```

默认不返回 `caseModel`、`plan`、`finish`、`inspect`、`capabilities`、`actions`、`actions[].example`、完整 layout、完整滚动上下文或稳定 evidence policy。

### 8.2 ControlFact

```typescript
interface ControlFact {
  ref: ElementRef;
  text?: string;
  role?: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  checkable: boolean;
  editable: boolean;
  focused?: boolean;
}
```

默认只包含 visible、enabled 且 clickable、checkable 或 editable 的控件。`controls.items` 最多返回前 24 个稳定排序项；超过上限时 `truncated=true`，Agent 使用 `inspect(elements)` 过滤获取完整事实。

控件顺序按布局观察的稳定顺序保留，不按文本重新排序，避免同一 Scene 投影抖动。

### 8.3 动态字段裁剪

- `signals` 为空时省略，只保留影响当前判断的非空信号。
- `conflicts` 为空时省略。
- `actualApp` 仅在目标 App 不在前台时返回。
- screenshot 不向 Agent 返回 sha256；摘要继续保存在内部 Scene 和证据图中。
- previousAction 只返回动作类型、投递状态、结果是否已知、整屏变化及可选标注图引用。

```typescript
interface PreviousActionSummary {
  operationRef: string;
  type: string;
  deliveryStatus: "NOT_SENT" | "DISPATCHED" | "RESULT_RECORDED" | "UNKNOWN";
  outcomeKnown: boolean;
  screenComparison: ScreenComparison;
  spatialEvidence?: {
    available: true;
    annotatedScreenshotPath: string;
  };
}
```

以上均是设备和证据事实，不包含“操作成功”“命中目标”等业务判断。

### 8.4 按需展开

| 内容 | 获取方式 |
|---|---|
| 完整控件树 | `inspect(channel="elements")` |
| 原始 layout | `inspect(channel="layout")` |
| 上一动作落点/轨迹 | 打开 previousAction 标注图，再 `inspect(channel="action")` 登记 |
| 完整 Scene、摘要、滚动上下文 | 仅 Runtime 内部或由特定 inspect 返回 |

inspect 响应只返回所请求的 projection，不重新附加默认 Scene。

## 9. ActionRef 构造和校验

### 9.1 稳定编码

```text
控件动作：<elementRef>:<actionType>
全局动作：screen:<actionType>
视觉动作：visual:<gesture>
```

示例只存在于 `references/case-runtime.md`：

```text
button-1:tap
input-2:inputText
screen:swipeUp
visual:longPress
```

### 9.2 控件属性映射

映射规则与当前 `capability-catalog.js` 保持一致：

| 控件事实 | 可构造动作 |
|---|---|
| clickable | tap、doubleTap、longPress |
| checkable | tap、toggle |
| editable | tap、inputText |

多个属性成立时取并集。Agent 不需要拿到每个动作的展开目录。

### 9.3 全局动作映射

- `screen:swipeUp`、`screen:swipeDown`：存在可用纵向区域时可用；无识别容器时 Runtime 仍按当前全屏规则处理。
- `screen:swipeLeft`、`screen:swipeRight`：只有 `interactionContext.horizontalScroll=true` 时可用。
- `screen:back`、`screen:home`、`screen:wait`：按平台和 execution 策略校验。
- `screen:dismissKeyboard`：仅平台支持且 `keyboardShown=true` 时可用。
- `screen:inputText`：不存在目标级 inputText，且存在焦点或键盘事实时可用。

### 9.4 视觉动作

`visual:*` 是否可用由 `interactionContext.visualGestures` 给出。视觉动作提交前，该 Scene 必须已经存在有效 visual inspection。

### 9.5 Runtime 校验

Facade 根据当前完整 Scene 重建内部 capabilities，并将 actionRef 映射到带 Scene 身份的 capabilityId。以下情况返回 `ACTION_NOT_AVAILABLE`，且不得执行设备动作：

- elementRef 不存在、不可见、禁用或属性不再支持 actionType。
- 全局动作的动态前提不成立。
- visual gesture 不在当前 Scene 的允许集合。
- action input 与动作类型不匹配。

错误响应只说明 actionRef 不适用于当前 Scene，并指向错误目录中的对应章节；不返回完整替代动作目录。

## 10. 单一职责提交与恢复

### 10.1 能力边界

| 能力 | 唯一写入或 effect |
|---|---|
| plan | Case Model revision |
| inspect | visual/action inspection fact |
| recordResult | expectation result event |
| observe | 新 Scene |
| act | 一个设备动作和动作后 Scene |
| knowledge | query 或 review 事实 |
| recover | 恢复 effect 或外部处置声明 |
| finish | 最终结果和 execution 收口 |

`observe`、`act` 和 `finish` 不接受 `updates`。请求失败时不会隐式保存另一类业务事实；Agent 根据当前事实选择是否单独调用 plan、inspect 或 recordResult。

### 10.2 事务边界

通用 `decision-*.draft.json` 已删除。Runtime 只为真正需要防止重复 effect 的动作、准备、恢复和 finish 使用专用事务：

```text
transactions/action-<id>.draft.json
transactions/preparation.draft.json
transactions/recovery.draft.json
transactions/finish.draft.json
```

plan、inspect 和 recordResult 在 execution 锁内先完整校验，再追加事实事件；recordResult 的批量输入为全有或全无，并对完全相同的当前结果幂等。

### 10.3 失败语义

- 请求结构、execution 或 dispatch 绑定无效：拒绝当前请求且不写业务事实。
- act 的 Scene、ActionRef 或 input 无效：不执行设备动作，Agent 可先 inspect/observe 后重试修正后的动作。
- effect 已 dispatch 且结果未知：返回 `ACTION_OUTCOME_UNKNOWN` 和当前事实，不自动重放。
- action 已完成并产生新 Scene但响应丢失：专用 action 事务恢复现有结果，不能再次执行动作。
- ledger 不完整：finish 返回 `RESULT_INCOMPLETE`；Agent使用 inspect、knowledge 或 recordResult 补齐后再 finish。

## 11. Expectation Result Ledger

### 11.1 事实来源

Ledger 的权威事实仍是追加事件，不新增 Agent 可编辑结果文件。新增事件：

```text
expectationResultUpdated
expectationResultInvalidated
```

`expectationResultUpdated` 保存：

```typescript
interface ExpectationResultEvent {
  resultUpdateId: string;
  submissionId: string;
  expectationRef: ExpectationRef;
  status: ExpectationStatus;
  actual: string;
  evidence: NormalizedEvidence;
  caseModelRevision: number;
  expectationSemanticHash: string;
  closure: {
    state: "RESOLVED" | "UNRESOLVED";
    reasons: string[];
  };
  decisionId?: string;
  basedOnSceneRef?: SceneRef;
}
```

同一 expectation 的后续更新追加新事件，不覆盖历史。当前值由“当前 semantic hash 下最后一个有效更新”投影。

如果新提交与当前有效结果的 status、actual、evidence 和 semantic hash 完全相同，Runtime 返回 idempotent receipt，不追加重复事件；任一字段变化都追加新 revision 事件。

事件中的 `closure` 是提交当时的诊断快照，不是永久状态。当前 ledger 投影必须根据最新 Scene、visual inspection、knowledge review、technical fact 和滚动覆盖事件重新计算 closure。后续证据补齐后，既有业务判断可以自动从 unresolved 变为 resolved，不要求 Agent 重复提交相同 status 和 actual。

### 11.2 Semantic hash

semantic hash 使用固定前缀 `expectation-semantic`：

```text
sha256(canonicalJson({ text: normalize(text) }))
```

`normalize(text)` 只统一换行、去除首尾空白，不做大小写转换或自然语言同义判断。业务语义字段变化属于契约变更，必须同步修改接口定义、文档和 protocol SHA。

### 11.3 Case Model 修订规则

| 修订结果 | Ledger 处理 |
|---|---|
| ref 保留且 semantic hash 相同 | 结果继续有效 |
| ref 保留但 semantic hash 改变 | 追加 `expectationResultInvalidated(reason=SEMANTICS_CHANGED)` |
| ref 被移除 | 追加 `expectationResultInvalidated(reason=EXPECTATION_RETIRED)`，只保留历史 |
| 新增 ref | 状态为 unresolved，原因 `RESULT_MISSING` |
| 只修改 plan items、understanding 等非验证点语义 | 不使结果失效 |

Runtime 不判断两段自然语言是否“意思差不多”。文本发生规范化后仍不同，就视为语义变化并要求 Agent 重新确认。

### 11.4 当前投影

每次 Case Runtime 成功响应返回小型状态摘要：

```typescript
interface CaseStateSummary {
  caseModelRevision: number | null;
  expectations: {
    active: number;
    resolved: number;
    unresolved: ExpectationRef[];
    conflicts: ExpectationRef[];
  };
}
```

仅当本次更新了 Case Model 时额外返回：

```typescript
interface CaseModelChange {
  revision: number;
  assignedRefs: Array<{ index: number; ref: ExpectationRef }>;
  retiredRefs: ExpectationRef[];
  invalidatedResultRefs: ExpectationRef[];
}
```

响应不重复返回完整 Case Model。

### 11.5 unresolved 与 conflicts

`unresolved` 表示 Agent 已提交或尚未提交的判断还不能进入最终结果，原因包括：

```text
RESULT_MISSING
SEMANTICS_CHANGED
EVIDENCE_REQUIRED
KNOWLEDGE_REQUIRED
VISUAL_INSPECTION_REQUIRED
SEARCH_COVERAGE_REQUIRED
```

`conflicts` 表示持久化事实之间存在确定性矛盾，需要 Agent 或技术调查处理，例如：

```text
SCENE_EVIDENCE_CHANGED
KNOWLEDGE_REFERENCE_INVALIDATED
TECHNICAL_FACT_NO_LONGER_VALID
RESULT_STATUS_EVIDENCE_CONFLICT
```

结构错误、未知 ref 和跨 execution 引用不是 unresolved/conflict，而是当前请求错误，直接拒绝。

## 12. finish 状态机

### 12.1 收口前投影

Runtime 从当前 Case Model 和 ledger 生成：

```typescript
interface FinishReadiness {
  ready: boolean;
  resolved: ExpectationRef[];
  unresolved: Array<{
    expectationRef: ExpectationRef;
    reasons: string[];
  }>;
  conflicts: Array<{
    expectationRef: ExpectationRef;
    codes: string[];
  }>;
}
```

### 12.2 完成条件

finish 只有同时满足以下条件才进入现有 finalization 事务：

1. 当前 Case Model 存在且至少一个 ACTIVE 验证点。
2. 每个 ACTIVE 验证点在当前 semantic hash 下恰好有一个当前结果。
3. readiness 中 unresolved 和 conflicts 均为空。
4. Runtime 从 ledger 投影出的 CaseResult 通过现有 `validateResultIntegrity()` 全量校验。
5. 汇总结论等于 checks 聚合结果。

最终 CaseResult 仍包含完整 checks 和 `caseModelRevision`，只是由 Runtime 从 ledger 组装，不再要求 Agent 在 finish 请求中重传。

### 12.3 RESULT_INCOMPLETE

未满足完成条件时返回：

```typescript
interface FinishIncomplete {
  status: "RESULT_INCOMPLETE";
  code: "CASE_RESULT_INCOMPLETE";
  readiness: FinishReadiness;
  caseState: CaseStateSummary;
  documentationRef: "references/case-runtime/errors.md#error-case-result-incomplete";
}
```

响应只说明未决事实，不生成补齐请求、retryWith 或 finish example。Agent 根据方法文档和当前业务判断决定下一步。

### 12.4 COMPLETED

完成响应只返回：

```typescript
interface FinishCompleted {
  status: "COMPLETED";
  executionRef: string;
  verdict: ExpectationStatus;
  resultRef: string;
  idempotent?: boolean;
}
```

不在 Agent-facing 响应中回传完整 result.json；完整结果已经持久化，Coordinator 和报告按引用读取。

## 13. 响应协议

### 13.1 成功响应

所有响应保留顶层 `status`，避免无收益的 envelope 重构。通用可选字段：

```typescript
interface AgentFacingSuccess {
  protocol: "agent-facing";
  status: string;
  scene?: AgentScene;
  caseState?: CaseStateSummary;
  caseModelChange?: CaseModelChange;
}
```

响应不允许出现以下静态说明字段：

```text
capabilities
actions
example
template
usage
useWhen
required
optional
source
returns
retryWith
nextCall
technicalContext.resume
```

### 13.2 错误响应

```typescript
interface AgentFacingError {
  protocol: "agent-facing";
  status: "INPUT_INVALID" | "SCENE_CHANGED" | "TECHNICAL" | "RESULT_INCOMPLETE" | "AGENT_INPUT_STALLED";
  code: string;
  message: string;
  retryable: boolean;
  issues?: Array<{
    field: string;
    code: string;
    message: string;
  }>;
  facts?: Record<string, unknown>;
  scene?: AgentScene;
  caseState?: CaseStateSummary;
  documentationRef: string;
}
```

允许返回具体失败原因和相关当前事实；禁止返回解决步骤或可复制请求。`message` 描述本次为什么失败，`documentationRef` 指向稳定解决办法。

`retryable=true` 只表示在状态变化或请求修正后可以再次调用，不表示允许宿主自动重放同一请求。`ACTION_OUTCOME_UNKNOWN` 永远不得自动重试 act。

### 13.3 文档引用格式

```text
references/<service>/errors.md#error-<lowercase-kebab-code>
```

例如：

```text
references/case-runtime/errors.md#error-scene-changed
references/case-runtime/errors.md#error-action-not-available
references/coordinator/errors.md#error-environment-not-ready
```

文档生成器必须为每个公开错误码生成对应锚点。CI 检查 response 定义引用的所有 code 均存在于服务文档。

### 13.4 稳定公开错误码

Facade 必须把内部异常映射为以下稳定公开 code；内部诊断可以作为 facts 返回，但不能迫使 Agent 理解内部 operation 名称。

共享错误：

| code | retryable | 含义 |
|---|---:|---|
| `AGENT_INPUT_INVALID` | true | 请求结构、类型或条件字段错误 |
| `AGENT_INPUT_STALLED` | false | 同类输入错误连续发生，停止自动猜测 |
| `PROTOCOL_MISMATCH` | false | Prompt、文档、客户端或 execution 协议版本不一致 |
| `BINDING_INVALID` | false | execution、Coordinator state 或 dispatch 绑定无效 |

Case Runtime 错误：

| code | retryable | 含义 |
|---|---:|---|
| `SCENE_REQUIRED` | true | 当前方法需要 Scene，但 execution 尚无 Scene |
| `SCENE_CHANGED` | true | basedOnSceneRef 已过期，必须重新查看当前 Scene |
| `ACTION_NOT_AVAILABLE` | true | actionRef 对当前 Scene 不成立 |
| `ACTION_INPUT_INVALID` | true | 动作输入缺失、越界或包含不支持字段 |
| `VISUAL_INSPECTION_REQUIRED` | true | 当前视觉动作或结论要求先登记图片事实 |
| `CASE_MODEL_REQUIRED` | true | 当前 execution 尚无 Case Model |
| `CASE_MODEL_REVISION_CONFLICT` | true | baseRevision 不是当前 revision |
| `EXPECTATION_UNKNOWN` | true | expectationRef 不属于当前 ACTIVE 模型 |
| `EVIDENCE_REFERENCE_INVALID` | true | Scene、知识、技术或滚动证据引用无效 |
| `KNOWLEDGE_QUERY_UNKNOWN` | true | queryId 不存在或不属于当前 execution |
| `KNOWLEDGE_REVIEW_INVALID` | true | 知识候选复核不满足当前 query 约束 |
| `APP_INITIAL_STATE_UNAVAILABLE` | 取决于 facts | 授权的初始状态准备未完成 |
| `ACTION_OUTCOME_UNKNOWN` | false | 动作可能已经投递，禁止重放 |
| `CASE_RESULT_INCOMPLETE` | true | ledger 仍有 unresolved 或 conflicts |
| `TIME_LIMIT` | false | 已停止新的设备动作，但仍允许调查已有事实和 finish |
| `CASE_RUNTIME_TECHNICAL` | 取决于 facts | 未归类的 execution 技术异常 |

Coordinator 错误：

| code | retryable | 含义 |
|---|---:|---|
| `COORDINATOR_INPUT_INVALID` | true | Coordinator 请求字段错误 |
| `COORDINATOR_STATE_INVALID` | false | Coordinator run 状态缺失、损坏或绑定不一致 |
| `DECISION_NOT_ALLOWED` | true | confirm decision 不适用于当前阶段 |
| `ENVIRONMENT_NOT_READY` | true | 平台、设备或 App 探测未就绪 |
| `IOS_SIGNING_REQUIRED` | true | iOS 真机绑定缺少明确签名字段 |
| `INPUT_CAPABILITY_NOT_READY` | true | 设备输入能力准备尚未完成 |
| `BATCH_BLOCKED` | false | 批次存在不可自动恢复的终态阻塞 |
| `COORDINATOR_TECHNICAL` | 取决于 facts | 未归类的批次级技术异常 |

`取决于 facts` 时必须在本次响应中给出实际 boolean，不能省略 retryable。

## 14. 传输设计

### 14.1 Case Runtime stdin

正常 Shell 路径使用现有 stdin 能力，一次宿主工具调用完成请求：

```bash
<runtime.command> <<'MAVT_REQUEST'
{"capability":"observe"}
MAVT_REQUEST
```

Case Runtime 只从 stdin 接收 Agent 请求，不创建或读取 requestPath。

使用带引号的 heredoc，避免 JSON 中 `$`、反引号和换行被 Shell 展开。文档不推荐直接拼接未经转义的 `echo '<json>'`。

### 14.2 Coordinator 传输

Coordinator 调用频率低，不是本轮主要性能瓶颈。当前实现保留现有 prepare/advance CLI 和 confirm/cancel 绑定命令，只把准确签名移入 `references/coordinator.md` 并移除响应 template。

如果后续统一 Coordinator stdin，其 JSON Schema 必须复用同一公开接口定义，不能创建第二套参数格式。

### 14.3 MCP

MCP 工具直接使用公开 requestSchema，execution 和 dispatch 绑定由工具注册上下文注入，Agent 不传内部 ID。MCP 只是 transport adapter：

- 不改变八个 Case Runtime 方法。
- 不新增业务意图执行器。
- 不绕过 Facade 校验、Runtime 锁、事务或审计。
- Shell 和 MCP 必须通过同一组 contract tests。

## 15. Prompt、Brief 与文档

### 15.1 Case Agent Prompt

`prompts/case-agent.md` 只保留：

- Case Agent 的职责和权限边界。
- “看图、决策、操作、再看图”的因果原则。
- 何时必须查看图片、调查知识和处理技术异常。
- `references/case-runtime.md` 的路径。
- 启动时只读取 `references/case-runtime.md` 快速索引，不预读方法页和错误目录。
- 只有紧凑签名不足以构造当前调用时才读取对应方法页；收到错误时只读取 `documentationRef` 指向的错误章节。
- stdin 是正常调用路径。

移除逐方法字段教程、复制 example 指令、requestPath 工作流、retryWith/nextCall/resume 机制说明。

### 15.2 Case Brief

Case Brief 的 runtime binding 只交付：

```typescript
interface CaseBriefRuntimeBinding {
  interfaceKind: "AGENT_FACING";
  protocol: "agent-facing";
  command: string;
  documentation: "references/case-runtime.md";
}
```

不再交付 capability cards、input 教程、requestPath 或 Scene 方法 example。完整原始用例和当前 Scene 仍正常交付；首次或 continuation 启动时，Brief 可以一次性交付当前完整 Case Model，保证新 Case Agent 能恢复业务上下文。进入正常调用后，Runtime 响应只返回 revision、CaseModelChange 和 expectation 摘要，不重复返回完整模型。

### 15.3 文档分层和体积预算

生成文档按“启动索引、方法详情、专题规则、错误恢复”拆分：

```text
references/
├── case-runtime.md                    # Case Agent 启动必读短索引
├── case-runtime/
│   ├── methods/
│   │   ├── observe.md
│   │   ├── inspect.md
│   │   ├── plan.md
│   │   ├── act.md
│   │   ├── knowledge.md
│   │   ├── recover.md
│   │   └── finish.md
│   ├── action-refs.md
│   └── errors.md
├── coordinator.md                     # 主 Agent 启动必读短索引
└── coordinator/
    ├── methods/
    │   ├── prepare-run.md
    │   ├── confirm-run.md
    │   ├── advance-run.md
    │   └── cancel-run.md
    └── errors.md
```

启动索引只包含：

- 方法名和一行用途。
- 可直接构造常用调用的紧凑签名。
- 动态参数从哪类运行时事实取得。
- 指向方法详情、ActionRef 规则和错误目录的链接。

启动索引不包含完整错误恢复说明、每个方法的全部状态表、长示例或内部原理。硬预算：

| 文档 | 单文件预算 | 启动时读取 |
|---|---:|---:|
| `references/case-runtime.md` | 不超过 6 KiB 且不超过 160 行 | 是 |
| `references/coordinator.md` | 不超过 4 KiB 且不超过 120 行 | 是 |
| 单个方法页 | 不超过 5 KiB | 否，按需 |
| `action-refs.md` | 不超过 6 KiB | 否，首次构造不熟悉动作时读取 |
| 单个 `errors.md` | 不超过 16 KiB | 否，只读错误码对应章节 |

Case Runtime 全部生成文档不超过 64 KiB，Coordinator 全部生成文档不超过 32 KiB。`build-agent-facing-docs.js --check` 同时检查 UTF-8 字节数、行数、链接、锚点和重复段落。超过预算视为协议测试失败，不能通过把同一说明复制到多个页面解决。

### 15.4 Coordinator 文档入口

`SKILL.md` 引用 `references/coordinator.md`，主 Agent 启动时只读取该短索引。Workspace Bootstrap 可以一次性返回绑定状态和文档路径，但不返回完整 capability cards。方法详情和错误处理同样按需读取。

### 15.5 protocol SHA

`agent-contract-manifest.js` 的 role resources 增加：

```text
case-executor:
  prompts/case-agent.md
  references/case-runtime.md
  references/case-runtime/methods/*.md
  references/case-runtime/action-refs.md
  references/case-runtime/errors.md

batch-coordinator:
  SKILL.md
  references/coordinator.md
  references/coordinator/methods/*.md
  references/coordinator/errors.md
```

上表的 `*.md` 表示 manifest 构建时展开后的确定文件列表，不允许 protocol digest 直接依赖运行时 glob 顺序。所有资源参与版本绑定，但 Agent 启动时只读取各角色的短索引。

`build-agent-contract.js` 还必须把对应公开接口定义的 canonical JSON 纳入 protocol digest。以下任一变化必须改变 protocol SHA：

- 方法签名或条件约束。
- 公开返回状态或错误码。
- ActionRef 映射规则。
- 文档中的恢复规则。
- Prompt 的角色协议。

只修改内部实现且不改变公开行为时，只改变 implementation SHA。

## 16. 部署约束

### 16.1 单一契约边界

- Execution 只使用 schema 12 和 `agent-facing`。
- Reader、Writer、Batch、Report 和 Facade 只接受当前 execution schema。
- Case Runtime 只提供 Agent-facing Facade 和 MCP 两个入口，不保留旧 Runtime Client。
- Shell 入口只接受 stdin；ActionRef 只由控件事实和文档规则构造。

### 16.2 分阶段落地

1. 建立公开接口定义、两份启动短索引、按需文档集和 `--check` 一致性及体积预算测试，暂不改变行为。
2. Case Agent 路径改用 stdin，并删除 requestPath。
3. 移除成功和错误响应中的静态说明字段，启用统一错误文档锚点。
4. 上线精简 Scene 和 ActionRef 映射校验，删除 capabilities inspect。
5. 上线独立 plan、inspect、recordResult 和 expectation ledger，execution schema 升到 12。
6. 切换 finish 为 ledger 收口，保留并复用完整 `validateResultIntegrity()`。
7. 稳定后发布 MCP transport；Shell 在本协议范围内继续作为受支持入口，移除 Shell 不属于本设计范围。

阶段 1 必须早于阶段 3，保证 Agent 在响应说明被移除前已经拥有可查询的签名文档。

### 16.3 发布

- protocol SHA、公开接口定义、生成文档和实现必须在同一次发布中切换。
- 部署前结束活动 batch，避免进程持有已删除入口或旧契约摘要。
- 不通过转换事件或手工编辑 result 的方式绕过当前契约。

## 17. 实现映射

| 设计内容 | 主要实现位置 |
|---|---|
| Coordinator 定义与文档元数据 | `scripts/coordinator/agent-facing-contract.js` |
| Case Runtime 定义与文档元数据 | `scripts/case-runtime/agent-facing-contract.js` |
| 文档生成和一致性检查 | 新增 `scripts/build-agent-facing-docs.js` |
| stdin 正常路径 | `prompts/case-agent.md`、`scripts/case-runtime/lifecycle.js` |
| 精简 Scene 投影 | `scripts/case-runtime/agent-facing-contract.js` |
| ActionRef 校验和内部映射 | `scripts/case-runtime/agent-facing-translator.js` |
| 单一职责请求翻译 | `scripts/case-runtime/agent-facing-translator.js`、`runtime-core.js` |
| expectation ledger | 新增 `scripts/case-runtime/expectation-result-service.js` |
| Case Model 失效规则 | `scripts/case-runtime/case-model-service.js` |
| finish ledger 收口 | `scripts/case-runtime/result-service.js`、`result-integrity.js` |
| 文档与 protocol SHA | `scripts/lib/agent-contract-manifest.js`、`scripts/build-agent-contract.js` |
| Coordinator 静态响应清理 | `scripts/coordinator/agent-facing-service.js`、`coordinator-agent.js` |
| Case Runtime 静态响应清理 | `scripts/case-runtime/agent-facing-translator.js`、`agent-facing-client.js` |

内部 Runtime operation contract 提供 Facade 所需的确定性操作，不公开给 Agent。Adapter、Device Port 和平台脚本保持平台动作语义。

## 18. 自动化验证要求

### 18.1 接口和文档

- 11 个公开方法全部存在定义和文档章节。
- 每个参数的必填、可选、条件必填、类型、枚举和含义都可由定义生成。
- 每个公开错误码都有稳定文档锚点。
- `build-agent-facing-docs.js --check` 能发现生成文档漂移。
- 启动短索引、方法页、专题页、错误页和文档总量均满足 §15.3 的字节预算；Prompt 静态检查确保启动时不要求预读全部文档。
- 接口定义或服务文档变化会改变对应 protocol SHA。

### 18.2 响应瘦身

- 对所有成功和错误响应递归断言禁止字段不存在。
- 默认 Scene 不包含 actions、capabilities、example、Case Model 或稳定协议文本。
- 固定 fixture 下 Agent-facing Scene 大小设置字节预算；超过预算测试失败。
- inspect 只返回请求 projection，不附加默认 Scene。

### 18.3 ActionRef 等价性

- 使用 Android、HarmonyOS、iOS Scene fixture，对每个内部 capability 验证 ActionRef 映射后产生相同的内部设备动作。
- 控件 stale、Scene stale、输入缺失、视觉未登记和动态全局动作不可用时均不得调用 Adapter。
- visual、screen 和 element 三类动作分别覆盖。

### 18.4 专用 effect 事务

对以下中断点做故障注入并恢复：

```text
action dispatched
scene written
finish artifacts written
finish event written
execution finalized
```

验证设备动作不重复、未知结果不重放、finish 结果不可变、恢复响应可继续决策。

另外覆盖以下非中断分支：

- actionRef 拼错时 Adapter 未调用，且不隐式写视觉或验证结果。
- basedOnSceneRef 已不是 current Scene 时 act 返回 `SCENE_CHANGED` 且不执行动作。
- recordResult 任一项无效时整批不产生部分事件。
- 正常发布流不产生 `decision-*.draft.json`。

### 18.5 Ledger 和 finish

- 初始 Case Model 产生全部 unresolved。
- result update 后按证据闭环计算 resolved/unresolved。
- 只修改 plan 不使结果失效。
- 修改验证点文本使对应结果失效。
- 退休验证点不进入最终结果且历史仍在。
- 新增验证点阻止 finish，直至提交有效结果。
- 负向结论、技术 BLOCKED、搜索不存在和视觉登记继续满足现有完整性规则。
- finish 不接受全量 checks，最终 result.json 仍包含完整 checks 和 caseModelRevision。
- finish 中断恢复保持幂等和结果不可变。

### 18.6 传输

- Shell 入口只接受 stdin JSON。
- heredoc 中包含引号、中文、美元符号、反引号和换行时 JSON 不被 Shell 展开。
- MCP 上线后，同一请求 fixture 在 Shell 和 MCP 下通过同一契约测试。

## 19. 可观测性

Runtime telemetry 增加但不进入普通响应：

```text
requestBytes
responseBytes
sceneProjectionBytes
ledgerProjectionMs
documentationRefCount
hostTransport = stdin | mcp
```

现有 invocationCount、runtimeActiveMs、adapterActiveMs 和 agentAndSchedulingGapMs 继续保留。业务验收不在本文范围内，但这些指标必须能让后续验收区分：

- 宿主工具边界是否减少。
- 单次响应是否变小。
- plan、visual、verdict 的独立调用是否正确闭环。
- finish 的 Agent 准备长尾是否减少。

## 20. 已关闭的设计问题

- Runtime 不执行自由文本业务意图，只执行 Agent 指定的 act/observe/finish effect。
- Scene 不发布完整动作目录；Agent 根据控件事实和稳定文档规则构造 ActionRef。
- Case Model 继续使用完整快照，不引入 patch。
- 验证点语义失效采用确定性 hash，不使用模型判断同义关系。
- Ledger 以追加事件为权威事实，不提供 Agent 可编辑状态文件。
- finish 不再接收全量 checks，但最终完整性校验不降级。
- plan、inspect、recordResult 与设备 effect 保持单一职责边界。
- recordResult 批量提交全有或全无，重复提交相同当前结果保持幂等。
- 历史 Scene 的 visual 和 verdict 可以独立登记；act 的 current Scene 校验只约束设备 effect。
- Agent 启动只读有硬预算的服务短索引，方法详情、ActionRef 和错误恢复按需读取。
- Coordinator 不为统一形式强制改造 stdin，优先保持低频控制通道稳定。
- 所有 execution 读写只接受 schema 12，不保留并行格式。

## 21. 后续实施计划输入

本设计经用户审核后，实施计划需要按以下独立里程碑拆分：

1. 公开接口定义与服务文档。
2. stdin 与静态响应清理。
3. 精简 Scene 与 ActionRef 映射。
4. 独立 plan、inspect、recordResult 与专用 effect 事务。
5. Expectation ledger 与 finish 收口。
6. MCP transport。

每个里程碑必须先完成自身契约测试和故障恢复测试，再进入下一阶段。002、003 的业务验收不写入实施计划，由用户独立处理。

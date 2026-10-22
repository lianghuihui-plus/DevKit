# MAVT 新手使用指南

MAVT（Mobile AI Visual Test）用于对 HarmonyOS、Android 和 iOS App 进行 AI 黑盒视觉测试。你只需准备测试用例、设备和目标 App，然后用自然语言提出生成或执行请求；MAVT 会完成环境确认、界面操作、结果判断、证据保存和报告生成。

Codex 插件安装、三个 Skill 的选择及升级恢复见 [项目指南](../../README.md)。本页保留源模块的开发与环境准备说明；插件模式下，`<skill-root>` 使用启动响应的固定 `runtimeRoot`，不能使用插件 Skill 目录。编写用例选择 `mavt:author-cases`，执行选择 `mavt:run-tests`，维护知识选择 `mavt:manage-knowledge`；安装插件后人工停用同用途的旧独立 Skill，避免误触发旧入口。

## 1. 使用前准备

### 1.1 检测和安装依赖

skill 提供了依赖检测脚本。将 `<skill-root>` 替换为 `SKILL.md` 所在目录，选择本次要测试的平台：

```bash
# 只检测，不修改系统
bash <skill-root>/scripts/setup-dependencies.sh --platform android
bash <skill-root>/scripts/setup-dependencies.sh --platform harmony
bash <skill-root>/scripts/setup-dependencies.sh --platform ios

# 检测并尝试安装缺失依赖
bash <skill-root>/scripts/setup-dependencies.sh --platform android --install
bash <skill-root>/scripts/setup-dependencies.sh --platform ios --install
```

默认模式只输出检测结果。使用 `--install` 后，脚本会先显示安装计划并等待确认，然后调用当前系统可用的 Homebrew、APT、npm 或 `sdkmanager` 完成可自动处理的部分，安装结束后会重新检测。

Xcode、DevEco Studio、Apple Developer 签名等无法可靠自动安装或配置的依赖，脚本会给出人工处理说明。退出码 `0` 表示依赖已就绪，`1` 表示仍有依赖缺失或用户取消安装，`2` 表示参数错误。

脚本自身需要 Bash。MAVT 的通用运行环境还包括：

- Node.js，可通过 `node -v` 检查
- `perl`、`mktemp`、`sed`、`awk` 等基础命令
- iOS 测试必须使用 macOS

MAVT 的 Node.js 脚本只使用内置模块，不需要在 skill 目录执行 `npm install`。

```bash
node -v
bash --version
perl -v
```

### 1.2 安装平台依赖

只需安装本次测试平台对应的依赖，不需要同时准备全部平台。

| 测试平台 | 必需依赖 |
| --- | --- |
| Android | Android SDK Platform Tools、SDK Platform、SDK Build Tools 和 JDK |
| HarmonyOS | DevEco Studio 或 HarmonyOS Command Line Tools，以及可用的 `hdc`、`devecocli` |
| iOS 模拟器 | macOS、Xcode、Appium 和 Appium XCUITest Driver |
| iOS 真机 | iOS 模拟器依赖，以及 Apple Developer 签名能力和可用的 WebDriverAgent 配置 |

Android 还需设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`，并将 `platform-tools` 加入 `PATH`。iOS 可使用以下命令安装 Appium 驱动：

```bash
npm install -g appium
appium driver install xcuitest
```

### 1.3 准备设备和目标 App

目标 App 需要提前安装，设备应保持连接、解锁和可操作状态。按测试平台检查设备：

```bash
# Android：设备状态应为 device
adb devices

# HarmonyOS：命令应能识别目标设备
hdc list targets
devecocli device list

# iOS：检查 Xcode、Appium 和已启动的模拟器
xcodebuild -version
appium -v
appium driver list --installed
xcrun simctl list devices booted
```

iOS 真机还需要信任当前 Mac，并准备设备 UDID、App Bundle ID、Team ID、签名 ID 和 WDA Bundle ID。
Android 设备需要开启 USB 调试；HarmonyOS 设备需要支持 `uitest`、`screenCap`、`dumpLayout` 和 `aa dump`。

### 1.4 确认 Skill 可用

完成运行环境准备后，确认当前会话已经加载并能够识别 `mobile-ai-visual-test` skill。可以直接说明：

```text
请使用 mobile-ai-visual-test 处理这次移动端测试。
```

### 1.5 准备空目录

新建一个空目录，并将当前工作目录切换到该目录。例如：

```bash
mkdir -p ~/mavt-workspaces/my-app
```

这个空目录将在后续步骤中初始化为测试工作区。测试工作区和 skill 安装目录是两个不同的目录；不要直接在 skill 目录中执行项目测试。

### 1.6 准备人工测试用例

用例可以来自 Markdown、文本、Excel、CSV、PDF、图片或多个文件。内容至少应说明：

- 测试前置条件
- 操作步骤
- 预期结果

文件格式和文件数量不等于用例数量，MAVT 会根据内容识别可独立执行的测试场景。

## 2. 第一次使用

### 第一步：初始化测试工作区

进入准备好的空目录后，先提出初始化请求：

```text
请使用 mobile-ai-visual-test，在当前空目录初始化 MAVT 测试工作区。
```

初始化完成后，工作区会包含 `workspace.json`、`cases`、`knowledge`、`app-packages` 和 `index.html` 等基础内容。后续的用例、运行记录、截图和报告都会保存在这个工作区中。

### 第二步：生成测试用例

将原始用例文件放在当前会话可读取的位置，然后在测试工作区中提出请求：

```text
请使用 mobile-ai-visual-test，读取 /绝对路径/登录测试用例.xlsx，
在当前目录生成 MAVT 测试用例。
```

生成完成后，检查返回的用例数量、编号和标题是否符合预期。工作区根目录的 `index.html` 也会展示当前用例。

### 第三步：连接设备并执行

确认设备在线、目标 App 已安装后，指定用例编号和平台：

```text
请使用 mobile-ai-visual-test，在当前连接的 Android 设备上执行用例 001、002。
```

也可以只执行一条用例：

```text
执行 MAVT 用例 001，使用当前启动的 iOS 模拟器。
```

执行前，会先展示识别到的平台、设备和目标 App 信息。确认这些信息后，MAVT 才会开始操作设备。

### 第四步：等待执行完成

执行期间，MAVT 会逐条处理用例，自动完成界面操作、检查预期结果并保存截图证据。请保持设备连接，不要同时手动操作目标 App。

如果执行被环境问题阻塞，可以直接要求：

```text
请根据当前 MAVT 诊断恢复环境，并继续本次执行。
```

如需停止，直接发出“停止当前 MAVT 执行”的请求。

## 3. 查看测试结果

执行完成后，打开测试工作区根目录下的：

```text
index.html
```

首页展示最近一次执行的总体情况，并可按状态、平台或用例编号筛选。点击某条用例可查看：

- 最终结果和执行耗时
- 每个检查点的判断结果
- 实际操作步骤和执行轨迹
- 关键页面截图及证据
- 流程调整、异常和未确定事项

常见结果状态：

| 状态 | 含义 |
| --- | --- |
| 通过 | 所有适用检查点均已满足 |
| 失败 | 已确认 App 表现不符合用例预期 |
| 阻塞 | 设备、自动化服务或其他技术条件导致无法继续 |
| 无法判断 | 当前证据不足以得出明确结果 |
| 无法执行 | 必要执行条件无法建立，且测试尚未进入有效验证 |
| 已取消 | 用户主动停止了本次执行 |

“阻塞”表示技术问题，不等同于产品测试失败。应先查看报告中的原因和诊断，再决定恢复环境或重新执行。

## 4. 常用指令示例

```text
# 初始化工作区
使用 mobile-ai-visual-test，在当前空目录初始化 MAVT 测试工作区。

# 从文件生成用例
使用 mobile-ai-visual-test，把 /绝对路径/cases.xlsx 导入当前测试工作区。

# 执行单条用例
使用 MAVT 在当前 Android 设备上执行用例 003。

# 批量执行
使用 MAVT 在 HarmonyOS 设备上执行用例 001、002、003。

# 查看或汇报结果
汇总当前 MAVT 批次的结果，并告诉我测试报告的位置。

# 从中断处继续
继续当前工作区中尚未完成的 MAVT 执行。
```

## 5. 使用注意事项

- 保留整个测试工作区，以便查看历史记录、恢复中断任务和重新生成报告。
- 不要手动修改工作区中的执行状态、结果、截图或报告文件。
- 用例要求首次安装状态时，iOS 安装包应放入工作区的 `app-packages/ios` 目录；普通用例不需要重复放置或重装。
- Android、HarmonyOS 清除 App 数据或 iOS 卸载重装只会在用例确实需要对应初始状态时进行。
- 设备无法识别时，先检查平台命令是否能发现设备，再根据 MAVT 诊断继续处理。

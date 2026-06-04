# harmony-ui-test-runner

`harmony-ui-test-runner` 负责读取 YAML，在真实设备上执行 UI 操作和断言，并写入测试报告、运行状态和成功路径缓存。

## 什么时候使用

- 需要验证 `test-plans/*.yaml` 是否能在设备上稳定通过。
- 需要通过多次执行把用例从 `verified` 提升为 `trusted`。
- 需要记录成功路径，让重复执行更快、更稳。
- 需要在失败时由 Agent 读源码和实时 UI 状态自动判断修复策略。

## 输入

- `test-plans/*.yaml`。
- `explorations/<page>/exploration.md` 和 `layoutTree.json`。
- 可选的 `success-paths/*.jsonl`。
- `CONTEXT.md` 中的 Bundle、Product、代码仓库和全局记录。

## 输出

| 产物 | 说明 |
|------|------|
| `test-reports/<timestamp>.md` | 每轮执行报告 |
| `test-records.json` | 机器运行状态唯一事实源 |
| `test-records.md` | 人工总览，由 runner 覆盖刷新 |
| `explorations/<page>/success-paths/<yaml-basename>.jsonl` | 单个 YAML 完整通过后的成功路径缓存 |
| `explorations/<page>/exploration.md` | 增量写入页面发现、修正和失败尝试 |

## 关键边界

- 每个 YAML 开始和结束都要原子更新 `test-records.json`。
- 已有 success-path 只能做 fast path，复用前必须实时 `dumpLayout` 校验。
- 每个 YAML 开始时必须初始化 `successPathBuffer`，执行中采集 before/after 证据。
- YAML 通过前必须执行 success-path 门禁：写入 JSONL，或在报告中说明未写入原因。
- 测试报告必须展示 buffer 节点数、写入状态、文件路径和说明。
- 不允许盲回放历史坐标或历史 hdc 命令。
- 失败、跳过、中断或设备异常时不得覆盖已有 success-path。
- 停止后继续时只读 records 恢复上下文，不继承上次前台页面、键盘或弹窗状态。

## 安装

```bash
./install.sh codex
```

不传平台名时会安装到所有已配置平台。

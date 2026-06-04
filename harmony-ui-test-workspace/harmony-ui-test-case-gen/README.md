# harmony-ui-test-case-gen

`harmony-ui-test-case-gen` 负责把自然语言测试意图或 `test-sources/*.md` 编译为 v2 YAML，并通过读源码和 hdc 探索沉淀页面经验。

## 什么时候使用

- 用户用自然语言描述一个或多个 UI 测试场景。
- 已有 `test-sources/*.md`，需要批量生成结构化 YAML。
- 需要探索页面控件、弹窗、状态规律，并生成页面冒烟 YAML。

## 输入

- `CONTEXT.md` 中的项目路径、路由表和页面导航。
- 用户自然语言，或 `test-sources/*.md`。
- 真实设备上的 `dumpLayout` 和项目源码分析结果。

## 输出

| 产物 | 说明 |
|------|------|
| `test-sources/<slug>.md` | 人类原始输入；临时自然语言也先落到这里 |
| `test-plans/<page>-<n>.yaml` | v2 结构化测试意图，一个 YAML 一个用例 |
| `test-plans/smoke-<page>.yaml` | 页面冒烟用例，固定命名 |
| `explorations/<page>/exploration.md` | 页面级经验库 |
| `explorations/<page>/layoutTree.json` | 最近一次真实 UI 快照 |
| `test-records.json` | 只初始化或更新 `auto_generated`，不写执行结果 |

## 关键边界

- YAML 只写测试意图，不写 id、index、selector 或坐标。
- 页面定位策略写入 `exploration.md`，供 runner 和 script-gen 使用。
- `sourceHash` 使用源文件原始字节 sha256，用于判断源用例是否变化。
- 批量模式先展示计划，再逐个写入；失败的源文件不阻塞后续源文件。

## 安装

```bash
./install.sh codex
```

不传平台名时会安装到所有已配置平台。


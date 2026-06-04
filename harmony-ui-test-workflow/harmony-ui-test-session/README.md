# harmony-ui-test-session

`harmony-ui-test-session` 负责创建或继续一个 `UITestWorkspace-*`。它是整个鸿蒙 UI 测试工作流的入口，主要任务是提取项目元数据、初始化工作空间目录，并写入后续 skill 必须遵守的全局上下文。

## 什么时候使用

- 第一次为某个 HarmonyOS 项目建立 UI 测试工作空间。
- 停止后隔天继续，需要重新加载已有 workspace。
- 需要确认 Bundle、Product、入口 Ability、route_map 路由索引和基础测试文档是否齐备。
- 如果存在多个 route_map 候选，session 阶段选择一个主 `routeMap`。

## 输入

- 工作名。
- HarmonyOS 项目代码仓库路径。
- 必要时由用户确认 Product、入口 Ability 或路由候选项。

## 输出

| 产物 | 说明 |
|------|------|
| `CONTEXT.md` | 全局项目元数据、路由索引、已解析页面路由、跨页面导航和全局记录 |
| `AGENT.md` | 后续 case-gen、runner、script-gen 必须遵守的行为约束 |
| `references/` | 设备检查、UiTest API 和使用指南 |
| `test-sources/example.md` | 源用例模板，用户可复制后改写 |
| `test-records.json` | 初始机器运行状态 |
| `test-records.md` | 初始人工执行总览 |

## 与其他 skill 的关系

- `case-gen` 读取 `CONTEXT.md` 的项目路径和路由索引，按目标页面补充已解析路由和页面导航。
- `runner` 读取 `CONTEXT.md` 的 Bundle / Product / 设备记录，并刷新运行状态。
- `script-gen` 读取 `CONTEXT.md` 的项目路径和已解析路由；缺失时按路由索引懒加载目标页面路由，定位目标模块的 `ohosTest` 目录。

## 安装

```bash
./install.sh codex
```

不传平台名时会安装到所有已配置平台。

# harmony-ui-test-script-gen

`harmony-ui-test-script-gen` 负责把 YAML、页面经验和 runner 验证过的语义证据转换为 HarmonyOS `ohosTest` ArkTS 测试脚本。

## 什么时候使用

- YAML 已经通过 runner 验证，需要落成项目内可维护的 ArkTS 测试脚本。
- 同页面多个用例需要合并成一个 `.test.ets`。
- 需要更新 `List.test.ets`，把新测试 suite 接入测试入口。

## 输入

- `test-plans/*.yaml`。
- `explorations/<page>/exploration.md`。
- `explorations/<page>/layoutTree.json`。
- hash 匹配的 `success-paths/*.jsonl`。
- `CONTEXT.md` 中的项目路径、已解析页面路由和路由索引。

## 输出

| 产物 | 说明 |
|------|------|
| `<module>/src/ohosTest/ets/test/<Page>.test.ets` | 同页面业务用例合并为多个 `it()` |
| `<Page>.smoke.test.ets` 或 `Smoke.test.ets` | 用户明确选择 smoke YAML 时生成 |
| `List.test.ets` | 增量追加 import 和 suite 调用 |
| `<module>/src/ohosTest/module.json5` | 缺失时创建测试模块配置 |
| `exploration.md` | 缺依据时写入待验证推断，不写已验证修正 |

## 关键边界

- 默认只为 `test-records.json` 中状态为 `verified` 或 `trusted` 的 YAML 生成脚本。
- `auto_generated`、`failing`、`stale`、`blocked` 或 records 缺失的 YAML 默认不生成；用户明确选择时必须展示风险并等待确认。
- 生成脚本前校验结构化 YAML 的 `caseId`、`source`、`sourceHash` 和 `action.kind`。
- 源用例变化时提示先重新执行 case-gen / runner；用户确认继续时不得读取过期 success-path 作为证据源，并在生成结果中标注“基于过期 YAML”。
- success-path 只能增强语义判断，不能把历史坐标或 hdc 命令写入 ArkTS。
- 只按当前 YAML target 查找页面路由；`CONTEXT.md ## 路由表` 缺失时按 `## 路由索引` 懒加载并补写。
- 正常新建 workspace 时 session 已选择主 `routeMap`；如果旧 workspace 或手工修改后的 `CONTEXT.md` 仍存在 route_map 候选不唯一且未选择主 `routeMap`，不写入脚本，建议先执行 session 选择主 routeMap。
- `List.test.ets` 只追加或更新对应 suite，不覆盖已有内容。
- 生成 ArkTS 时遵守 `AGENT.md` 的语法限制：不用 `any`、`Object`、匿名对象、`Level` 或 `done`。

## 安装

```bash
./install.sh codex
```

不传平台名时会安装到所有已配置平台。

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function loadContracts(root) {
  const load = (relative) => {
    const resolved = require.resolve(path.join(root, relative));
    delete require.cache[resolved];
    return require(resolved).PUBLIC_CONTRACT;
  };
  return {
    caseRuntime: load('scripts/case-runtime/agent-facing-contract.js'),
    coordinator: load('scripts/coordinator/agent-facing-contract.js'),
  };
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function typeName(schema = {}) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((item) => JSON.stringify(item)).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(typeName).join(' | ');
  if (schema.type === 'array') return `${typeName(schema.items)}[]`;
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'object' || schema.properties) return 'object';
  return schema.type || 'unknown';
}

function propertySchemas(schema) {
  if (schema?.properties) return schema.properties;
  if (schema?.oneOf) return Object.assign({}, ...schema.oneOf.map(propertySchemas));
  return {};
}

function requiredProperties(schema) {
  if (schema?.required) return new Set(schema.required);
  if (!schema?.oneOf?.length) return new Set();
  const branches = schema.oneOf.map((item) => new Set(item.required || []));
  return new Set([...branches[0]].filter((name) => branches.every((branch) => branch.has(name))));
}

function signature(method) {
  const properties = propertySchemas(method.requestSchema);
  const required = requiredProperties(method.requestSchema);
  const params = Object.entries(properties).map(([name, schema]) => `${name}${required.has(name) ? '' : '?'}: ${typeName(schema)}`);
  return `${method.name}({ ${params.join(', ')} })`;
}

function methodPage(serviceName, method) {
  const properties = propertySchemas(method.requestSchema);
  const required = requiredProperties(method.requestSchema);
  const parameterRows = Object.entries(method.parameterDescriptions).map(([name, description]) => {
    const schema = properties[name] || {};
    return `| \`${name}\` | ${required.has(name) ? '是' : '否/条件'} | \`${typeName(schema)}\` | ${description} |`;
  }).join('\n');
  const section = (title, values) => values.length
    ? `\n## ${title}\n\n${values.map((value) => `- ${value}`).join('\n')}\n`
    : '';
  return `# ${serviceName}.${method.name}\n\n${method.summary}\n\n\`\`\`typescript\n${signature(method)}\n\`\`\`\n\n## 参数\n\n| 参数 | 必填 | 类型 | 含义 |\n|---|---|---|---|\n${parameterRows}\n${section('条件要求', method.conditionalRequirements)}${section('上下文校验', method.contextualValidationRules)}${section('成功状态', method.successStatuses.map((value) => `\`${value}\``))}${section('副作用', method.sideEffects)}\n## 幂等性\n\n${method.idempotency}\n\n## 错误\n\n${method.errorCodes.map((code) => `- [\`${code}\`](../errors.md#error-${kebab(code)})`).join('\n')}\n\n## 最小示例\n\n\`\`\`json\n${JSON.stringify(method.minimalExample, null, 2)}\n\`\`\`\n`;
}

function serviceIndex(title, contract, baseDirectory, extraLinks = []) {
  const rows = Object.values(contract.methods).map((method) =>
    `| [\`${method.name}\`](${baseDirectory}/methods/${kebab(method.name)}.md) | ${method.summary} | \`${signature(method)}\` |`).join('\n');
  return `# ${title}\n\n协议：\`${contract.protocol}\`。本页是启动短索引；只在紧凑签名不足时读取对应方法页，收到错误时只读取 \`documentationRef\` 指向的章节。\n\n## 方法\n\n| 方法 | 用途 | 紧凑签名 |\n|---|---|---|\n${rows}\n\n## 参数来源\n\n- Scene、控件、键盘和滚动状态来自当前 Runtime 响应。\n- 用户选择和目标绑定来自当前 Coordinator 探测事实。\n- 验证点引用来自 Case Model 变更回执或 continuation brief。\n\n## 按需文档\n\n${[...extraLinks, `- [错误目录](${baseDirectory}/errors.md)`].join('\n')}\n`;
}

function errorsPage(title, contract) {
  const sections = Object.entries(contract.errors).map(([code, definition]) => {
    const recovery = definition.retryable
      ? '根据本次响应的动态事实修正输入或等待状态变化后重新调用；不要重放结果未知的设备动作。'
      : '保留当前现场，读取本次响应中的原因和事实；需要人工或技术处置时完成处置后回到 facade。';
    return `<a id="error-${kebab(code)}"></a>\n## ${code}\n\n${definition.summary}\n\n**可重试：** ${definition.retryable ? '是' : '否'}\n\n**处理：** ${recovery}`;
  }).join('\n\n');
  return `# ${title} 错误目录\n\n错误响应只返回本次失败原因、相关动态事实和本页锚点；调用签名见服务索引。\n\n${sections}\n`;
}

function actionRefsPage() {
  return `# Case Runtime ActionRef\n\nActionRef 是 Runtime 发布事实的稳定引用，Agent 不解析内部 capabilityId。\n\n## 格式\n\n| 类型 | 格式 | 示例 |\n|---|---|---|\n| 控件动作 | \`<elementRef>:<actionType>\` | \`button-1:tap\` |\n| 全局动作 | \`screen:<actionType>\` | \`screen:swipeUp\` |\n| 视觉动作 | \`visual:<gesture>\` | \`visual:longPress\` |\n\n## 控件映射\n\n- \`clickable\`：\`tap\`、\`doubleTap\`、\`longPress\`。\n- \`checkable\`：\`tap\`、\`toggle\`。\n- \`editable\`：\`tap\`、\`inputText\`。\n- 多个属性同时成立时取并集。\n\n## 动态约束\n\n- 屏幕动作由 \`interactionContext\` 的滚动、焦点和键盘事实约束。\n- 视觉动作必须出现在 \`interactionContext.visualGestures\`，且 Scene 已登记视觉事实或本次 act 同时提交 \`updates.visual\`。\n- Runtime 在完整当前 Scene 上重建能力；无效引用返回 \`ACTION_NOT_AVAILABLE\`，不会返回整份替代动作目录。\n`;
}

function outputFiles({ root }) {
  const { caseRuntime, coordinator } = loadContracts(root);
  const files = new Map();
  files.set('references/case-runtime.md', serviceIndex('Case Runtime', caseRuntime, 'case-runtime', ['- [ActionRef 规则](case-runtime/action-refs.md)']));
  files.set('references/case-runtime/action-refs.md', actionRefsPage());
  files.set('references/case-runtime/errors.md', errorsPage('Case Runtime', caseRuntime));
  for (const method of Object.values(caseRuntime.methods)) {
    files.set(`references/case-runtime/methods/${kebab(method.name)}.md`, methodPage('CaseRuntime', method));
  }
  files.set('references/coordinator.md', serviceIndex('Coordinator', coordinator, 'coordinator'));
  files.set('references/coordinator/errors.md', errorsPage('Coordinator', coordinator));
  for (const method of Object.values(coordinator.methods)) {
    files.set(`references/coordinator/methods/${kebab(method.name)}.md`, methodPage('Coordinator', method));
  }
  return files;
}

function assertBudget(relative, content) {
  const bytes = Buffer.byteLength(content);
  const lines = content.split('\n').length;
  if (relative === 'references/case-runtime.md' && (bytes > 6 * 1024 || lines > 160)) throw new Error(`${relative} exceeds 6 KiB/160 lines`);
  if (relative === 'references/coordinator.md' && (bytes > 4 * 1024 || lines > 120)) throw new Error(`${relative} exceeds 4 KiB/120 lines`);
  if (relative.includes('/methods/') && bytes > 5 * 1024) throw new Error(`${relative} exceeds 5 KiB`);
  if (relative.endsWith('/action-refs.md') && bytes > 6 * 1024) throw new Error(`${relative} exceeds 6 KiB`);
  if (relative.endsWith('/errors.md') && bytes > 16 * 1024) throw new Error(`${relative} exceeds 16 KiB`);
}

function assertAggregate(files, prefix, limit) {
  const total = [...files].filter(([relative]) => relative === `references/${prefix}.md` || relative.startsWith(`references/${prefix}/`))
    .reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0);
  if (total > limit) throw new Error(`${prefix} generated docs exceed ${limit} bytes`);
}

function assertLinks(root, files) {
  for (const [relative, content] of files) {
    const links = [...content.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1]);
    for (const link of links) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), link));
      if (!files.has(target) && !fs.existsSync(path.join(root, target))) throw new Error(`${relative} has broken link ${link}`);
    }
  }
}

function buildDocs({ root = path.resolve(__dirname, '..'), check = false } = {}) {
  const files = outputFiles({ root });
  for (const [relative, content] of files) assertBudget(relative, content);
  assertAggregate(files, 'case-runtime', 64 * 1024);
  assertAggregate(files, 'coordinator', 32 * 1024);
  assertLinks(root, files);
  for (const [relative, content] of files) {
    const absolute = path.join(root, relative);
    if (check) {
      if (!fs.existsSync(absolute) || fs.readFileSync(absolute, 'utf8') !== content) throw new Error(`Generated documentation drift: ${relative}`);
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return files;
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  const files = buildDocs({ check });
  process.stdout.write(`${check ? 'checked' : 'generated'} ${files.size} agent-facing documentation files\n`);
}

if (require.main === module) main();

module.exports = { buildDocs, outputFiles };

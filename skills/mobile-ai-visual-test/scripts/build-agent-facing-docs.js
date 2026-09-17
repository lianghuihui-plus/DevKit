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
  const interfaceModule = require.resolve(path.join(root, 'scripts/lib/coordinator-interface-contract.js'));
  delete require.cache[interfaceModule];
  const coordinatorInterfaces = require(interfaceModule);
  return {
    caseRuntime: load('scripts/case-runtime/agent-facing-contract.js'),
    coordinator: load('scripts/coordinator/agent-facing-contract.js'),
    interfaces: coordinatorInterfaces.INTERFACE_CONTRACTS,
    commandErrors: coordinatorInterfaces.COMMAND_ERROR_DEFINITIONS,
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
  if (schema?.oneOf) {
    const merged = {};
    for (const branch of schema.oneOf) {
      for (const [name, property] of Object.entries(propertySchemas(branch))) {
        const candidates = merged[name]?.oneOf || (merged[name] ? [merged[name]] : []);
        if (!candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(property))) candidates.push(property);
        merged[name] = candidates.length === 1 ? candidates[0] : { oneOf: candidates };
      }
    }
    return merged;
  }
  return {};
}

function requiredProperties(schema) {
  if (schema?.required) return new Set(schema.required);
  if (!schema?.oneOf?.length) return new Set();
  const branches = schema.oneOf.map((item) => new Set(item.required || []));
  return new Set([...branches[0]].filter((name) => branches.every((branch) => branch.has(name))));
}

function schemaSignature(methodName, schema) {
  const properties = propertySchemas(schema);
  const required = requiredProperties(schema);
  const params = Object.entries(properties).map(([name, schema]) => `${name}${required.has(name) ? '' : '?'}: ${typeName(schema)}`);
  return `${methodName}({ ${params.join(', ')} })`;
}

function signatures(method) {
  return (method.requestSchema?.oneOf || [method.requestSchema]).map((schema) => schemaSignature(method.name, schema));
}

function signature(method) {
  return signatures(method).join(' / ');
}

function methodPage(serviceName, method, contract) {
  const properties = propertySchemas(method.requestSchema);
  const required = requiredProperties(method.requestSchema);
  const parameterRows = Object.entries(method.parameterDescriptions).map(([name, description]) => {
    const schema = properties[name] || {};
    return `| \`${name}\` | ${required.has(name) ? '是' : '否/条件'} | \`${typeName(schema)}\` | ${description} |`;
  }).join('\n');
  const section = (title, values) => values.length
    ? `\n## ${title}\n\n${values.map((value) => `- ${value}`).join('\n')}\n`
    : '';
  const methodSignatures = signatures(method);
  const signatureTitle = methodSignatures.length > 1 ? '## 调用分支\n\n' : '';
  return `# ${serviceName}.${method.name}\n\n${method.summary}\n\n${signatureTitle}\`\`\`typescript\n${methodSignatures.join('\n')}\n\`\`\`\n\n## 参数\n\n| 参数 | 必填 | 类型 | 含义 |\n|---|---|---|---|\n${parameterRows}\n${section('条件要求', method.conditionalRequirements)}${section('上下文校验', method.contextualValidationRules)}${section('成功状态', method.successStatuses.map((value) => `\`${value}\``))}${section('副作用', method.sideEffects)}\n## 幂等性\n\n${method.idempotency}\n\n## 错误\n\n${method.errorCodes.map((code) => `- [\`${code}\`](../errors/${contract.errors[code].group}.md#error-${kebab(code)})`).join('\n')}\n\n## 最小示例\n\n\`\`\`json\n${JSON.stringify(method.minimalExample, null, 2)}\n\`\`\`\n`;
}

function serviceIndex(title, contract, baseDirectory, extraLinks = []) {
  const rows = Object.values(contract.methods).map((method) =>
    `| [\`${method.name}\`](${baseDirectory}/methods/${kebab(method.name)}.md) | ${method.summary} | \`${signature(method)}\` |`).join('\n');
  const referenceSource = title === 'Case Runtime'
    ? '- CHECK 节点和分支引用来自 Case Flow 回执或 continuation brief。'
    : '- 用例、平台和设备选择来自 Coordinator 响应或当前用户输入。';
  return `# ${title}\n\n协议：\`${contract.protocol}\`。本页是启动短索引；只在紧凑签名不足时读取对应方法页，收到错误时只读取 \`documentationRef\` 指向的章节。\n\n## 方法\n\n| 方法 | 用途 | 紧凑签名 |\n|---|---|---|\n${rows}\n\n## 参数来源\n\n- Scene、控件、键盘和滚动状态来自当前 Runtime 响应。\n- 用户选择和目标绑定来自当前 Coordinator 探测事实。\n${referenceSource}\n\n## 按需文档\n\n${[...extraLinks, `- [错误目录](${baseDirectory}/errors.md)`].join('\n')}\n`;
}

function groupedErrors(contract) {
  const groups = new Map();
  for (const [code, definition] of Object.entries(contract.errors)) {
    if (!definition.recovery) throw new Error(`${code} must declare targeted recovery`);
    const group = definition.group || 'general';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([code, definition]);
  }
  return groups;
}

function errorsIndex(title, contract) {
  const rows = Object.entries(contract.errors).map(([code, definition]) =>
    `<a id="error-${kebab(code)}"></a>- [\`${code}\`](errors/${definition.group || 'general'}.md#error-${kebab(code)})：${definition.summary}`).join('\n');
  return `# ${title} 错误路由\n\n只定位当前响应的 \`documentationRef\`；完整原因和恢复动作位于对应分组页。\n\n${rows}\n`;
}

function errorGroupPage(title, entries) {
  const sections = entries.map(([code, definition]) =>
    `<a id="error-${kebab(code)}"></a>\n## ${code}\n\n${definition.summary}\n\n**可重试：** ${definition.retryable ? '是' : '否'}\n\n**处理：** ${definition.recovery}`).join('\n\n');
  return `# ${title}\n\n只在响应指向本页时读取对应错误章节。\n\n${sections}\n`;
}

function commandIndex(interfaces) {
  const modules = new Map();
  for (const definition of Object.values(interfaces)) {
    if (!modules.has(definition.module)) modules.set(definition.module, definition.summary);
  }
  const rows = [...modules].map(([module, summary]) => `| [${module}](commands/${module}.md) | ${summary} |`).join('\n');
  return `# 命令模块\n\n仅在 Authoring、维护或技术排障需要直接调用正式 CLI 时进入当前模块；普通执行协调 Agent 和 Case Agent 不读取本目录。\n\n| 模块 | 用途 |\n|---|---|\n${rows}\n\n预绑定命令见 [transport 规则](commands/transports.md)，收到错误时只读取响应中的 \`documentationRef\`。\n`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function commandModulePage(module, definitions) {
  const sections = definitions.flatMap(([entrypoint, definition]) => definition.commands.map((item) => {
    const anchor = item.documentationRef.split('#')[1];
    const positionalRows = item.positionals.map((value) => `| \`${value.name}\` | ${value.required ? '是' : '否'} | ${value.description} |`);
    const flagRows = Object.entries(item.flags).map(([name, value]) => `| \`--${kebab(name)}\` | ${value.required ? '是' : '否'} | ${value.description}${value.enum ? `；可选：${value.enum.map((entry) => `\`${entry}\``).join('、')}` : ''} |`);
    const parameterRows = [...positionalRows, ...flagRows];
    return `<a id="${anchor}"></a>\n## ${entrypoint}${item.name ? ` ${item.name}` : ''}\n\n${item.summary}\n\n**角色：** ${definition.roles.map((role) => `\`${role}\``).join('、')}\n\n**访问：** \`${definition.access}\`\n\n\`\`\`bash\n${item.usage}\n\`\`\`\n\n${parameterRows.length ? `| 参数 | 必填 | 含义 |\n|---|---|---|\n${parameterRows.join('\n')}\n\n` : ''}**成功：** ${item.responses.map((value) => `\`${value}\``).join('、')}\n\n**最小示例：**\n\n\`\`\`bash\n${item.example.map(shellQuote).join(' ')}\n\`\`\`\n\n错误只按响应中的 [文档引用](errors/${module}.md) 处理。`;
  })).join('\n\n');
  return `# ${module}\n\n本页只服务当前功能模块，不需要预读其他命令模块。\n\n${sections}\n`;
}

function commandErrorsPage(module, commandErrors) {
  const targeted = Object.entries(commandErrors)
    .filter(([, definition]) => definition.module === module)
    .map(([code, definition]) => `<a id="error-${kebab(code)}"></a>\n## ${code}\n\n${definition.summary}\n\n**可重试：** ${definition.retryable ? '是' : '否'}\n\n**处理：** ${definition.recovery}`)
    .join('\n\n');
  return `# ${module} 命令错误\n\n<a id="request-invalid"></a>\n## REQUEST_INVALID\n\n命令、参数、枚举或 JSON 输入不符合当前命令契约。按 \`issues\` 修正，并使用响应中的 \`usage\` 和 \`example\` 重试一次。\n\n<a id="domain"></a>\n## 领域错误\n\n输入格式正确，但当前业务对象、状态或资源不允许该操作。保留响应中的稳定 \`code\`，按 \`message\` 修复对应领域事实；不要把它当作参数错误反复改字段。\n\n<a id="technical"></a>\n## TECHNICAL\n\n命令已通过输入校验，但执行时发生技术异常。保留 \`stage\`、\`logRefs\` 和安全资源事实，完成技术处置后回到当前正式入口。${targeted ? `\n\n${targeted}` : ''}\n`;
}

function transportsPage(caseRuntime, coordinator) {
  const entries = [
    ...Object.entries(coordinator.transports || {}).map(([name, value]) => ['Coordinator', name, value]),
    ...Object.entries(caseRuntime.transports || {}).map(([name, value]) => ['Case Runtime', name, value]),
  ];
  const sections = entries.map(([owner, name, value]) => `## ${owner}.${name}\n\n${value.summary}\n\n- 输入：${value.input}\n- 调用：${value.rule}\n- 成功：${value.success}\n- 错误：${value.errors.map((code) => `\`${code}\``).join('、')}`).join('\n\n');
  return `# 预绑定 Transport\n\nTransport 命令由框架生成并绑定当前状态。Agent 原样执行，只构造文档明确要求的业务输入。\n\n${sections}\n`;
}

function actionRefsPage() {
  return `# Case Runtime ActionRef\n\nActionRef 是 Runtime 发布事实的稳定引用，Agent 不解析内部 capabilityId。\n\n## 格式\n\n| 类型 | 格式 | 示例 |\n|---|---|---|\n| 控件动作 | \`<elementRef>:<actionType>\` | \`button-1:tap\` |\n| 全局动作 | \`screen:<actionType>\` | \`screen:swipeUp\` |\n| 视觉动作 | \`visual:<gesture>\` | \`visual:longPress\` |\n\n## 控件映射\n\n- \`clickable\`：\`tap\`、\`doubleTap\`、\`longPress\`。\n- \`checkable\`：\`tap\`、\`toggle\`。\n- \`editable\`：\`tap\`、\`inputText\`。\n- 多个属性同时成立时取并集。\n\n## 动态约束\n\n- 屏幕动作由 \`interactionContext\` 的滚动、焦点和键盘事实约束。\n- 视觉动作必须出现在 \`interactionContext.visualGestures\`，且 Scene 已通过 \`inspect(channel="visual")\` 登记视觉事实。\n- Runtime 在完整当前 Scene 上重建能力；无效引用返回 \`ACTION_NOT_AVAILABLE\`，不会返回整份替代动作目录。\n`;
}

function outputFiles({ root }) {
  const { caseRuntime, coordinator, interfaces, commandErrors } = loadContracts(root);
  const files = new Map();
  files.set('references/case-runtime.md', serviceIndex('Case Runtime', caseRuntime, 'case-runtime', ['- [ActionRef 规则](case-runtime/action-refs.md)']));
  files.set('references/case-runtime/action-refs.md', actionRefsPage());
  files.set('references/case-runtime/errors.md', errorsIndex('Case Runtime', caseRuntime));
  for (const [group, entries] of groupedErrors(caseRuntime)) {
    files.set(`references/case-runtime/errors/${group}.md`, errorGroupPage(`Case Runtime ${group} 错误`, entries));
  }
  for (const method of Object.values(caseRuntime.methods)) {
    files.set(`references/case-runtime/methods/${kebab(method.name)}.md`, methodPage('CaseRuntime', method, caseRuntime));
  }
  files.set('references/coordinator.md', serviceIndex('Coordinator', coordinator, 'coordinator'));
  files.set('references/coordinator/errors.md', errorsIndex('Coordinator', coordinator));
  for (const [group, entries] of groupedErrors(coordinator)) {
    files.set(`references/coordinator/errors/${group}.md`, errorGroupPage(`Coordinator ${group} 错误`, entries));
  }
  for (const method of Object.values(coordinator.methods)) {
    files.set(`references/coordinator/methods/${kebab(method.name)}.md`, methodPage('Coordinator', method, coordinator));
  }
  files.set('references/commands.md', commandIndex(interfaces));
  const modules = new Map();
  for (const entry of Object.entries(interfaces)) {
    const module = entry[1].module;
    if (!modules.has(module)) modules.set(module, []);
    modules.get(module).push(entry);
  }
  for (const [module, definitions] of modules) {
    files.set(`references/commands/${module}.md`, commandModulePage(module, definitions));
    files.set(`references/commands/errors/${module}.md`, commandErrorsPage(module, commandErrors));
  }
  files.set('references/commands/transports.md', transportsPage(caseRuntime, coordinator));
  return files;
}

function assertBudget(relative, content) {
  const bytes = Buffer.byteLength(content);
  const lines = content.split('\n').length;
  if (relative === 'references/case-runtime.md' && (bytes > 6 * 1024 || lines > 160)) throw new Error(`${relative} exceeds 6 KiB/160 lines`);
  if (relative === 'references/coordinator.md' && (bytes > 4 * 1024 || lines > 120)) throw new Error(`${relative} exceeds 4 KiB/120 lines`);
  if (relative.includes('/methods/') && bytes > 5 * 1024) throw new Error(`${relative} exceeds 5 KiB`);
  if (relative.endsWith('/action-refs.md') && bytes > 6 * 1024) throw new Error(`${relative} exceeds 6 KiB`);
  if (relative.endsWith('/errors.md') && bytes > 4 * 1024) throw new Error(`${relative} exceeds 4 KiB`);
  if (relative.startsWith('references/commands/') && bytes > 8 * 1024) throw new Error(`${relative} exceeds 8 KiB`);
  if (relative.includes('/errors/') && bytes > 8 * 1024) throw new Error(`${relative} exceeds 8 KiB`);
  if (relative === 'references/commands.md' && bytes > 4 * 1024) throw new Error(`${relative} exceeds 4 KiB`);
}

function assertAggregate(files, prefix, limit) {
  const total = [...files].filter(([relative]) => relative === `references/${prefix}.md` || relative.startsWith(`references/${prefix}/`))
    .reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0);
  if (total > limit) throw new Error(`${prefix} generated docs exceed ${limit} bytes`);
}

function assertLinks(root, files) {
  for (const [relative, content] of files) {
    const links = [...content.matchAll(/\]\(([^)#]+\.md)(?:#([^)]+))?\)/g)].map((match) => ({ link: match[1], anchor: match[2] || null }));
    for (const { link, anchor } of links) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), link));
      if (!files.has(target) && !fs.existsSync(path.join(root, target))) throw new Error(`${relative} has broken link ${link}`);
      if (anchor) {
        const targetContent = files.get(target) || fs.readFileSync(path.join(root, target), 'utf8');
        const explicitAnchors = new Set([...targetContent.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]));
        const headingAnchors = new Set([...targetContent.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => kebab(match[1].replace(/[`*_]/g, '').trim())));
        if (!explicitAnchors.has(anchor) && !headingAnchors.has(anchor)) {
          throw new Error(`${relative} has broken anchor ${link}#${anchor}`);
        }
      }
    }
  }
}

function buildDocs({ root = path.resolve(__dirname, '..'), check = false } = {}) {
  const files = outputFiles({ root });
  for (const [relative, content] of files) assertBudget(relative, content);
  assertAggregate(files, 'case-runtime', 64 * 1024);
  assertAggregate(files, 'coordinator', 32 * 1024);
  assertAggregate(files, 'commands', 64 * 1024);
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

module.exports = { assertLinks, buildDocs, outputFiles };

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
  if (schema.type === 'array') return schema.items?.oneOf || schema.items?.enum
    ? `Array<${typeName(schema.items)}>` : `${typeName(schema.items)}[]`;
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
  return (method.inputSchema.oneOf || [method.inputSchema]).map((schema) => schemaSignature(method.name, schema));
}

function signature(method) {
  return signatures(method).join(' / ');
}

function detailedType(schema) {
  if (schema.oneOf) return schema.oneOf.map(detailedType).join(' | ');
  if (schema.type === 'array') return `Array<${detailedType(schema.items)}>`;
  if (schema.properties) return `{ ${Object.entries(schema.properties).map(([name, child]) =>
    `${name}${(schema.required || []).includes(name) ? '' : '?'}: ${detailedType(child)}`).join('; ')} }`;
  return typeName(schema);
}

function nestedInputs(method) {
  const values = Object.entries(propertySchemas(method.inputSchema)).filter(([, schema]) =>
    schema.properties || schema.oneOf?.some((branch) => branch.properties) || schema.items?.properties || schema.items?.oneOf);
  return values.length ? `\n## 结构字段\n\n\`\`\`typescript\n${values.map(([name, schema]) => `input.${name}: ${detailedType(schema)}`).join('\n')}\n\`\`\`\n` : '';
}

function methodPage(serviceName, method, contract) {
  const properties = propertySchemas(method.inputSchema);
  const required = requiredProperties(method.inputSchema);
  const parameterRows = Object.entries(method.parameterDescriptions).map(([name, description]) => {
    const schema = name.split('.').reduce((current, part) => propertySchemas(current)[part], method.inputSchema) || {};
    return `| \`${name}\` | ${required.has(name) ? '是' : '否/条件'} | \`${typeName(schema).replace(/\|/g, '\\|')}\` | ${description} |`;
  }).join('\n');
  const section = (title, values) => values.length
    ? `\n## ${title}\n\n${values.map((value) => `- ${value}`).join('\n')}\n`
    : '';
  const methodSignatures = signatures(method);
  const signatureTitle = methodSignatures.length > 1 ? '## 调用分支\n\n' : '';
  return `# ${serviceName}.${method.name}\n\n${method.summary}\n\n签名参数是规范请求的 \`input\`；外壳固定为 \`{operation,input}\`。\n\n${signatureTitle}\`\`\`typescript\n${methodSignatures.join('\n')}\n\`\`\`\n\n## 参数\n\n| 参数 | 必填 | 类型 | 含义 |\n|---|---|---|---|\n${parameterRows}\n${nestedInputs(method)}${section('条件要求', method.conditionalRequirements)}${section('上下文校验', method.contextualValidationRules)}${section('成功状态', method.successStatuses.map((value) => `\`${value}\``))}${projectionSection(method.responseProjection)}${section('副作用', method.sideEffects)}\n## 幂等性\n\n${method.idempotency}\n\n## 错误\n\n${method.errorCodes.map((code) => `- [\`${code}\`](../errors/${contract.errors[code].group}.md#error-${kebab(code)})`).join('\n')}\n\n## 最小示例\n\n\`\`\`json\n${method.minimalExamples.map((example) => JSON.stringify(example, null, method.minimalExamples.length === 1 ? 2 : 0)).join("\n```\n\n```json\n")}\n\`\`\`\n`;
}

function projectionSection(projection, condition = '成功') {
  if (!projection) throw new Error('Every public method must declare responseProjection');
  for (const key of ['modes', 'outcomes']) {
    if (projection[key]) return Object.entries(projection[key]).map(([value, branch]) =>
      projectionSection(branch, `${condition} / ${key === 'modes' ? 'mode' : 'outcome'}=${value}`)).join('');
  }
  for (const field of ['resultFields', 'primaryResourceType', 'associatedResourceTypes']) {
    if (!Object.hasOwn(projection, field)) throw new Error(`responseProjection requires ${field}`);
  }
  return `\n### ${condition}\n\n- 简单结果：${projection.resultFields.map((field) => `\`${field}\``).join('、')}。\n- 主数据：${projection.primaryResourceType ? `\`${projection.primaryResourceType}\`` : '无'}。\n- 关联资源：${Array.isArray(projection.associatedResourceTypes) ? projection.associatedResourceTypes.map((type) => `\`${type}\``).join('、') || '无' : projection.associatedResourceTypes}。\n`;
}

function resourcesPage(title, contract) {
  const rows = Object.entries(contract.resourceCatalog).map(([type, definition]) => `| \`${type}\` | ${definition.summary} |`).join('\n');
  const evidenceRefs = contract.resourceCatalog.scene
    ? '\n\n证据字段同样只接受已发布引用：`sceneRef` / `sceneRefs` 使用 `scene` ref，`knowledgeRefs` 使用适用候选的 `knowledgeDocumentRef`，`technicalRefs` 使用 `technicalFact` ref。`ActionRef`、`checkNodeRef`、`queryId` 和 `scrollContextRef` 是响应内容中的领域标识，不传给 `read`。'
    : '';
  return `# ${title} 资源目录\n\n资源引用来自 \`data.ref\`、\`resources[].ref\` 或明确标注的资源字段；原样传给返回该引用的绑定 Facade：\n\n\`\`\`json\n${JSON.stringify(contract.methods.read.minimalExample, null, 2)}\n\`\`\`\n\n读取返回完整主数据 \`data\`，关联复杂数据仍为 \`resources\` 中的类型化引用；不截断、抽样或内联复制关联资源。\`$resourceType\` 表示所读资源类型，\`$declaredResources\` 表示该资源声明的关联资源。引用不可拼接、跨作用域使用或替换为流程节点、边和操作 ID。${evidenceRefs}\n\n| 类型 | 内容 |\n|---|---|\n${rows}\n\n错误中的 \`documentationRef\` 和 \`operationDocumentationRef\` 是静态文档路径，使用宿主文件读取能力打开，不传给 \`read\`。\n`;
}

function serviceIndex(title, contract, baseDirectory, extraLinks = []) {
  const rows = Object.values(contract.methods).map((method) =>
    `| [\`${method.name}\`](${baseDirectory}/methods/${kebab(method.name)}.md) | ${method.summary} | \`${signature(method).replace(/\|/g, '\\|')}\` |`).join('\n');
  const referenceSource = title === 'Case Runtime'
    ? '- CHECK 节点和分支引用来自 Case Flow 回执或 continuation brief。'
    : '- 用例、平台和设备选择来自 Coordinator 响应或当前用户输入。';
  const transport = Object.values(contract.transports).map((item) => `- ${item.summary}${item.input}${item.rule}`).join('\n');
  return `# ${title}\n\n协议：\`${contract.protocol}\`。启动时读取本索引；字段不足时读取对应方法页。\n\n## 请求与响应\n\n- stdin 一次提交 \`{operation,input}\`；签名内参数属于 \`input\`，空输入使用 \`{}\`。\n- 响应为 \`{protocol,status,operation,result,resources,data?,error?}\`。状态：${contract.statuses.map((status) => `\`${status}\``).join('、')}；业务状态在 \`result.outcome\`。\n- \`result\` 只含简单事实；主复杂结果完整放入 \`data\`，关联复杂数据只在 \`resources\` 发布引用，按需 \`read({ref})\`。\n- ref 原样复制；不能从路径、ID 或文字拼装。输入错误同时读取 \`error.documentationRef\` 与 \`error.operationDocumentationRef\`；其他错误读取前者。\n${transport}\n\n## 方法\n\n| 方法 | 用途 | 紧凑签名 |\n|---|---|---|\n${rows}\n\n## 参数来源\n\n${referenceSource}\n\n## 按需文档\n\n${[...extraLinks, `- [资源目录](${baseDirectory}/resources.md)`, `- [错误目录](${baseDirectory}/errors.md)`].join('\n')}\n`;
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
    `<a id="error-${kebab(code)}"></a>- [\`${code}\`](errors/${definition.group || 'general'}.md#error-${kebab(code)})`).join('\n');
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

function actionRefsPage(contract) {
  const method = contract.methods.act;
  const branches = method.inputSchema.properties.action.oneOf;
  return `# Case Runtime 动作目标\n\n${method.parameterDescriptions.action}。ActionRef 原样取自已发布控件或屏幕事实；Agent 可以自主选择任意归一化坐标。Runtime 不判断视觉目标或业务意图。\n\n## 动作分支\n\n\`\`\`typescript\n${branches.map((schema) => `action: ${detailedType(schema)}`).join('\n')}\n\`\`\`\n\n坐标必须在 0 到 1 范围内；视觉动作先读取截图并通过 \`inspect(mode="visual")\` 登记事实。完整请求及响应见 [act](methods/act.md)。\n\n${[...method.conditionalRequirements, ...method.contextualValidationRules].map((rule) => `- ${rule}`).join('\n')}\n`;
}

function outputFiles({ root }) {
  const { caseRuntime, coordinator, interfaces, commandErrors } = loadContracts(root);
  const files = new Map();
  files.set('references/case-runtime.md', serviceIndex('Case Runtime', caseRuntime, 'case-runtime', ['- [ActionRef 规则](case-runtime/action-refs.md)']));
  files.set('references/case-runtime/action-refs.md', actionRefsPage(caseRuntime));
  files.set('references/case-runtime/errors.md', errorsIndex('Case Runtime', caseRuntime));
  files.set('references/case-runtime/resources.md', resourcesPage('Case Runtime', caseRuntime));
  for (const [group, entries] of groupedErrors(caseRuntime)) {
    files.set(`references/case-runtime/errors/${group}.md`, errorGroupPage(`Case Runtime ${group} 错误`, entries));
  }
  for (const method of Object.values(caseRuntime.methods)) {
    files.set(`references/case-runtime/methods/${kebab(method.name)}.md`, methodPage('CaseRuntime', method, caseRuntime));
  }
  files.set('references/coordinator.md', serviceIndex('Coordinator', coordinator, 'coordinator'));
  files.set('references/coordinator/errors.md', errorsIndex('Coordinator', coordinator));
  files.set('references/coordinator/resources.md', resourcesPage('Coordinator', coordinator));
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
  if (relative.endsWith('/errors.md') && bytes > 6 * 1024) throw new Error(`${relative} exceeds 6 KiB`);
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

'use strict';
const { PUBLIC_CONTRACT } = require('../coordinator/agent-facing-contract');
const { PUBLIC_CONTRACT: CASE_CONTRACT } = require('../case-runtime/agent-facing-contract');
const { validateAgentJson } = require('../lib/agent-json-contract');
const string = { type: 'string', minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const contextRef = { ...string, pattern: '^mavt-context:[A-Za-z0-9_-]+$' };
const workspace = { ...string, pattern: '^/' };
const role = { enum: ['author', 'knowledge', 'coordinator'] };
const operation = { oneOf: [object({ type: { const: 'ADD' }, draftPath: workspace }), object({ type: { const: 'UPDATE' }, entryId: string, draftPath: workspace }), object({ type: { const: 'DELETE' }, entryId: string })] };
const request = object({ schemaVersion: { const: 1 }, reason: string, operations: { type: 'array', minItems: 1, items: operation } });
const schemas = {
  mavt_workspace_init: object({ workspace, role }),
  mavt_workspace_open: object({ workspace, role, batchId: string }, ['workspace', 'role']),
  mavt_workspace_doctor: object({ workspace }),
  mavt_cases_import: object({ contextRef, request: object({ cases: { type: 'array', minItems: 1, items: object({ sourceLocator: string, title: string, sourceText: string }) } }) }),
  ...Object.fromEntries(['inspect', 'list', 'validate'].map(name => [`mavt_knowledge_${name}`, object({ contextRef })])),
  mavt_knowledge_show: object({ contextRef, entryId: string }),
  mavt_knowledge_prepare: object({ contextRef, request }),
  mavt_knowledge_apply: object({ contextRef, request, planHash: { ...string, pattern: '^[a-f0-9]{64}$' } }),
  ...Object.fromEntries(['prepare', 'confirm', 'advance', 'cancel', 'read'].map(name => {
    const operationName = name === 'read' ? name : `${name}Run`;
    return [`mavt_run_${name}`, object({ contextRef, input: { type: 'object', ...PUBLIC_CONTRACT.methods[operationName].inputSchema } })];
  })),
  mavt_run_status: object({ contextRef }), mavt_run_report: object({ contextRef }),
  ...Object.fromEntries(Object.values(CASE_CONTRACT.methods).map(method => [`mavt_case_${method.name}`,
    object({ contextRef, input: method.inputSchema })])),
  mavt_case_image: object({ contextRef, ref: string }),
};
const resultProperties = {
  contextRef, planHash: string, code: string, message: string, error: { type: 'object' },
  result: { type: 'object' }, data: { type: 'object' }, resources: { type: 'array', items: { type: 'object' } },
};
const outputBranch = statuses => ({ type: 'object', required: ['status'], additionalProperties: true, properties: { ...resultProperties, status: { enum: statuses } } });
const OUTPUT_SCHEMA = { type: 'object', description: 'Authoritative domain result; UNKNOWN and domain error details remain structured.', oneOf: [
  outputBranch(['SUCCEEDED', 'VALID', 'PREPARED', 'APPLIED']),
  outputBranch(['REJECTED', 'FAILED', 'UNKNOWN', 'REQUEST_INVALID']),
  { type: 'object', required: ['type', 'cases'], properties: { type: { const: 'caseAuthoringImport' }, cases: { type: 'array', items: { type: 'object' } } }, additionalProperties: true },
] };
function definitions() { return Object.entries(schemas).map(([name, inputSchema]) => ({ name, description: CASE_CONTRACT.methods[name.replace(/^mavt_case_/, '')]?.summary || name.replace(/^mavt_/, '').replace(/_/g, ' '), inputSchema, outputSchema: OUTPUT_SCHEMA,
  annotations: { readOnlyHint: /doctor|inspect|list|show|validate|status|report|_read$|_image$/.test(name), destructiveHint: /apply|cancel/.test(name), openWorldHint: /confirm|advance/.test(name) } })); }
function validate(name, args) {
  if (!Object.hasOwn(schemas, name)) throw Object.assign(new Error(`Unknown MAVT tool: ${name}`), { code: 'MAVT_MCP_TOOL_UNKNOWN' });
  const issues = validateAgentJson(args, schemas[name]);
  if (issues.length) throw Object.assign(new Error('Invalid tool arguments'), { code: 'MAVT_MCP_INPUT_INVALID', issues });
}
module.exports = { definitions, schemas, validate, OUTPUT_SCHEMA };

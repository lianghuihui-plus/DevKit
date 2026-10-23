'use strict';
const string = { type: 'string', minLength: 1 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const contextRef = { ...string, pattern: '^mavt-context:[A-Za-z0-9_-]+$' };
const global = (name, inputSchema, effect, handler, annotations) => ({ name, inputSchema, role: 'reporting', scope: 'global', effect, handler, annotations });
const workspace = (name, inputSchema, effect, handler, annotations) => ({ name, inputSchema, role: 'reporting', scope: 'workspace', effect, handler, annotations });
const read = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const write = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const network = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const destructive = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
const descriptors = Object.freeze([
  global('mavt_reporting_settings_read', object({}), 'local-read', service => service.readSettings(), read),
  global('mavt_reporting_settings_update', object({ serverUrl: string, autoUpload: { type: 'boolean' }, acknowledgeNotice: { type: 'boolean' } }), 'local-write', (service, args) => service.updateSettings(args), write),
  global('mavt_reporting_credentials_prepare', object({ serverUrl: string }), 'local-write', (service, args) => service.prepareCredentials(args.serverUrl || service.readSettings().serverUrl), write),
  global('mavt_reporting_check', object({}), 'network-read', service => service.checkConnection(), network),
  workspace('mavt_reporting_submit', object({ contextRef, scope: { const: 'workspace' } }, ['contextRef', 'scope']), 'submit', (service, args, context) => service.submit({ workspace: context.workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: context.runtimeRoot, bundleId: context.bundleId }), network),
  workspace('mavt_reporting_status', object({ contextRef, jobId: string }, ['contextRef']), 'local-read', (service, args, context) => service.status(context.workspace, args.jobId), read),
  workspace('mavt_reporting_retry', object({ contextRef, jobId: string, acceptCredentialChange: { const: true } }, ['contextRef', 'jobId']), 'submit', (service, args, context) => service.retry(context.workspace, args.jobId, { acceptCredentialChange: args.acceptCredentialChange }), network),
  workspace('mavt_reporting_identity_reset', object({ contextRef }, ['contextRef']), 'local-write', (service, args, context) => service.resetIdentity(context.workspace), destructive),
]);
const byName = new Map(descriptors.map(item => [item.name, item]));
function descriptor(name) { return byName.get(name) || null; }
function invoke(name, args, context, service = require('./service').createReportingService()) {
  const item = descriptor(name);
  if (!item) throw Object.assign(new Error('Unknown reporting tool'), { code: 'MAVT_MCP_TOOL_UNKNOWN' });
  return { status: 'SUCCEEDED', result: item.handler(service, args, context) };
}
module.exports = { descriptors, descriptor, invoke };

'use strict';
const path = require('node:path');
const { successEnvelope } = require('../lib/agent-facing-envelope');
const CONFIRM_DECISIONS = new Set(['USE_CURRENT', 'CONFIRM_ENVIRONMENT', 'CONFIRM_BINDING']);
const unavailable = () => ({ code: 'REPORTING_UNAVAILABLE' });
function serviceFor(options) { return options.reportingService || require('./service').createReportingService(); }
function safely(callback, fallback = unavailable()) {
  try { return callback(); } catch { return fallback; }
}
function addReporting(response, reporting) {
  if (!response || !reporting || response.operation === 'read') return response;
  return successEnvelope({ operation: response.operation, result: { ...response.result, reporting },
    ...(response.data ? { data: response.data } : {}), resources: response.resources });
}
function preflight(workspace, options = {}) {
  return safely(() => serviceFor(options).preflight(workspace));
}
function prepareAttempt(state, request, options = {}) {
  if (request.operation !== 'confirmRun' || !CONFIRM_DECISIONS.has(request.input?.decision) || state.environmentConfirmed) return null;
  return safely(() => serviceFor(options).prepareRunSnapshot({ workspace: state.workspace, batchId: state.batchId,
    request: request.input }).attemptId, null);
}
function recover(state, options = {}) {
  if (!state.environmentConfirmed || !state.initialization?.reportingAttemptId) return null;
  return safely(() => serviceFor(options).acceptRunSnapshot(state.workspace, state.batchId, state.initialization.reportingAttemptId), null);
}
function reportState(state, options = {}) {
  const snapshot = recover(state, options);
  if (snapshot) return { serverUrl: snapshot.serverUrl, configured: snapshot.configured, autoUpload: snapshot.autoUpload,
    noticeCode: snapshot.noticeAcknowledged ? null : 'REPORTING_NOTICE_REQUIRED' };
  if (state.environmentConfirmed) return unavailable();
  return preflight(state.workspace, options);
}
function terminal(state, response, options = {}) {
  if (!['COMPLETE', 'BLOCKED'].includes(state.phase) || response && !['COMPLETE', 'BLOCKED'].includes(response.result?.phase)) return null;
  if (state.environmentConfirmed && !recover(state, options)) return { state: 'REPORTING_UNAVAILABLE', code: 'REPORTING_UNAVAILABLE' };
  return safely(() => {
    // The Run binding is verified after Coordinator locks have been released.
    const loaded = require('../lib/runtime-binding').readRunBinding(state.workspace, state.batchId);
    const runtimeRoot = loaded.runtimeRoot || path.resolve(__dirname, '../..');
    return serviceFor(options).submit({ workspace: state.workspace, scope: 'batch', trigger: 'automatic', batchId: state.batchId,
      runtimeRoot, bundleId: loaded.bundleId || null });
  }, { state: 'REPORTING_UNAVAILABLE', code: 'REPORTING_UNAVAILABLE' });
}
function afterRequest(state, request, response, options = {}) {
  if (request.operation === 'read') return response;
  const reporting = ['COMPLETE', 'BLOCKED'].includes(state.phase)
    ? terminal(state, response, options) || reportState(state, options) : reportState(state, options);
  return addReporting(response, reporting);
}
module.exports = { addReporting, preflight, prepareAttempt, recover, afterRequest };

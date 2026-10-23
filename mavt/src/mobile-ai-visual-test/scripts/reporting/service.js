'use strict';
const { createRepository } = require('./repository');
const { createSettings } = require('./settings');
const { createCredentials } = require('./credentials');
const { createIdentity } = require('./identity');
const { createIntents } = require('./intents');
const { createJobQueue } = require('./jobs');

function createReportingService(options = {}) {
  const repository = options.repository || createRepository(options);
  const settings = options.settings || createSettings({ repository });
  const credentials = options.credentials || createCredentials({ repository });
  const identity = options.identity || createIdentity({ repository });
  const intents = options.intents || createIntents({ repository, settings, credentials });
  const launcher = options.launcher || ((claim, workspace) => require('./launcher').launchWorker(claim, workspace,
    { configDir: repository.configDir }));
  const jobs = options.jobs || createJobQueue({ repository, settings, credentials, identity, intents,
    launcher, clock: options.clock });
  function preflight(workspace) {
    const view = settings.read();
    const credential = credentials.status(view.serverUrl);
    return { serverUrl: view.serverUrl, autoUpload: view.autoUpload, configured: credential.configured,
      noticeCode: view.noticeAcknowledged ? null : 'REPORTING_NOTICE_REQUIRED' };
  }
  function checkConnection() {
    const view = settings.read();
    if (!credentials.status(view.serverUrl).configured) return { ok: false, code: 'REPORTING_NEEDS_CREDENTIAL' };
    return require('./launcher').checkConnection({ configDir: repository.configDir });
  }
  function resetIdentity(workspace) {
    jobs.reapDeadClaim(workspace);
    const { workspaceId, identityEpoch } = identity.reset(workspace);
    return { workspaceId, identityEpoch };
  }
  return {
    readSettings: settings.read,
    updateSettings: settings.update,
    prepareCredentials: credentials.prepare,
    checkConnection,
    preflight,
    prepareRunSnapshot: intents.prepareRunSnapshot,
    acceptRunSnapshot: intents.acceptRunSnapshot,
    submit: jobs.submit,
    status: jobs.status,
    retry: jobs.retry,
    resetIdentity
  };
}
module.exports = { createReportingService };

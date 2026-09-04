'use strict';

const {
  acquireAppium,
  releaseAppium,
} = require('./service-lifecycle');
const wdaLifecycle = require('./wda-lifecycle');
const appiumClient = require('./appium-client');

function overallOwnership(parts) {
  if (parts.some((part) => part?.ownership === 'FRAMEWORK_MANAGED')) return 'FRAMEWORK_MANAGED';
  if (parts.some((part) => part?.ownership === 'EXTERNAL')) return 'EXTERNAL';
  return 'NONE';
}

function overallReleaseStatus(parts) {
  if (parts.some((part) => part?.ok === false || part?.status === 'RELEASE_FAILED')) return 'RELEASE_FAILED';
  if (parts.some((part) => part?.status === 'RETAINED')) return 'RETAINED';
  return 'RELEASED';
}

function forwardingResource(target, wdaResult, dependencies = {}) {
  const ports = [...new Set([Number(target.wdaLocalPort || 8100), 9100]
    .filter((port) => Number.isInteger(port) && port > 0))];
  const inspect = dependencies.listeningPorts || wdaLifecycle.listeningPorts;
  const observed = inspect(ports);
  const managedWdaAlreadyActive = wdaResult?.ownership === 'FRAMEWORK_MANAGED' && wdaResult?.status === 'ACTIVE';
  return {
    status: 'TRACKED',
    ports,
    observedAtAcquire: observed,
    baselineListeningPorts: managedWdaAlreadyActive ? [] : observed,
  };
}

async function acquireIosRuntime(target, ownerKey, dependencies = {}) {
  const appiumResult = await (dependencies.acquireAppium || acquireAppium)(target, ownerKey);
  if (!appiumResult.ok) return appiumResult;
  const wdaResult = (dependencies.acquireWda || wdaLifecycle.acquireWda)(
    target,
    ownerKey,
    dependencies.wdaDependencies,
  );
  if (!wdaResult.ok) {
    if (appiumResult.ownership === 'FRAMEWORK_MANAGED') {
      await (dependencies.releaseAppium || releaseAppium)({ ...appiumResult, ownerKey });
    }
    return wdaResult;
  }
  let session;
  try {
    const createSession = dependencies.createSession || (process.env.MAVT_IOS_FAKE === '1'
      ? async () => ({ sessionId: `fake-session-${ownerKey}`, capabilities: { platformName: 'iOS' } })
      : appiumClient.createSession);
    session = await createSession(target, { autoLaunch: false, timeoutMs: 180000 });
  } catch (error) {
    await (dependencies.releaseWda || wdaLifecycle.releaseWda)(wdaResult.resource, ownerKey, dependencies.wdaDependencies);
    if (appiumResult.ownership === 'FRAMEWORK_MANAGED') {
      await (dependencies.releaseAppium || releaseAppium)({ ...appiumResult, ownerKey });
    }
    return {
      ok: false,
      status: 'ACQUIRE_FAILED',
      ownership: 'NONE',
      failureCode: 'IOS_APPIUM_SESSION_CREATE_FAILED',
      reason: error.message || String(error),
    };
  }
  return {
    ok: true,
    status: 'ACTIVE',
    ownership: overallOwnership([appiumResult, wdaResult]),
    resource: {
      schemaVersion: 1,
      appium: {
        status: appiumResult.status,
        ownership: appiumResult.ownership,
        ...appiumResult.resource,
      },
      wda: {
        status: wdaResult.status,
        ownership: wdaResult.ownership,
        ...wdaResult.resource,
      },
      forwarding: forwardingResource(target, wdaResult, dependencies),
      session: {
        sessionId: session.sessionId,
        server: target.appiumServer,
        ownership: 'FRAMEWORK_MANAGED',
        capabilities: session.capabilities || {},
      },
    },
  };
}

async function releaseIosRuntime(runtime, dependencies = {}) {
  const resource = runtime?.resource || {};
  if (!resource.appium && !resource.wda) return releaseAppium(runtime);
  const ownerKey = runtime.ownerKey;
  let sessionResult = { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' };
  if (resource.session?.ownership === 'FRAMEWORK_MANAGED' && resource.session.sessionId) {
    try {
      const deleteSession = dependencies.deleteSession || (process.env.MAVT_IOS_FAKE === '1' ? async () => {} : appiumClient.deleteSession);
      await deleteSession(resource.session.server, resource.session.sessionId);
    } catch (error) {
      sessionResult = {
        ok: false,
        status: 'RELEASE_FAILED',
        ownership: 'FRAMEWORK_MANAGED',
        failureCode: 'IOS_APPIUM_SESSION_RELEASE_FAILED',
        reason: error.message || String(error),
      };
    }
  }
  const wdaResult = await (dependencies.releaseWda || wdaLifecycle.releaseWda)(
    resource.wda,
    ownerKey,
    dependencies.wdaDependencies,
  );
  const appiumResult = await (dependencies.releaseAppium || releaseAppium)({
    ok: true,
    status: resource.appium?.status || 'ACTIVE',
    ownership: resource.appium?.ownership || 'NONE',
    ownerKey,
    resource: resource.appium || {},
  });
  const inspect = dependencies.listeningPorts || wdaLifecycle.listeningPorts;
  const ports = resource.forwarding?.ports || [];
  const baselinePorts = new Set(resource.forwarding?.baselineListeningPorts || []);
  const listening = inspect(ports);
  const unexpectedPorts = listening.filter((port) => !baselinePorts.has(port));
  const forwardingResult = unexpectedPorts.length
    ? {
      ok: false,
      status: 'RELEASE_FAILED',
      ownership: 'FRAMEWORK_MANAGED',
      failureCode: 'IOS_AUTOMATION_RELEASE_INCOMPLETE',
      reason: `iOS automation forwarding ports remain active: ${unexpectedPorts.join(', ')}`,
    }
    : {
      ok: true,
      status: listening.length ? 'RETAINED' : 'RELEASED',
      ownership: listening.length ? 'EXTERNAL' : 'FRAMEWORK_MANAGED',
    };
  const parts = [sessionResult, wdaResult, appiumResult, forwardingResult];
  const status = overallReleaseStatus(parts);
  const failed = parts.find((part) => part.ok === false || part.status === 'RELEASE_FAILED');
  return {
    ok: status !== 'RELEASE_FAILED',
    status,
    ownership: status === 'RETAINED' ? 'EXTERNAL' : overallOwnership(parts),
    ...(failed?.failureCode ? { failureCode: failed.failureCode } : {}),
    ...(failed?.reason ? { reason: failed.reason } : {}),
    resource: {
      schemaVersion: 1,
      appium: {
        ...resource.appium,
        status: appiumResult.status,
        ownership: appiumResult.ownership,
        ...(appiumResult.failureCode ? { failureCode: appiumResult.failureCode } : {}),
        ...(appiumResult.reason ? { reason: appiumResult.reason } : {}),
      },
      wda: {
        ...resource.wda,
        ...(wdaResult.resource || {}),
        status: wdaResult.status,
        ownership: wdaResult.ownership,
        ...(wdaResult.failureCode ? { failureCode: wdaResult.failureCode } : {}),
        ...(wdaResult.reason ? { reason: wdaResult.reason } : {}),
      },
      forwarding: {
        ...resource.forwarding,
        status: forwardingResult.status,
        ownership: forwardingResult.ownership,
        listeningPorts: listening,
        ...(forwardingResult.failureCode ? { failureCode: forwardingResult.failureCode } : {}),
        ...(forwardingResult.reason ? { reason: forwardingResult.reason } : {}),
      },
      session: {
        ...resource.session,
        status: sessionResult.status,
        ...(sessionResult.failureCode ? { failureCode: sessionResult.failureCode } : {}),
        ...(sessionResult.reason ? { reason: sessionResult.reason } : {}),
      },
    },
  };
}

module.exports = {
  acquireIosRuntime,
  forwardingResource,
  overallOwnership,
  overallReleaseStatus,
  releaseIosRuntime,
};

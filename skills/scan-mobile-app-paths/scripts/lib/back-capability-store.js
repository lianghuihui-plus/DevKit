'use strict';

const path = require('path');
const { contextDir, readJson, now, commitEvent, nextId, hashObject } = require('./common');

function file(scanDir, contextId) { return path.join(contextDir(scanDir, contextId), 'back-capabilities.json'); }
function loadBackCapabilities(scanDir, contextId) { return readJson(file(scanDir, contextId), { schemaVersion: 1, contextId, items: [] }); }

function recordBackCapability(scanDir, contextId, input) {
  const store = loadBackCapabilities(scanDir, contextId); const transitionFingerprint = hashObject({ contextId, fromReachableStateId: input.fromReachableStateId, toReachableStateId: input.toReachableStateId, action: 'BACK' });
  let item = store.items.find(entry => entry.transitionFingerprint === transitionFingerprint);
  if (!item) { item = { schemaVersion: 1, backCapabilityId: nextId(scanDir, 'backCapability', 'back'), contextId, fromReachableStateId: input.fromReachableStateId, toReachableStateId: input.toReachableStateId, createdAt: now() }; store.items.push(item); }
  Object.assign(item, { beforeObservationId: input.beforeObservationId, actionResultId: input.actionResultId, afterObservationId: input.afterObservationId, verificationStatus: input.verificationStatus, transitionFingerprint, status: input.verificationStatus === 'EXACT' ? 'ACTIVE' : 'INVALIDATED', updatedAt: now() });
  commitEvent(scanDir, item.status === 'ACTIVE' ? 'backCapabilityRecorded' : 'backCapabilityInvalidated', { contextId, backCapability: item }, [{ path: `contexts/${contextId}/back-capabilities.json`, op: 'UPSERT', collection: 'items', keyFields: ['backCapabilityId'], value: item, fallback: { schemaVersion: 1, contextId, items: [] } }]); return item;
}

module.exports = { loadBackCapabilities, recordBackCapability };

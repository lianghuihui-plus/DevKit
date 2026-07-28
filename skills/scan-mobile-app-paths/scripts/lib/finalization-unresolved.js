'use strict';

function verificationUnresolvedItems(queue = {}, contextId, targetCompleted = false) {
  return (queue.items || [])
    .filter(item => ['PENDING', 'FAILED'].includes(item.status))
    .filter(item => !targetCompleted || item.reason === 'CONFIRMED_TARGET_PATH')
    .map(item => ({
      type: 'VERIFICATION_UNRESOLVED',
      contextId,
      verificationId: item.verificationId,
      status: item.status,
      reasonCode: item.reasonCode || null,
      ...(targetCompleted ? { targetScope: 'CONFIRMED_TARGET_PATH' } : {})
    }));
}

module.exports = { verificationUnresolvedItems };

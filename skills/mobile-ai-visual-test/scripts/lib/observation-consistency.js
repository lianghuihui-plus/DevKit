'use strict';

function secureStateIndex(view) {
  return new Map((view?._states || []).filter((entry) => entry.secure).map((entry) => [entry.stateKey, entry]));
}

function compareObservationViews(before, after, action = {}) {
  const changes = [];
  const conflicts = [];
  const prior = secureStateIndex(before);
  const current = secureStateIndex(after);
  for (const [stateKey, left] of prior.entries()) {
    const right = current.get(stateKey);
    if (!right || left.maskedLength === null || right.maskedLength === null || left.maskedLength === right.maskedLength) continue;
    const unexpected = action.type !== 'inputText';
    changes.push({
      stateKey,
      element: left.text,
      property: 'maskedLength',
      before: left.maskedLength,
      after: right.maskedLength,
      unexpected,
    });
    if (unexpected) {
      conflicts.push({
        code: 'UNEXPECTED_SECURE_INPUT_MUTATION',
        severity: 'CRITICAL',
        stateKey,
        message: `非文本输入动作 ${action.type || 'unknown'} 使安全输入框长度从 ${left.maskedLength} 变为 ${right.maskedLength}`,
        actionType: action.type || null,
        resolved: false,
      });
    }
  }
  if (after?.signals?.keyboard?.shown === true && after?.signals?.coordinateConsistency === 'MISMATCH') {
    conflicts.push({
      code: 'KEYBOARD_COORDINATE_SPACE_MISMATCH',
      severity: 'ACTION_BLOCKING',
      message: '键盘处于显示状态，且键盘/控件树坐标空间与当前截图不一致',
      actionType: action.type || null,
      resolved: false,
    });
  }
  return { stateChanges: changes, conflicts };
}

function inputRepairSucceeded(actionEvent) {
  return actionEvent?.type === 'actionResult'
    && actionEvent.requestedAction?.type === 'inputText'
    && actionEvent.ok === true
    && ['VERIFIED', 'MASKED'].includes(actionEvent.deviceResult?.inputEffect?.status);
}

function coordinateActionConflict(view, platform, actionType) {
  if (String(platform || '').toLowerCase() !== 'ios'
    || !['tap', 'toggle', 'longPress', 'swipe'].includes(actionType)) return null;
  return view?.conflicts?.find((entry) => entry.code === 'KEYBOARD_COORDINATE_SPACE_MISMATCH') || null;
}

function unresolvedEvidenceConflicts(execDir, events, buildView, options = {}) {
  const unresolved = new Map();
  const cache = new Map();
  const actions = new Map(events.filter((entry) => entry.type === 'actionResult').map((entry) => [entry.operationId, entry]));
  for (const event of events) {
    if (options.warmSessionGeneration !== undefined
      && event.warmSessionGeneration !== undefined
      && event.warmSessionGeneration !== options.warmSessionGeneration) continue;
    if (event.type !== 'observation' || event.usable === false || !event.relatedOperationId) continue;
    const action = actions.get(event.relatedOperationId);
    const view = buildView(execDir, event, { includeConsistency: true, events, cache });
    for (const conflict of view?.conflicts || []) {
      if (conflict.severity !== 'CRITICAL') continue;
      const key = `${conflict.code}:${conflict.stateKey || '*'}`;
      unresolved.set(key, {
        ...conflict,
        observationRef: event.ref,
        operationId: event.relatedOperationId,
      });
    }
    if (inputRepairSucceeded(action)) {
      const repairKeys = new Set((view.stateChanges || []).map((entry) => entry.stateKey).filter(Boolean));
      const secureStates = (view._states || []).filter((entry) => entry.secure);
      if (repairKeys.size === 0 && secureStates.length === 1) repairKeys.add(secureStates[0].stateKey);
      for (const [key, conflict] of unresolved.entries()) {
        if (conflict.code === 'UNEXPECTED_SECURE_INPUT_MUTATION' && repairKeys.has(conflict.stateKey)) unresolved.delete(key);
      }
    }
    if (view?.signals?.keyboard?.shown !== true || view?.signals?.coordinateConsistency !== 'MISMATCH') {
      unresolved.delete('KEYBOARD_COORDINATE_SPACE_MISMATCH:*');
    }
  }
  return [...unresolved.values()];
}

module.exports = {
  compareObservationViews,
  coordinateActionConflict,
  inputRepairSucceeded,
  unresolvedEvidenceConflicts,
};

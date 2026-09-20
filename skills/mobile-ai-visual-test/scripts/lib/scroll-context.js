#!/usr/bin/env node
'use strict';

function counts(items) {
  const result = new Map();
  for (const item of items || []) result.set(item.anchorKey, (result.get(item.anchorKey) || 0) + 1);
  return result;
}

function sharedEvidence(beforeItems, afterItems) {
  const beforeCounts = counts(beforeItems);
  const afterCounts = counts(afterItems);
  const unique = (beforeItems || []).filter((item) => beforeCounts.get(item.anchorKey) === 1
    && afterCounts.get(item.anchorKey) === 1);
  if (unique.length) return { continuous: true, confidence: 'HIGH', shared: unique.map((item) => item.anchorKey) };
  const beforePairs = new Set((beforeItems || []).slice(0, -1)
    .map((item, index) => `${item.anchorKey}:${beforeItems[index + 1].anchorKey}`));
  const sharedPairs = (afterItems || []).slice(0, -1)
    .map((item, index) => `${item.anchorKey}:${afterItems[index + 1].anchorKey}`)
    .filter((key) => beforePairs.has(key));
  return sharedPairs.length
    ? { continuous: true, confidence: 'MEDIUM', shared: sharedPairs }
    : { continuous: false, confidence: 'NONE', shared: [] };
}

function directionFor(action) {
  if (action?.type !== 'swipe' || !Number.isFinite(Number(action.fromY)) || !Number.isFinite(Number(action.toY))) return null;
  if (Number(action.fromY) === Number(action.toY)) return null;
  return Number(action.fromY) > Number(action.toY) ? 'DOWN' : 'UP';
}

function sharedVerticalDeltas(beforeItems, afterItems, shared) {
  const before = new Map((beforeItems || []).map((item) => [item.anchorKey, item]));
  const after = new Map((afterItems || []).map((item) => [item.anchorKey, item]));
  return (shared || []).filter((key) => before.has(key) && after.has(key))
    .map((key) => Number(after.get(key).bounds[1]) - Number(before.get(key).bounds[1]))
    .filter((value) => Math.abs(value) >= 2);
}

function coherentMovement(direction, beforeItems, afterItems, shared) {
  const deltas = sharedVerticalDeltas(beforeItems, afterItems, shared);
  if (!deltas.length) return false;
  return direction === 'DOWN' ? deltas.some((value) => value < 0) : deltas.some((value) => value > 0);
}

function suggestedDistance(container) {
  const height = Number(container.bounds[3]) - Number(container.bounds[1]);
  const full = (container.items || []).filter((item) => item.bounds[1] >= container.bounds[1]
    && item.bounds[3] <= container.bounds[3]);
  const maxItemHeight = Math.max(0, ...full.map((item) => Number(item.bounds[3]) - Number(item.bounds[1])));
  const desired = maxItemHeight > 0 ? height - maxItemHeight - 16 : height * 0.5;
  return Math.round(Math.max(height * 0.25, Math.min(height * 0.75, desired)));
}

function initialContext(container, sceneId, generation, index) {
  const endHint = container.items.some((item) => item.boundaryHint === 'END');
  return {
    id: `scroll-${sceneId}-${index + 1}`,
    generation,
    contextKey: container.contextKey,
    containerKey: container.containerKey,
    axis: 'VERTICAL',
    bounds: container.bounds,
    trackingStatus: 'TRACKING',
    reachedStart: 'UNKNOWN',
    reachedEnd: endHint ? 'PROBABLE' : 'UNKNOWN',
    coverage: 'CONTIGUOUS',
    searchedAbove: false,
    searchedBelow: false,
    unexploredDirections: ['UP', 'DOWN'],
    absenceConclusionSupported: false,
    suggestedSwipeDistance: suggestedDistance(container),
    noProgress: { UP: 0, DOWN: 0 },
    lastDirection: null,
    anchors: container.items.map((item) => ({ anchorKey: item.anchorKey, bounds: item.bounds })),
    evidenceRefs: [sceneId],
  };
}

function finalizedContext(context) {
  const unexploredDirections = [];
  if (context.reachedStart !== 'CONFIRMED') unexploredDirections.push('UP');
  if (context.reachedEnd !== 'CONFIRMED') unexploredDirections.push('DOWN');
  return {
    ...context,
    unexploredDirections,
    absenceConclusionSupported: context.coverage === 'CONTIGUOUS'
      && context.reachedStart === 'CONFIRMED'
      && context.reachedEnd === 'CONFIRMED',
  };
}

function sameAnchorSequence(beforeItems, afterItems) {
  const before = (beforeItems || []).map((item) => item.anchorKey);
  const after = (afterItems || []).map((item) => item.anchorKey);
  return before.length === after.length && before.every((key, index) => key === after[index]);
}

function continueContext(prior, beforeContainer, afterContainer, previousAction, sceneId) {
  const action = previousAction?.action;
  if (!action || ['wait'].includes(action.type)) {
    if (!sameAnchorSequence(beforeContainer.items, afterContainer.items)) return null;
    return finalizedContext({
      ...prior,
      bounds: afterContainer.bounds,
      suggestedSwipeDistance: suggestedDistance(afterContainer),
      anchors: afterContainer.items.map((item) => ({ anchorKey: item.anchorKey, bounds: item.bounds })),
      evidenceRefs: [...new Set([...(prior.evidenceRefs || []), sceneId])],
    });
  }
  const direction = directionFor(action);
  if (!direction || previousAction.command?.status !== 'ACCEPTED') return null;
  const shared = sharedEvidence(beforeContainer.items, afterContainer.items);
  const noSignificantMovement = sameAnchorSequence(beforeContainer.items, afterContainer.items)
    && sharedVerticalDeltas(beforeContainer.items, afterContainer.items, shared.shared).length === 0;
  const noProgress = { ...(prior.noProgress || { UP: 0, DOWN: 0 }) };
  let coverage = prior.coverage;
  let searchedAbove = prior.searchedAbove;
  let searchedBelow = prior.searchedBelow;
  let reachedStart = prior.reachedStart;
  let reachedEnd = prior.reachedEnd;
  if (prior.lastDirection && prior.lastDirection !== direction) noProgress[direction] = 0;
  if (shared.continuous && noSignificantMovement) {
    noProgress[direction] = (noProgress[direction] || 0) + 1;
    const boundary = noProgress[direction] >= 2 ? 'CONFIRMED' : 'PROBABLE';
    if (direction === 'UP') reachedStart = boundary;
    else reachedEnd = boundary;
  } else if (shared.continuous && coherentMovement(direction, beforeContainer.items, afterContainer.items, shared.shared)) {
    noProgress.UP = 0;
    noProgress.DOWN = 0;
    if (direction === 'UP') searchedAbove = true;
    else searchedBelow = true;
  } else {
    coverage = 'GAPPED';
  }
  if (afterContainer.items.some((item) => item.boundaryHint === 'END') && reachedEnd === 'UNKNOWN') reachedEnd = 'PROBABLE';
  return finalizedContext({
    ...prior,
    bounds: afterContainer.bounds,
    reachedStart,
    reachedEnd,
    coverage,
    searchedAbove,
    searchedBelow,
    noProgress,
    lastDirection: direction,
    suggestedSwipeDistance: suggestedDistance(afterContainer),
    anchors: afterContainer.items.map((item) => ({ anchorKey: item.anchorKey, bounds: item.bounds })),
    evidenceRefs: [...new Set([...(prior.evidenceRefs || []), sceneId])],
  });
}

function updateScrollContexts({ previousScene, containers = [], previousAction, sceneId, generation }) {
  if (!containers.length) return [];
  return containers.map((container, index) => {
    const prior = (previousScene?.scrollContexts || []).find((entry) => entry.contextKey === container.contextKey
      && entry.containerKey === container.containerKey && entry.generation === generation);
    const beforeContainer = (previousScene?.scrollContainers || []).find((entry) => entry.contextKey === container.contextKey
      && entry.containerKey === container.containerKey);
    const continued = prior && beforeContainer
      ? continueContext(prior, beforeContainer, container, previousAction, sceneId)
      : null;
    return continued || initialContext(container, sceneId, generation, index);
  });
}

module.exports = {
  directionFor,
  sameAnchorSequence,
  sharedEvidence,
  suggestedDistance,
  updateScrollContexts,
};

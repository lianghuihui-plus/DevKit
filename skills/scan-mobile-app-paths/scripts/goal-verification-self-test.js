#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { classifyGoalReplay } = require('./lib/goal-verification-result');
const { counterSeedFromCanonical } = require('./lib/canonical-map-store');

let tests = 0;
function check(value, expected) {
  assert.deepEqual(value, expected);
  tests += 1;
}

function task() {
  return {
    verificationId: 'verify-goal',
    terminalReachableStateId: 'rs-target',
    edgeIds: ['edge-a', 'edge-b'],
    transitionFingerprints: ['fp-a', 'fp-b']
  };
}

function graph({ supersede = false } = {}) {
  return {
    edges: [
      { id: 'edge-a', verification: { transitionFingerprint: supersede ? 'fp-old' : 'fp-a' } },
      { id: 'edge-b', verification: { transitionFingerprint: 'fp-b' } }
    ]
  };
}

const semanticallyVerifiedRestore = {
  status: 'SUCCEEDED',
  reachableStateId: 'rs-target',
  fixedEdgeIds: ['edge-a', 'edge-b'],
  fixedTransitionFingerprints: ['fp-a', 'fp-b'],
  steps: [
    { edgeId: 'edge-a', verificationStatus: 'SAME_PAGE', afterObservationId: 'obs-a' },
    { edgeId: 'edge-b', verificationStatus: 'PROBABLE', afterObservationId: 'obs-b' }
  ],
  equivalenceReviews: [{ status: 'EXPECTED_STATE_EQUIVALENT', observationId: 'obs-b' }]
};

const goalMiss = classifyGoalReplay({ task: task(), graph: graph(), restored: semanticallyVerifiedRestore, childStatus: 0, matchStatus: 'NO_MATCH' });
check(goalMiss.pathReplayVerified, true);
check(goalMiss.goalVerified, false);
check(goalMiss.pathReplayStatus, 'COLD_REPLAY_VERIFIED');
check(goalMiss.reasonCode, 'GOAL_REPLAY_NOT_STRONG');
check(goalMiss.failure, null);

const goalHit = classifyGoalReplay({ task: task(), graph: graph(), restored: semanticallyVerifiedRestore, childStatus: 0, matchStatus: 'CANDIDATE_STRONG' });
check(goalHit.pathReplayVerified, true);
check(goalHit.goalVerified, true);
check(goalHit.reasonCode, null);

const branchFailure = classifyGoalReplay({
  task: task(),
  graph: graph(),
  restored: {
    status: 'FAILED',
    restoreId: 'restore-1',
    reasonCode: 'STEP_MISMATCH',
    actionsReplayed: 1,
    steps: [{ edgeId: 'edge-a', verificationStatus: 'EXACT' }]
  },
  childStatus: 1,
  matchStatus: null
});
check(branchFailure.pathReplayVerified, false);
check(branchFailure.failure.blockingEdgeIds, ['edge-b']);
check(branchFailure.failure.scope, 'BRANCH_EDGE_BLOCKED');

const superseded = classifyGoalReplay({ task: task(), graph: graph({ supersede: true }), restored: semanticallyVerifiedRestore, childStatus: 0, matchStatus: 'CANDIDATE_STRONG' });
check(superseded.pathReplayStatus, 'SUPERSEDED');
check(superseded.failure, null);

check(counterSeedFromCanonical({ contextId: 'guest', backCapabilities: { items: [{ backCapabilityId: 'back-0003' }] } }).backCapability, 3);
check(counterSeedFromCanonical({ contextId: 'guest', backCapabilities: { items: [{ backCapabilityId: 'backcap-0007' }, { backCapabilityId: 'back-0003' }] } }).backCapability, 7);

console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'goal-verification', tests }, null, 2));

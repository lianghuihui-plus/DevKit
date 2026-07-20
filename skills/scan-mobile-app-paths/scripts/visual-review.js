#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  parseArgs, required, requiredId, resolveScanDir, loadScan, readJson, jsonArg, safeSegment,
  commitEvent, output, main, fail, now, loadFrontier
} = require('./lib/common');
const { activeContextId } = require('./lib/run-protocol');
const { recordVisualReview } = require('./lib/visual-review-store');

function releaseAttempt(scanDir, contextId, attempt, reasonCode) {
  attempt.status = 'FAILED';
  attempt.reasonCode = reasonCode;
  attempt.updatedAt = now();
  const frontier = loadFrontier(scanDir, contextId);
  const item = frontier.items.find(entry => entry.id === attempt.frontierId);
  if (item?.status === 'CLAIMED' && (!item.claimedAttemptId || item.claimedAttemptId === attempt.attemptId)) {
    item.status = item.attempts < 3 ? 'RETRYABLE' : 'FAILED';
    item.reasonCode = reasonCode;
    item.resolvedAt = now();
    item.lastAttemptId = attempt.attemptId;
    item.claimToken = null;
    item.claimedAttemptId = null;
  }
  const ops = [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }];
  if (item) ops.push({ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item });
  commitEvent(scanDir, 'attemptVisualReviewRejected', { contextId, attemptId: attempt.attemptId, reasonCode, visualReviewId: attempt.visualReviewId, frontierItem: item || null }, ops);
  return { attempt, frontierItem: item || null };
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'record';
  if (command !== 'record') fail(`Unknown visual-review command: ${command}`, 'COMMAND_INVALID');
  const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: true });
  const contextId = args.context || activeContextId(scan);
  if (!contextId) fail('context is required', 'CONTEXT_REQUIRED');
  const observationId = safeSegment(required(args, 'observationId'), 'observationId');
  const reviewTypeInput = required(args, 'reviewType');
  const assessment = jsonArg(required(args, 'assessment'), null, 'assessment JSON');
  const attemptId = args.attemptId ? safeSegment(requiredId(args, 'attemptId'), 'attemptId') : null;
  const owner = attemptId ? { type: 'ATTEMPT', id: attemptId } : args.ownerType || args.ownerId ? { type: String(args.ownerType || 'UNKNOWN'), id: String(args.ownerId || '') } : null;
  const visualReview = recordVisualReview(scanDir, { contextId, observationId, reviewType: reviewTypeInput, assessment, owner });
  const reviewType = visualReview.reviewType;
  let attempt = null; let frontierItem = null;
  if (attemptId) {
    attempt = readJson(path.join(scanDir, 'attempts', `${attemptId}.json`));
    if (attempt.contextId !== contextId) fail('Attempt belongs to another context', 'ATTEMPT_CAUSALITY_INVALID');
    if (reviewType === 'PAGE_OUTCOME' && attempt.afterObservationId !== observationId) fail('PAGE_OUTCOME VisualReview must bind to Attempt afterObservationId', 'VISUAL_REVIEW_INVALID');
    if (!['AWAITING_VISUAL_REVIEW', 'AWAITING_OUTCOME_REVIEW'].includes(attempt.status)) fail('Attempt is not awaiting visual review', 'ATTEMPT_STATE_INVALID');
    attempt.visualReviewId = visualReview.visualReviewId;
    attempt.visualReviewStatus = visualReview.status;
    attempt.visualReviews ||= [];
    attempt.visualReviews.push({ visualReviewId: visualReview.visualReviewId, observationId, reviewType, status: visualReview.status, recordedAt: visualReview.createdAt });
    if (visualReview.status === 'ACCEPTED') {
      attempt.status = 'AWAITING_OUTCOME_REVIEW';
      attempt.reviewObservationId = observationId;
      attempt.updatedAt = now();
      commitEvent(scanDir, 'attemptVisualReviewAccepted', { contextId, attemptId, visualReviewId: visualReview.visualReviewId, observationId, reviewType }, [
        { path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }
      ]);
    } else {
      const released = releaseAttempt(scanDir, contextId, attempt, visualReview.reasonCode || visualReview.status);
      attempt = released.attempt;
      frontierItem = released.frontierItem;
    }
  }
  output({ schemaVersion: 1, ok: true, visualReview, attempt, frontierItem });
});

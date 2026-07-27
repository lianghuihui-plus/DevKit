#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { POPUP_DISPOSITIONS, NON_GRAPH_POPUP_DISPOSITIONS, validateDismissAction } = require('../lib/popup-policy');
const { normalizeAssessment } = require('../lib/visual-review-store');
const { assertBusinessModalReview, assertInterruptionCleanupReview, assertDismissalMatchesAssessment } = require('../lib/popup-assessment-guard');

let tests = 0;
function check(value, expected) {
  assert.deepEqual(value, expected);
  tests += 1;
}

function acceptedReview(popupAssessment) {
  const assessment = normalizeAssessment({
    status: 'ACCEPTED',
    pageUsable: true,
    pageKind: 'popup',
    pageName: '自测浮层',
    confidence: 'HIGH',
    rationale: 'self-test visual review',
    popupAssessment
  });
  return { popupAssessment: assessment.popupAssessment };
}

function fails(fn, code) {
  try { fn(); } catch (error) { check(error.code, code); return; }
  throw new Error(`Expected failure: ${code}`);
}

check(POPUP_DISPOSITIONS.includes('GUIDE_POPUP'), true);
check(POPUP_DISPOSITIONS.includes('PROMOTION_POPUP'), true);
check(NON_GRAPH_POPUP_DISPOSITIONS, ['GUIDE_POPUP', 'PROMOTION_POPUP', 'DISMISSIBLE_POPUP']);
const businessReview = acceptedReview({ popupPresent: true, graphRole: 'STATE', popupKind: 'BUSINESS_MODAL', businessRelevance: 'BUSINESS_FUNCTION', openedByUserAction: true, containsBusinessControls: true, stableBusinessSurface: true, dismissalSemantics: 'CLOSES_BUSINESS_CONTEXT', visualEvidence: ['modal-panel', 'selection-controls'], rationale: '功能性业务面板' });
check(assertBusinessModalReview(businessReview).popupKind, 'BUSINESS_MODAL');
const guideReview = acceptedReview({ popupPresent: true, graphRole: 'INTERRUPTION', popupKind: 'GUIDE_POPUP', businessRelevance: 'NON_BUSINESS', stablePageBlocking: true, dismissal: { available: true, method: 'TAP', safety: 'WEAK_DISMISS', targetDescription: '关闭按钮' }, stablePageAfterDismissalExpected: true, visualEvidence: ['coach-mark', 'close-affordance'], rationale: '图片型引导遮挡页面' });
check(assertInterruptionCleanupReview(guideReview, 'GUIDE_POPUP').graphRole, 'INTERRUPTION');
assertDismissalMatchesAssessment(guideReview.popupAssessment, { type: 'tap', fallbackBounds: [900, 80, 1040, 220] }); tests += 1;
check(validateDismissAction({ type: 'tap', fallbackBounds: [900, 80, 1040, 220] }, { environment: 'test' }, { popupAssessment: guideReview.popupAssessment }).safety.role, 'POPUP_DISMISSAL');
fails(() => assertBusinessModalReview(guideReview), 'BUSINESS_MODAL_REVIEW_INSUFFICIENT');
fails(() => assertDismissalMatchesAssessment(guideReview.popupAssessment, { type: 'keyEvent', key: 'BACK' }), 'POPUP_DISMISSAL_MISMATCH');
const incompleteBusinessReview = acceptedReview({ popupPresent: true, graphRole: 'STATE', popupKind: 'BUSINESS_MODAL', openedByUserAction: true, visualEvidence: ['modal-panel'], rationale: '缺少业务控件证据' });
fails(() => assertBusinessModalReview(incompleteBusinessReview), 'BUSINESS_MODAL_REVIEW_INSUFFICIENT');
const unsafeInterruptionReview = acceptedReview({ popupPresent: true, graphRole: 'INTERRUPTION', popupKind: 'PROMOTION_POPUP', stablePageBlocking: true, dismissal: { available: true, method: 'TAP', safety: 'RISKY' }, stablePageAfterDismissalExpected: true, visualEvidence: ['image-overlay'], rationale: '关闭动作不安全' });
fails(() => assertInterruptionCleanupReview(unsafeInterruptionReview, 'PROMOTION_POPUP'), 'INTERRUPTION_CLEANUP_REVIEW_INSUFFICIENT');

console.log(JSON.stringify({ schemaVersion: 1, ok: true, suite: 'popup-policy', tests }));
